import { sql } from "drizzle-orm";
import {
	check,
	foreignKey,
	integer,
	primaryKey,
	snakeCase,
	text,
	unique,
} from "drizzle-orm/pg-core";

import type { StoredMessagePart } from "@/modules/threads/storage";

import { storedJson } from "./columns";
import { messages } from "./messages";
import { runs } from "./runs";

export const messageParts = snakeCase.table(
	"message_parts",
	{
		messageId: text()
			.notNull()
			.references(() => messages.id, { onDelete: "cascade" }),
		id: text().notNull(),
		ordinal: integer().notNull(),
		meta: storedJson<StoredMessagePart>().notNull(),
		chunks: integer().notNull(),
		chars: integer().notNull(),
		modelChars: integer().notNull(),
		stepIndex: integer(),
	},
	(t) => [
		primaryKey({ columns: [t.messageId, t.id] }),
		unique("message_parts_ordinal_unique").on(t.messageId, t.ordinal),
		check(
			"message_parts_position_check",
			sql`${t.ordinal} >= 0 and ${t.chunks} >= 0 and ${t.chars} >= 0 and ${t.modelChars} >= 0`,
		),
	],
);

export const messagePartChunks = snakeCase.table(
	"message_part_chunks",
	{
		messageId: text().notNull(),
		partId: text().notNull(),
		index: integer().notNull(),
		data: text().notNull(),
	},
	(t) => [
		primaryKey({ columns: [t.messageId, t.partId, t.index] }),
		foreignKey({
			columns: [t.messageId, t.partId],
			foreignColumns: [messageParts.messageId, messageParts.id],
		}).onDelete("cascade"),
		check("message_part_chunks_index_check", sql`${t.index} >= 0`),
	],
);

// Pages are staged while the run is active. The final Run transaction is the
// sole switch to historical reads. A page hash rejects conflicting replays.
export const runArchives = snakeCase.table("run_archives", {
	runId: text()
		.primaryKey()
		.references(() => runs.id, { onDelete: "cascade" }),
	sealId: text().notNull(),
	pages: integer().notNull().default(0),
	records: integer().notNull().default(0),
	digest: text().notNull().default(""),
});
export const runArchivePages = snakeCase.table(
	"run_archive_pages",
	{
		runId: text()
			.notNull()
			.references(() => runArchives.runId, { onDelete: "cascade" }),
		index: integer().notNull(),
		digest: text().notNull(),
	},
	(t) => [primaryKey({ columns: [t.runId, t.index] })],
);
