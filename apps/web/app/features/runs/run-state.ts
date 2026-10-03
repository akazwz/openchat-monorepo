import { clone } from "@bufbuild/protobuf";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";

import {
	type Run,
	type RunChange,
	RunSchema,
	type RunSnapshot as WireSnapshot,
} from "~/gen/heveta/v1/run_pb";
import { RunStatus } from "~/gen/heveta/v1/run_status_pb";
import {
	type Message,
	MessagePartSchema,
	MessageRole,
	MessageSchema,
} from "~/gen/heveta/v1/thread_pb";

// A run and its messages at one committed revision. The output message
// carries its run as of that revision (Message.run_*), which is all the
// transcript shows of it.
export interface RunSnapshot {
	run: Run;
	inputMessage: Message;
	outputMessage: Message;
	revision: number;
}
// What is known cannot take this event; committed state must be read again.
export class SnapshotRequired extends Error {}

export const isActiveStatus = (status: RunStatus) =>
	status === RunStatus.QUEUED || status === RunStatus.RUNNING;
export const isActiveRun = (run: Run) => isActiveStatus(run.status);
// A reply whose run is still going.
export const isRunningReply = (message: Message) =>
	message.role === MessageRole.ASSISTANT && isActiveStatus(message.runStatus);

// The output as its run is at `revision`.
function withRun(message: Message, run: Run, revision: number) {
	message.runStatus = run.status;
	message.runAttempt = run.attempt;
	message.runCancelRequested = run.cancelRequested;
	message.runRevision = revision;
	return message;
}

export function readSnapshot(value: WireSnapshot | undefined): RunSnapshot {
	const run = value?.run;
	const inputMessage = value?.inputMessage;
	const outputMessage = value?.outputMessage;
	if (
		!value ||
		!run?.id ||
		!run.turnId ||
		run.attempt < 1 ||
		!inputMessage?.id ||
		!outputMessage?.id ||
		run.threadId !== inputMessage.threadId ||
		run.threadId !== outputMessage.threadId ||
		run.turnId !== inputMessage.turnId ||
		run.turnId !== outputMessage.turnId ||
		inputMessage.role !== MessageRole.USER ||
		inputMessage.runId ||
		outputMessage.role !== MessageRole.ASSISTANT ||
		outputMessage.runId !== run.id
	)
		throw new SnapshotRequired("Run snapshot is incomplete");
	return {
		run: clone(RunSchema, run),
		inputMessage: clone(MessageSchema, inputMessage),
		outputMessage: withRun(
			clone(MessageSchema, outputMessage),
			run,
			value.revision,
		),
		revision: value.revision,
	};
}

// A committed change of a run applied to its reply, on a copy: the reply as
// of the change's revision. One already applied changes nothing; one that
// does not follow the reply's revision needs the run's snapshot.
export function applyRunChange(reply: Message, change: RunChange): Message {
	if (change.revision <= reply.runRevision) return reply;
	if (change.revision !== reply.runRevision + 1)
		throw new SnapshotRequired("Run revision is missing");
	const run = change.run;
	if (
		!run ||
		run.id !== reply.runId ||
		run.turnId !== reply.turnId ||
		run.attempt !== reply.runAttempt
	)
		throw new SnapshotRequired("Run changed");
	const next = clone(MessageSchema, reply);
	for (const item of change.changes) {
		const update = item.change;
		if (update.case === "part") {
			if (!update.value.id) throw new SnapshotRequired("Run part is missing");
			const part = clone(MessagePartSchema, update.value);
			const index = next.parts.findIndex((existing) => existing.id === part.id);
			if (index === -1) next.parts.push(part);
			else next.parts[index] = part;
		} else if (update.case === "textDelta") {
			const part = next.parts.find(
				(existing) => existing.id === update.value.partId,
			);
			if (part?.content.case === "text")
				part.content.value += update.value.text;
			else if (part?.content.case === "reasoning")
				part.content.value.text += update.value.text;
			else throw new SnapshotRequired("Run text part is missing");
		} else throw new SnapshotRequired("Run part change is missing");
	}
	if (change.outputUpdateTime)
		next.updateTime = clone(TimestampSchema, change.outputUpdateTime);
	return withRun(next, run, change.revision);
}
