import type { FunctionTool } from "openai/resources/responses/responses";

import { errorDetails } from "@/lib/error-details";
import { AppError } from "@/lib/errors";
import type { JsonObject } from "@/lib/json";
import type { FileReference } from "@/modules/files/types";

export interface ToolOutcome {
	// Text the model reads as the call's result.
	output: string;
	// The call failed; the model sees the message and can try another way.
	isError?: boolean;
	// Stored files the call shows the person, in the reply right after the
	// call. The model is not sent them.
	shown?: FileReference[];
	// Stored images the model reads as part of the result, after `output`.
	images?: FileReference[];
}

// Where a tool's calls do their work, which is how the app shows them: in
// this service (the web, memory, past conversations), on the user's computer,
// in the browser on its screen, or handing the person a file. The loop only
// passes it on with each call.
export type ToolSurface = "service" | "computer" | "browser" | "delivery";

// What the model is told about a tool, and all the agent loop knows of it.
export interface ToolSpec {
	name: string;
	description: string;
	// JSON Schema for the arguments object, in OpenAI strict mode (every
	// property listed in `required`, and `additionalProperties: false`) unless
	// `strict` is false: definitions we do not write ourselves (an MCP
	// server's) have optional properties.
	parameters: Record<string, unknown>;
	strict?: boolean;
	// Takes no effect: an interrupted call is safely run again. After an
	// interruption of any other call, the model is told its outcome is unknown
	// instead.
	readOnly: boolean;
	// May run at the same time as the calls next to it in one model step that
	// may too: it changes nothing they read, and reads nothing an earlier call
	// in the step could still be changing. Only a read-only call may. Any
	// other call runs alone, in the model's order. Not the same as readOnly: a
	// screenshot saved to a file is safe to take again, but must come before
	// the call that sends it.
	concurrent: boolean;
	surface: ToolSurface;
}

// A call the loop has validated and hands to an executor.
export interface ToolCall {
	callId: string;
	name: string;
	arguments: Record<string, unknown>;
}

// Where tool calls run. The loop only knows this interface: in this Worker
// (localToolSet) or on the user's computer (modules/sandbox/tools.ts); the
// user's own machines can implement it too without the loop changing.
interface ToolExecutor {
	// Undefined when the call may have taken effect but its outcome cannot be
	// had (its answer was lost): reported as unknown, never as failed, so the
	// model checks before repeating it.
	execute(
		call: ToolCall,
		signal: AbortSignal,
	): Promise<ToolOutcome | undefined>;
	// A call an earlier attempt started and did not answer: its outcome if it
	// can still be had (a command still running or finished since), otherwise
	// undefined, which reports the outcome as unknown.
	resume?(
		call: ToolCall,
		signal: AbortSignal,
	): Promise<ToolOutcome | undefined>;
	// Lets go of what this execution's calls opened (a connection) as it
	// ends, and, when the run ended with it, what the run held throughout (the
	// computer, which settings do not pull away under a run that will resume).
	// It never throws.
	close?(runEnded: boolean): Promise<void>;
}

// The tools a run offers: what the model is told, and what runs the calls.
export interface ToolSet {
	specs: readonly ToolSpec[];
	executor: ToolExecutor;
}

// A tool this Worker runs itself, so its surface is the service. Its owner
// builds it with whatever it needs (database, user); the loop never sees
// `execute`.
export interface LocalTool extends Omit<ToolSpec, "surface"> {
	execute(
		args: Record<string, unknown>,
		context: { signal: AbortSignal },
	): Promise<ToolOutcome>;
}

export function localToolSet(tools: readonly LocalTool[]): ToolSet {
	const handlers = new Map(tools.map((tool) => [tool.name, tool]));
	return {
		specs: tools.map(({ execute: _, ...spec }) => ({
			...spec,
			surface: "service",
		})),
		executor: {
			async execute(call, signal) {
				const tool = handlers.get(call.name);
				if (!tool) throw new Error(`No local handler for "${call.name}"`);
				return tool.execute(call.arguments, { signal });
			},
		},
	};
}

// A run's tools from several executors (this Worker, the user's computer):
// the model sees them as one list, and each call goes to the executor that
// declared its tool.
export function composeToolSets(sets: readonly ToolSet[]): ToolSet {
	const owners = new Map<string, ToolExecutor>();
	for (const set of sets)
		for (const spec of set.specs) {
			if (owners.has(spec.name))
				throw new Error(`Tool "${spec.name}" is declared twice`);
			owners.set(spec.name, set.executor);
		}
	return {
		specs: sets.flatMap((set) => set.specs),
		executor: {
			execute(call, signal) {
				const owner = owners.get(call.name);
				if (!owner) throw new Error(`No executor for "${call.name}"`);
				return owner.execute(call, signal);
			},
			async resume(call, signal) {
				return owners.get(call.name)?.resume?.(call, signal);
			},
			async close(runEnded) {
				await Promise.all(sets.map((set) => set.executor.close?.(runEnded)));
			},
		},
	};
}

export const toolDefinitions = (specs: readonly ToolSpec[]): FunctionTool[] =>
	specs.map((spec) => ({
		type: "function",
		name: spec.name,
		description: spec.description,
		parameters: spec.parameters,
		strict: spec.strict ?? true,
	}));

// A requested call that has not produced a result yet.
export interface PendingToolCall {
	callId: string;
	name: string;
	arguments: string;
	// The TOOL step that carries this call.
	stepIndex: number;
	// The call intent was durably committed; an external result may be unknown.
	started?: boolean;
}

const unexpectedFailure = "The tool failed unexpectedly.";

// Every failure becomes a result the model can act on; only cancellation ends
// the run. Internal error details stay out of the transcript.
// A result is stored in PostgreSQL (message parts, checkpoints), whose text
// cannot hold NUL; a command's output or a file read may have it. It becomes
// the replacement character, as undecodable bytes do.
const storable = (outcome: ToolOutcome): ToolOutcome =>
	outcome.output.includes("\u0000")
		? { ...outcome, output: outcome.output.replaceAll("\u0000", "\uFFFD") }
		: outcome;

// A call's arguments as the model wrote them (JSON text): an object, or
// undefined when they are not one.
export function parseToolArguments(text: string): JsonObject | undefined {
	try {
		const value: unknown = JSON.parse(text || "{}");
		if (value && typeof value === "object" && !Array.isArray(value))
			return value as JsonObject;
	} catch {}
	return undefined;
}
// The same arguments as people see them: text that is not an object is shown
// whole.
export const toolArguments = (text: string): JsonObject =>
	parseToolArguments(text) ?? { arguments: text };

// Runs a call, or with `resume` collects one an earlier attempt started.
// Failures become results the model reads; only a stop and the end of the
// attempt propagate.

async function invoke(
	tools: ToolSet,
	call: PendingToolCall,
	signal: AbortSignal,
	resume: boolean,
): Promise<ToolOutcome> {
	if (!tools.specs.some((spec) => spec.name === call.name))
		return { output: `Tool "${call.name}" is not available.`, isError: true };
	const args = parseToolArguments(call.arguments);
	if (!args)
		return { output: "The arguments must be a JSON object.", isError: true };
	const request = { callId: call.callId, name: call.name, arguments: args };
	try {
		const outcome = resume
			? await tools.executor.resume?.(request, signal)
			: await tools.executor.execute(request, signal);
		return storable(outcome ?? interruptedToolOutcome);
	} catch (error) {
		signal.throwIfAborted();
		if (error instanceof AppError)
			return { output: error.message, isError: true };
		// The model gets a generic message; the details go to the logs.
		console.warn("[Tool] Unexpected failure", {
			tool: call.name,
			callId: call.callId,
			...errorDetails(error),
		});
		return { output: unexpectedFailure, isError: true };
	}
}

export const runTool = (
	tools: ToolSet,
	call: PendingToolCall,
	signal: AbortSignal,
) => invoke(tools, call, signal, false);

export const resumeTool = (
	tools: ToolSet,
	call: PendingToolCall,
	signal: AbortSignal,
) => invoke(tools, call, signal, true);

const interruptedToolOutcome: ToolOutcome = {
	output:
		"This call was interrupted before its result was recorded; whether it took effect is unknown. Check before repeating it.",
	isError: true,
};
