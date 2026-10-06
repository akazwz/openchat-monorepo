import {
	and,
	desc,
	eq,
	exists,
	getColumns,
	ilike,
	lt,
	not,
	sql,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

import type { Database } from "@/db/client";
import { messages } from "@/db/schema/messages";
import { runs, unfinishedRun } from "@/db/schema/runs";
import {
	type ThreadContextWindow,
	type ThreadRecord,
	threads,
} from "@/db/schema/threads";
import { errorDetails } from "@/lib/error-details";
import { AppError, ErrorCode } from "@/lib/errors";
import { pageOptions, pageResult } from "@/lib/pagination";
import { containing } from "@/lib/sql";
import { announce, userEvents } from "@/modules/events/publish";
import { discardUnreferenced, threadFileIds } from "@/modules/files/lifecycle";
import { cancelRunExecution, activeToolResult } from "@/modules/runs/delivery";
import { getRunSnapshot, getRunById } from "@/modules/runs/queries";
import { isActiveRun } from "@/modules/runs/types";

import { archivedParts } from "./content-store";
import { shownMessage } from "./shown";
import { messageFromRow } from "./storage";
import type { Thread } from "./types";

interface ThreadUpdate {
	title?: string;
}
export interface PageInput {
	pageSize?: number;
	pageToken?: string;
}
// A conversation's record as it is read, with whether a reply is being
// written in it: a run of it has not finished (a conversation has at most one,
// runs_active_thread_idx). Every record the server gives out is read with it,
// in one statement that reads the conversation, so it holds as of the record's
// own activity time (thread.proto). Never in a change's RETURNING: a change
// that waited for a run's start (which holds the conversation's row) returns
// the row with that run's time, but reads runs as they were when the statement
// began, before the run was there, and said no reply was being written at the
// new time; the side nav then showed none for the whole run. A subquery built as one, so
// its columns name their tables: in a raw `sql` fragment, a query of one table
// leaves them unqualified, and "thread_id" = "id" compared the run with itself.
export const threadColumns = {
	...getColumns(threads),
	running: exists(
		new QueryBuilder()
			.select({ one: sql`1` })
			.from(runs)
			.where(and(eq(runs.threadId, threads.id), unfinishedRun(runs.status))),
	).mapWith(Boolean),
};
export const threadFromRow = ({
	id,
	title,
	revision,
	updatedAt,
	running,
	main,
}: ThreadRecord & { running: boolean }): Thread => ({
	id,
	title,
	revision,
	activeAt: updatedAt,
	running,
	main,
});
const owned = (userId: string, id: string) =>
	and(eq(threads.id, id), eq(threads.userId, userId));

// A conversation started by its first input is titled from that input; one
// without text is untitled (""), which the app shows in its own language.
export function threadTitle(text: string) {
	return Array.from(text.trim()).slice(0, 40).join("");
}
export async function getThread(db: Database, userId: string, id: string) {
	const [row] = await db
		.select(threadColumns)
		.from(threads)
		.where(owned(userId, id));
	if (!row) throw new AppError("Thread not found", ErrorCode.NotFound);
	return threadFromRow(row);
}
// The user's continuing conversation with the agent, made on their first
// visit. Two devices asking at once make one: the index on a user's main
// conversation turns the second insert into nothing, and both read the same
// row.
export async function getMainThread(db: Database, userId: string) {
	const main = and(eq(threads.userId, userId), threads.main);
	const read = () => db.select(threadColumns).from(threads).where(main);
	let [row] = await read();
	if (!row) {
		await db
			.insert(threads)
			.values({ userId, main: true })
			.onConflictDoNothing();
		[row] = await read();
	}
	if (!row) throw new AppError("Main thread missing", ErrorCode.Internal);
	return threadFromRow(row);
}
// The main conversation has no title and stays for as long as the account.
async function refuseMain(db: Database, userId: string, id: string) {
	const [row] = await db
		.select({ main: threads.main })
		.from(threads)
		.where(owned(userId, id));
	if (row?.main)
		throw new AppError(
			"The main conversation cannot be renamed or deleted",
			ErrorCode.FailedPrecondition,
		);
}
function activityCursor(cursor: string) {
	const [time, id] = cursor.split(":");
	const at = new Date(Number(time));
	if (!id || Number.isNaN(at.getTime()))
		throw new AppError("invalid page_token", ErrorCode.InvalidArgument);
	return { time: at, id };
}
export async function listThreads(
	db: Database,
	userId: string,
	input: PageInput & { query?: string } = {},
) {
	const query = input.query?.trim() ?? "";
	if (query.length > 200)
		throw new AppError("Search query is too long", ErrorCode.InvalidArgument);
	const scope = `threads:${userId}:${query}`;
	const { limit, cursor } = pageOptions(input.pageSize, input.pageToken, scope);
	// The side conversations, the most recently active first; a page
	// continues after the last one's time and ID. The main conversation is
	// read on its own (getMainThread).
	const after = cursor ? activityCursor(cursor) : undefined;
	const rows = await db
		.select(threadColumns)
		.from(threads)
		.where(
			and(
				eq(threads.userId, userId),
				not(threads.main),
				query ? ilike(threads.title, containing(query)) : undefined,
				after
					? sql`(${threads.updatedAt}, ${threads.id}) < (${after.time}, ${after.id})`
					: undefined,
			),
		)
		.orderBy(desc(threads.updatedAt), desc(threads.id))
		.limit(limit + 1);
	return pageResult(
		rows.map(threadFromRow),
		limit,
		scope,
		(thread) => `${thread.activeAt.getTime()}:${thread.id}`,
	);
}
export async function updateThread(
	db: Database,
	userId: string,
	id: string,
	update: ThreadUpdate,
) {
	if (update.title !== undefined && update.title.length > 200)
		throw new AppError("Title is too long", ErrorCode.InvalidArgument);
	if (update.title === undefined)
		throw new AppError("Thread update is empty", ErrorCode.InvalidArgument);
	await refuseMain(db, userId, id);
	const [row] = await db
		.update(threads)
		.set({
			title: update.title,
			revision: sql`${threads.revision} + 1`,
			// A rename is the person's choice; nothing generated replaces it.
			titleSource: "user" as const,
		})
		.where(owned(userId, id))
		.returning({ id: threads.id });
	if (!row) throw new AppError("Thread not found", ErrorCode.NotFound);
	// Read after it (threadColumns).
	const thread = await getThread(db, userId, id);
	await announce(userId, [userEvents.thread(thread)]);
	return thread;
}
// A reply still being written goes with its conversation: its run's rows are
// deleted with the rest, and its actor, told after the commit, stops at once
// (or at its next commit, which finds the run gone).
export async function deleteThread(db: Database, userId: string, id: string) {
	await refuseMain(db, userId, id);
	const running = await db.transaction(async (tx) => {
		const [thread] = await tx
			.select({ id: threads.id })
			.from(threads)
			.where(owned(userId, id))
			.for("update");
		if (!thread) throw new AppError("Thread not found", ErrorCode.NotFound);
		const active = await tx
			.select({ id: runs.id })
			.from(runs)
			.where(and(eq(runs.threadId, id), unfinishedRun(runs.status)));
		const fileIds = await threadFileIds(tx, userId, id);
		// Foreign keys remove turns, messages, runs, steps and private checkpoints.
		await tx.delete(threads).where(owned(userId, id));
		await discardUnreferenced(tx, userId, fileIds);
		return active;
	});
	await announce(userId, [userEvents.threadDeleted(id)]);
	for (const run of running)
		await cancelRunExecution(run.id).catch((error: unknown) =>
			console.warn("[Thread] Deleted; its run stops at its next commit", {
				runId: run.id,
				...errorDetails(error),
			}),
		);
}
export async function listMessages(
	db: Database,
	userId: string,
	threadId: string,
	input: PageInput = {},
) {
	await getThread(db, userId, threadId);
	const scope = `messages:${userId}:${threadId}`;
	const { limit, cursor } = pageOptions(input.pageSize, input.pageToken, scope);
	const rows = await db
		.select({
			message: { ...getColumns(messages), text: sql<string>`''` },
			run: {
				status: runs.status,
				attempt: runs.attempt,
				cancelRequested: runs.cancelRequested,
				revision: runs.revision,
			},
		})
		.from(messages)
		.leftJoin(runs, eq(runs.id, messages.runId))
		.where(
			and(
				eq(messages.userId, userId),
				eq(messages.threadId, threadId),
				shownMessage,
				cursor ? lt(messages.id, cursor) : undefined,
			),
		)
		.orderBy(desc(messages.id))
		.limit(limit + 1);
	// Each assistant output comes with its run as of this read, in the same
	// statement, so the copy and its revision agree.
	const hydrated = await Promise.all(
		rows.map(async (row) => {
			const message = messageFromRow(row.message);
			if (!message.runId) return { ...message, run: undefined };
			if (row.run && isActiveRun(row.run.status)) {
				const snapshot = await getRunSnapshot(db, userId, message.runId);
				return {
					...snapshot.outputMessage,
					run: { ...snapshot.run, revision: snapshot.revision },
				};
			}
			message.parts = await archivedParts(db, message.id, {
				omitLongOutputs: true,
			});
			return { ...message, run: row.run ?? undefined };
		}),
	);
	const page = pageResult(hydrated, limit, scope);
	return { ...page, items: page.items.reverse() };
}

// Merges into where the model's context window stands (runtime/window.ts).
export async function updateContextWindow(
	db: Database,
	threadId: string,
	patch: ThreadContextWindow,
) {
	await db
		.update(threads)
		.set({
			contextWindow: sql`${threads.contextWindow} || ${JSON.stringify(patch)}::jsonb`,
		})
		.where(eq(threads.id, threadId));
}

// One tool result of a message the user can see, whole: listed messages
// leave long outputs out (part-codec.ts).
export async function getToolResult(
	db: Database,
	userId: string,
	messageId: string,
	toolCallId: string,
) {
	const [row] = await db
		.select({ ...getColumns(messages), text: sql<string>`''` })
		.from(messages)
		.where(
			and(
				eq(messages.id, messageId),
				eq(messages.userId, userId),
				shownMessage,
			),
		);
	if (!row?.runId)
		throw new AppError("Tool result not found", ErrorCode.NotFound);
	let run = await getRunById(db, row.runId);
	let part;
	let failure: unknown;
	if (run && isActiveRun(run.status)) {
		try {
			part = await activeToolResult(run.id, userId, toolCallId);
		} catch (error) {
			failure = error;
		}
	}
	const [visible] = await db
		.select({ id: messages.id })
		.from(messages)
		.where(
			and(eq(messages.id, row.id), eq(messages.userId, userId), shownMessage),
		);
	if (!visible) throw new AppError("Tool result not found", ErrorCode.NotFound);
	run = await getRunById(db, row.runId);
	if (run && !isActiveRun(run.status))
		part = (await archivedParts(db, row.id, { toolCallId }))[0];
	else if (failure)
		throw new AppError("Tool result is unavailable", ErrorCode.Unavailable);
	if (!part) throw new AppError("Tool result not found", ErrorCode.NotFound);
	return part;
}
