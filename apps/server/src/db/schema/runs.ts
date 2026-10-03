import { type SQLWrapper, sql } from "drizzle-orm";
import {
	boolean,
	check,
	foreignKey,
	integer,
	snakeCase,
	text,
	unique,
	uniqueIndex,
} from "drizzle-orm/pg-core";

import type { ReasoningEffort } from "@/config";
import type { RunStatus } from "@/modules/runs/types";

import { timestamptz } from "./columns";
import { devices } from "./devices";
import { turns } from "./turns";

// A run not finished yet: queued (1) or running (2), RunStatus in
// modules/runs/types. The statuses are written into the SQL, not bound as
// parameters, so a query with it can use runs_active_thread_idx, whose
// predicate this is: a generic plan (a cached prepared statement) cannot prove
// a partial index's predicate from parameters, and scanned every run instead.
export const unfinishedRun = (status: SQLWrapper) => sql`${status} in (1, 2)`;

export const runs = snakeCase.table(
	"runs",
	{
		id: text().primaryKey(),
		threadId: text().notNull(),
		userId: text().notNull(),
		requestId: text().notNull(),
		requestHash: text().notNull(),
		deviceId: text().references(() => devices.id),
		turnId: text().notNull(),
		// Within its turn, from one; the latest is the one shown. Its output is
		// the message with its run_id.
		attempt: integer().notNull(),
		model: text().notNull(),
		// Null for a model whose reasoning cannot be adjusted.
		reasoningEffort: text().$type<ReasoningEffort>(),
		status: integer().$type<RunStatus>().notNull(),
		revision: integer().notNull().default(1),
		// Why a failed run failed, for the logs; people see only that it did.
		error: text().notNull().default(""),
		cancelRequested: boolean().notNull().default(false),
		createdAt: timestamptz().notNull(),
		startedAt: timestamptz(),
		finishedAt: timestamptz(),
	},
	(t) => [
		unique("runs_id_turn_thread_user_unique").on(
			t.id,
			t.turnId,
			t.threadId,
			t.userId,
		),
		unique("runs_turn_attempt_unique").on(t.turnId, t.attempt),
		check("runs_attempt_positive", sql`${t.attempt} > 0`),
		foreignKey({
			name: "runs_turn_owner_fk",
			columns: [t.turnId, t.threadId, t.userId],
			foreignColumns: [turns.id, turns.threadId, turns.userId],
		}).onDelete("cascade"),
		uniqueIndex("runs_user_request_idx").on(t.userId, t.requestId),
		uniqueIndex("runs_active_thread_idx")
			.on(t.threadId)
			.where(unfinishedRun(t.status)),
	],
);
export type RunRecord = typeof runs.$inferSelect;
