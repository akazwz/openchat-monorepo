import type { Database } from "@/db/client";
import { errorDetails } from "@/lib/error-details";
import { AppError, ErrorCode } from "@/lib/errors";
import { announce, publish, userEvents } from "@/modules/events/publish";

import { answerRunToolCall, cancelRunExecution } from "./delivery";
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

// The person approves or refuses a call that waits for their consent
// (docs/approvals.md). The run's actor holds the call and records the answer:
// the same answer again changes nothing, and one that comes too late (the
// call was answered otherwise, or the run was stopped or has ended) is
// refused.
export async function answerToolCall(
	db: Database,
	userId: string,
	runId: string,
	callId: string,
	approved: boolean,
): Promise<RunSnapshot> {
	if (!runId || !callId)
		throw new AppError("Run and call are required", ErrorCode.InvalidArgument);
	// Not found for someone else's run, before its actor is asked.
	await getRunSnapshot(db, userId, runId);
	const answered = await answerRunToolCall(runId, userId, callId, approved);
	const snapshot = await getRunSnapshot(db, userId, runId);
	// The call as the conversation has it settles an answer that was not
	// taken: the same one given before (a retry whose first reply was lost,
	// perhaps after the run went on and ended) stands.
	const call = snapshot.outputMessage.parts.find(
		(part) =>
			part.content.case === "toolCall" && part.content.value.id === callId,
	);
	const given =
		call?.content.case === "toolCall" ? call.content.value.consent : undefined;
	if (!answered && given !== (approved ? "granted" : "refused"))
		throw new AppError(
			"This action is no longer waiting for an answer",
			ErrorCode.FailedPrecondition,
		);
	if (answered) await announce(userId, [userEvents.runSnapshot(snapshot)]);
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
