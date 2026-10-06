import { and, asc, count, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
	type ScheduleRecord,
	schedules,
	type ScheduleUnit,
} from "@/db/schema/schedules";
import { threads } from "@/db/schema/threads";
import { ErrorReason } from "@/gen/heveta/v1/error_pb";
import { AppError, ErrorCode } from "@/lib/errors";
import { announce, userEvents } from "@/modules/events/publish";
import { getThread, threadTitle } from "@/modules/threads/service";
import { submitTurn } from "@/modules/turns/service";

import { armSchedule, disarmSchedule } from "./delivery";

export interface Repeat {
	count: number;
	unit: ScheduleUnit;
}
export interface Schedule {
	id: string;
	threadId: string;
	instructions: string;
	nextAt: Date;
	every?: Repeat;
	createdAt: Date;
}
export const scheduleUnits: readonly ScheduleUnit[] = [
	"minute",
	"hour",
	"day",
	"week",
	"month",
];

const maxSchedules = 20;
const maxInstructionChars = 4_000;
// Each wake-up is a run of the model: one that repeats faster would be a
// loop, not a schedule.
const minRepeatMs = 15 * 60_000;
const maxAheadMs = 366 * 24 * 60 * 60_000;
// A wake-up whose conversation is still answering its last turn waits.
const busyRetryMs = 2 * 60_000;
const unitMs: Record<Exclude<ScheduleUnit, "month">, number> = {
	minute: 60_000,
	hour: 60 * 60_000,
	day: 24 * 60 * 60_000,
	week: 7 * 24 * 60 * 60_000,
};

const fromRow = (row: ScheduleRecord): Schedule => ({
	id: row.id,
	threadId: row.threadId,
	instructions: row.instructions,
	nextAt: row.nextAt,
	...(row.everyCount && row.everyUnit
		? { every: { count: row.everyCount, unit: row.everyUnit } }
		: {}),
	createdAt: row.createdAt,
});

// The occurrence after `from`, in UTC: a month later is the same day of the
// next month (or its last day, for a day that month does not have).
function step(from: Date, every: Repeat) {
	if (every.unit !== "month")
		return new Date(from.getTime() + every.count * unitMs[every.unit]);
	const next = new Date(from);
	next.setUTCDate(1);
	next.setUTCMonth(next.getUTCMonth() + every.count);
	const days = new Date(
		Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
	).getUTCDate();
	next.setUTCDate(Math.min(from.getUTCDate(), days));
	return next;
}
// The first occurrence after `now`, counted from the one that was due at
// `due`: occurrences missed meanwhile (a long outage) are not made up.
export function nextOccurrence(due: Date, every: Repeat, now: Date) {
	let next = step(due, every);
	while (next <= now) next = step(next, every);
	return next;
}

function validRepeat(every: Repeat | undefined) {
	if (!every) return;
	if (
		!Number.isInteger(every.count) ||
		every.count < 1 ||
		!scheduleUnits.includes(every.unit)
	)
		throw new AppError("The repeat is not valid", ErrorCode.InvalidArgument);
	const from = new Date(0);
	if (step(from, every).getTime() - from.getTime() < minRepeatMs)
		throw new AppError(
			"A schedule repeats every 15 minutes at the most",
			ErrorCode.InvalidArgument,
		);
}

// A schedule and the conversation its wake-ups run in, named for what it
// does. Its alarm is set once it is committed; a lost alarm would leave a
// schedule that never runs, so the schedule is withdrawn when arming fails.
export async function createSchedule(
	db: Database,
	userId: string,
	input: { instructions: string; firstAt: Date; every?: Repeat },
	now = new Date(),
): Promise<Schedule> {
	const instructions = input.instructions.trim();
	if (!instructions || instructions.length > maxInstructionChars)
		throw new AppError(
			`Instructions are required, up to ${maxInstructionChars} characters`,
			ErrorCode.InvalidArgument,
		);
	const ahead = input.firstAt.getTime() - now.getTime();
	if (!Number.isFinite(ahead) || ahead <= 0 || ahead > maxAheadMs)
		throw new AppError(
			"The first run must be in the future, within a year",
			ErrorCode.InvalidArgument,
		);
	validRepeat(input.every);
	const row = await db.transaction(async (tx) => {
		const [{ total }] = await tx
			.select({ total: count() })
			.from(schedules)
			.where(eq(schedules.userId, userId));
		if (total >= maxSchedules)
			throw new AppError(
				`There are already ${maxSchedules} schedules; delete one first`,
				ErrorCode.ResourceExhausted,
			);
		const [thread] = await tx
			.insert(threads)
			.values({ userId, title: threadTitle(instructions) })
			.returning({ id: threads.id });
		const [created] = await tx
			.insert(schedules)
			.values({
				userId,
				threadId: thread.id,
				instructions,
				nextAt: input.firstAt,
				everyCount: input.every?.count ?? null,
				everyUnit: input.every?.unit ?? null,
			})
			.returning();
		return created;
	});
	try {
		await armSchedule(row.id, row.nextAt);
	} catch (error) {
		await db.delete(threads).where(eq(threads.id, row.threadId));
		throw error;
	}
	await announce(userId, [
		userEvents.thread(await getThread(db, userId, row.threadId)),
	]);
	return fromRow(row);
}

export async function listSchedules(db: Database, userId: string) {
	const rows = await db
		.select()
		.from(schedules)
		.where(eq(schedules.userId, userId))
		.orderBy(asc(schedules.nextAt), asc(schedules.id));
	return rows.map(fromRow);
}

// The schedule stops; its conversation, with what its wake-ups did, stays.
export async function deleteSchedule(db: Database, userId: string, id: string) {
	const [row] = await db
		.delete(schedules)
		.where(and(eq(schedules.id, id), eq(schedules.userId, userId)))
		.returning({ id: schedules.id });
	if (!row) throw new AppError("Schedule not found", ErrorCode.NotFound);
	// An alarm left behind finds no schedule and retires itself.
	await disarmSchedule(id).catch(() => {});
}

// The schedule's alarm rang (ScheduleActor): its instructions are given as a
// turn of its conversation, marked as scheduled, and the schedule moves on.
// Answers when to ring next; nothing when the schedule is over. The turn's
// request is named by the occurrence, so one given twice (the alarm retried
// after a failure) is one turn.
export async function fireSchedule(
	db: Database,
	id: string,
	now: Date,
	afterResponse: (work: Promise<unknown>) => void,
): Promise<Date | undefined> {
	const [row] = await db.select().from(schedules).where(eq(schedules.id, id));
	if (!row) return undefined;
	// Woken early (an alarm armed again): not due yet.
	if (row.nextAt > now) return row.nextAt;
	try {
		await submitTurn(
			db,
			{
				requestId: `wake-${row.id}-${row.nextAt.getTime()}`,
				modelId: "",
				input: {
					case: "newTurn",
					value: {
						threadId: row.threadId,
						text: row.instructions,
						fileIds: [],
						scheduled: true,
					},
				},
			},
			{
				userId: row.userId,
				signal: AbortSignal.timeout(60_000),
				afterResponse,
			},
		);
	} catch (error) {
		// Its last turn is still being answered: this one waits for it.
		if (error instanceof AppError && error.reason === ErrorReason.RUN_ACTIVE)
			return new Date(now.getTime() + busyRetryMs);
		throw error;
	}
	const schedule = fromRow(row);
	if (!schedule.every) {
		await db.delete(schedules).where(eq(schedules.id, id));
		return undefined;
	}
	const next = nextOccurrence(row.nextAt, schedule.every, now);
	await db.update(schedules).set({ nextAt: next }).where(eq(schedules.id, id));
	return next;
}
