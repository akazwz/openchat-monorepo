import { sql } from "drizzle-orm";
import { check, integer, snakeCase, text, unique } from "drizzle-orm/pg-core";

import type { StepKind, StepStatus } from "@/modules/steps/types";

import { timestamptz } from "./columns";
import { runs } from "./runs";

export const steps = snakeCase.table(
	"steps",
	{
		id: text().primaryKey(),
		runId: text()
			.notNull()
			.references(() => runs.id, { onDelete: "cascade" }),
		index: integer().notNull(),
		kind: integer().$type<StepKind>().notNull(),
		status: integer().$type<StepStatus>().notNull(),
		toolName: text().notNull().default(""),
		responseId: text().notNull().default(""),
		inputTokens: integer(),
		outputTokens: integer(),
		error: text().notNull().default(""),
		createdAt: timestamptz().notNull().defaultNow(),
		startedAt: timestamptz(),
		finishedAt: timestamptz(),
	},
	(t) => [
		unique("steps_run_index_unique").on(t.runId, t.index),
		check("steps_index_positive", sql`${t.index} > 0`),
		check(
			"steps_kind_valid",
			sql`(${t.kind} = 1 and ${t.toolName} = '') or (${t.kind} = 2 and ${t.toolName} <> '')`,
		),
		check(
			"steps_status_valid",
			sql`${t.status} between 1 and 5 or ${t.status} = 7`,
		),
		check(
			"steps_lifecycle_check",
			sql`(${t.status} in (1, 7) and ${t.finishedAt} is null) or (${t.status} not in (1, 7) and ${t.finishedAt} is not null)`,
		),
		check(
			"steps_pending_not_started",
			sql`${t.status} <> 7 or ${t.startedAt} is null`,
		),
		check(
			"steps_usage_nonnegative",
			sql`(${t.inputTokens} is null or ${t.inputTokens} >= 0) and (${t.outputTokens} is null or ${t.outputTokens} >= 0)`,
		),
	],
);
export type StepRecord = typeof steps.$inferSelect;
