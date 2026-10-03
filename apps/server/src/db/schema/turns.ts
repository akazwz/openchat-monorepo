import {
	foreignKey,
	index,
	snakeCase,
	text,
	unique,
} from "drizzle-orm/pg-core";

import { timestamptz } from "./columns";
import { threads } from "./threads";

// One user input and its execution attempts: its input is the message with
// its turn_id and role "user", its attempts the runs with its turn_id, and the
// latest attempt the one shown.
export const turns = snakeCase.table(
	"turns",
	{
		id: text().primaryKey(),
		threadId: text().notNull(),
		userId: text().notNull(),
		createdAt: timestamptz().notNull(),
	},
	(t) => [
		unique("turns_id_thread_user_unique").on(t.id, t.threadId, t.userId),
		foreignKey({
			name: "turns_thread_owner_fk",
			columns: [t.threadId, t.userId],
			foreignColumns: [threads.id, threads.userId],
		}).onDelete("cascade"),
		index("turns_thread_id_idx").on(t.threadId, t.id),
	],
);
export type TurnRecord = typeof turns.$inferSelect;
