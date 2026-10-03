import { create, toBinary } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { exports } from "cloudflare:workers";

import {
	ComputerChangedSchema,
	DevicesChangedSchema,
	MailChangedSchema,
	MemoryChangedSchema,
	type UserEvent,
	UserEventSchema,
} from "@/gen/heveta/v1/event_pb";
import { errorDetails } from "@/lib/error-details";
import { objectLocation } from "@/lib/location";
import { userResource } from "@/modules/auth/rpc-codec";
import { runEventResource } from "@/modules/runs/rpc-codec";
import type { RunEvent, RunSnapshot } from "@/modules/runs/types";
import { threadResource } from "@/modules/threads/rpc-codec";
import type { Thread } from "@/modules/threads/types";

// The user's hub (hub.ts).
export const userHub = (userId: string) =>
	exports.UserHub.getByName(userId, objectLocation);

type UserRecord = Parameters<typeof userResource>[0];

// Changes reach every device of their user after they commit (docs/sync.md).
// PostgreSQL stays the source of truth: an event only tells devices what to
// show now, and a device that missed one reads the state again over RPC.
export const userEvents = {
	devices: () =>
		create(UserEventSchema, {
			event: { case: "devices", value: create(DevicesChangedSchema) },
		}),
	run: (event: RunEvent) =>
		create(UserEventSchema, {
			event: { case: "run", value: runEventResource(event) },
		}),
	runSnapshot: (snapshot: RunSnapshot) =>
		userEvents.run({
			type: "snapshot",
			runId: snapshot.run.id,
			snapshot,
		}),
	thread: (thread: Thread) =>
		create(UserEventSchema, {
			event: { case: "thread", value: threadResource(thread) },
		}),
	// A conversation's new turn moves it up, to this time.
	threadActivity: (threadId: string, activeAt: Date) =>
		create(UserEventSchema, {
			event: {
				case: "threadActivity",
				value: { threadId, activeTime: timestampFromDate(activeAt) },
			},
		}),
	threadDeleted: (threadId: string) =>
		create(UserEventSchema, {
			event: { case: "threadDeleted", value: threadId },
		}),
	memory: () =>
		create(UserEventSchema, {
			event: { case: "memory", value: create(MemoryChangedSchema) },
		}),
	computer: () =>
		create(UserEventSchema, {
			event: { case: "computer", value: create(ComputerChangedSchema) },
		}),
	mail: () =>
		create(UserEventSchema, {
			event: { case: "mail", value: create(MailChangedSchema) },
		}),
	user: (user: UserRecord) =>
		create(UserEventSchema, {
			event: { case: "user", value: userResource(user) },
		}),
};

// Sends each batch in order. Independent publishers can arrive out of commit
// order: resource revisions and deletion semantics decide what wins. Throws
// when the hub cannot be reached; run final-state delivery retries.
export async function publish(userId: string, events: UserEvent[]) {
	if (!events.length) return;
	await userHub(userId).publish(
		events.map((event) => toBinary(UserEventSchema, event)),
	);
}

// For changes a later event or a device's next read repairs: a failure is
// logged, never surfaced to the command that made the change.
export async function announce(userId: string, events: UserEvent[]) {
	try {
		await publish(userId, events);
	} catch (error) {
		console.warn("[Events] Publish failed", errorDetails(error));
	}
}

// Closes the event channels of a revoked or expired session.
export async function closeChannels(userId: string, sessionId: string) {
	// The caller retains the revoked session until this succeeds.
	await userHub(userId).closeSession(sessionId);
}
