import { runClient } from "~/lib/rpc-client";

import { readSnapshot } from "./run-state";

export type RunLookup =
	| { case: "runId"; value: string }
	| { case: "requestId"; value: string };
export async function getRun(runId: string, signal?: AbortSignal) {
	const snapshot = readSnapshot(
		(await runClient.getRun({ runId }, { signal, timeoutMs: 10000 })).snapshot,
	);
	if (snapshot.run.id !== runId) throw new Error("Run lookup changed");
	return snapshot;
}
export async function cancelRun(lookup: RunLookup, signal: AbortSignal) {
	const snapshot = readSnapshot(
		(await runClient.cancelRun({ lookup }, { signal, timeoutMs: 10000 }))
			.snapshot,
	);
	if (
		(lookup.case === "runId" ? snapshot.run.id : snapshot.run.requestId) !==
		lookup.value
	)
		throw new Error("Run lookup changed");
	return snapshot;
}
