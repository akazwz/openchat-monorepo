import { DurableObject } from "cloudflare:workers";

import { createDatabase, type Database } from "@/db/client";
import { errorDetails } from "@/lib/error-details";
import { AppError, ErrorCode } from "@/lib/errors";
import { announce, userEvents } from "@/modules/events/publish";
import { StepStatus } from "@/modules/steps/types";
import type { PartDescriptor } from "@/modules/threads/content";
import { scanText, sliceText } from "@/modules/threads/text-source";

import { executeRun } from "./driver";
import { maxConsecutiveFailures } from "./execution-errors";
import { LocalRunStorage } from "./local-storage";
import { loadRunMessages } from "./records";
import { publishRunState } from "./service";
import { runOutcome } from "./state";
import { getRunById } from "./store";
import { StopReason } from "./types";
import { isActiveRun } from "./types";

interface RunSchedule {
	runId: string;
	// Consecutive executions that failed without progress, the one running
	// counted among them until it makes progress or ends: one that dies with
	// its isolate (out of memory, say) never gets to count itself, and would
	// otherwise be started again from the same boundary forever. It sets the
	// backoff and ends a run that keeps failing.
	failures: number;
	// Set while an execution runs. The next one finding it set knows the
	// last one never reached its end: it died with its isolate.
	running?: boolean;
}

const scheduleKey = "run-schedule";
const retryDelayMs = 2_000;
const maxRetryDelayMs = 60_000;
const maxBackoffStep = 6;
// While a run executes, its alarm beats this often. An object without an
// incoming event for 70–140 seconds is evicted, and one restarted meanwhile
// (a deploy) has lost the execution: the next beat finds none and starts it
// again from the run's last saved boundary.
const heartbeatMs = 30_000;
// Why a run that kept failing ended, for the logs (runs.error): its
// executions kept failing, or kept dying with the isolate running them.
const failedRepeatedly = "The run failed repeatedly. Please retry.";
const stoppedRepeatedly =
	"The run's server stopped repeatedly while running it, without finishing a step; a step may need more memory than the server has. Please retry.";

// One native Durable Object per Run. SQLite owns active output and recovery;
// PostgreSQL owns acceptance, controls, file pins and completed archives.
// The run executes in the object's background, not inside an alarm (whose
// handler may last at most 15 minutes): a run takes as long as it takes, and
// the alarm only wakes the object and keeps it alive.
export class RunActor extends DurableObject<Env> {
	#local?: LocalRunStorage;
	get local() {
		return (this.#local ??= new LocalRunStorage(this.ctx.storage));
	}

	#execution?: { controller: AbortController; promise: Promise<void> };

	// Wakes the run's executor at once, or after `delayMs`: a run being
	// accepted is armed before its transaction commits (turns/service.ts), so
	// a committed run always has its wakeup. A wakeup already due sooner stays.
	async ensure(runId: string, delayMs = 0): Promise<void> {
		await this.#schedule(runId, Date.now() + delayMs);
	}

	// CancelRun has committed the stop: a running execution ends at once, and
	// an idle object wakes even when it was backing off a failure.
	async cancel(runId: string): Promise<void> {
		await this.#schedule(runId, Date.now());
		this.#execution?.controller.abort();
		await this.#observeControl();
	}

	async #schedule(runId: string, at: number) {
		if (
			!runId ||
			!this.ctx.id.equals(this.ctx.exports.RunActor.idFromName(runId))
		)
			throw new Error("Run actor identity mismatch");
		await this.ctx.storage.transaction(async (storage) => {
			const schedule = await storage.get<RunSchedule>(scheduleKey);
			if (schedule && schedule.runId !== runId)
				throw new Error("Run actor identity mismatch");
			if (!schedule)
				await storage.put<RunSchedule>(scheduleKey, { runId, failures: 0 });
			// A running execution keeps its own heartbeat.
			if (this.#execution) return;
			const alarm = await storage.getAlarm();
			if (alarm === null || alarm > at) await storage.setAlarm(at);
		});
	}

	override async alarm(): Promise<void> {
		// The next beat is due before the execution starts, so a restart at any
		// point still finds its wakeup; the execution replaces it when it ends.
		await this.ctx.storage.setAlarm(Date.now() + heartbeatMs);
		if (this.#execution) {
			await this.#observeControl();
			return;
		}
		const stored = await this.ctx.storage.get<RunSchedule>(scheduleKey);
		if (!stored) {
			await this.ctx.storage.deleteAlarm();
			return;
		}
		// This execution counts as failing from its start.
		const schedule: RunSchedule = {
			runId: stored.runId,
			failures: stored.failures + 1,
			running: true,
		};
		await this.ctx.storage.put(scheduleKey, schedule);
		const controller = new AbortController();
		const execution = {
			controller,
			promise: this.#execute(schedule, stored, controller.signal),
		};
		this.#execution = execution;
		void execution.promise.finally(() => {
			if (this.#execution === execution) this.#execution = undefined;
		});
	}

	async #withRun<T>(
		userId: string | undefined,
		read: (
			db: Database,
			run: NonNullable<Awaited<ReturnType<typeof getRunById>>>,
		) => Promise<T>,
	) {
		const schedule = await this.ctx.storage.get<RunSchedule>(scheduleKey);
		const id = schedule?.runId ?? this.local.state()?.run.id;
		if (!id) throw new AppError("Run not found", ErrorCode.NotFound);
		const database = createDatabase();
		try {
			const run = await getRunById(database.db, id);
			if (!run || (userId && run.userId !== userId))
				throw new AppError("Run not found", ErrorCode.NotFound);
			return await read(database.db, run);
		} finally {
			await database.close();
		}
	}
	async #observeControl() {
		try {
			await this.#withRun(undefined, async (_db, run) => {
				if (run.cancelRequested || !isActiveRun(run.status))
					this.#execution?.controller.abort();
				const event = await this.local.observeControl(run);
				if (event) await announce(run.userId, [userEvents.run(event)]);
			});
		} catch (error) {
			if (error instanceof AppError && error.code === ErrorCode.NotFound)
				this.#execution?.controller.abort();
			else throw error;
		}
	}
	async readHead(userId: string) {
		return this.#withRun(userId, async (db, run) => {
			if (!isActiveRun(run.status)) return undefined;
			if (!this.local.state()) {
				const { input, output } = await loadRunMessages(db, run);
				await this.local.initialize(run, input, output);
			}
			const state = this.local.state()!;
			return JSON.stringify(
				{
					run: state.run,
					input: state.input,
					output: state.output,
					commitSeq: state.commitSeq,
				},
				(_key, value: unknown) =>
					typeof value === "bigint" ? value.toString() : value,
			);
		});
	}
	#readOwner(userId: string) {
		const state = this.local.state();
		if (!state || state.run.userId !== userId)
			throw new AppError("Run content is unavailable", ErrorCode.Unavailable);
		return state;
	}
	async readParts(userId: string, at: number, after: number) {
		this.#readOwner(userId);
		return this.local.partsPage(at, after).map((part) => JSON.stringify(part));
	}
	async readBody(userId: string, descriptor: string, after: number) {
		this.#readOwner(userId);
		return this.local.bodyPage(JSON.parse(descriptor) as PartDescriptor, after);
	}

	async searchText(userId: string, terms: string[]) {
		if (!(await this.readHead(userId))) return undefined;
		this.#readOwner(userId);
		return scanText(this.local.textChunks(), terms);
	}
	async readText(userId: string, offset: number, limit: number) {
		if (!(await this.readHead(userId))) return undefined;
		this.#readOwner(userId);
		return sliceText(this.local.textChunks(), offset, Math.min(limit, 40_000));
	}

	// `before`: the schedule as the executions before this one left it.
	async #execute(
		schedule: RunSchedule,
		before: RunSchedule,
		signal: AbortSignal,
	) {
		let failures = schedule.failures;
		// Progress starts a new count, with this execution the first of it
		// should it fail after all.
		const progressed = () => {
			if (failures === 1) return;
			failures = 1;
			void this.ctx.storage
				.put<RunSchedule>(scheduleKey, { ...schedule, failures })
				.catch((error: unknown) =>
					console.warn("[Run] Progress not recorded", {
						runId: schedule.runId,
						...errorDetails(error),
					}),
				);
		};
		try {
			const database = createDatabase();
			try {
				let run = await getRunById(database.db, schedule.runId);
				if (run && isActiveRun(run.status)) {
					if (!this.local.state()) {
						const { input, output } = await loadRunMessages(database.db, run);
						await this.local.initialize(run, input, output);
					}
					if (await this.local.resolvePending(database.db)) progressed();
					const event = await this.local.observeControl(run);
					if (event) await announce(run.userId, [userEvents.run(event)]);
					if (!this.local.state()?.seal) {
						if (failures > maxConsecutiveFailures) {
							const current = this.local.state()!.run;
							const reason = run.cancelRequested
								? StopReason.CANCELLED
								: StopReason.ERROR;
							await this.local.save(database.db, {
								id: crypto.randomUUID(),
								run: {
									...current,
									...runOutcome(
										reason,
										before.running ? stoppedRepeatedly : failedRepeatedly,
									),
								},
								changes: [],
								final: true,
								openStepStatus:
									reason === StopReason.CANCELLED
										? StepStatus.CANCELLED
										: this.local.checkpoint()?.phase === "model"
											? StepStatus.INTERRUPTED
											: StepStatus.FAILED,
							});
						} else
							await executeRun(
								database.db,
								run.id,
								signal,
								this.local,
								progressed,
							);
					}
					await this.local.archive(database.db);
					run = await getRunById(database.db, run.id);
				}
				// A final PG commit can outlive its acknowledgment to this actor.
				// Confirm the same seal before discarding local recovery data.
				const state = this.local.state();
				if (
					run &&
					!isActiveRun(run.status) &&
					state?.seal &&
					isActiveRun(state.run.status)
				)
					await this.local.archive(database.db);
				if (run && isActiveRun(run.status))
					throw new Error("Run execution has not reached a terminal state");
				// Devices keep showing a run as running until they see its final
				// state, so the wakeup retires only once that state is published;
				// a failed publish backs off and publishes again.
				if (run) await publishRunState(database.db, run);
			} finally {
				await database.close();
			}
			// Only a confirmed archive/missing Run can retire and remove bodies.
			await this.ctx.storage.deleteAll();
			await this.ctx.storage.deleteAlarm();
			this.#local = undefined;
		} catch (error) {
			const backoffStep = Math.min(Math.max(failures, 1), maxBackoffStep);
			// One that has failed too often is ended by the next wakeup, at
			// once; it publishes the final state.
			const delay =
				failures >= maxConsecutiveFailures && !this.local.state()?.seal
					? 0
					: Math.min(retryDelayMs * 2 ** (backoffStep - 1), maxRetryDelayMs);
			// Retry delivery, not the model operation. The next execution re-reads
			// the checkpoint; an uncertain in-flight model request is never
			// replayed.
			await this.ctx.storage.transaction(async (storage) => {
				await storage.put<RunSchedule>(scheduleKey, {
					runId: schedule.runId,
					failures,
				});
				await storage.setAlarm(Date.now() + delay);
			});
			console.warn("[Run] Execution deferred", {
				runId: schedule.runId,
				failures,
				retryInMs: delay,
				...errorDetails(error),
			});
		}
	}
}
