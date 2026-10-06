import { exports } from "cloudflare:workers";

import { objectLocation } from "@/lib/location";

const actor = (id: string) =>
	exports.ScheduleActor.getByName(id, objectLocation);

// The schedule's own alarm: it wakes at `at` and from then on keeps its own
// time (ScheduleActor).
export async function armSchedule(id: string, at: Date) {
	await actor(id).arm(id, at.getTime());
}
export async function disarmSchedule(id: string) {
	await actor(id).disarm();
}
