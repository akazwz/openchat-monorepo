import { APIError } from "openai";
import { Stream } from "openai/core/streaming";
import type {
	FunctionTool,
	ResponseCreateParamsStreaming,
	ResponseOutputItem,
	ResponseStreamEvent,
} from "openai/resources/responses/responses";
import type { ReasoningEffort } from "openai/resources/shared";

import {
	apiErrorDetails,
	GatewayError,
	providerErrorDetails,
	responseDetails,
} from "@/lib/error-details";
import { sendModelRequest } from "@/lib/openai";

import { ResponsesOutput } from "./output";
import { ModelRequestRefused, type StreamResponse } from "./types";

interface CloudflareResponsesOptions {
	model: string;
	userId: string;
	runId: string;
	// The conversation, as the prompt cache key of its requests. Without one
	// the provider routes a request by its first tokens, the instructions and
	// tools every conversation shares, so all of them would crowd the same
	// cache; with it, each conversation's requests go where its prefix is.
	threadId: string;
	gatewayId: string;
	// Fixed for the conversation, so it opens every request's cached prefix.
	instructions: string;
	tools: FunctionTool[];
	// Omitted for models without a reasoning effort control.
	reasoningEffort?: ReasoningEffort;
}

// Whether the provider may take a request it refused if it is made again
// later: it says so, or the refusal is a timeout, a conflict, a rate limit or
// its own failure. These are the refusals the OpenAI SDK retries itself.
function mayPass(response: Response) {
	const asked = response.headers.get("x-should-retry");
	if (asked === "true" || asked === "false") return asked === "true";
	return (
		response.status === 408 ||
		response.status === 409 ||
		response.status === 429 ||
		response.status >= 500
	);
}

// A streamed Responses call through the AI binding (lib/openai.ts), read with
// the OpenAI SDK's own stream decoder. The body goes to the binding as the
// object it is, not through the SDK's client, which would serialize it for
// the binding to parse and serialize again: with the files a request carries,
// each copy is megabytes. The SDK's retries go with it: a refusal is retried
// by the run instead (ModelRequestRefused).
export function createCloudflareResponses(
	options: CloudflareResponsesOptions,
): StreamResponse {
	// "none" asks the model not to reason at all.
	const reasons =
		options.reasoningEffort !== undefined && options.reasoningEffort !== "none";
	return async function* streamResponse(input, { modelStep, signal }) {
		const context = {
			runId: options.runId,
			step: modelStep,
			model: options.model,
			gateway: options.gatewayId,
		};
		const body: ResponseCreateParamsStreaming & { model: string } = {
			model: options.model,
			input,
			instructions: options.instructions,
			// No output cap: the model's own limit applies.
			tools: options.tools,
			tool_choice: "auto",
			parallel_tool_calls: true,
			...(options.reasoningEffort
				? {
						reasoning: {
							effort: options.reasoningEffort,
							context: "current_turn",
							// A summary of the reasoning, shown to people.
							...(reasons ? { summary: "auto" as const } : {}),
						},
					}
				: {}),
			// Carries the reasoning to the run's next request.
			...(reasons ? { include: ["reasoning.encrypted_content"] } : {}),
			store: false,
			safety_identifier: options.userId,
			prompt_cache_key: options.threadId,
			stream: true,
		};
		let response: Response;
		try {
			response = await sendModelRequest(body, {
				metadata: { run_id: options.runId, step: modelStep },
				signal,
			});
		} catch (error) {
			if (signal.aborted) throw error;
			// No answer came, so nothing was received from the model; the
			// OpenAI SDK sent such a request again too.
			throw new ModelRequestRefused("AI Gateway invocation failed", {
				cause: new GatewayError(
					"AI Gateway invocation failed",
					{ ...context, phase: "request" },
					{ cause: error },
				),
			});
		}
		const upstream = responseDetails(response);
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			let payload: unknown = text;
			try {
				payload = JSON.parse(text);
			} catch {}
			const refusal = new GatewayError("AI Gateway refused the request", {
				...context,
				phase: "request",
				...upstream,
				provider: providerErrorDetails(payload),
			});
			if (mayPass(response))
				throw new ModelRequestRefused(
					`The model provider refused the request (HTTP ${response.status})`,
					{ cause: refusal },
				);
			throw refusal;
		}
		// Stops reading the stream when the run stops.
		const controller = new AbortController();
		const stop = () => controller.abort(signal.reason);
		signal.addEventListener("abort", stop, { once: true });
		try {
			const stream = Stream.fromSSEResponse<ResponseStreamEvent>(
				response,
				controller,
			);
			const completedItems = new Map<number, ResponseOutputItem>();
			const output = new ResponsesOutput();
			for await (const event of stream) {
				signal.throwIfAborted();
				for (const update of output.accept(event)) yield update;
				switch (event.type) {
					case "response.output_item.done":
						completedItems.set(event.output_index, event.item);
						break;
					case "response.completed":
					case "response.incomplete":
					case "response.failed": {
						// Full final content wins. Preserve optional native metadata seen
						// on item.done when the final envelope omits those fields.
						const finalOutput = event.response.output.map((item, index) => {
							const completed = completedItems.get(index);
							if (item.type === "reasoning" && completed?.type === "reasoning")
								return {
									...item,
									encrypted_content:
										item.encrypted_content ?? completed.encrypted_content,
								};
							if (item.type === "message" && completed?.type === "message")
								return { ...item, phase: item.phase ?? completed.phase };
							return item;
						});
						for (const update of output.finish(finalOutput)) yield update;
						yield {
							type: "response",
							response: { ...event.response, output: finalOutput },
							...(event.type === "response.failed"
								? {
										error: new GatewayError("AI Gateway response failed", {
											...context,
											phase: "stream",
											...upstream,
											provider: providerErrorDetails(event.response.error),
										}),
									}
								: {}),
						};
						return;
					}
					case "error":
						throw new GatewayError("AI Gateway stream returned an error", {
							...context,
							phase: "stream",
							...upstream,
							provider: providerErrorDetails(event),
						});
				}
			}
			signal.throwIfAborted();
			throw new Error("AI Gateway stream ended before completion");
		} catch (error) {
			// Only the execution owner classifies termination.
			if (signal.aborted || error instanceof GatewayError) throw error;
			throw new GatewayError(
				"AI Gateway stream failed",
				{
					...context,
					phase: "stream",
					...upstream,
					...(error instanceof APIError ? apiErrorDetails(error) : {}),
				},
				{ cause: error },
			);
		} finally {
			signal.removeEventListener("abort", stop);
		}
	};
}
