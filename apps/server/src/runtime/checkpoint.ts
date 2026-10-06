import type { ModelInput } from "./responses/types";
import type { Consent, PendingToolCall } from "./tools";
import type { Omitted } from "./window";

export interface StepUpdate {
	// Stable, 1-based operation identity within this execution; resuming the
	// checkpoint never allocates a new index. Persistence assigns the private record ID.
	index: number;
	kind: "model" | "tool";
	status: "pending" | "running" | "completed" | "failed";
	// TOOL steps.
	toolName?: string;
	// A pending call the person was asked about, and their answer once given.
	consent?: Consent;
	// MODEL steps.
	responseId?: string;
	// Omitted means the provider did not report a valid count.
	inputTokens?: number;
	outputTokens?: number;
	error?: string;
}

// Private execution state. Persist it separately from public Run/Message data.
// - ready: the next operation is a model request.
// - model: a model request may be in flight; its outcome is unknown.
// - tools: `pendingCalls` are requested and not yet answered in `messages`.
//   One of them may be waiting for the person's consent: the execution ends
//   there without ending the run, and the next one goes on from it once they
//   have answered.
// A run that ends has no checkpoint: its final state is the run's own.
export interface LoopCheckpoint {
	version: 4;
	phase: "ready" | "model" | "tools";
	// The transcript in the window; `omitted` is what has slid out of it.
	messages: ModelInput;
	omitted?: Omitted;
	// Measured on the last model request; see LoopContext.
	tokensPerChar?: number;
	// The highest step index allocated so far.
	lastStepIndex: number;
	// Steps whose state changed at this boundary.
	steps?: StepUpdate[];
	pendingCalls?: PendingToolCall[];
}

export interface LoopPersistence {
	checkpoint?: LoopCheckpoint;
	// Saves a boundary; the next operation starts only once it is saved.
	saveCheckpoint: (checkpoint: LoopCheckpoint) => Promise<void>;
	// The model answered. Durably seals its output and final steps; the owner
	// confirms the historical archive before publishing a terminal Run.
	complete: (steps: StepUpdate[]) => Promise<void>;
}

export class InterruptedOperationError extends Error {
	constructor() {
		super("Interrupted model operation cannot be replayed");
		this.name = "InterruptedOperationError";
	}
}

// Whether a boundary records what an operation did: a model's response, or a
// tool call's result (a failed call's too, which the model reads). The
// intent to call the model, and a request the provider refused, record
// nothing: an execution that saves only those has not moved the run on.
export const recordsOutcome = (checkpoint: LoopCheckpoint) =>
	(checkpoint.steps ?? []).some((step) =>
		step.kind === "tool"
			? step.status === "completed" || step.status === "failed"
			: step.status === "completed",
	);
