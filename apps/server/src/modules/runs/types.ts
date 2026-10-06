import type { ReasoningEffort } from "@/config";
import type { Message, MessagePart } from "@/modules/threads/types";

export { StopReason } from "@/runtime/types";

export enum RunStatus {
	UNSPECIFIED = 0,
	QUEUED = 1,
	RUNNING = 2,
	COMPLETED = 3,
	CANCELLED = 4,
	FAILED = 5,
	// 6 is retired (formerly LIMIT_REACHED).
}

export const isActiveRun = (status: RunStatus): boolean =>
	status === RunStatus.QUEUED || status === RunStatus.RUNNING;

// Public execution state is independent of its database record and checkpoint.
export interface Run {
	id: string;
	threadId: string;
	requestId: string;
	turnId: string;
	attempt: number;
	model: string;
	deviceId?: string | null;
	reasoningEffort: ReasoningEffort | null;
	status: RunStatus;
	createdAt: Date;
	startedAt: Date | null;
	finishedAt: Date | null;
	cancelRequested: boolean;
}

export interface RunInput {
	requestId: string;
	// A catalog model id; empty uses the default (new turn) or the previous
	// attempt's model (retry).
	modelId: string;
	// One of the model's efforts; absent uses its default (new turn) or the
	// previous attempt's when the model accepts it (retry).
	reasoningEffort?: ReasoningEffort;
	input:
		| {
				case: "newTurn";
				value: {
					threadId: string;
					text: string;
					fileIds: string[];
					deviceId?: string;
					// Given by a schedule's wake-up, never by a person's request.
					scheduled?: boolean;
				};
		  }
		| { case: "retryTurn"; value: { turnId: string; previousRunId: string } };
}

export interface RunContext {
	userId: string;
	signal: AbortSignal;
	// Keeps work the answer does not wait for going after the response
	// (the Worker's `waitUntil`).
	afterResponse: (work: Promise<unknown>) => void;
}

export type RunLookup = { runId?: string; requestId?: string };

export interface RunSnapshot {
	run: Run;
	inputMessage: Message;
	outputMessage: Message;
	revision: number;
}

export type PartChange =
	| { type: "part"; part: MessagePart }
	| { type: "textDelta"; partId: string; text: string };

export interface RunChange {
	revision: number;
	run: Run;
	changes: PartChange[];
	outputUpdatedAt: Date;
}

export type RunEvent = { runId: string } & (
	| { type: "snapshot"; snapshot: RunSnapshot }
	| { type: "change"; change: RunChange }
);

// How long accepting a run may take (prepareRun's transaction_timeout); its
// actor, armed before, wakes only after this (runs/delivery.ts).
export const acceptanceTimeoutMs = 30_000;
