import { v7 as uuidv7 } from "uuid";

import type { Database } from "@/db/client";
import { errorDetails } from "@/lib/error-details";
import { AppError, ErrorCode } from "@/lib/errors";
import { announce, userEvents } from "@/modules/events/publish";
import { armRun, dispatchRun } from "@/modules/runs/delivery";
import { getRunSnapshot, prepareRun } from "@/modules/runs/store";
import {
	isActiveRun,
	type RunContext,
	type RunInput,
	type RunSnapshot,
} from "@/modules/runs/types";
import type { Thread } from "@/modules/threads/types";

// Command acceptance owns the turn and attempt in one transaction. Once accepted,
// the request connection cannot revoke the command. The attempt's actor is
// armed before the commit, so an accepted attempt runs even if the dispatch
// after the commit is lost; if arming fails, nothing is accepted. Arming (a
// new Durable Object) and the transaction run at once: neither waits for the
// other to start.
export async function submitTurn(
	db: Database,
	input: RunInput,
	context: RunContext,
): Promise<{ snapshot: RunSnapshot; thread?: Thread }> {
	const runId = uuidv7();
	const armedAt = Date.now();
	const ready = armRun(runId).catch((error: unknown) => {
		console.warn("[Turn] Run actor not armed", errorDetails(error));
		throw new AppError("Unable to start the reply", ErrorCode.Unavailable);
	});
	// Awaited by the transaction, unless it fails before: then arming's own
	// failure has nothing left to stop.
	ready.catch(() => {});
	const {
		run,
		replay,
		thread,
		snapshot: acceptedSnapshot,
	} = await prepareRun(
		db,
		context.userId,
		input,
		{ id: runId, armedAt, ready },
		context.signal,
	);
	const snapshot = replay
		? await getRunSnapshot(db, context.userId, run.id)
		: acceptedSnapshot;
	// The answer is the accepted attempt; telling the other devices and
	// starting the actor follow it, in this order, rather than hold it: a
	// failed publish is only logged, and an undelivered start is covered by
	// the armed actor.
	context.afterResponse(
		(async () => {
			// A replayed request changed nothing; an accepted one shows up on the
			// user's other devices: a new conversation, or an existing one moved
			// up by its new turn, and the new attempt. An existing conversation's
			// record is not announced, only its new time: a copy read in this
			// transaction could arrive after a rename that waited for it, and
			// undo it on screen. Published before delivery, so the attempt's
			// snapshot precedes its first change.
			if (!replay)
				await announce(context.userId, [
					thread
						? userEvents.thread(thread)
						: userEvents.threadActivity(run.threadId, run.createdAt),
					userEvents.runSnapshot(snapshot),
				]);
			if (isActiveRun(run.status)) {
				try {
					await dispatchRun(run.id);
				} catch (error) {
					console.warn("[Turn] Accepted; the armed actor starts the run", {
						turnId: run.turnId,
						runId: run.id,
						...errorDetails(error),
					});
				}
			}
		})(),
	);
	return { snapshot, thread };
}
