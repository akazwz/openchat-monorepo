import type { FileReference } from "@/modules/files/types";

import type { ModelInput } from "./responses/types";
import type { Consent, ToolSurface } from "./tools";
import type { Omitted, WindowPolicy } from "./window";

// Runtime outcomes are independent of persistence, RPC, and the chat interface.
// A run has no step, token, or time budget: it ends when the model replies
// without calling a tool, when the user stops it, or on an error. Values 2–4
// are retired (formerly budget limits). WAITING does not end the run: a call
// waits for the person's consent, and the loop goes on from its checkpoint
// once they have answered.
export enum StopReason {
	UNSPECIFIED = 0,
	MODEL_COMPLETE = 1,
	CANCELLED = 5,
	ERROR = 6,
	WAITING = 7,
}

export interface ModelText {
	id: string;
	modelMessageId: string;
	contentIndex: number;
	text: string;
	phase?: "commentary" | "final_answer";
	status: "in_progress" | "completed" | "incomplete";
	refusal: boolean;
}

// The provider's summary of one reasoning item, shown to people. The model's
// own reasoning continues through its encrypted form, never through this.
export interface ModelReasoning {
	id: string;
	text: string;
}

// A snapshot declares a model text or reasoning item before any deltas for
// it. It also carries authoritative final content when the provider completes.
export type OutputEvent =
	| { type: "textSnapshot"; text: ModelText }
	| { type: "textDelta"; textId: string; delta: string }
	| { type: "reasoningSnapshot"; reasoning: ModelReasoning }
	| { type: "reasoningDelta"; reasoningId: string; delta: string };

// A tool call the model requested and its result, as shown to the person.
// `stepIndex` is the TOOL step that carries the call.
export interface ToolCallEvent {
	type: "toolCall";
	stepIndex: number;
	callId: string;
	name: string;
	arguments: string;
	// Its tool's surface; none for a tool the run does not have.
	surface?: ToolSurface;
	// The call waits for the person's consent, or has their answer.
	consent?: Consent;
}
export interface ToolResultEvent {
	type: "toolResult";
	stepIndex: number;
	callId: string;
	name: string;
	output: string;
	isError: boolean;
	// ToolOutcome.shown and ToolOutcome.images.
	shown: FileReference[];
	images: FileReference[];
}

export type LoopEvent =
	| OutputEvent
	| ToolCallEvent
	| ToolResultEvent
	// The input tokens per character a request measured, for the estimates
	// of the requests after it (and of the conversation's next run).
	| { type: "calibration"; tokensPerChar: number };

export interface LoopContext {
	window: WindowPolicy;
	// What every request carries around the transcript, not part of it (not
	// in checkpoints or the window): `before` it, context that holds for the
	// whole execution, in the cached prefix; `after` it, what changes between
	// executions or must come last to be followed.
	before: ModelInput;
	after: ModelInput;
	// Characters every request carries besides the transcript: instructions,
	// tool definitions, `before` and `after`.
	fixedChars: number;
	// Where the window stands when the run starts; a checkpoint's own values
	// take over on resume.
	omitted: Omitted;
	tokensPerChar: number;
	// The model reads images: those a tool showed go into its result.
	supportsImages: boolean;
}
