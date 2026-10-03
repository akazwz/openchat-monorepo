import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { RunActor } from "@/modules/runs/actor";
import {
	DeferredExecutionError,
	maxConsecutiveFailures,
} from "@/modules/runs/execution-errors";
import { RunStatus } from "@/modules/runs/types";

const fake = vi.hoisted(() => ({
	execute: undefined as
		| ((signal: AbortSignal, progressed: () => void) => Promise<void>)
		| undefined,
	// The run's persisted status; an attempt that finishes the run sets it.
	status: 2,
	published: [] as string[],
	publish: undefined as (() => Promise<void>) | undefined,
	// Runs ended for failing repeatedly, with why.
	abandoned: [] as { id: string; error: string }[],
	// No such run: its acceptance never committed.
	missing: false,
	sealed: false,
	archiveFailures: 0,
}));
vi.mock("@/db/client", () => ({
	createDatabase: () => ({ db: {}, close: async () => {} }),
}));
vi.mock("@/modules/runs/store", () => ({
	getRunById: async (_db: unknown, id: string) =>
		fake.missing ? undefined : { id, userId: "owner", status: fake.status },
}));
vi.mock("@/modules/runs/service", () => ({
	publishRunState: async (_db: unknown, run: { id: string }) => {
		await fake.publish?.();
		fake.published.push(run.id);
	},
}));
vi.mock("@/modules/runs/driver", () => ({
	executeRun: (
		_db: unknown,
		_runId: string,
		signal: AbortSignal,
		_local: unknown,
		progressed: () => void,
	) => fake.execute!(signal, progressed),
}));

vi.mock("@/modules/runs/records", () => ({
	loadRunMessages: async () => ({ input: {}, output: {} }),
}));
vi.mock("@/modules/runs/local-storage", () => ({
	LocalRunStorage: class {
		constructor(_storage: DurableObjectStorage) {}
		#state: { run: { id: string; status: number }; seal?: boolean } | undefined;
		state() {
			if (this.#state) this.#state.seal = fake.sealed;
			return this.#state;
		}
		async initialize(run: { id: string; status: number }) {
			this.#state = { run };
		}
		async resolvePending() {
			return false;
		}
		async observeControl() {
			return undefined;
		}
		checkpoint() {
			return undefined;
		}
		async save(_db: unknown, batch: { run: { id: string; error: string } }) {
			fake.abandoned.push({ id: batch.run.id, error: batch.run.error });
			fake.status = RunStatus.FAILED;
		}
		async archive() {
			if (fake.archiveFailures > 0) {
				fake.archiveFailures--;
				throw new Error("archive unavailable");
			}
			if (fake.sealed) fake.status = RunStatus.COMPLETED;
		}
	},
}));

// An object's storage, which outlives the instance using it: a new instance
// over the same storage is the object restarted (its isolate died).
function objectStorage() {
	const values = new Map<string, unknown>();
	let alarm: number | null = null;
	const storage = {
		get: async (key: string) => values.get(key),
		put: async (key: string, value: unknown) => {
			values.set(key, value);
		},
		getAlarm: async () => alarm,
		setAlarm: async (time: number) => {
			alarm = time;
		},
		deleteAll: async () => {
			values.clear();
		},
		deleteAlarm: async () => {
			alarm = null;
		},
		transaction: async <T>(fn: (txn: unknown) => Promise<T>) => fn(storage),
	};
	return { storage, alarm: () => alarm };
}
function actor(stored = objectStorage()) {
	const { storage } = stored;
	const ctx = {
		id: { equals: () => true },
		storage,
		exports: { RunActor: { idFromName: () => ({}) } },
	};
	const env = { RUN_ACTORS: { idFromName: () => ({}) } };
	return {
		actor: new RunActor(
			ctx as unknown as DurableObjectState,
			env as unknown as Env,
		),
		alarm: stored.alarm,
		stored,
	};
}

beforeEach(() => {
	fake.status = RunStatus.RUNNING;
	fake.published = [];
	fake.publish = undefined;
	fake.abandoned = [];
	fake.missing = false;
	fake.sealed = false;
	fake.archiveFailures = 0;
	fake.execute = undefined;
	vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	vi.useRealTimers();
});

// The run executes in the background of its wakeup; this lets it settle.
const settled = () => new Promise((resolve) => setTimeout(resolve));
async function wake(runActor: RunActor) {
	await runActor.alarm();
	await settled();
}

test("a run executes in the background; beats keep its object alive and never start it twice", async () => {
	const { actor: runActor, alarm } = actor();
	await runActor.ensure("run-1");
	let finish!: () => void;
	fake.execute = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				finish = () => {
					fake.status = RunStatus.COMPLETED;
					resolve();
				};
			}),
	);
	await wake(runActor);
	expect(fake.execute).toHaveBeenCalledOnce();
	expect(alarm()).toBe(Date.now() + 30_000);
	await wake(runActor);
	expect(fake.execute).toHaveBeenCalledOnce();
	expect(alarm()).toBe(Date.now() + 30_000);
	finish();
	await settled();
	expect(fake.published).toEqual(["run-1"]);
	expect(alarm()).toBeNull();
});

test("a stop reaches the running execution at once", async () => {
	const { actor: runActor, alarm } = actor();
	await runActor.ensure("run-1");
	fake.execute = (signal) =>
		new Promise<void>((resolve) => {
			signal.addEventListener("abort", () => {
				fake.status = RunStatus.CANCELLED;
				resolve();
			});
		});
	await wake(runActor);
	await runActor.cancel("run-1");
	await settled();
	expect(fake.published).toEqual(["run-1"]);
	expect(alarm()).toBeNull();
});

test("a failed execution backs off before its next wakeup; progress starts the count again", async () => {
	const { actor: runActor, alarm } = actor();
	await runActor.ensure("run-1");
	fake.execute = async () => {
		throw new Error("database unavailable");
	};
	await wake(runActor);
	expect(alarm()).toBe(Date.now() + 2_000);
	await wake(runActor);
	expect(alarm()).toBe(Date.now() + 4_000);
	fake.execute = async (_signal, progressed) => {
		progressed();
		throw new DeferredExecutionError({ cause: new Error("again") });
	};
	await wake(runActor);
	expect(alarm()).toBe(Date.now() + 2_000);
});

test("a finished run's final state is published before its wakeup retires; a failed publish keeps it", async () => {
	const { actor: runActor, alarm } = actor();
	await runActor.ensure("run-1");
	fake.execute = async () => {
		fake.status = RunStatus.COMPLETED;
	};
	fake.publish = async () => {
		throw new Error("hub unreachable");
	};
	await wake(runActor);
	expect(fake.published).toEqual([]);
	expect(alarm()).toBe(Date.now() + 2_000);
	// The next wakeup finds the run finished and only publishes its state.
	fake.execute = async () => {
		throw new Error("a finished run is not executed again");
	};
	fake.publish = undefined;
	await wake(runActor);
	expect(fake.published).toEqual(["run-1"]);
	expect(alarm()).toBeNull();
});

test("a run whose executions keep failing ends instead of retrying forever", async () => {
	const { actor: runActor, alarm } = actor();
	await runActor.ensure("run-1");
	// Loading the run fails the same way every time (a broken query).
	fake.execute = async () => {
		throw new Error("column reference is ambiguous");
	};
	for (let attempt = 1; attempt < maxConsecutiveFailures; attempt++) {
		await wake(runActor);
		expect(alarm()).toBeGreaterThan(Date.now());
	}
	await wake(runActor);
	expect(fake.abandoned).toEqual([]);
	// The last failure wakes it at once: it is ended, its final state goes
	// out, and the wakeup retires.
	expect(alarm()).toBe(Date.now());
	await wake(runActor);
	expect(fake.abandoned).toEqual([
		{ id: "run-1", error: "The run failed repeatedly. Please retry." },
	]);
	expect(fake.published).toEqual(["run-1"]);
	expect(alarm()).toBeNull();
});

test("an execution that dies with its isolate counts as failed, so one that keeps killing it ends the run", async () => {
	const stored = objectStorage();
	await actor(stored).actor.ensure("run-1");
	// Out of memory: the execution never settles, and the next beat finds a
	// new instance with no execution in it.
	const started = vi.fn();
	fake.execute = () => {
		started();
		return new Promise<void>(() => {});
	};
	for (let attempt = 1; attempt <= maxConsecutiveFailures; attempt++)
		await wake(actor(stored).actor);
	expect(started).toHaveBeenCalledTimes(maxConsecutiveFailures);
	expect(fake.abandoned).toEqual([]);
	await wake(actor(stored).actor);
	expect(started).toHaveBeenCalledTimes(maxConsecutiveFailures);
	expect(fake.abandoned).toEqual([
		{ id: "run-1", error: expect.stringContaining("stopped repeatedly") },
	]);
	expect(fake.published).toEqual(["run-1"]);
	expect(stored.alarm()).toBeNull();
});

test("a sealed run keeps retrying its archive beyond the execution failure cap", async () => {
	const { actor: runActor, alarm } = actor();
	await runActor.ensure("run-1");
	fake.archiveFailures = maxConsecutiveFailures + 3;
	fake.execute = vi.fn(async () => {
		fake.sealed = true;
	});
	for (let attempt = 0; attempt < maxConsecutiveFailures + 3; attempt++) {
		await wake(runActor);
		expect(alarm()).toBeGreaterThan(Date.now());
	}
	await wake(runActor);
	expect(fake.execute).toHaveBeenCalledOnce();
	expect(fake.abandoned).toEqual([]);
	expect(fake.published).toEqual(["run-1"]);
	expect(alarm()).toBeNull();
});

test("an execution that dies after progress starts the count again", async () => {
	const stored = objectStorage();
	await actor(stored).actor.ensure("run-1");
	let progress = true;
	fake.execute = (_signal, progressed) => {
		if (progress) progressed();
		return new Promise<void>(() => {});
	};
	// A long run whose isolate is restarted by deploys, each time after it
	// moved on, is never ended for it.
	for (let attempt = 1; attempt <= maxConsecutiveFailures * 2; attempt++)
		await wake(actor(stored).actor);
	expect(fake.abandoned).toEqual([]);
	// Without progress, it takes the full count.
	progress = false;
	for (let attempt = 1; attempt < maxConsecutiveFailures; attempt++)
		await wake(actor(stored).actor);
	expect(fake.abandoned).toEqual([]);
	await wake(actor(stored).actor);
	expect(fake.abandoned).toHaveLength(1);
});

// A run's actor is armed before the run is accepted, so a committed run runs
// even if the dispatch after its commit is lost.
test("an actor armed before acceptance starts at once when dispatched, and forgets a run never accepted", async () => {
	const dispatched = actor();
	await dispatched.actor.ensure("run-1", 60_000);
	expect(dispatched.alarm()).toBe(Date.now() + 60_000);
	await dispatched.actor.ensure("run-1");
	expect(dispatched.alarm()).toBe(Date.now());

	const abandoned = actor();
	await abandoned.actor.ensure("run-2", 60_000);
	fake.missing = true;
	fake.execute = vi.fn(async () => {});
	await wake(abandoned.actor);
	expect(fake.execute).not.toHaveBeenCalled();
	expect(fake.published).toEqual([]);
	expect(abandoned.alarm()).toBeNull();
});
