import type { Database } from "@/db/client";
import type { ScheduleUnit } from "@/db/schema/schedules";
import { AppError, ErrorCode } from "@/lib/errors";
import type { LocalTool } from "@/runtime/tools";

import {
	createSchedule,
	deleteSchedule,
	listSchedules,
	type Schedule,
	scheduleUnits,
} from "./service";

const text = (value: unknown) => (typeof value === "string" ? value : "");
const integer = (value: unknown) =>
	typeof value === "number" && Number.isInteger(value) ? value : 0;
// To the minute, in UTC, as the model is told the date.
const when = (at: Date) =>
	`${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
const line = (schedule: Schedule) =>
	`[${schedule.id}] next ${when(schedule.nextAt)}, ${
		schedule.every
			? `every ${schedule.every.count} ${schedule.every.unit}${schedule.every.count > 1 ? "s" : ""}`
			: "once"
	}: ${schedule.instructions}`;

// How the agent works when nobody is writing to it (docs/agent-form.md): it
// sets itself a time to be woken with instructions, once or repeatedly. Each
// schedule has its own conversation, where its wake-ups run and the person
// reads what they did.
export function scheduleTools(db: Database, userId: string): LocalTool[] {
	return [
		{
			name: "schedule_create",
			description:
				"Schedule yourself to do something later, once or repeatedly: at that time you are woken in a conversation of the schedule's own, with your instructions as the message, and nobody there to ask. Use it when the user asks for something at a later time or regularly (a reminder, a daily summary, checking again in two hours). Write the instructions for your later self, complete in themselves: what to do, for whom, and how to report. The time is either delay_minutes from now or at (ISO 8601, UTC); ask the user's time zone if a clock time matters and you do not know it. Repeats count from the first run, in UTC, at most every 15 minutes.",
			parameters: {
				type: "object",
				properties: {
					instructions: {
						type: "string",
						description: "What to do when woken, complete in itself.",
					},
					delay_minutes: {
						type: "integer",
						description:
							"Minutes from now until the first run; 0 when `at` gives the time.",
					},
					at: {
						type: "string",
						description:
							"The first run as ISO 8601 in UTC (2026-10-04T08:00:00Z); empty when delay_minutes gives it.",
					},
					repeat_count: {
						type: "integer",
						description: "Repeat every this many units; 0 to run once.",
					},
					repeat_unit: {
						type: "string",
						enum: ["", ...scheduleUnits],
						description: "The unit of the repeat; empty to run once.",
					},
				},
				required: [
					"instructions",
					"delay_minutes",
					"at",
					"repeat_count",
					"repeat_unit",
				],
				additionalProperties: false,
			},
			readOnly: false,
			concurrent: false,
			execute: async (args) => {
				const now = new Date();
				const delay = integer(args.delay_minutes);
				const at = text(args.at).trim();
				if (Boolean(at) === delay > 0)
					throw new AppError(
						"Give either delay_minutes or at, not both",
						ErrorCode.InvalidArgument,
					);
				const firstAt = at
					? new Date(at)
					: new Date(now.getTime() + delay * 60_000);
				const count = integer(args.repeat_count);
				const unit = text(args.repeat_unit) as ScheduleUnit | "";
				if (Boolean(unit) !== count > 0)
					throw new AppError(
						"A repeat needs both repeat_count and repeat_unit",
						ErrorCode.InvalidArgument,
					);
				const schedule = await createSchedule(
					db,
					userId,
					{
						instructions: text(args.instructions),
						firstAt,
						...(unit ? { every: { count, unit } } : {}),
					},
					now,
				);
				return { output: `Scheduled. ${line(schedule)}` };
			},
		},
		{
			name: "schedule_list",
			description:
				"List your schedules: when each runs next, how it repeats, and its instructions.",
			parameters: {
				type: "object",
				properties: {},
				required: [],
				additionalProperties: false,
			},
			readOnly: true,
			concurrent: true,
			execute: async () => {
				const found = await listSchedules(db, userId);
				return {
					output: found.length
						? `Now: ${when(new Date())}\n${found.map(line).join("\n")}`
						: "No schedules.",
				};
			},
		},
		{
			name: "schedule_delete",
			description:
				"Delete one of your schedules by its id (from schedule_list), when the user no longer wants it. Its conversation stays.",
			parameters: {
				type: "object",
				properties: {
					id: { type: "string", description: "The schedule's id." },
				},
				required: ["id"],
				additionalProperties: false,
			},
			readOnly: false,
			concurrent: false,
			execute: async (args) => {
				await deleteSchedule(db, userId, text(args.id));
				return { output: "Deleted." };
			},
		},
	];
}
