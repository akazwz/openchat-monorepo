import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";

import {
	type CancelRunRequest,
	PartChangeSchema,
	RunChangeSchema,
	RunEventSchema,
	RunSchema,
	RunSnapshotSchema,
} from "@/gen/heveta/v1/run_pb";
import { effortToProto } from "@/modules/models/reasoning-effort";
import { partToProto } from "@/modules/threads/part-codec";
import { messageToProto } from "@/modules/threads/rpc-codec";

import type {
	PartChange,
	Run,
	RunChange,
	RunEvent,
	RunLookup,
	RunSnapshot,
} from "./types";

const runResource = (run: Run) =>
	create(RunSchema, {
		id: run.id,
		threadId: run.threadId,
		requestId: run.requestId,
		turnId: run.turnId,
		attempt: run.attempt,
		model: run.model,
		deviceId: run.deviceId ?? "",
		reasoningEffort: effortToProto(run.reasoningEffort),
		status: run.status,
		createTime: timestampFromDate(run.createdAt),
		startTime: run.startedAt ? timestampFromDate(run.startedAt) : undefined,
		finishTime: run.finishedAt ? timestampFromDate(run.finishedAt) : undefined,
		cancelRequested: run.cancelRequested,
	});

export const runSnapshotResource = (snapshot: RunSnapshot) =>
	create(RunSnapshotSchema, {
		run: runResource(snapshot.run),
		inputMessage: messageToProto(snapshot.inputMessage),
		outputMessage: messageToProto(
			snapshot.outputMessage,
			{
				...snapshot.run,
				revision: snapshot.revision,
			},
			{ omitLongOutputs: true },
		),
		revision: snapshot.revision,
	});

export function runLookup(req: CancelRunRequest): RunLookup {
	switch (req.lookup.case) {
		case "runId":
			return { runId: req.lookup.value };
		case "requestId":
			return { requestId: req.lookup.value };
		default:
			throw new ConnectError("Run lookup is required", Code.InvalidArgument);
	}
}

function partChangeResource(change: PartChange) {
	return create(PartChangeSchema, {
		change:
			change.type === "part"
				? {
						case: "part",
						value: partToProto(change.part, { omitLongOutputs: true }),
					}
				: {
						case: "textDelta",
						value: { partId: change.partId, text: change.text },
					},
	});
}

function runChangeResource(change: RunChange) {
	return create(RunChangeSchema, {
		revision: change.revision,
		run: runResource(change.run),
		changes: change.changes.map(partChangeResource),
		outputUpdateTime: timestampFromDate(change.outputUpdatedAt),
	});
}

export function runEventResource(event: RunEvent) {
	return create(RunEventSchema, {
		runId: event.runId,
		event:
			event.type === "snapshot"
				? { case: "snapshot", value: runSnapshotResource(event.snapshot) }
				: { case: "change", value: runChangeResource(event.change) },
	});
}
