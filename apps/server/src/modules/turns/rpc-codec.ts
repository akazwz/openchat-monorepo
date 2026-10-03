import { Code, ConnectError } from "@connectrpc/connect";

import type {
	RetryTurnRequest,
	StartTurnRequest,
} from "@/gen/heveta/v1/turn_pb";
import { effortFromProto } from "@/modules/models/reasoning-effort";
import type { RunInput } from "@/modules/runs/types";

export function startTurnInput(req: StartTurnRequest): RunInput {
	if (!req.input)
		throw new ConnectError("Input is required", Code.InvalidArgument);
	return {
		requestId: req.requestId,
		modelId: req.modelId,
		reasoningEffort: effortFromProto(req.reasoningEffort),
		input: {
			case: "newTurn",
			value: {
				threadId: req.threadId,
				text: req.input.text,
				fileIds: req.input.fileIds,
				deviceId: req.deviceId || undefined,
			},
		},
	};
}

export function retryTurnInput(req: RetryTurnRequest): RunInput {
	return {
		requestId: req.requestId,
		modelId: req.modelId,
		reasoningEffort: effortFromProto(req.reasoningEffort),
		input: {
			case: "retryTurn",
			value: { turnId: req.turnId, previousRunId: req.previousRunId },
		},
	};
}
