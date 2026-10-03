import type { MessageInitShape } from "@bufbuild/protobuf";

import { type RunSnapshot, readSnapshot } from "~/features/runs/run-state";
import type { Thread } from "~/gen/heveta/v1/thread_pb";
import type {
	RetryTurnRequestSchema,
	StartTurnRequestSchema,
} from "~/gen/heveta/v1/turn_pb";
import { turnClient } from "~/lib/rpc-client";

interface AcceptedTurn {
	snapshot: RunSnapshot;
	// The conversation a turn without a thread started.
	thread?: Thread;
}
export async function startTurn(
	input: MessageInitShape<typeof StartTurnRequestSchema>,
	signal: AbortSignal,
): Promise<AcceptedTurn> {
	const response = await turnClient.startTurn(input, {
		signal,
		timeoutMs: 20000,
	});
	const snapshot = readSnapshot(response.snapshot);
	if (
		// An empty thread ID asked the server to start a new conversation.
		(input.threadId
			? snapshot.run.threadId !== input.threadId
			: response.thread?.id !== snapshot.run.threadId) ||
		snapshot.run.requestId !== input.requestId ||
		snapshot.run.attempt !== 1
	)
		throw new Error("Turn acknowledgement changed");
	return { snapshot, thread: response.thread };
}
export async function retryTurn(
	input: MessageInitShape<typeof RetryTurnRequestSchema>,
	signal: AbortSignal,
): Promise<AcceptedTurn> {
	const response = await turnClient.retryTurn(input, {
		signal,
		timeoutMs: 20000,
	});
	const snapshot = readSnapshot(response.snapshot);
	if (
		snapshot.run.turnId !== input.turnId ||
		snapshot.run.requestId !== input.requestId ||
		snapshot.run.attempt < 2
	)
		throw new Error("Turn retry acknowledgement changed");
	return { snapshot };
}
