import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { ConnectRouter } from "@connectrpc/connect";

import type { ScheduleUnit as Unit } from "@/db/schema/schedules";
import {
	ScheduleSchema,
	ScheduleService,
	ScheduleUnit,
} from "@/gen/heveta/v1/schedule_pb";
import { AppError, ErrorCode } from "@/lib/errors";
import { getAuthInfo } from "@/rpc/context";
import { getDB } from "@/rpc/database";

import { deleteSchedule, listSchedules, type Schedule } from "./service";

const units: Record<Unit, ScheduleUnit> = {
	minute: ScheduleUnit.MINUTE,
	hour: ScheduleUnit.HOUR,
	day: ScheduleUnit.DAY,
	week: ScheduleUnit.WEEK,
	month: ScheduleUnit.MONTH,
};
const scheduleResource = (schedule: Schedule) =>
	create(ScheduleSchema, {
		id: schedule.id,
		threadId: schedule.threadId,
		instructions: schedule.instructions,
		nextTime: timestampFromDate(schedule.nextAt),
		everyCount: schedule.every?.count ?? 0,
		everyUnit: schedule.every
			? units[schedule.every.unit]
			: ScheduleUnit.UNSPECIFIED,
		createTime: timestampFromDate(schedule.createdAt),
	});

export function registerSchedules(router: ConnectRouter) {
	router.service(ScheduleService, {
		async listSchedules(_req, ctx) {
			const schedules = await listSchedules(
				getDB(ctx),
				getAuthInfo(ctx).userId,
			);
			return { schedules: schedules.map(scheduleResource) };
		},
		async deleteSchedule(req, ctx) {
			try {
				await deleteSchedule(
					getDB(ctx),
					getAuthInfo(ctx).userId,
					req.scheduleId,
				);
			} catch (error) {
				if (!(error instanceof AppError && error.code === ErrorCode.NotFound))
					throw error;
			}
			return {};
		},
	});
}
