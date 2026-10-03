// A transient failure (database, storage, a model request the provider
// refused for now) the actor retries with backoff.
export class DeferredExecutionError extends Error {
	constructor(options: { cause: unknown }) {
		super("Run execution deferred after a transient failure", options);
		this.name = "DeferredExecutionError";
	}
}

// Runs have no time budget, so repeated transient failures need their own
// bound: this many consecutive executions failing without progress end the
// run (RunActor). An execution that dies with its isolate counts too.
export const maxConsecutiveFailures = 5;
