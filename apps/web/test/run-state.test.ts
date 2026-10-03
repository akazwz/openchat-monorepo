import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";

import {
	applyRunChange,
	readSnapshot,
	SnapshotRequired,
} from "~/features/runs/run-state";
import {
	PartChangeSchema,
	type Run,
	RunChangeSchema,
	RunSchema,
	RunSnapshotSchema,
	TextDeltaSchema,
} from "~/gen/heveta/v1/run_pb";
import { RunStatus } from "~/gen/heveta/v1/run_status_pb";
import {
	type Message,
	MessagePartSchema,
	ReasoningSchema,
	MessageRole,
	MessageSchema,
} from "~/gen/heveta/v1/thread_pb";

const runId = "run-1";
const identity = {
	id: runId,
	threadId: "thread-1",
	turnId: "turn-1",
	requestId: "request-1",
	attempt: 1,
};
const outputMessageId = "message-2";
const run = (status = RunStatus.RUNNING) =>
	create(RunSchema, { ...identity, status });

function wireSnapshot(
	revision: number,
	options: { status?: RunStatus; text?: string } = {},
) {
	return create(RunSnapshotSchema, {
		run: run(options.status),
		revision,
		inputMessage: create(MessageSchema, {
			id: "message-1",
			threadId: identity.threadId,
			turnId: identity.turnId,
			role: MessageRole.USER,
		}),
		outputMessage: create(MessageSchema, {
			id: outputMessageId,
			threadId: identity.threadId,
			turnId: identity.turnId,
			runId,
			role: MessageRole.ASSISTANT,
			parts:
				options.text === undefined
					? []
					: [
							create(MessagePartSchema, {
								id: "part-1",
								content: { case: "text", value: options.text },
							}),
						],
		}),
	});
}
// The reply as a run's snapshot at `revision` has it.
const reply = (revision: number, text = "") =>
	readSnapshot(wireSnapshot(revision, { text })).outputMessage;

function delta(revision: number, text: string, next: Run = run()) {
	return create(RunChangeSchema, {
		revision,
		run: next,
		changes: [
			create(PartChangeSchema, {
				change: {
					case: "textDelta",
					value: create(TextDeltaSchema, { partId: "part-1", text }),
				},
			}),
		],
	});
}

const text = (message: Message) =>
	message.parts.map((part) =>
		part.content.case === "text" ? part.content.value : "",
	);

describe("applyRunChange", () => {
	it("applies consecutive changes in order", () => {
		let message = reply(1);
		message = applyRunChange(message, delta(2, "Hel"));
		message = applyRunChange(message, delta(3, "lo"));
		expect(message.runRevision).toBe(3);
		expect(text(message)).toEqual(["Hello"]);
	});

	it("applies reasoning deltas without losing earlier reasoning", () => {
		const snapshot = wireSnapshot(1);
		snapshot.outputMessage!.parts = [
			create(MessagePartSchema, {
				id: "part-1",
				content: {
					case: "reasoning",
					value: create(ReasoningSchema, { text: "Think" }),
				},
			}),
		];
		const original = readSnapshot(snapshot).outputMessage;
		const changed = applyRunChange(original, delta(2, " more"));
		expect(changed.parts[0].content).toMatchObject({
			case: "reasoning",
			value: { text: "Think more" },
		});
		expect(original.parts[0].content).toMatchObject({
			case: "reasoning",
			value: { text: "Think" },
		});
	});

	it("applies a change to a copy", () => {
		const known = reply(1, "a");
		applyRunChange(known, delta(2, "b"));
		expect(text(known)).toEqual(["a"]);
	});

	it("ignores a duplicate or old change", () => {
		const message = applyRunChange(reply(1), delta(2, "a"));
		expect(applyRunChange(message, delta(2, "a"))).toBe(message);
		expect(applyRunChange(message, delta(1, "x"))).toBe(message);
		expect(text(message)).toEqual(["a"]);
	});

	it("asks for a snapshot when a revision is missing", () => {
		expect(() => applyRunChange(reply(1), delta(3, "a"))).toThrow(
			SnapshotRequired,
		);
	});

	it("asks for a snapshot for another run's change", () => {
		const other = create(RunSchema, { ...identity, id: "run-2" });
		expect(() => applyRunChange(reply(1), delta(2, "a", other))).toThrow(
			SnapshotRequired,
		);
	});

	it("keeps the reply's run with it", () => {
		const message = reply(1);
		expect(message.runStatus).toBe(RunStatus.RUNNING);
		const stopping = create(RunSchema, {
			...identity,
			status: RunStatus.RUNNING,
			cancelRequested: true,
		});
		expect(applyRunChange(message, delta(2, "a", stopping))).toMatchObject({
			runRevision: 2,
			runCancelRequested: true,
		});
		expect(
			applyRunChange(message, delta(2, "a", run(RunStatus.FAILED))).runStatus,
		).toBe(RunStatus.FAILED);
		const read = readSnapshot(wireSnapshot(3, { status: RunStatus.CANCELLED }));
		expect(read.outputMessage.runStatus).toBe(RunStatus.CANCELLED);
		expect(read.outputMessage.runAttempt).toBe(1);
	});
});
