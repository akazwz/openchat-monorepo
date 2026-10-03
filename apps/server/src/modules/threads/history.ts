import { and, asc, desc, eq, or, type SQL, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { messages } from "@/db/schema/messages";
import { runs, unfinishedRun } from "@/db/schema/runs";
import { threads } from "@/db/schema/threads";
import { AppError, ErrorCode } from "@/lib/errors";
import { containing } from "@/lib/sql";
import { textWindow } from "@/lib/text";
import {
	activeTextRead,
	activeTextSearch,
	type ActiveTextSource,
} from "@/modules/runs/delivery";
import { isActiveRun } from "@/modules/runs/types";

import { getThread } from "./service";
import { shownMessage } from "./shown";
import { scanText, sliceText } from "./text-source";
import type { MessagePart } from "./types";

// A message as text for the agent's own tools, stored with it (messages.text):
// its text parts, not its files, tool calls or reasoning.
export const messageText = (parts: MessagePart[]) =>
	parts
		.flatMap((part) =>
			part.content.case === "text" ? [part.content.value] : [],
		)
		.join("\n");
// Past conversations as the agent's tools read them: only what the person
// sees, each turn's input and its latest reply.
const shown = (userId: string) =>
	and(eq(messages.userId, userId), shownMessage);

const matchedMessages = 60;
const shownConversations = 10;
const snippetsPerConversation = 2;
const snippetBefore = 60;
const snippetAfter = 160;
const readMessageChars = 4_000;
const readTotalChars = 40_000;

interface ConversationHit {
	id: string;
	title: string;
	updatedAt: Date;
	snippets: { role: "user" | "assistant"; createdAt: Date; text: string }[];
}

// The text around the first keyword in it, by characters.
function snippet(text: string, terms: string[]) {
	const lower = text.toLowerCase();
	const at = Math.min(
		...terms.map((term) => {
			const index = lower.indexOf(term.toLowerCase());
			return index < 0 ? Number.POSITIVE_INFINITY : index;
		}),
	);
	const chars = Array.from(text);
	const start = Number.isFinite(at)
		? Math.max(0, Array.from(text.slice(0, at)).length - snippetBefore)
		: 0;
	const end = Math.min(chars.length, start + snippetBefore + snippetAfter);
	return `${start > 0 ? "…" : ""}${chars.slice(start, end).join("").replace(/\s+/g, " ").trim()}${end < chars.length ? "…" : ""}`;
}

// Recheck the PostgreSQL projection after an active read: deletion wins, and
// a completed archive is read from PostgreSQL even if the actor was retired.
async function resolveActiveText<T>(
	db: Database,
	userId: string,
	messageId: string,
	read: () => Promise<T | undefined>,
	archived: (text: string) => T,
) {
	let value: T | undefined;
	let failure: unknown;
	try {
		value = await read();
	} catch (error) {
		failure = error;
	}
	const [row] = await db
		.select({ text: messages.text, status: runs.status })
		.from(messages)
		.innerJoin(runs, eq(runs.id, messages.runId))
		.where(and(eq(messages.id, messageId), shown(userId)));
	if (!row) return undefined;
	if (!isActiveRun(row.status)) return archived(row.text);
	if (!value)
		throw (
			failure ??
			new AppError(
				"Active conversation content unavailable",
				ErrorCode.Unavailable,
			)
		);
	return value;
}

// Plain substring matching, as memory search: the query splits on whitespace
// into keywords, and messages matching more keywords rank first. Results are
// grouped by conversation; the current one is included, since what has slid
// out of the model's context window is found here too.
export async function searchConversations(
	db: Database,
	userId: string,
	query: string,
	activeText?: ActiveTextSource,
): Promise<ConversationHit[]> {
	const terms = [...new Set(query.trim().split(/\s+/).filter(Boolean))].slice(
		0,
		10,
	);
	if (!terms.length) return [];
	const matches = terms.map(
		(term): SQL => sql`${messages.text} ilike ${containing(term)}`,
	);
	const score = sql.join(
		matches.map((match) => sql`(${match})::int`),
		sql` + `,
	);
	const rows = await db
		.select({
			id: messages.id,
			score: sql<number>`(${score})::int`,
			threadId: messages.threadId,
			title: threads.title,
			updatedAt: threads.updatedAt,
			role: messages.role,
			createdAt: messages.createdAt,
			text: messages.text,
		})
		.from(messages)
		.innerJoin(threads, eq(threads.id, messages.threadId))
		// By the user's conversations first: messages have no index by user.
		.where(and(eq(threads.userId, userId), shown(userId), or(...matches)))
		.orderBy(desc(score), desc(messages.id))
		.limit(matchedMessages);
	const active = await db
		.select({
			id: messages.id,
			runId: runs.id,
			threadId: messages.threadId,
			title: threads.title,
			updatedAt: threads.updatedAt,
			role: messages.role,
			createdAt: messages.createdAt,
		})
		.from(runs)
		.innerJoin(messages, eq(messages.runId, runs.id))
		.innerJoin(threads, eq(threads.id, runs.threadId))
		.where(
			and(
				eq(threads.userId, userId),
				unfinishedRun(runs.status),
				shown(userId),
			),
		);
	const candidates = rows.map((row) => ({
		...row,
		snippet: snippet(row.text, terms),
	}));
	// Only one bounded text result at a time, regardless of active run count.
	for (const row of active) {
		const result = await resolveActiveText(
			db,
			userId,
			row.id,
			() => activeTextSearch(row.runId, userId, terms, activeText),
			(text) => scanText([text], terms),
		);
		if (result?.score)
			candidates.push({
				...row,
				score: result.score,
				text: "",
				snippet: result.snippet,
			});
	}
	const unique = new Map(candidates.map((row) => [row.id, row]));
	const ranked = [...unique.values()]
		.sort((a, b) => b.score - a.score || b.id.localeCompare(a.id))
		.slice(0, matchedMessages);
	const hits = new Map<string, ConversationHit>();
	for (const row of ranked) {
		let hit = hits.get(row.threadId);
		if (!hit) {
			if (hits.size >= shownConversations) continue;
			hit = {
				id: row.threadId,
				title: row.title,
				updatedAt: row.updatedAt,
				snippets: [],
			};
			hits.set(row.threadId, hit);
		}
		if (hit.snippets.length < snippetsPerConversation)
			hit.snippets.push({
				role: row.role,
				createdAt: row.createdAt,
				text: row.snippet,
			});
	}
	return [...hits.values()];
}

interface Transcript {
	id: string;
	title: string;
	// Messages with text, numbered from 0 in the conversation.
	total: number;
	messages: {
		index: number;
		role: "user" | "assistant";
		createdAt: Date;
		// Its text from `start` to `end`, of `length` in all.
		text: string;
		start: number;
		end: number;
		length: number;
	}[];
	// Where to read on, when messages after these were left out.
	next?: number;
}

// One conversation's text from message `start` on, the first of them from
// character `offset`. Each message shows at most `readMessageChars`, so one
// long message does not crowd out the rest, and the whole at most
// `readTotalChars`; a message read on from an offset (a long final answer
// that has slid out of the window) may fill the whole read. The caller reads
// on from `next`, or a message on from where it was cut.
export async function readConversation(
	db: Database,
	userId: string,
	threadId: string,
	start = 0,
	offset = 0,
	activeText?: ActiveTextSource,
): Promise<Transcript> {
	const thread = await getThread(db, userId, threadId);
	const rows = await db
		.select({
			id: messages.id,
			runId: messages.runId,
			status: runs.status,
			role: messages.role,
			createdAt: messages.createdAt,
			text: messages.text,
		})
		.from(messages)
		.leftJoin(runs, eq(runs.id, messages.runId))
		.where(and(shown(userId), eq(messages.threadId, threadId)))
		.orderBy(asc(messages.id));
	const withText: ((typeof rows)[number] & {
		initial?: ReturnType<typeof sliceText>;
	})[] = [];
	for (const row of rows) {
		if (row.runId && row.status && isActiveRun(row.status)) {
			const initial = await resolveActiveText(
				db,
				userId,
				row.id,
				() =>
					activeTextRead(row.runId!, userId, 0, readMessageChars, activeText),
				(text) => sliceText([text], 0, readMessageChars),
			);
			if (initial?.nonEmpty) withText.push({ ...row, initial });
		} else if (row.text.trim()) withText.push(row);
	}
	const kept: Transcript["messages"] = [];
	const first = Math.min(Math.max(start, 0), withText.length);
	let total = 0;
	let index = first;
	for (; index < withText.length; index++) {
		const row = withText[index];
		const continued = index === first && offset > 0;
		const part = row.initial
			? continued
				? await resolveActiveText(
						db,
						userId,
						row.id,
						() =>
							activeTextRead(
								row.runId!,
								userId,
								offset,
								readTotalChars,
								activeText,
							),
						(text) => sliceText([text], offset, readTotalChars),
					)
				: row.initial
			: {
					...textWindow(
						row.text,
						continued ? offset : 0,
						continued ? readTotalChars : readMessageChars,
					),
					length: row.text.length,
				};
		if (!part) continue;
		const size = part.end - part.start;
		if (kept.length && total + size > readTotalChars) break;
		kept.push({
			index,
			role: row.role,
			createdAt: row.createdAt,
			text: part.text,
			start: part.start,
			end: part.end,
			length: part.length,
		});
		total += size;
	}
	return {
		id: thread.id,
		title: thread.title,
		total: withText.length,
		messages: kept,
		...(index < withText.length ? { next: index } : {}),
	};
}
