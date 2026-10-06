import {
	foreignKey,
	index,
	integer,
	snakeCase,
	text,
} from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

import { createdAt, timestamptz } from "./columns";
import { threads } from "./threads";

export type ScheduleUnit = "minute" | "hour" | "day" | "week" | "month";

// A wake-up of the agent (docs/agent-form.md): at `nextAt` it is given
// `instructions` as a turn of the schedule's own conversation, without anyone
// writing to it. One that repeats moves on from its due time; one that does
// not is removed once it has run. Its conversation's deletion removes it.
export const schedules = snakeCase.table(
	"schedules",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => uuidv7()),
		userId: text().notNull(),
		threadId: text().notNull(),
		instructions: text().notNull(),
		nextAt: timestamptz().notNull(),
		// Both null: once.
		everyCount: integer(),
		everyUnit: text().$type<ScheduleUnit>(),
		createdAt: createdAt(),
	},
	(t) => [
		foreignKey({
			name: "schedules_thread_owner_fk",
			columns: [t.threadId, t.userId],
			foreignColumns: [threads.id, threads.userId],
		}).onDelete("cascade"),
		index("schedules_user_next_idx").on(t.userId, t.nextAt),
	],
);
export type ScheduleRecord = typeof schedules.$inferSelect;
