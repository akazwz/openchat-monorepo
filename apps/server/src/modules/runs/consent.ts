import type { Database } from "@/db/client";
import type { RunRecord } from "@/db/schema/runs";
import type { Consent } from "@/runtime/tools";

import type { LocalRunStorage } from "./local-storage";
import { isActiveRun, type RunEvent } from "./types";

// The person's answer to a call that waits for their consent
// (docs/approvals.md), recorded in the run's checkpoint and on the call as
// the conversation shows it, in one commit: the execution that follows runs
// the call or tells the model it was refused. Only the run's actor calls
// this, with no execution under way and one answer at a time. Not answered
// when the call is not waiting for this answer: it has the other one, or the
// run was stopped or has ended. The same answer again changes nothing.
export async function recordConsent(
	db: Database,
	local: LocalRunStorage,
	run: RunRecord,
	callId: string,
	consent: Exclude<Consent, "requested">,
): Promise<{ answered: boolean; event?: RunEvent }> {
	if (!isActiveRun(run.status) || run.cancelRequested)
		return { answered: false };
	const state = local.state();
	if (!state || state.seal) return { answered: false };
	// A commit the last execution left unfinished comes first.
	await local.resolvePending(db);
	const current = local.consent(callId);
	if (current === consent) return { answered: true };
	if (current !== "requested") return { answered: false };
	const checkpoint = local.checkpoint();
	const call = checkpoint?.pendingCalls?.find(
		(pending) => pending.callId === callId,
	);
	const part = local.part(`${callId}:call`);
	if (!checkpoint || !call || part?.content.case !== "toolCall")
		return { answered: false };
	const saved = await local.save(db, {
		id: crypto.randomUUID(),
		run: local.state()!.run,
		changes: [
			{
				type: "part",
				part: {
					...part,
					content: {
						case: "toolCall",
						value: { ...part.content.value, consent },
					},
				},
			},
		],
		checkpoint: {
			...checkpoint,
			steps: [
				{
					index: call.stepIndex,
					kind: "tool",
					toolName: call.name,
					status: "pending",
					consent,
				},
			],
			pendingCalls: checkpoint.pendingCalls?.map((pending) =>
				pending === call ? { ...pending, consent } : pending,
			),
		},
		final: false,
	});
	return { answered: true, event: saved.event };
}
