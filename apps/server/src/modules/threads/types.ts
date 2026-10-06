import type { JsonValue } from "@/lib/json";
import type { FileReference } from "@/modules/files/types";
import type { Consent, ToolSurface } from "@/runtime/tools";

export interface Thread {
	id: string;
	title: string;
	revision: number;
	// Its last activity (threads.updatedAt): when its latest run began.
	activeAt: Date;
	// Its latest run has not finished (Thread.running in thread.proto).
	running: boolean;
	// The user's continuing conversation with the agent (threads.main).
	main: boolean;
}

export interface ToolCall {
	id: string;
	name: string;
	// As the model wrote them (JSON text), which is what it is sent back: a
	// parsed copy stored as jsonb would come back with its keys reordered and
	// its spacing lost, so later requests would differ from the prefix the
	// provider cached. People see them parsed (part-codec.ts).
	arguments: string;
	// Where it did its work (ToolSurface), recorded when it was called.
	surface?: ToolSurface;
	// The call waits for the person's consent, or has their answer
	// (docs/approvals.md).
	consent?: Consent;
}
export interface ToolResult {
	toolCallId: string;
	name: string;
	output: JsonValue;
	// A body intentionally not loaded by a summary read; never a saved result.
	outputOmitted?: boolean;
	isError: boolean;
	// Images the model read as part of the result (view_image).
	images?: FileReference[];
}
export interface MessagePart {
	id: string;
	assistantText?: {
		messageId: string;
		contentIndex: number;
		phase?: "commentary" | "final_answer";
		refusal: boolean;
		status?: "in_progress" | "completed" | "incomplete";
	};
	content:
		| { case: "text"; value: string }
		| { case: "file"; value: FileReference }
		| { case: "toolCall"; value: ToolCall }
		| { case: "toolResult"; value: ToolResult }
		| { case: "reasoning"; value: { text: string } };
}
export interface Message {
	id: string;
	threadId: string;
	turnId: string;
	runId: string | null;
	role: "user" | "assistant";
	parts: MessagePart[];
	// A user message given by a schedule's wake-up.
	scheduled?: boolean;
	createdAt: Date;
	updatedAt: Date;
}
