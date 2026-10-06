import { expect, test, vi } from "vitest";

import { AppError, ErrorCode } from "@/lib/errors";
import type { Message } from "@/modules/threads/types";
import {
	modelHistory,
	noEarlierTurns,
	windowedHistory,
} from "@/runtime/adapters/thread-history";
import {
	InterruptedOperationError,
	type LoopCheckpoint,
	recordsOutcome,
	type StepUpdate,
} from "@/runtime/checkpoint";
import { agentLoop } from "@/runtime/loop";
import {
	modelFileReference,
	type ModelFileSource,
	modelFiles,
} from "@/runtime/responses/model-files";
import { ResponsesOutput } from "@/runtime/responses/output";
import {
	type ModelEvent,
	type ModelInput,
	ModelRequestRefused,
	type ModelResponse,
	type StreamResponse,
} from "@/runtime/responses/types";
import { type LocalTool, localToolSet, type ToolSet } from "@/runtime/tools";
import { type LoopContext, type LoopEvent, StopReason } from "@/runtime/types";
import {
	clearedToolImage,
	nothingOmitted,
	type WindowPolicy,
} from "@/runtime/window";

// A window these fixtures never reach; test/window.test.ts covers sliding.
const policy: WindowPolicy = {
	tokens: 1_000_000,
	trigger: 0.8,
	target: 0.2,
	recentToolResults: 3,
	omittedUserChars: 8_000,
	fileBytes: 1_000_000,
};
const context: LoopContext = {
	window: policy,
	before: [],
	after: [],
	fixedChars: 0,
	omitted: nothingOmitted,
	tokensPerChar: 1,
	supportsImages: true,
};
const loadHistory = (
	history: Message[],
	fileBytes: number,
	supportsImages: boolean,
) =>
	windowedHistory(
		history,
		noEarlierTurns,
		{},
		{
			policy: { ...policy, fileBytes },
			fixedChars: 0,
			tokensPerChar: 1,
			reads: supportsImages ? ["image", "pdf"] : [],
			readOnly: () => true,
		},
	);
const noTools: ToolSet = localToolSet([]);
// The run's end, for loops whose test is about something else.
const noCompletion = async () => {};
function response(tokens = 7): ModelResponse {
	return {
		id: "response-fixture",
		status: "completed",
		incomplete_details: null,
		usage: { output_tokens: tokens },
		output: [
			{
				type: "reasoning",
				id: "reasoning",
				summary: [],
				encrypted_content: "encrypted-native-reasoning",
			},
			{
				type: "message",
				id: "progress",
				role: "assistant",
				status: "completed",
				phase: "commentary",
				content: [{ type: "output_text", text: "Working", annotations: [] }],
			},
			{
				type: "message",
				id: "answer",
				role: "assistant",
				status: "completed",
				phase: "final_answer",
				content: [{ type: "output_text", text: "Done", annotations: [] }],
			},
		],
	};
}
function* modelEvents(value: ModelResponse): Generator<ModelEvent> {
	yield* new ResponsesOutput().finish(value.output);
	yield { type: "response", response: value };
}
async function consume(
	loop: ReturnType<typeof agentLoop>,
	onEvent?: (event: LoopEvent) => void,
) {
	const events: LoopEvent[] = [];
	while (true) {
		const next = await loop.next();
		if (next.done) return { events, reason: next.value };
		events.push(next.value);
		onEvent?.(next.value);
	}
}

test("a completed reply ends the run once, with its step, after its output", async () => {
	const checkpoints: LoopCheckpoint[] = [];
	const observed: LoopEvent[] = [];
	const ended: StepUpdate[][] = [];
	const value = response();
	const complete = vi.fn(async function* (input: ModelInput) {
		expect(input).toEqual([{ role: "user", content: "Help" }]);
		expect(checkpoints.at(-1)?.phase).toBe("model");
		yield* modelEvents(value);
	});
	const result = await consume(
		agentLoop(
			[{ role: "user", content: "Help" }],
			new AbortController().signal,
			complete,
			context,
			noTools,
			{
				async complete(steps) {
					// Everything the reply showed precedes its end.
					expect(
						observed.filter((event) => event.type === "textSnapshot"),
					).toHaveLength(2);
					ended.push(steps);
				},
				async saveCheckpoint(checkpoint) {
					checkpoints.push(checkpoint);
				},
			},
		),
		(event) => observed.push(event),
	);
	expect(result.reason).toBe(StopReason.MODEL_COMPLETE);
	expect(complete).toHaveBeenCalledOnce();
	expect(ended).toEqual([
		[
			{
				index: 1,
				kind: "model",
				status: "completed",
				responseId: "response-fixture",
				outputTokens: 7,
			},
		],
	]);
	expect(checkpoints.map((checkpoint) => checkpoint.phase)).toEqual([
		"ready",
		"model",
	]);
	expect(
		result.events
			.filter((event) => event.type === "textSnapshot")
			.map((event) => event.text),
	).toMatchObject([
		{
			modelMessageId: "progress",
			phase: "commentary",
			status: "completed",
			text: "Working",
		},
		{
			modelMessageId: "answer",
			phase: "final_answer",
			status: "completed",
			text: "Done",
		},
	]);
	expect(JSON.stringify(result.events)).not.toContain(
		"encrypted-native-reasoning",
	);
});
test("a ready checkpoint resumes native input without replacing its history", async () => {
	const checkpoint: LoopCheckpoint = {
		version: 4,
		phase: "ready",
		lastStepIndex: 1,
		messages: [
			{ role: "user", content: "Original input" },
			...(response().output as ModelInput),
		],
	};
	const contexts: ModelInput[] = [];
	const streamResponse: StreamResponse = async function* (input, options) {
		contexts.push(structuredClone(input));
		expect(options.modelStep).toBe(2);
		yield* modelEvents(response(3));
	};
	const result = await consume(
		agentLoop(
			[{ role: "user", content: "Must not replace saved input" }],
			new AbortController().signal,
			streamResponse,
			context,
			noTools,
			{
				complete: noCompletion,
				checkpoint,
				saveCheckpoint: vi.fn(async () => {}),
			},
		),
	);
	expect(contexts).toEqual([checkpoint.messages]);
	expect(result.reason).toBe(StopReason.MODEL_COMPLETE);
	expect(checkpoint.messages).toHaveLength(4);
});

test("an interrupted provider operation is never replayed", async () => {
	const complete = vi.fn(async function* () {
		yield* modelEvents(response());
	});
	const saveCheckpoint = vi.fn(async () => {});
	await expect(
		consume(
			agentLoop([], new AbortController().signal, complete, context, noTools, {
				checkpoint: {
					version: 4,
					phase: "model",
					lastStepIndex: 1,
					messages: [],
				},
				saveCheckpoint,
				complete: noCompletion,
			}),
		),
	).rejects.toBeInstanceOf(InterruptedOperationError);
	expect(complete).not.toHaveBeenCalled();
	expect(saveCheckpoint).not.toHaveBeenCalled();
});

test("a reply cut off by the model's own output limit keeps its text and ends the run", async () => {
	const checkpoints: LoopCheckpoint[] = [];
	const value = response();
	value.status = "incomplete";
	value.incomplete_details = { reason: "max_output_tokens" };
	const complete = vi.fn(async function* () {
		yield* modelEvents(value);
	});
	const ended = vi.fn(async (_steps: StepUpdate[]) => {});
	const result = await consume(
		agentLoop([], new AbortController().signal, complete, context, noTools, {
			complete: ended,
			async saveCheckpoint(checkpoint) {
				checkpoints.push(checkpoint);
			},
		}),
	);
	expect(result.reason).toBe(StopReason.MODEL_COMPLETE);
	expect(complete).toHaveBeenCalledOnce();
	expect(ended).toHaveBeenCalledExactlyOnceWith([
		expect.objectContaining({ status: "completed", outputTokens: 7 }),
	]);
	expect(result.events).toContainEqual(
		expect.objectContaining({ type: "textSnapshot" }),
	);
});

test("a provider request cannot start before its checkpoint commits", async () => {
	const complete = vi.fn(async function* () {
		yield* modelEvents(response());
	});
	await expect(
		consume(
			agentLoop([], new AbortController().signal, complete, context, noTools, {
				complete: noCompletion,
				async saveCheckpoint() {
					throw new Error("Checkpoint commit failed");
				},
			}),
		),
	).rejects.toThrow("Checkpoint commit failed");
	expect(complete).not.toHaveBeenCalled();
});

// The run's owner ends it, closing the open model step.
test("provider failures preserve their cause and leave the run to its owner to end", async () => {
	const checkpoints: LoopCheckpoint[] = [];
	const failure = new Error("Provider stream failed");
	await expect(
		consume(
			agentLoop(
				[],
				new AbortController().signal,
				async function* () {
					yield* new ResponsesOutput().finish(response().output);
					throw failure;
				},
				context,
				noTools,
				{
					complete: noCompletion,
					async saveCheckpoint(checkpoint) {
						checkpoints.push(checkpoint);
					},
				},
			),
		),
	).rejects.toBe(failure);
	expect(checkpoints.at(-1)?.phase).toBe("model");
});

test("cancellation stops consumption and leaves final classification to the executor", async () => {
	const controller = new AbortController();
	const checkpoints: LoopCheckpoint[] = [];
	const complete = vi.fn(async function* () {
		yield* modelEvents(response());
	});
	await expect(
		consume(
			agentLoop([], controller.signal, complete, context, noTools, {
				complete: noCompletion,
				async saveCheckpoint(checkpoint) {
					checkpoints.push(checkpoint);
				},
			}),
			() => controller.abort(),
		),
	).rejects.toThrow();
	expect(complete).toHaveBeenCalledOnce();
	expect(checkpoints.at(-1)?.phase).toBe("model");
});

function userMessage(id: string, text: string, images: [string, number][]) {
	return {
		id,
		threadId: "thread",
		turnId: id,
		runId: null,
		role: "user",
		createdAt: new Date("2026-09-22T00:00:00.000Z"),
		updatedAt: new Date("2026-09-22T00:00:00.000Z"),
		parts: [
			{ id: `${id}-text`, content: { case: "text", value: text } },
			...images.map(([fileId, size]) => ({
				id: `${id}-${fileId}`,
				content: {
					case: "file" as const,
					value: {
						id: fileId,
						url: `https://files.invalid/${fileId}.png`,
						mimeType: "image/png",
						fileName: `${fileId}.png`,
						size: BigInt(size),
						workspacePath: `/workspace/uploads/${fileId}.png`,
					},
				},
			})),
		],
	} satisfies Message;
}
const imageData = (fileId: string) =>
	`data:image/png;base64,${Buffer.from(fileId.repeat(100)).toString("base64")}`;
// Images as the file source serves them: each its ID a hundred times over,
// read by `read`.
const imageSource = (
	read: (fileId: string) => Promise<string> = async (fileId) =>
		imageData(fileId),
): ModelFileSource => ({
	sizes: async (ids) => new Map(ids.map((id) => [id, id.length * 100])),
	read,
});

test("image inputs stay file references in history and checkpoints and are read only for the request", async () => {
	const history = loadHistory(
		[userMessage("first", "Describe", [["image-1", 400]])],
		1000,
		true,
	).items;
	expect(history).toEqual([
		{
			role: "user",
			content: [
				{ type: "input_text", text: "Describe" },
				{
					type: "input_image",
					image_url: modelFileReference("image-1"),
					detail: "auto",
				},
				{
					type: "input_text",
					text: "[Attached: image-1.png (400 bytes), copied to your computer at /workspace/uploads/image-1.png]",
				},
			],
		},
	]);
	const checkpoints: LoopCheckpoint[] = [];
	const resolveImage = vi.fn(async (fileId: string) => {
		// Nothing is committed as a model operation until image data is ready.
		expect(checkpoints.map((checkpoint) => checkpoint.phase)).toEqual([
			"ready",
		]);
		return imageData(fileId);
	});
	const requests: ModelInput[] = [];
	await consume(
		agentLoop(
			history,
			new AbortController().signal,
			async function* (input) {
				requests.push(input);
				yield* modelEvents(response());
			},
			context,
			noTools,
			{
				complete: noCompletion,
				async saveCheckpoint(checkpoint) {
					checkpoints.push(checkpoint);
				},
			},
			modelFiles(imageSource(resolveImage), 1000),
		),
	);
	expect(resolveImage).toHaveBeenCalledOnce();
	expect(requests[0][0]).toMatchObject({
		content: [
			{},
			{ type: "input_image", image_url: imageData("image-1") },
			{ type: "input_text" },
		],
	});
	expect(checkpoints.map((checkpoint) => checkpoint.phase)).toEqual([
		"ready",
		"model",
	]);
	const saved = JSON.stringify(checkpoints);
	expect(saved).not.toContain("data:");
	expect(saved).toContain(modelFileReference("image-1"));
	// The caller's history is never rewritten with image data.
	expect(JSON.stringify(history)).not.toContain("data:");
});

test("an earlier reply goes back as its text and phase, without the ID its provider gave it", () => {
	// A DeepSeek reply (its message IDs are UUIDs) in a conversation that
	// goes on with an OpenAI model, which refuses any ID not its own.
	const reply = {
		id: "reply",
		threadId: "thread",
		turnId: "first",
		runId: "run",
		role: "assistant",
		createdAt: new Date("2026-09-22T00:00:00.000Z"),
		updatedAt: new Date("2026-09-22T00:00:00.000Z"),
		parts: [
			{
				id: "reply-text",
				assistantText: {
					messageId: "57b57cce-acf9-4a3c-a07b-0d6cd77fd09a",
					contentIndex: 0,
					phase: "final_answer" as const,
					refusal: false,
					status: "completed" as const,
				},
				content: { case: "text" as const, value: "记住了，你喜欢乌龙茶。" },
			},
		],
	} satisfies Message;
	expect(modelHistory([reply])).toEqual([
		{
			type: "message",
			role: "assistant",
			content: "记住了，你喜欢乌龙茶。",
			phase: "final_answer",
		},
	]);
});

test("a PDF goes to a model that reads PDFs, and is only a file on the computer for one that does not", () => {
	const message = userMessage("first", "Summarize", []);
	message.parts.push({
		id: "first-report",
		content: {
			case: "file",
			value: {
				id: "report",
				url: "https://files.invalid/report.pdf",
				mimeType: "application/pdf",
				fileName: "report.pdf",
				size: 900n,
				workspacePath: "/workspace/uploads/report.pdf",
			},
		},
	});
	const note = {
		type: "input_text",
		text: "[Attached: report.pdf (900 bytes), copied to your computer at /workspace/uploads/report.pdf]",
	};
	expect(modelHistory([message], ["image", "pdf"])).toEqual([
		{
			role: "user",
			content: [
				{ type: "input_text", text: "Summarize" },
				{
					type: "input_file",
					file_data: modelFileReference("report"),
					filename: "report.pdf",
				},
				note,
			],
		},
	]);
	// DeepSeek's API ignores files without a word: the model is told where
	// the PDF is and opens it there.
	expect(modelHistory([message], ["image"])).toEqual([
		{
			role: "user",
			content: [{ type: "input_text", text: "Summarize" }, note],
		},
	]);
});

test("an image read failure before the request leaves the ready boundary retryable", async () => {
	const checkpoints: LoopCheckpoint[] = [];
	const complete = vi.fn(async function* () {
		yield* modelEvents(response());
	});
	const failure = new Error("R2 unavailable");
	await expect(
		consume(
			agentLoop(
				modelHistory([userMessage("first", "Look", [["image-1", 10]])]),
				new AbortController().signal,
				complete,
				context,
				noTools,
				{
					complete: noCompletion,
					async saveCheckpoint(checkpoint) {
						checkpoints.push(checkpoint);
					},
				},
				modelFiles(
					imageSource(async () => {
						throw failure;
					}),
					1000,
				),
			),
		),
	).rejects.toBe(failure);
	expect(complete).not.toHaveBeenCalled();
	expect(checkpoints.map((checkpoint) => checkpoint.phase)).toEqual(["ready"]);
});

function toolCallResponse(
	calls: { id: string; name: string; arguments: string }[],
	status: ModelResponse["status"] = "completed",
): ModelResponse {
	return {
		id: `response-${calls.map((call) => call.id).join("-")}`,
		status,
		incomplete_details:
			status === "incomplete" ? { reason: "max_output_tokens" } : null,
		usage: { output_tokens: 2 },
		output: calls.map((call) => ({
			type: "function_call",
			id: `fc-${call.id}`,
			call_id: call.id,
			name: call.name,
			arguments: call.arguments,
			status: "completed",
		})),
	};
}
function tool(
	name: string,
	readOnly: boolean,
	execute: LocalTool["execute"],
): LocalTool {
	return {
		name,
		description: name,
		parameters: { type: "object", properties: {}, additionalProperties: false },
		readOnly,
		concurrent: readOnly,
		execute,
	};
}

test("the loop runs tools until the model replies without calling one", async () => {
	const checkpoints: LoopCheckpoint[] = [];
	const replies = [
		toolCallResponse([{ id: "a", name: "lookup", arguments: '{"q":"x"}' }]),
		toolCallResponse([{ id: "b", name: "lookup", arguments: '{"q":"y"}' }]),
		response(),
	];
	const inputs: ModelInput[] = [];
	const lookup = vi.fn(async (args: Record<string, unknown>) => ({
		output: `found ${args.q}`,
	}));
	const result = await consume(
		agentLoop(
			[{ role: "user", content: "Find" }],
			new AbortController().signal,
			async function* (input, options) {
				inputs.push(structuredClone(input));
				expect(options.modelStep).toBe([1, 3, 5][inputs.length - 1]);
				yield* modelEvents(replies[inputs.length - 1]);
			},
			context,
			localToolSet([tool("lookup", true, lookup)]),
			{
				complete: noCompletion,
				async saveCheckpoint(checkpoint) {
					checkpoints.push(structuredClone(checkpoint));
				},
			},
		),
	);
	expect(result.reason).toBe(StopReason.MODEL_COMPLETE);
	expect(lookup).toHaveBeenCalledTimes(2);
	// Each request carries every earlier call and its output.
	expect(inputs[2]).toEqual([
		{ role: "user", content: "Find" },
		replies[0].output[0],
		{ type: "function_call_output", call_id: "a", output: "found x" },
		replies[1].output[0],
		{ type: "function_call_output", call_id: "b", output: "found y" },
	]);
	expect(
		result.events.filter(
			(event) => event.type === "toolCall" || event.type === "toolResult",
		),
	).toEqual([
		{
			type: "toolCall",
			stepIndex: 2,
			callId: "a",
			name: "lookup",
			arguments: '{"q":"x"}',
			surface: "service",
		},
		{
			type: "toolResult",
			stepIndex: 2,
			callId: "a",
			name: "lookup",
			output: "found x",
			isError: false,
			shown: [],
			images: [],
		},
		{
			type: "toolCall",
			stepIndex: 4,
			callId: "b",
			name: "lookup",
			arguments: '{"q":"y"}',
			surface: "service",
		},
		{
			type: "toolResult",
			stepIndex: 4,
			callId: "b",
			name: "lookup",
			output: "found y",
			isError: false,
			shown: [],
			images: [],
		},
	]);
	expect(checkpoints.map((checkpoint) => checkpoint.phase)).toEqual([
		"ready",
		"model",
		"tools",
		"tools",
		"ready",
		"model",
		"tools",
		"tools",
		"ready",
		"model",
	]);
	// The last boundary precedes the model's answer, which ends the run.
	expect(checkpoints.at(-1)).toMatchObject({ lastStepIndex: 5 });
});

test("tool failures become results the model reads; the run continues", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const replies = [
		toolCallResponse([
			{ id: "a", name: "missing", arguments: "{}" },
			{ id: "b", name: "broken", arguments: "{}" },
			{ id: "c", name: "broken", arguments: "not json" },
			{ id: "d", name: "refusing", arguments: "{}" },
		]),
		response(),
	];
	let request = 0;
	const inputs: ModelInput[] = [];
	const result = await consume(
		agentLoop(
			[],
			new AbortController().signal,
			async function* (input) {
				inputs.push(structuredClone(input));
				yield* modelEvents(replies[request++]);
			},
			context,
			localToolSet([
				tool("broken", false, async () => {
					throw new Error("secret internal detail");
				}),
				tool("refusing", false, async () => {
					throw new AppError("Not allowed here.", ErrorCode.InvalidArgument);
				}),
			]),
			{ complete: noCompletion, saveCheckpoint: vi.fn(async () => {}) },
		),
	);
	expect(result.reason).toBe(StopReason.MODEL_COMPLETE);
	// An unexpected error's details go to the logs, never to the model.
	expect(warn).toHaveBeenCalledWith(
		"[Tool] Unexpected failure",
		expect.objectContaining({ tool: "broken", callId: "b" }),
	);
	expect(JSON.stringify(inputs[1])).not.toContain("secret internal detail");
	warn.mockRestore();
	const outputs = inputs[1].filter(
		(item) => "type" in item && item.type === "function_call_output",
	);
	expect(outputs).toEqual([
		{
			type: "function_call_output",
			call_id: "a",
			output: 'Tool "missing" is not available.',
		},
		{
			type: "function_call_output",
			call_id: "b",
			output: "The tool failed unexpectedly.",
		},
		{
			type: "function_call_output",
			call_id: "c",
			output: "The arguments must be a JSON object.",
		},
		{ type: "function_call_output", call_id: "d", output: "Not allowed here." },
	]);
	expect(JSON.stringify(result.events)).not.toContain("secret internal detail");
});

test("read-only calls next to each other run together; order holds around others", async () => {
	const order: string[] = [];
	let releaseReads: () => void = () => {};
	const reads = new Promise<void>((resolve) => {
		releaseReads = resolve;
	});
	const read = (name: string) =>
		tool(name, true, async () => {
			order.push(`start ${name}`);
			await reads;
			order.push(`end ${name}`);
			return { output: name };
		});
	const write = tool("write", false, async () => {
		order.push("write");
		return { output: "written" };
	});
	const replies = [
		toolCallResponse([
			{ id: "1", name: "read1", arguments: "{}" },
			{ id: "2", name: "read2", arguments: "{}" },
			{ id: "3", name: "write", arguments: "{}" },
			{ id: "4", name: "read3", arguments: "{}" },
		]),
		response(),
	];
	let request = 0;
	const run = consume(
		agentLoop(
			[],
			new AbortController().signal,
			async function* () {
				yield* modelEvents(replies[request++]);
			},
			context,
			localToolSet([read("read1"), read("read2"), read("read3"), write]),
			{ complete: noCompletion, saveCheckpoint: vi.fn(async () => {}) },
		),
	);
	// The first two start together; the read after the write waits for it.
	await vi.waitFor(() => expect(order).toContain("start read2"));
	expect(order).toEqual(["start read1", "start read2"]);
	releaseReads();
	await run;
	expect(order.slice(2)).toEqual([
		"end read1",
		"end read2",
		"write",
		"start read3",
		"end read3",
	]);
});

test("after an interruption, only the first pending call can have started", async () => {
	const lookup = vi.fn(async () => ({ output: "fresh" }));
	const send = vi.fn(async () => ({ output: "sent" }));
	const post = vi.fn(async () => ({ output: "posted" }));
	const inputs: ModelInput[] = [];
	const checkpoint: LoopCheckpoint = {
		version: 4,
		phase: "tools",
		lastStepIndex: 4,
		messages: [
			{ role: "user", content: "Go" },
			...(toolCallResponse([
				{ id: "s", name: "send", arguments: "{}" },
				{ id: "r", name: "lookup", arguments: "{}" },
				{ id: "p", name: "post", arguments: "{}" },
			]).output as ModelInput),
		],
		pendingCalls: [
			{
				callId: "s",
				name: "send",
				arguments: "{}",
				stepIndex: 2,
				started: true,
			},
			{ callId: "r", name: "lookup", arguments: "{}", stepIndex: 3 },
			{ callId: "p", name: "post", arguments: "{}", stepIndex: 4 },
		],
	};
	const result = await consume(
		agentLoop(
			[],
			new AbortController().signal,
			async function* (input, options) {
				inputs.push(structuredClone(input));
				expect(options.modelStep).toBe(5);
				yield* modelEvents(response());
			},
			context,
			localToolSet([
				tool("lookup", true, lookup),
				tool("send", false, send),
				tool("post", false, post),
			]),
			{
				complete: noCompletion,
				checkpoint,
				saveCheckpoint: vi.fn(async () => {}),
			},
		),
	);
	expect(result.reason).toBe(StopReason.MODEL_COMPLETE);
	// The first call may have taken effect: not repeated, reported unknown.
	expect(send).not.toHaveBeenCalled();
	// Calls run in order, so the others had not started.
	expect(lookup).toHaveBeenCalledOnce();
	expect(post).toHaveBeenCalledOnce();
	expect(inputs[0].slice(-3)).toMatchObject([
		{
			type: "function_call_output",
			call_id: "s",
			output: expect.stringContaining("unknown"),
		},
		{ type: "function_call_output", call_id: "r", output: "fresh" },
		{ type: "function_call_output", call_id: "p", output: "posted" },
	]);
	// The calls are republished in case their parts were lost with the host.
	expect(result.events.slice(0, 3).map((event) => event.type)).toEqual([
		"toolCall",
		"toolCall",
		"toolCall",
	]);
});

test("an interrupted call its executor can still collect is collected", async () => {
	const run = vi.fn(async () => ({ output: "again" }));
	const collect = vi.fn(async () => ({ output: "finished meanwhile" }));
	const inputs: ModelInput[] = [];
	const checkpoint: LoopCheckpoint = {
		version: 4,
		phase: "tools",
		lastStepIndex: 2,
		messages: [
			{ role: "user", content: "Go" },
			...(toolCallResponse([{ id: "c", name: "command", arguments: "{}" }])
				.output as ModelInput),
		],
		pendingCalls: [
			{
				callId: "c",
				name: "command",
				arguments: "{}",
				stepIndex: 2,
				started: true,
			},
		],
	};
	const set = localToolSet([tool("command", false, run)]);
	await consume(
		agentLoop(
			[],
			new AbortController().signal,
			async function* (input) {
				inputs.push(structuredClone(input));
				yield* modelEvents(response());
			},
			context,
			{ specs: set.specs, executor: { ...set.executor, resume: collect } },
			{
				complete: noCompletion,
				checkpoint,
				saveCheckpoint: vi.fn(async () => {}),
			},
		),
	);
	expect(run).not.toHaveBeenCalled();
	expect(collect).toHaveBeenCalledWith(
		expect.objectContaining({ callId: "c", name: "command" }),
		expect.anything(),
	);
	expect(inputs[0].at(-1)).toMatchObject({
		call_id: "c",
		output: "finished meanwhile",
	});
});

test("tool output with NUL characters becomes storable text", async () => {
	const inputs: ModelInput[] = [];
	const replies = [
		toolCallResponse([{ id: "b", name: "binary", arguments: "{}" }]),
		response(),
	];
	let request = 0;
	const result = await consume(
		agentLoop(
			[{ role: "user", content: "Read it" }],
			new AbortController().signal,
			async function* (input) {
				inputs.push(structuredClone(input));
				yield* modelEvents(replies[request++]);
			},
			context,
			localToolSet([
				tool("binary", true, async () => ({ output: "a\u0000b" })),
			]),
			{ complete: noCompletion, saveCheckpoint: vi.fn(async () => {}) },
		),
	);
	const toolResult = result.events.find((event) => event.type === "toolResult");
	expect(toolResult).toMatchObject({ output: "a\uFFFDb" });
	expect(JSON.stringify(inputs[1])).not.toContain("\\u0000");
});

test("a response cut off during a tool call fails instead of running a partial call", async () => {
	const lookup = vi.fn(async () => ({ output: "x" }));
	const checkpoints: LoopCheckpoint[] = [];
	await expect(
		consume(
			agentLoop(
				[],
				new AbortController().signal,
				async function* () {
					yield* modelEvents(
						toolCallResponse(
							[{ id: "a", name: "lookup", arguments: '{"q":' }],
							"incomplete",
						),
					);
				},
				context,
				localToolSet([tool("lookup", true, lookup)]),
				{
					complete: noCompletion,
					async saveCheckpoint(checkpoint) {
						checkpoints.push(checkpoint);
					},
				},
			),
		),
	).rejects.toThrow("cut off during a tool call");
	expect(lookup).not.toHaveBeenCalled();
	expect(checkpoints.at(-1)?.phase).toBe("model");
});

test("earlier tool use is restored as call/output pairs, with a stand-in for a missing result", () => {
	const input = modelHistory([
		{
			id: "m1",
			threadId: "t",
			turnId: "turn",
			runId: "run",
			role: "assistant",
			createdAt: new Date(0),
			updatedAt: new Date(0),
			parts: [
				{
					id: "a:call",
					content: {
						case: "toolCall",
						value: { id: "a", name: "lookup", arguments: '{"q":"x"}' },
					},
				},
				{
					id: "a:result",
					content: {
						case: "toolResult",
						value: {
							toolCallId: "a",
							name: "lookup",
							output: "found",
							isError: false,
						},
					},
				},
				{
					id: "b:call",
					content: {
						case: "toolCall",
						value: { id: "b", name: "send", arguments: "{}" },
					},
				},
			],
		},
	]);
	expect(input).toEqual([
		{
			type: "function_call",
			call_id: "a",
			name: "lookup",
			arguments: '{"q":"x"}',
		},
		{ type: "function_call_output", call_id: "a", output: "found" },
		{ type: "function_call", call_id: "b", name: "send", arguments: "{}" },
		{
			type: "function_call_output",
			call_id: "b",
			output: "No result was recorded for this call.",
		},
	]);
});

test("an image a tool returns is the model's to read, the same in the run and when rebuilt from the conversation", async () => {
	const image = {
		id: "shot",
		mimeType: "image/png",
		fileName: "shot.png",
		size: 10n,
	};
	const replies = [
		toolCallResponse([{ id: "a", name: "view_image", arguments: "{}" }]),
		response(),
	];
	const inputs: ModelInput[] = [];
	const checkpoints: LoopCheckpoint[] = [];
	const result = await consume(
		agentLoop(
			[{ role: "user", content: "Look" }],
			new AbortController().signal,
			async function* (input) {
				inputs.push(structuredClone(input));
				yield* modelEvents(replies[inputs.length - 1]);
			},
			context,
			localToolSet([
				tool("view_image", true, async () => ({
					output: "/workspace/shot.png",
					images: [image],
				})),
			]),
			{
				complete: noCompletion,
				async saveCheckpoint(checkpoint) {
					checkpoints.push(structuredClone(checkpoint));
				},
			},
			modelFiles(imageSource(), 1000),
		),
	);
	const referenced = {
		type: "function_call_output",
		call_id: "a",
		output: [
			{ type: "input_text", text: "/workspace/shot.png" },
			{
				type: "input_image",
				image_url: modelFileReference("shot"),
				detail: "auto",
			},
		],
	};
	// The request carries the image data; the checkpoint only its reference.
	expect(inputs[1].at(-1)).toEqual({
		...referenced,
		output: [
			referenced.output[0],
			{ ...referenced.output[1], image_url: imageData("shot") },
		],
	});
	expect(checkpoints.at(-1)?.messages).toContainEqual(referenced);
	expect(JSON.stringify(checkpoints)).not.toContain("data:");
	expect(result.events).toContainEqual(
		expect.objectContaining({ type: "toolResult", images: [image], shown: [] }),
	);
	// Rebuilt from the saved reply, the result is the same item, so later
	// requests keep the prefix; a model without image input reads the text.
	const reply: Message = {
		id: "m1",
		threadId: "t",
		turnId: "turn",
		runId: "run",
		role: "assistant",
		createdAt: new Date(0),
		updatedAt: new Date(0),
		parts: [
			{
				id: "a:call",
				content: {
					case: "toolCall",
					value: { id: "a", name: "view_image", arguments: "{}" },
				},
			},
			{
				id: "a:result",
				content: {
					case: "toolResult",
					value: {
						toolCallId: "a",
						name: "view_image",
						output: "/workspace/shot.png",
						isError: false,
						images: [image],
					},
				},
			},
		],
	};
	expect(modelHistory([reply])[1]).toEqual(referenced);
	expect(modelHistory([reply], [])[1]).toEqual({
		type: "function_call_output",
		call_id: "a",
		output: "/workspace/shot.png",
	});
});

test("past the file budget the newest image is left out, and only the files that fit are read", async () => {
	const read = vi.fn(async (fileId: string) => imageData(fileId));
	const image = (fileId: string) => ({
		type: "input_image" as const,
		image_url: modelFileReference(fileId),
		detail: "auto" as const,
	});
	const input: ModelInput = [
		{ role: "user", content: [image("old"), image("gone")] },
		{
			type: "function_call_output",
			call_id: "a",
			output: [image("mid"), image("new")],
		},
		{ role: "user", content: [{ type: "input_text", text: "Go on" }] },
	];
	const source: ModelFileSource = {
		// "gone" no longer exists; every other file is 300 bytes.
		sizes: async (ids) =>
			new Map(
				ids.map((id) => [
					id,
					id === "gone"
						? new AppError("File not found", ErrorCode.NotFound)
						: 300,
				]),
			),
		read,
	};
	const signal = new AbortController().signal;
	const files = modelFiles(source, 600);
	const resolved = await files.resolve(
		input,
		await files.sizes(input, signal),
		signal,
	);
	// Past the budget (which the window's clearing keeps a transcript
	// within), what is left out is the newest image, as text, never read; an
	// earlier attachment gone degrades to text.
	expect(read.mock.calls.map(([fileId]) => fileId).sort()).toEqual([
		"mid",
		"old",
	]);
	const kinds = resolved.flatMap((item) =>
		("content" in item && Array.isArray(item.content)
			? item.content
			: "output" in item && Array.isArray(item.output)
				? item.output
				: []
		).map((part) => ("type" in part ? part.type : "")),
	);
	expect(kinds).toEqual([
		"input_image",
		"input_text",
		"input_image",
		"input_text",
		"input_text",
	]);
	// The current input's own attachment must be readable.
	const current: ModelInput = [{ role: "user", content: [image("gone")] }];
	await expect(
		files.resolve(current, await files.sizes(current, signal), signal),
	).rejects.toMatchObject({ code: ErrorCode.NotFound });
});

test("a request the provider refused for now closes its step and leaves the run ready to try again", async () => {
	const checkpoints: LoopCheckpoint[] = [];
	const saveCheckpoint = async (checkpoint: LoopCheckpoint) => {
		checkpoints.push(structuredClone(checkpoint));
	};
	const refusal = new ModelRequestRefused("The model provider refused", {
		cause: new Error("HTTP 429"),
	});
	await expect(
		consume(
			agentLoop(
				[{ role: "user", content: "Help" }],
				new AbortController().signal,
				// Refused before any event.
				() => ({
					[Symbol.asyncIterator]: () => ({
						next: () => Promise.reject(refusal),
					}),
				}),
				context,
				noTools,
				{ complete: noCompletion, saveCheckpoint },
			),
		),
	).rejects.toBe(refusal);
	const refused = checkpoints.at(-1);
	if (!refused) throw new Error("expected a checkpoint");
	expect(checkpoints.map((checkpoint) => checkpoint.phase)).toEqual([
		"ready",
		"model",
		"ready",
	]);
	expect(refused.steps).toEqual([
		{
			index: 1,
			kind: "model",
			status: "failed",
			error: "The model provider refused",
		},
	]);
	// Nothing was done, so it is no progress: failing again counts.
	expect(recordsOutcome(refused)).toBe(false);
	// The next execution makes the request again, as a new step.
	const ended: StepUpdate[][] = [];
	const result = await consume(
		agentLoop(
			[],
			new AbortController().signal,
			async function* (input) {
				expect(input).toEqual([{ role: "user", content: "Help" }]);
				yield* modelEvents(response());
			},
			context,
			noTools,
			{
				checkpoint: refused,
				saveCheckpoint,
				async complete(steps) {
					ended.push(steps);
				},
			},
		),
	);
	expect(result.reason).toBe(StopReason.MODEL_COMPLETE);
	expect(ended).toEqual([
		[expect.objectContaining({ index: 2, kind: "model", status: "completed" })],
	]);
});

test("what each request carries around the transcript is sent, never kept in it", async () => {
	const inputs: ModelInput[] = [];
	const checkpoints: LoopCheckpoint[] = [];
	const replies = [
		toolCallResponse([{ id: "a", name: "lookup", arguments: '{"q":"x"}' }]),
		response(),
	];
	await consume(
		agentLoop(
			[{ role: "user", content: "Help" }],
			new AbortController().signal,
			async function* (input) {
				inputs.push(input);
				yield* modelEvents(replies[inputs.length - 1]);
			},
			{
				...context,
				before: [{ role: "user", content: "memory" }],
				after: [{ role: "developer", content: "format" }],
			},
			localToolSet([tool("lookup", true, async () => ({ output: "found" }))]),
			{
				complete: noCompletion,
				async saveCheckpoint(checkpoint) {
					checkpoints.push(structuredClone(checkpoint));
				},
			},
		),
	);
	// Memory opens the cached prefix; the reply format closes each request.
	expect(inputs[0]).toEqual([
		{ role: "user", content: "memory" },
		{ role: "user", content: "Help" },
		{ role: "developer", content: "format" },
	]);
	expect(inputs[1][0]).toEqual({ role: "user", content: "memory" });
	expect(inputs[1].at(-1)).toEqual({ role: "developer", content: "format" });
	// The second request starts with all the first sent before its end.
	expect(inputs[1].slice(0, 2)).toEqual(inputs[0].slice(0, 2));
	expect(JSON.stringify(checkpoints)).not.toContain("memory");
	expect(JSON.stringify(checkpoints)).not.toContain("format");
});

test("past the file budget a run clears its oldest images, keeps the newest, and keeps the prefix after", async () => {
	const shots = 4;
	const replies = [
		...Array.from({ length: shots }, (_, index) =>
			toolCallResponse([
				{ id: `s${index + 1}`, name: "screenshot", arguments: "{}" },
			]),
		),
		response(),
	];
	const inputs: ModelInput[] = [];
	let taken = 0;
	await consume(
		agentLoop(
			[{ role: "user", content: "Browse" }],
			new AbortController().signal,
			async function* (input) {
				inputs.push(structuredClone(input));
				yield* modelEvents(replies[inputs.length - 1]);
			},
			{ ...context, window: { ...policy, fileBytes: 1000 } },
			localToolSet([
				tool("screenshot", true, async () => {
					taken++;
					return {
						output: "Took a screenshot",
						images: [
							{
								id: `shot-${taken}`,
								mimeType: "image/png",
								fileName: `shot-${taken}.png`,
								size: 300n,
							},
						],
					};
				}),
			]),
			{ complete: noCompletion, saveCheckpoint: async () => {} },
			modelFiles(
				{
					sizes: async (ids) => new Map(ids.map((id) => [id, 300])),
					read: async (id) => imageData(id),
				},
				1000,
			),
		),
	);
	const images = (input: ModelInput) =>
		input.flatMap((item) =>
			"type" in item &&
			item.type === "function_call_output" &&
			Array.isArray(item.output)
				? item.output.flatMap((part) =>
						part.type === "input_image"
							? [part.image_url]
							: part.type === "input_text" && part.text === clearedToolImage
								? ["cleared"]
								: [],
					)
				: [],
		);
	expect(images(inputs[2])).toEqual([imageData("shot-1"), imageData("shot-2")]);
	// Three images reach the trigger (80% of 1000 bytes): the oldest are
	// cleared down to the target (20%), except the one not yet seen.
	expect(images(inputs[3])).toEqual([
		"cleared",
		"cleared",
		imageData("shot-3"),
	]);
	expect(images(inputs[4])).toEqual([
		"cleared",
		"cleared",
		imageData("shot-3"),
		imageData("shot-4"),
	]);
	// Below the trigger again, the next request only grows at its end.
	expect(inputs[4].slice(0, inputs[3].length)).toEqual(inputs[3]);
});

// A reply that asks for two calls: a note saved, then an email sent, which
// needs the person's consent.
function consentFixture() {
	const ran: string[] = [];
	const tool = (name: string, consent: boolean): LocalTool => ({
		name,
		description: name,
		parameters: { type: "object", properties: {}, additionalProperties: false },
		readOnly: false,
		concurrent: false,
		...(consent ? { consent } : {}),
		async execute() {
			ran.push(name);
			return { output: `${name} done` };
		},
	});
	const calls: ModelResponse = {
		...response(),
		output: ["note", "send"].map((name) => ({
			type: "function_call",
			id: `item-${name}`,
			call_id: `call-${name}`,
			name,
			arguments: "{}",
			status: "completed",
		})),
	};
	return {
		ran,
		tools: localToolSet([tool("note", false), tool("send", true)]),
		calls,
	};
}

test("a call that needs consent stops the loop without running, after the calls before it", async () => {
	const { ran, tools, calls } = consentFixture();
	const checkpoints: LoopCheckpoint[] = [];
	const requests: ModelInput[] = [];
	const result = await consume(
		agentLoop(
			[{ role: "user", content: "Save a note, then send it" }],
			new AbortController().signal,
			async function* (input) {
				requests.push(input);
				yield* modelEvents(calls);
			},
			context,
			tools,
			{
				complete: noCompletion,
				async saveCheckpoint(checkpoint) {
					checkpoints.push(structuredClone(checkpoint));
				},
			},
		),
	);
	expect(result.reason).toBe(StopReason.WAITING);
	expect(ran).toEqual(["note"]);
	expect(requests).toHaveLength(1);
	// The request is saved with the boundary the next execution starts from.
	const last = checkpoints.at(-1)!;
	expect(last.phase).toBe("tools");
	expect(last.pendingCalls).toMatchObject([
		{ callId: "call-send", started: false, consent: "requested" },
	]);
	expect(last.steps).toEqual([
		{
			index: 3,
			kind: "tool",
			toolName: "send",
			status: "pending",
			consent: "requested",
		},
	]);
	// The conversation shows the call as waiting.
	expect(
		result.events
			.filter((event) => event.type === "toolCall")
			.map((event) => [event.callId, event.consent]),
	).toEqual([
		["call-note", undefined],
		["call-send", undefined],
		["call-send", "requested"],
	]);
});

test("an answered call runs once when approved, never when refused, and waits on when unanswered", async () => {
	const waitingAt = async () => {
		const { ran, tools, calls } = consentFixture();
		const checkpoints: LoopCheckpoint[] = [];
		await consume(
			agentLoop(
				[{ role: "user", content: "Save a note, then send it" }],
				new AbortController().signal,
				async function* () {
					yield* modelEvents(calls);
				},
				context,
				tools,
				{
					complete: noCompletion,
					async saveCheckpoint(checkpoint) {
						checkpoints.push(structuredClone(checkpoint));
					},
				},
			),
		);
		ran.length = 0;
		return { ran, tools, checkpoint: checkpoints.at(-1)! };
	};
	const resume = async (consent: "requested" | "granted" | "refused") => {
		const { ran, tools, checkpoint } = await waitingAt();
		const requests: ModelInput[] = [];
		const saved: LoopCheckpoint[] = [];
		const result = await consume(
			agentLoop(
				[],
				new AbortController().signal,
				async function* (input) {
					requests.push(structuredClone(input));
					yield* modelEvents(response());
				},
				context,
				tools,
				{
					checkpoint: {
						...checkpoint,
						pendingCalls: checkpoint.pendingCalls?.map((call) => ({
							...call,
							consent,
						})),
					},
					complete: noCompletion,
					async saveCheckpoint(next) {
						saved.push(structuredClone(next));
					},
				},
			),
		);
		const answer = requests[0]?.find(
			(item) =>
				"type" in item &&
				item.type === "function_call_output" &&
				item.call_id === "call-send",
		);
		return { ran, result, requests, saved, answer };
	};

	const approved = await resume("granted");
	expect(approved.result.reason).toBe(StopReason.MODEL_COMPLETE);
	expect(approved.ran).toEqual(["send"]);
	expect(approved.answer).toMatchObject({ output: "send done" });

	const refused = await resume("refused");
	expect(refused.result.reason).toBe(StopReason.MODEL_COMPLETE);
	expect(refused.ran).toEqual([]);
	// The model reads that it did not happen, and why.
	expect(refused.answer).toMatchObject({
		output: expect.stringContaining("did not approve"),
	});

	const unanswered = await resume("requested");
	expect(unanswered.result.reason).toBe(StopReason.WAITING);
	expect(unanswered.ran).toEqual([]);
	expect(unanswered.requests).toEqual([]);
	// Asked once: waiting on saves nothing new.
	expect(unanswered.saved).toEqual([]);
});
