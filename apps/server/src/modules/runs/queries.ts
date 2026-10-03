import { and, asc, count, eq, gte, lt, or, sql, getColumns } from "drizzle-orm";

import { agentConfig } from "@/config";
import type { Database } from "@/db/client";
import { messages, userMessage } from "@/db/schema/messages";
import { type RunRecord, runs } from "@/db/schema/runs";
import { threads } from "@/db/schema/threads";
import { turns } from "@/db/schema/turns";
import { AppError, ErrorCode } from "@/lib/errors";
import { archivedPartDescriptors } from "@/modules/threads/content-store";
import { shownMessage } from "@/modules/threads/shown";
import { messageFromRow } from "@/modules/threads/storage";
import { decodeParts } from "@/modules/threads/storage";
import type { MessagePart } from "@/modules/threads/types";
import {
	type EarlierTurns,
	noEarlierTurns,
} from "@/runtime/adapters/thread-history";

import { activeRunSnapshot } from "./delivery";
import type { HistoryBody } from "./history-loader";
import { loadRunMessages, snapshotFromRun } from "./records";
import { isActiveRun, type RunSnapshot } from "./types";

// Actor-only access. Public RPC callers use ownership-aware lookups above.
export async function getRunById(
	db: Database,
	runId: string,
): Promise<RunRecord | undefined> {
	const [run] = await db.select().from(runs).where(eq(runs.id, runId));
	return run;
}
export async function getRunSnapshot(
	db: Database,
	userId: string,
	runId: string,
): Promise<RunSnapshot> {
	const [run] = await db
		.select()
		.from(runs)
		.where(and(eq(runs.userId, userId), eq(runs.id, runId)));
	if (!run) throw new AppError("Run not found", ErrorCode.NotFound);
	if (!isActiveRun(run.status)) return snapshotFromRun(db, run);
	let snapshot: RunSnapshot | undefined;
	let failure: unknown;
	try {
		snapshot = await activeRunSnapshot(runId, userId);
	} catch (error) {
		failure = error;
	}
	const current = await getRunById(db, runId);
	if (!current || current.userId !== userId)
		throw new AppError("Run not found", ErrorCode.NotFound);
	if (!isActiveRun(current.status)) return snapshotFromRun(db, current);
	if (!snapshot)
		throw (
			failure ??
			new AppError("Run snapshot is unavailable", ErrorCode.Unavailable)
		);
	return snapshot;
}
export async function loadRunForExecution(
	db: Database,
	runId: string,
	options: { history?: boolean } = {},
) {
	return db.transaction(async (tx) => {
		const [run] = await tx
			.select()
			.from(runs)
			.where(eq(runs.id, runId))
			.for("share");
		if (!run) throw new AppError("Run not found", ErrorCode.NotFound);
		const { input, output } = await loadRunMessages(tx, run);
		const [thread] = await tx
			.select({ contextWindow: threads.contextWindow })
			.from(threads)
			.where(eq(threads.id, run.threadId));
		const contextWindow = thread?.contextWindow ?? {};
		const start = contextWindow.startTurnId;
		// The turns inside the model's context window, and the new input.
		const rows = await tx
			.select({ message: { ...getColumns(messages), text: sql<string>`''` } })
			.from(messages)
			.where(
				and(
					eq(messages.userId, run.userId),
					eq(messages.threadId, run.threadId),
					start ? gte(messages.turnId, start) : undefined,
					or(lt(messages.turnId, run.turnId), eq(messages.id, input.id)),
					shownMessage,
				),
			)
			.orderBy(asc(messages.turnId), asc(messages.id));
		const bodies = new Map<MessagePart, HistoryBody>();
		const history = [];
		if (options.history !== false)
			for (const row of rows) {
				const message = messageFromRow(row.message);
				if (message.role === "assistant") {
					message.parts = [];
					for (const descriptor of await archivedPartDescriptors(
						tx,
						message.id,
					)) {
						const [part] = decodeParts([descriptor.meta]);
						if (part.content.case === "text" && descriptor.chars)
							part.content.value = "x";
						else if (part.content.case === "toolCall" && descriptor.chars)
							part.content.value.arguments = "x";
						else if (part.content.case === "toolResult")
							part.content.value.output = "x";
						message.parts.push(part);
						bodies.set(part, { ...descriptor, messageId: message.id });
					}
				}
				history.push(message);
			}
		while (history.length && history[0].role !== "user") history.shift();

		return {
			run,
			input,
			output,
			history,
			bodies,
			contextWindow,
			earlier: start
				? await earlierTurns(tx, run.threadId, start)
				: noEarlierTurns,
		};
	});
}

// The turns before the window's `start`: how many, and the input messages of
// the newest of them, as many as the notice can quote (windowedHistory
// quotes them). Newest first while the running total of their words before
// each is under the limit: a superset, since a quote also holds the notes on
// its attachments, and the notice trims to the limit exactly.
async function earlierTurns(
	tx: Pick<Database, "select">,
	threadId: string,
	start: string,
): Promise<EarlierTurns> {
	const earlier = and(eq(turns.threadId, threadId), lt(turns.id, start));
	const [{ total }] = await tx
		.select({ total: count() })
		.from(turns)
		.where(earlier);
	const inputs = tx
		.select({
			// Named, since both tables' ids would otherwise both be "id".
			turnId: sql<string>`${turns.id}`.as("turn_id"),
			messageId: sql<string>`${messages.id}`.as("message_id"),
			before:
				sql<number>`coalesce(sum(char_length(${messages.text})) over (order by ${turns.id} desc rows between unbounded preceding and 1 preceding), 0)`.as(
					"before",
				),
		})
		.from(turns)
		.innerJoin(
			messages,
			and(eq(messages.turnId, turns.id), userMessage(messages.role)),
		)
		.where(earlier)
		.as("inputs");
	const rows = await tx
		.select({ message: { ...getColumns(messages), text: sql<string>`''` } })
		.from(inputs)
		.innerJoin(messages, eq(messages.id, inputs.messageId))
		.where(lt(inputs.before, agentConfig.window.omittedUserChars))
		.orderBy(asc(inputs.turnId));
	return {
		turns: total,
		inputs: rows.map((row) => messageFromRow(row.message)),
	};
}
