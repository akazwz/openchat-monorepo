import { type SQLWrapper, sql } from "drizzle-orm";
import {
	check,
	foreignKey,
	index,
	snakeCase,
	text,
	unique,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

import type { StoredMessagePart } from "@/modules/threads/storage";

import { createdAt, storedJson, timestamptz } from "./columns";
import { runs } from "./runs";
import { turns } from "./turns";

// A turn's input message. Written into the SQL rather than bound, so a query
// with it can use messages_turn_input_unique, whose predicate this is.
export const userMessage = (role: SQLWrapper) => sql`${role} = 'user'`;

export const messages = snakeCase.table(
	"messages",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => uuidv7()),
		userId: text().notNull(),
		threadId: text().notNull(),
		turnId: text().notNull(),
		runId: text(),
		role: text().$type<"user" | "assistant">().notNull(),
		parts: storedJson<StoredMessagePart[]>().notNull().default([]),
		// Its text parts joined (threads/history.ts messageText), which the
		// agent's conversation tools search and read: written with the parts
		// (a reply's at each of its run's boundaries), so a search reads one
		// column instead of unpacking every message's parts.
		text: text().notNull().default(""),
		createdAt: createdAt(),
		updatedAt: timestamptz().notNull().defaultNow(),
	},
	(t) => [
		unique("messages_run_unique").on(t.runId),
		// A query uses it only with the predicate written into its SQL
		// (userMessage), not bound as a parameter: see runs.ts unfinishedRun.
		uniqueIndex("messages_turn_input_unique")
			.on(t.turnId)
			.where(userMessage(t.role)),
		check(
			"messages_role_run_check",
			sql`(${t.role} = 'user' and ${t.runId} is null) or (${t.role} = 'assistant' and ${t.runId} is not null)`,
		),
		foreignKey({
			name: "messages_turn_owner_fk",
			columns: [t.turnId, t.threadId, t.userId],
			foreignColumns: [turns.id, turns.threadId, turns.userId],
		}).onDelete("cascade"),
		foreignKey({
			name: "messages_run_owner_fk",
			columns: [t.runId, t.turnId, t.threadId, t.userId],
			foreignColumns: [runs.id, runs.turnId, runs.threadId, runs.userId],
		}).onDelete("cascade"),
		index("messages_thread_id_idx").on(t.threadId, t.id),
		// Substring search (ILIKE '%keyword%') by trigrams (pg_trgm). A
		// keyword of fewer than three characters has no trigram and is checked
		// against the rows the rest of the query selects.
		index("messages_text_trgm_idx").using("gin", t.text.op("gin_trgm_ops")),
	],
);
export type MessageRecord = typeof messages.$inferSelect;
