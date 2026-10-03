import { and, desc, eq, or, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { type MemoryRecord, memories } from "@/db/schema/memories";
import { AppError, ErrorCode } from "@/lib/errors";
import { containing } from "@/lib/sql";
import { announce, userEvents } from "@/modules/events/publish";

// Entries are short: the newest go into the model's instructions on each run
// (see tools.ts), and the model searches for the rest.
const maxContentChars = 500;
const searchLimit = 20;

export interface Memory {
	id: string;
	content: string;
	createdAt: Date;
	updatedAt: Date;
}
const memoryFromRow = ({
	id,
	content,
	createdAt,
	updatedAt,
}: MemoryRecord): Memory => ({ id, content, createdAt, updatedAt });

const chars = (text: string) => Array.from(text).length;

function contentValue(input: string) {
	const content = input.trim();
	if (!content || chars(content) > maxContentChars)
		throw new AppError(
			`A memory must be 1–${maxContentChars} characters.`,
			ErrorCode.InvalidArgument,
		);
	return content;
}
const owned = (userId: string, id: string) =>
	and(eq(memories.userId, userId), eq(memories.id, id));

export async function addMemory(db: Database, userId: string, input: string) {
	const content = contentValue(input);
	const [row] = await db
		.insert(memories)
		.values({ userId, content })
		.returning();
	await announce(userId, [userEvents.memory()]);
	return memoryFromRow(row);
}

export async function updateMemory(
	db: Database,
	userId: string,
	id: string,
	input: string,
) {
	const content = contentValue(input);
	const [row] = await db
		.update(memories)
		.set({ content })
		.where(owned(userId, id))
		.returning();
	if (!row) throw new AppError("Memory not found.", ErrorCode.NotFound);
	await announce(userId, [userEvents.memory()]);
	return memoryFromRow(row);
}

// Newest change first; everything when no limit is given.
export async function listMemories(
	db: Database,
	userId: string,
	limit?: number,
) {
	const query = db
		.select()
		.from(memories)
		.where(eq(memories.userId, userId))
		.orderBy(desc(memories.updatedAt), desc(memories.id));
	const rows = await (limit === undefined ? query : query.limit(limit));
	return rows.map(memoryFromRow);
}

// The most recently updated entries, and how many there are in all, in one
// query: a run reads them before its first model request.
export async function newestMemories(
	db: Database,
	userId: string,
	limit: number,
) {
	const rows = await db
		.select({
			memory: memories,
			total: sql<number>`count(*) over ()`.mapWith(Number),
		})
		.from(memories)
		.where(eq(memories.userId, userId))
		.orderBy(desc(memories.updatedAt), desc(memories.id))
		.limit(limit);
	return {
		entries: rows.map((row) => memoryFromRow(row.memory)),
		total: rows[0]?.total ?? 0,
	};
}

export async function deleteAllMemories(db: Database, userId: string) {
	await db.delete(memories).where(eq(memories.userId, userId));
	await announce(userId, [userEvents.memory()]);
}

export async function deleteMemory(db: Database, userId: string, id: string) {
	const [row] = await db
		.delete(memories)
		.where(owned(userId, id))
		.returning({ id: memories.id });
	if (!row) throw new AppError("Memory not found.", ErrorCode.NotFound);
	await announce(userId, [userEvents.memory()]);
}

// Plain substring matching, no embeddings: the query splits on whitespace into
// keywords (PostgreSQL full-text search does not segment Chinese). Entries
// matching more keywords come first.
export async function searchMemories(
	db: Database,
	userId: string,
	query: string,
) {
	const terms = [...new Set(query.trim().split(/\s+/).filter(Boolean))].slice(
		0,
		10,
	);
	if (!terms.length) return [];
	const matches = terms.map(
		(term) => sql`${memories.content} ilike ${containing(term)}`,
	);
	const score = sql.join(
		matches.map((match) => sql`(${match})::int`),
		sql` + `,
	);
	const rows = await db
		.select()
		.from(memories)
		.where(and(eq(memories.userId, userId), or(...matches)))
		.orderBy(desc(score), desc(memories.updatedAt))
		.limit(searchLimit);
	return rows.map(memoryFromRow);
}
