import { isCurrentSession } from "~/features/auth/store";
import type { SessionOwner } from "~/features/auth/types";
import { applyRunChangeToList } from "~/features/threads/queries";
import type { RunEvent } from "~/gen/heveta/v1/run_pb";

import { getRun } from "./run-api";
import { type RunSnapshot, readSnapshot } from "./run-state";

// Applies the runs' events from the event channel to the conversations they
// belong to (docs/sync.md). A run's events apply one at a time, in the order
// they arrive. A snapshot shows the run; a change applies to its reply in its
// conversation's list, and one that does not follow it (a missed revision, a
// run first seen mid-way) is repaired from committed state with GetRun, as is
// one whose run a send is waiting for. A conversation nobody has loaded takes
// nothing: it is read when opened.
export function createRunSync(handlers: {
	// A run's committed state: shown, and confirming the send that started it.
	snapshot(owner: SessionOwner, snapshot: RunSnapshot): void;
	// Whether a send of this session is waiting for the run of this request.
	awaited(owner: SessionOwner, requestId: string): boolean;
}) {
	const queues = new Map<string, Promise<void>>();
	const apply = async (owner: SessionOwner, envelope: RunEvent) => {
		if (!isCurrentSession(owner)) return;
		const event = envelope.event;
		if (event.case === "snapshot") {
			handlers.snapshot(owner, readSnapshot(event.value));
			return;
		}
		if (event.case !== "change") return;
		const change = event.value;
		const applied = applyRunChangeToList(owner.userId, change);
		if (
			applied === "snapshot" ||
			(applied === "unloaded" &&
				handlers.awaited(owner, change.run?.requestId ?? ""))
		) {
			const snapshot = await getRun(envelope.runId);
			if (isCurrentSession(owner)) handlers.snapshot(owner, snapshot);
		}
	};
	return (owner: SessionOwner, event: RunEvent) => {
		const queued = (queues.get(event.runId) ?? Promise.resolve())
			.then(() => apply(owner, event))
			.catch(() => {
				// A failed repair leaves the run as it was; the next event or the
				// channel's reconnect reads it again.
			});
		queues.set(event.runId, queued);
		void queued.finally(() => {
			if (queues.get(event.runId) === queued) queues.delete(event.runId);
		});
	};
}
