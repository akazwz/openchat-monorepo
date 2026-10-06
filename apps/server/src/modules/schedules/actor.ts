import { DurableObject } from "cloudflare:workers";

import { createDatabase } from "@/db/client";
import { errorDetails } from "@/lib/error-details";

import { fireSchedule } from "./service";

const idKey = "schedule-id";
const retryMs = 60_000;

// One Durable Object per schedule: its alarm is the schedule's due time, so
// nothing scans for due schedules. When it rings, the schedule is given its
// turn and the alarm moves to the next occurrence; a schedule that is gone
// (run once, deleted, its conversation deleted) retires the object.
export class ScheduleActor extends DurableObject<Env> {
	async arm(id: string, at: number): Promise<void> {
		if (!this.ctx.id.equals(this.ctx.exports.ScheduleActor.idFromName(id)))
			throw new Error("Schedule actor identity mismatch");
		await this.ctx.storage.put(idKey, id);
		await this.ctx.storage.setAlarm(at);
	}
	async disarm(): Promise<void> {
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
	}
	override async alarm(): Promise<void> {
		const id = await this.ctx.storage.get<string>(idKey);
		if (!id) return;
		const database = createDatabase();
		try {
			const next = await fireSchedule(database.db, id, new Date(), (work) =>
				this.ctx.waitUntil(work),
			);
			if (next) await this.ctx.storage.setAlarm(next.getTime());
			else await this.disarm();
		} catch (error) {
			// A passing failure (the database): the wake-up stays due, and is
			// given again under the same request, so it never runs twice.
			console.warn("[Schedule] Wake-up deferred", {
				scheduleId: id,
				...errorDetails(error),
			});
			await this.ctx.storage.setAlarm(Date.now() + retryMs);
		} finally {
			await database.close();
		}
	}
}
