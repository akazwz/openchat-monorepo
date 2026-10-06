import type { ResponseFunctionToolCall } from "openai/resources/responses/responses";

import {
	InterruptedOperationError,
	type LoopCheckpoint,
	type LoopPersistence,
	type StepUpdate,
} from "./checkpoint";
import {
	type ModelFiles,
	noModelFiles,
	sendsModelFiles,
	toolResultOutput,
} from "./responses/model-files";
import {
	type ModelInput,
	ModelRequestRefused,
	type ModelResponse,
	type StreamResponse,
} from "./responses/types";
import {
	type PendingToolCall,
	refusedToolOutcome,
	resumeTool,
	runTool,
	type ToolOutcome,
	type ToolSet,
} from "./tools";
import { type LoopContext, type LoopEvent, StopReason } from "./types";
import {
	clearModelFiles,
	contextChars,
	slideWindow,
	windowNotice,
} from "./window";

const tokenCount = (value: number | undefined) =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined;
const count = (value: unknown) =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function validCheckpoint(checkpoint: LoopCheckpoint) {
	return (
		checkpoint.version === 4 &&
		count(checkpoint.lastStepIndex) &&
		Array.isArray(checkpoint.messages) &&
		["ready", "model", "tools"].includes(checkpoint.phase) &&
		(checkpoint.phase !== "tools" || Array.isArray(checkpoint.pendingCalls))
	);
}

// The kernel owns model scheduling. It knows neither a database Run nor a
// product Message. It runs until the model replies without calling a tool;
// there is no step, token, or time budget, and only cancellation (the signal)
// or an error ends it early. A call that needs the person's consent stops it
// without ending the run (StopReason.WAITING): the owner starts it again from
// the checkpoint once the answer is recorded there. The owner persists output and each awaited
// checkpoint together before allowing another operation to begin. Context and
// checkpoints hold file references; `files` builds each request's file data
// before the model boundary is committed, so a failed read never sends a
// request.
export async function* agentLoop(
	history: ModelInput,
	signal: AbortSignal,
	streamResponse: StreamResponse,
	context: LoopContext,
	tools: ToolSet,
	persistence: LoopPersistence,
	files: ModelFiles = noModelFiles,
): AsyncGenerator<LoopEvent, StopReason> {
	const checkpoint = persistence.checkpoint;
	if (checkpoint && !validCheckpoint(checkpoint))
		throw new Error("Invalid runtime checkpoint");
	if (checkpoint?.phase === "model") throw new InterruptedOperationError();
	// Items are never mutated; only the arrays are copied as they grow.
	let messages = [...(checkpoint?.messages ?? history)];
	let omitted = checkpoint?.omitted ?? context.omitted;
	let tokensPerChar = checkpoint?.tokensPerChar ?? context.tokensPerChar;
	let lastStepIndex = checkpoint?.lastStepIndex ?? 0;
	const save = (
		phase: LoopCheckpoint["phase"],
		boundary: Pick<LoopCheckpoint, "steps" | "pendingCalls">,
	) =>
		persistence.saveCheckpoint({
			version: 4,
			phase,
			messages: [...messages],
			omitted,
			tokensPerChar,
			lastStepIndex,
			...boundary,
		});

	const specOf = (name: string) =>
		tools.specs.find((candidate) => candidate.name === name);
	const readOnlyTool = (name: string) => specOf(name)?.readOnly === true;

	// Answers every pending call in the model's order and commits each result
	// before the next. Concurrent calls next to each other start together;
	// any other call waits for those before it, and those after it wait for it
	// (a snapshot after a click sees the click, a file is sent after it is
	// saved). Only read-only calls run concurrently, so of a step an
	// interrupted execution left, only the first pending call can have started
	// and be unsafe to run again (`resumed`); the rest run as new.
	// A call that needs the person's consent (docs/approvals.md) is asked
	// about when its turn comes, those before it answered: the boundary is
	// saved with the request and this returns true, the calls from it on still
	// pending. With their answer in the checkpoint, the next execution runs it
	// or tells the model it was refused, and goes on.
	async function* answer(
		calls: PendingToolCall[],
		resumed: boolean,
	): AsyncGenerator<LoopEvent, boolean> {
		const spec = (call: PendingToolCall) => specOf(call.name);
		const readOnly = (call: PendingToolCall) => spec(call)?.readOnly === true;
		const concurrent = (call: PendingToolCall) =>
			spec(call)?.concurrent === true && readOnly(call);
		const asks = (call: PendingToolCall) =>
			spec(call)?.consent === true && !readOnly(call) && !call.started;
		const started = new Map<PendingToolCall, Promise<ToolOutcome>>();
		let remaining = [...calls];
		const startCalls = async (group: PendingToolCall[]) => {
			const fresh = group.filter((call) => !call.started);
			if (!fresh.length) return;
			await save("tools", {
				steps: fresh.map((call) => ({
					index: call.stepIndex,
					kind: "tool",
					toolName: call.name,
					status: "running",
				})),
				pendingCalls: remaining.map((call) =>
					fresh.includes(call) ? { ...call, started: true } : call,
				),
			});
			for (const call of fresh) call.started = true;
			signal.throwIfAborted();
		};
		for (const [position, call] of calls.entries()) {
			signal.throwIfAborted();
			if (concurrent(call) && !started.has(call)) {
				const group: PendingToolCall[] = [];
				for (const next of calls.slice(position)) {
					if (!concurrent(next)) break;
					group.push(next);
				}
				await startCalls(group);
				for (const next of group) {
					const running = runTool(tools, next, signal);
					// Awaited in turn below; a stop before then leaves it unawaited.
					running.catch(() => {});
					started.set(next, running);
				}
			}
			const refused = asks(call) && call.consent === "refused";
			if (asks(call) && !refused && call.consent !== "granted") {
				if (call.consent !== "requested") {
					call.consent = "requested";
					yield* callEvents([call]);
					await save("tools", {
						steps: [
							{
								index: call.stepIndex,
								kind: "tool",
								toolName: call.name,
								status: "pending",
								consent: "requested",
							},
						],
						pendingCalls: remaining,
					});
				}
				return true;
			}
			const collect = resumed && call.started === true && !readOnly(call);
			if (!refused && !collect && !started.has(call)) await startCalls([call]);
			// A call that may have taken effect is collected, not repeated; when
			// that is not possible its outcome is reported as unknown. One the
			// person refused never runs.
			const outcome = refused
				? refusedToolOutcome
				: collect
					? await resumeTool(tools, call, signal)
					: await (started.get(call) ?? runTool(tools, call, signal));
			signal.throwIfAborted();
			messages = [
				...messages,
				{
					type: "function_call_output",
					call_id: call.callId,
					output: toolResultOutput(
						outcome.output,
						(outcome.images ?? []).map((image) => image.id),
						context.supportsImages,
					),
				},
			];
			remaining = remaining.filter((item) => item !== call);
			yield {
				type: "toolResult",
				stepIndex: call.stepIndex,
				callId: call.callId,
				name: call.name,
				output: outcome.output,
				isError: outcome.isError === true,
				shown: outcome.shown ?? [],
				images: outcome.images ?? [],
			};
			await save(remaining.length ? "tools" : "ready", {
				steps: [
					{
						index: call.stepIndex,
						kind: "tool",
						toolName: call.name,
						status: outcome.isError ? "failed" : "completed",
						...(outcome.isError ? { error: outcome.output } : {}),
					},
				],
				pendingCalls: remaining,
			});
		}
		return false;
	}
	const callEvents = (calls: PendingToolCall[]): LoopEvent[] =>
		calls.map((call) => ({
			type: "toolCall",
			stepIndex: call.stepIndex,
			callId: call.callId,
			name: call.name,
			arguments: call.arguments,
			surface: tools.specs.find((spec) => spec.name === call.name)?.surface,
			...(call.consent ? { consent: call.consent } : {}),
		}));

	if (!checkpoint) await save("ready", {});
	if (checkpoint?.phase === "tools") {
		const pending = checkpoint.pendingCalls ?? [];
		// Parts for these calls may not have been published before the stop.
		yield* callEvents(pending);
		if (yield* answer(pending, true)) return StopReason.WAITING;
	}
	while (true) {
		signal.throwIfAborted();
		const modelStep = lastStepIndex + 1;
		// The window slides here, before a request, and only past its trigger;
		// in between it grows at the end, which keeps the cached prefix.
		const slide = slideWindow(messages, omitted, {
			policy: context.window,
			fixedChars: context.fixedChars,
			tokensPerChar,
			readOnly: readOnlyTool,
		});
		if (slide) {
			messages = slide.items;
			omitted = slide.omitted;
		}
		// Past the file budget's trigger, the oldest files are cleared in the
		// transcript itself, so later requests keep its prefix until the next
		// clearing.
		const sizes = await files.sizes(messages, signal);
		const clearing = clearModelFiles(messages, sizes, context.window);
		if (clearing) messages = clearing.items;
		const transcript = [...windowNotice(omitted, context.window), ...messages];
		const request = await files.resolve(
			[...context.before, ...transcript, ...context.after],
			sizes,
			signal,
		);
		signal.throwIfAborted();
		// Commit intent before calling the provider. A process lost after this
		// boundary cannot know whether generation completed or was billed.
		lastStepIndex = modelStep;
		let step: StepUpdate = {
			index: modelStep,
			kind: "model",
			status: "running",
		};
		await save("model", { steps: [step] });
		let response: ModelResponse | undefined;
		let responseFailure: Error | undefined;
		const calls: ResponseFunctionToolCall[] = [];
		signal.throwIfAborted();
		try {
			for await (const event of streamResponse(request, {
				modelStep,
				signal,
			})) {
				signal.throwIfAborted();
				if (response) throw new Error("Model emitted events after completion");
				if (event.type === "response") {
					response = event.response;
					responseFailure = event.error;
				} else yield event;
			}
		} catch (error) {
			// A refusal that may pass comes before anything was generated: the
			// step closes as failed and the boundary is ready again, so the
			// owner can make the request again later. Any other failure leaves
			// the model step open: the owner ends the run and closes it
			// (failed, or cancelled when the run was stopped).
			if (error instanceof ModelRequestRefused && !signal.aborted)
				await save("ready", {
					steps: [{ ...step, status: "failed", error: error.message }],
				});
			throw error;
		}
		if (!response) {
			signal.throwIfAborted();
			throw new Error("Model returned no response");
		}
		// A received terminal envelope remains known even if cancellation arrives
		// now. Persist its actual usage; the execution owner resolves Run cancellation.
		step = {
			...step,
			responseId: response.id,
			inputTokens: tokenCount(response.usage?.input_tokens),
			outputTokens: tokenCount(response.usage?.output_tokens),
		};
		// The provider's exact count for what was just sent recalibrates the
		// estimate for this conversation, unless files were sent: their
		// tokens would inflate what a character costs.
		if (step.inputTokens && !sendsModelFiles(transcript)) {
			tokensPerChar =
				step.inputTokens / (context.fixedChars + contextChars(transcript));
			yield { type: "calibration", tokensPerChar };
		}
		if (responseFailure) throw responseFailure;
		for (const item of response.output) {
			if (item.type === "function_call") calls.push(item);
			else if (item.type !== "message" && item.type !== "reasoning")
				throw new Error("Model requested an unavailable capability");
			messages.push(item);
		}
		if (response.status !== "completed" && response.status !== "incomplete")
			throw new Error("Model response did not complete");
		// A reply cut off by the model's own output limit keeps its text, but
		// a call cut off mid-arguments cannot be run.
		if (response.status === "incomplete" && calls.length)
			throw new Error("Model response was cut off during a tool call");
		if (
			response.status === "incomplete" &&
			response.incomplete_details?.reason !== "max_output_tokens"
		)
			throw new Error("Model response is incomplete");
		step = { ...step, status: "completed" };
		if (!calls.length) {
			await persistence.complete([step]);
			return StopReason.MODEL_COMPLETE;
		}
		const pending = calls.map((call, offset): PendingToolCall => ({
			callId: call.call_id,
			name: call.name,
			arguments: call.arguments,
			stepIndex: modelStep + 1 + offset,
			started: false,
		}));
		lastStepIndex = modelStep + pending.length;
		await save("tools", {
			steps: [
				step,
				...pending.map((call): StepUpdate => ({
					index: call.stepIndex,
					kind: "tool",
					toolName: call.name,
					status: "pending",
				})),
			],
			pendingCalls: pending,
		});
		yield* callEvents(pending);
		if (yield* answer(pending, false)) return StopReason.WAITING;
	}
}
