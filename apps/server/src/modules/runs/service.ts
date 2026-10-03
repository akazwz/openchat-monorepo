import type { Database } from "@/db/client";
import { errorDetails } from "@/lib/error-details";
import { AppError, ErrorCode } from "@/lib/errors";
import { announce, publish, userEvents } from "@/modules/events/publish";

import { cancelRunExecution } from "./delivery";
import { getRunSnapshot, requestCancelRun } from "./store";
import { isActiveRun, type RunLookup, type RunSnapshot } from "./types";

export async function cancelRun(
	db: Database,
	userId: string,
	lookup: RunLookup,
): Promise<RunSnapshot> {
	const run = await requestCancelRun(db, userId, lookup);
	// The running execution stops when its actor is told. Each commit of the
	// run reads the stop too, but a long command commits nothing until it
	// ends: a stop the actor did not hear fails, and asking again tells it.
	if (isActiveRun(run.status)) {
		try {
			await cancelRunExecution(run.id);
		} catch (error) {
			console.warn("[Run] Stop committed; its actor was not told", {
				runId: run.id,
				...errorDetails(error),
			});
			throw new AppError("Unable to stop the reply", ErrorCode.Unavailable);
		}
	}
	const snapshot = await getRunSnapshot(db, userId, run.id);
	await announce(userId, [userEvents.runSnapshot(snapshot)]);
	return snapshot;
}

// A run's final state must reach every device, or they keep showing it as
// running. Unlike other events this throws when the hub cannot be reached, so
// the run's actor keeps its wakeup and publishes again (see RunActor).
export async function publishRunState(
	db: Database,
	run: { id: string; userId: string },
) {
	const snapshot = await getRunSnapshot(db, run.userId, run.id);
	await publish(run.userId, [userEvents.runSnapshot(snapshot)]);
}
