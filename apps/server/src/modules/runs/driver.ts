import { asc, eq } from "drizzle-orm";

import {
	agentConfig,
	cloudComputerInstructions,
	appConfig,
	defaultModel,
	findModel,
} from "@/config";
import { createDatabase, type Database } from "@/db/client";
import { threads } from "@/db/schema/threads";
import { turns } from "@/db/schema/turns";
import { errorDetails } from "@/lib/error-details";
import { AppError, ErrorCode } from "@/lib/errors";
import { announce, userEvents } from "@/modules/events/publish";
import { modelFileSource } from "@/modules/files/model";
import { fileKinds } from "@/modules/files/types";
import { fileNameOnComputer } from "@/modules/files/workspace-paths";
import { mailInstructions } from "@/modules/mail/tools";
import { memoryContext } from "@/modules/memories/tools";
import { StepStatus } from "@/modules/steps/types";
import { updateContextWindow } from "@/modules/threads/service";
import { generateThreadTitle } from "@/modules/threads/title";
import type { Message } from "@/modules/threads/types";
import {
	InterruptedOperationError,
	type LoopCheckpoint,
	recordsOutcome,
	type StepUpdate,
} from "@/runtime/checkpoint";
import { agentLoop } from "@/runtime/loop";
import { createCloudflareResponses } from "@/runtime/responses/cloudflare";
import { modelFiles } from "@/runtime/responses/model-files";
import type { ModelInput } from "@/runtime/responses/types";
import { resumeTool, toolDefinitions, type ToolSet } from "@/runtime/tools";
import {
	contextChars,
	nothingOmitted,
	type WindowPolicy,
} from "@/runtime/window";

import { DeferredExecutionError } from "./execution-errors";
import { loadHistoryWindow } from "./history-loader";
import type { LocalRunStorage, RunBatch } from "./local-storage";
import { RunOutput } from "./output";
import { runOutcome } from "./state";
import { loadRunForExecution, type RunRecord } from "./store";
import { runTools } from "./tools";
import { isActiveRun, type RunEvent, RunStatus, StopReason } from "./types";

const flushIntervalMs = 250;
// A boundary's commit is tried this many times, waiting `saveRetryMs`, then
// twice as long, and so on, in between. One that can be made again gives up
// soon: the next execution starts again from the last saved boundary.
const saveAttempts = 3;
// One that records what an operation did (a model's response, a tool's
// result) or the run's end is all there is of it: a finished response lost
// with its commit cannot be had again, since a model request whose outcome
// is unknown is not replayed. It is tried for about a minute (0.5 + 1 + … +
// 32 seconds), through a short database outage or failover.
const outcomeSaveAttempts = 8;
const saveRetryMs = 500;
const generationFailure = "Model generation failed. Please retry.";
const interruptedFailure =
	"Execution was interrupted on the server. Your partial reply was saved; please retry.";

// Only a run's actor calls this, in the background of its wakeup (RunActor).
// Browser requests observe output or commit a stop; they never own its
// signal. The actor aborts the signal only for a stop that is committed, so
// an aborted signal means cancelled. A transient failure before any model
// request, or a model request the provider refused for now, is thrown as a
// DeferredExecutionError: the actor retries it, and ends a run that keeps
// failing. `progressed` is told once this execution has committed an
// operation's outcome: a failure after it is not a repeat of the one before.
export async function executeRun(
	db: Database,
	runId: string,
	actorSignal: AbortSignal,
	local: LocalRunStorage,
	progressed: () => void = () => {},
) {
	// Progress reaches the user's devices after each commit, in commit order
	// (docs/sync.md), from a queue of its own: the next commit does not wait
	// for the devices to be told of the last. The queue is empty before this
	// returns, so the actor's publication of the final state comes after it
	// (it publishes that again until delivered).
	let published = Promise.resolve();
	const publishInOrder = (userId: string, event: RunEvent) => {
		published = published.then(() => announce(userId, [userEvents.run(event)]));
	};
	try {
		await execute(db, runId, actorSignal, local, publishInOrder, progressed);
	} finally {
		await published;
	}
}

async function execute(
	db: Database,
	runId: string,
	actorSignal: AbortSignal,
	local: LocalRunStorage,
	publishInOrder: (userId: string, event: RunEvent) => void,
	progressed: () => void,
) {
	const prepared = await loadRunForExecution(db, runId, {
		history: !local.state()?.checkpoint,
	});
	await local.initialize(prepared.run, prepared.input, prepared.output);
	await local.resolvePending(db);
	if (local.state()?.seal) return;
	let run = local.state()!.run;
	const announceSaved = (event: RunEvent | undefined) => {
		if (event) publishInOrder(run.userId, event);
	};
	announceSaved(await local.observeControl(prepared.run));
	run = local.state()!.run;
	if (!isActiveRun(run.status)) return;
	if (!run.cancelRequested && run.status === RunStatus.QUEUED) {
		const claimed = await local.save(db, {
			id: crypto.randomUUID(),
			run: { ...run, status: RunStatus.RUNNING, startedAt: new Date() },
			changes: [],
			final: false,
		});
		run = claimed.run;
		announceSaved(claimed.event);
	}
	const output = new RunOutput();
	const checkpoint = local.checkpoint();
	// The last committed loop phase. Until a model boundary is saved, nothing
	// has been sent to the provider and an unexpected failure can be retried.
	let savedPhase = checkpoint?.phase;
	let reportedProgress = false;
	const localAbort = new AbortController();
	const persistedStop = new AbortController();
	const signal = AbortSignal.any([
		actorSignal,
		persistedStop.signal,
		localAbort.signal,
	]);
	// A new conversation's title is written alongside its first reply, which
	// never waits for it: the title reaches devices as its own thread event.
	void titleFirstTurn(run, prepared.input, actorSignal);
	let outcome: ReturnType<typeof runOutcome> | undefined;
	// How a step still RUNNING at the terminal commit ends.
	let openStepStatus = StepStatus.FAILED;
	let cancelled = run.cancelRequested;
	let completed = false;
	let terminalObserved = false;
	let writeFailed = false;
	let writeFailure: unknown;
	let deferral: { error: unknown } | undefined;
	let writes = Promise.resolve();
	let outputUpdates = 0;
	let persistedOutputUpdates = 0;
	let scheduledFlush = false;
	let closing = false;
	let measuredTokensPerChar: number | undefined;
	let pendingSave: RunBatch | undefined;

	// Operation boundaries read PostgreSQL controls. Stream progress remains
	// local; the actor heartbeat observes controls during a long operation.
	const observePersistedState = (current: RunRecord | undefined) => {
		if (current?.cancelRequested) {
			cancelled = true;
			run.cancelRequested = true;
			persistedStop.abort();
		}
		if (!current || !isActiveRun(current.status)) {
			terminalObserved = true;
			persistedStop.abort();
		}
	};
	// A commit is replayable: it writes the same batch ID and only its new content, steps by index,
	// and the checkpoint position, so one whose
	// answer was lost changes nothing when sent again.
	const commit = async (save: RunBatch, attempts: number) => {
		for (let attempt = 1; ; attempt++) {
			try {
				return await local.save(db, save);
			} catch (error) {
				// An AppError is the run's state (finished, not found), not a
				// passing failure.
				if (
					error instanceof AppError ||
					attempt === attempts ||
					actorSignal.aborted
				)
					throw error;
				console.warn("[Run] Save failed; retrying", {
					runId,
					...errorDetails(error),
				});
				await new Promise((done) =>
					setTimeout(done, saveRetryMs * 2 ** (attempt - 1)),
				);
			}
		}
	};
	const flush = (
		nextCheckpoint?: LoopCheckpoint,
		final = false,
		finalSteps?: StepUpdate[],
	) => {
		// A boundary (a checkpoint, the end) must be saved before the loop goes
		// on, and is tried again; progress shown in between need not: the next
		// write retries the retained batch first.
		const boundary = nextCheckpoint !== undefined || final;
		const recorded =
			final || (nextCheckpoint !== undefined && recordsOutcome(nextCheckpoint));
		const write = writes
			.then(async () => {
				// Take a detached batch after the previous write settles. At an awaited
				// checkpoint, output, counters, and native state commit atomically.
				const batchUpdates = outputUpdates;
				if (pendingSave) {
					const previous = await commit(
						pendingSave,
						boundary ? saveAttempts : 1,
					);
					announceSaved(previous.event);
					run = previous.run;
					pendingSave = undefined;
				}
				const save: RunBatch = {
					id: crypto.randomUUID(),
					run: { ...run, ...(final ? outcome : undefined) },
					changes: output.takeChanges(),
					checkpoint: nextCheckpoint,
					final,
					steps: finalSteps,
					openStepStatus,
				};
				pendingSave = save;
				const saved = await commit(
					save,
					boundary ? (recorded ? outcomeSaveAttempts : saveAttempts) : 1,
				);
				pendingSave = undefined;
				announceSaved(saved.event);
				persistedOutputUpdates = batchUpdates;
				if (nextCheckpoint) {
					savedPhase = nextCheckpoint.phase;
					if (recorded) output.releaseBoundary();
				}
				if (recorded && !final && !reportedProgress) {
					reportedProgress = true;
					progressed();
				}
				run = saved.run;
				if (!final) observePersistedState(saved.run);
			})
			.catch((error: unknown) => {
				// The run ended elsewhere (its conversation was deleted, its actor
				// ended it): nothing is left to save.
				if (
					error instanceof AppError &&
					(error.code === ErrorCode.NotFound ||
						error.code === ErrorCode.FailedPrecondition)
				) {
					terminalObserved = true;
					localAbort.abort(error);
					throw error;
				}
				if (!boundary) {
					console.warn("[Run] Progress not saved; the next write carries it", {
						runId,
						...errorDetails(error),
					});
					return;
				}
				// A boundary that cannot be saved stops this execution; the next
				// one reloads the saved projection and checkpoint from durable storage.
				writeFailed = true;
				writeFailure = error;
				localAbort.abort(error);
				throw error;
			});
		writes = write;
		return write;
	};
	// The next run's estimates start from this conversation's own ratio.
	const saveRatio = async () => {
		if (!measuredTokensPerChar) return;
		await updateContextWindow(db, run.threadId, {
			tokensPerChar: measuredTokensPerChar,
		}).catch((error) =>
			console.warn("[Run] Context window ratio not saved", {
				runId,
				...errorDetails(error),
			}),
		);
	};
	// The run's end, committed once: its state, its output, and the steps
	// that closed with it.
	const end = async (steps?: StepUpdate[]) => {
		output.finish();
		await saveRatio();
		await flush(undefined, true, steps);
	};
	const progressInterval = setInterval(() => {
		if (
			closing ||
			scheduledFlush ||
			outputUpdates === persistedOutputUpdates ||
			writeFailed
		)
			return;
		scheduledFlush = true;
		void flush()
			.catch(() => {})
			.finally(() => {
				scheduledFlush = false;
			});
	}, flushIntervalMs);

	// A run keeps its model even if the catalog later drops it, and what it
	// read: all it could.
	const model = findModel(run.model);
	const reads = model?.reads ?? fileKinds;
	let tools: ToolSet | undefined;
	const runToolSet = () => {
		tools ??= runTools(db, run, {
			readsImages: reads.includes("image"),
			activeText: { runId: run.id, local },
		});
		return tools;
	};
	try {
		if (cancelled) {
			persistedStop.abort();
			await stopStartedCall(runToolSet, checkpoint, signal);
		}
		signal.throwIfAborted();
		const tools = runToolSet();
		const definitions = toolDefinitions(tools.specs);
		const window: WindowPolicy = {
			tokens: (model ?? defaultModel()).contextWindow,
			trigger: agentConfig.window.trigger,
			target: agentConfig.window.target,
			recentToolResults: agentConfig.window.recentToolResults,
			omittedUserChars: agentConfig.window.omittedUserChars,
			fileBytes: agentConfig.limits.modelFileBytes,
		};
		const readOnly = (name: string) =>
			tools.specs.find((spec) => spec.name === name)?.readOnly === true;
		// What each request carries around the transcript. Memory, as of this
		// execution (entries written during it come back as tool results),
		// holds for all of its requests, and often for the conversation's
		// next runs: it goes before the transcript, in the cached prefix.
		// Right after the history would not do: the next run rebuilds this
		// run's items without their reasoning (runtime/adapters), so its
		// prefix ends where this run's items begin, and what was placed there
		// would be sent uncached again. It comes as the user's data, quoted,
		// in a user message rather than the developer's: an entry is what
		// someone said (or what a web page or an email got written into it),
		// never an instruction. After the transcript go the date (which
		// changes from day to day and would otherwise break the whole prefix)
		// and the mailbox's address, both short, and the reply format, which
		// the models follow only there (see agentConfig.replyFormat).
		const [memory, mail] = await Promise.all([
			memoryContext(db, run.userId),
			mailInstructions(db, run.userId),
		]);
		const before: ModelInput = [{ role: "user", content: memory }];
		const after: ModelInput = [
			{
				role: "developer",
				content: `${mail}\n\nCurrent date: ${new Date().toISOString().slice(0, 10)} (UTC).\n\n${agentConfig.replyFormat}`,
			},
		];
		const instructions = run.deviceId
			? agentConfig.instructions.replace(
					cloudComputerInstructions,
					`You are using the user's selected macOS computer (device ${run.deviceId}), with their current user permissions. It is their real computer; act only within their request. Use shell (zsh), read_file, write_file and edit_file. Commands are macOS/BSD, not GNU/Linux; inspect which tools are installed instead of assuming. The default working directory is the Heveta workspace (cwd='.'), independent of the cloud computer. Attachments are placed under this workspace at uploads/<file id>/<file name>; paths in earlier messages may refer to a different computer. Use shell to list uploads before opening attachments. This Mac's files do not expire after 30 days. send_file saves a result with the conversation and shows it to the user; view_image reads an image for you. For GUI work, take screenshot, use computer with normalized display coordinates and DOM key codes, then screenshot again to see the result. Screen Recording and Accessibility permissions are granted by the user on the Mac. GUI operations pause while a person controls the desktop. No browser DOM tools are installed on this Mac; use screenshots and native input for interactive pages, and web_fetch for reading pages. Never claim an operation succeeded without its tool result.`,
				)
			: agentConfig.instructions;
		const fixedChars =
			instructions.length +
			JSON.stringify(definitions).length +
			contextChars([...before, ...after]);
		const tokensPerChar =
			prepared.contextWindow.tokensPerChar ?? agentConfig.window.tokensPerChar;
		const windowed = checkpoint
			? undefined
			: await loadHistoryWindow(
					db,
					prepared.history,
					prepared.bodies,
					prepared.earlier,
					prepared.contextWindow,
					{
						policy: window,
						fixedChars,
						tokensPerChar,
						reads,
						readOnly,
						attachmentPath: run.deviceId
							? (file) =>
									`uploads/${file.id}/${fileNameOnComputer(file.fileName)}`
							: undefined,
					},
				);
		if (windowed?.moved)
			await updateContextWindow(db, run.threadId, windowed.moved);
		const loop = agentLoop(
			windowed?.items ?? [],
			signal,
			createCloudflareResponses({
				model: run.model,
				userId: run.userId,
				runId: run.id,
				threadId: run.threadId,
				gatewayId: appConfig.aiGatewayId,
				instructions,
				tools: definitions,
				reasoningEffort: run.reasoningEffort ?? undefined,
			}),
			{
				window,
				before,
				after,
				fixedChars,
				omitted: windowed?.omitted ?? nothingOmitted,
				tokensPerChar,
				supportsImages: reads.includes("image"),
			},
			tools,
			{
				checkpoint,
				saveCheckpoint: flush,
				complete: async (steps) => {
					outcome = runOutcome(StopReason.MODEL_COMPLETE, generationFailure);
					await end(steps);
					completed = true;
				},
			},
			// Context and checkpoints reference the files the model reads by
			// ID: the user's images and PDFs, and the images tools returned,
			// some during this run. Only the run's user's files resolve.
			modelFiles(
				modelFileSource(db, run.userId),
				agentConfig.limits.modelFileBytes,
			),
		);
		try {
			while (true) {
				const next = await loop.next();
				if (next.done) break;
				if (next.value.type === "calibration")
					measuredTokensPerChar = next.value.tokensPerChar;
				else if (
					next.value.type === "toolCall" ||
					next.value.type === "toolResult"
				) {
					output.applyTool(next.value);
					outputUpdates++;
				} else {
					output.apply(next.value);
					outputUpdates++;
				}
				if (
					outputUpdates - persistedOutputUpdates >= 100 ||
					output.pendingBytes >= 64 * 1024
				)
					await flush();
			}
		} finally {
			localAbort.abort();
			await loop.return(StopReason.ERROR);
		}
	} catch (error) {
		if (actorSignal.aborted) cancelled = true;
		if (
			!(error instanceof AppError) &&
			!(error instanceof InterruptedOperationError) &&
			!cancelled &&
			!terminalObserved &&
			!writeFailed &&
			savedPhase !== "model"
		) {
			// A database or storage failure before a model request (loading
			// history or reading images) is transient: nothing was sent or
			// billed. So is a model request the provider refused for now: the
			// loop closed its step and saved the boundary as ready again. The
			// actor backs off and resumes from the saved boundary.
			deferral = { error };
		} else {
			const reason = cancelled ? StopReason.CANCELLED : StopReason.ERROR;
			const message =
				error instanceof InterruptedOperationError
					? interruptedFailure
					: // Only an error meant for the user is shown as it is.
						error instanceof AppError && error.code !== ErrorCode.Internal
						? error.message
						: generationFailure;
			outcome = runOutcome(reason, message);
			openStepStatus =
				reason === StopReason.CANCELLED
					? StepStatus.CANCELLED
					: error instanceof InterruptedOperationError
						? StepStatus.INTERRUPTED
						: StepStatus.FAILED;
		}
		if (!writeFailed && !terminalObserved && !deferral)
			console.warn("[Run] Execution stopped", {
				runId,
				model: run.model,
				status: outcome ? RunStatus[outcome.status] : undefined,
				...errorDetails(error),
			});
	} finally {
		closing = true;
		clearInterval(progressInterval);
		localAbort.abort();
		await writes.catch(() => {});
	}
	// What the tools held for the run is let go once it ended; an execution
	// that stops for another to resume the run keeps it.
	const closeTools = (runEnded: boolean) => tools?.executor.close?.(runEnded);
	if (writeFailed) {
		await closeTools(false);
		throw writeFailure;
	}
	if (completed || terminalObserved) {
		await closeTools(true);
		return;
	}
	if (deferral) {
		await closeTools(false);
		throw new DeferredExecutionError({ cause: deferral.error });
	}
	try {
		await end();
	} catch (error) {
		if (!terminalObserved) {
			await closeTools(false);
			throw error;
		}
	}
	await closeTools(true);
}

// A stop that found no execution to stop (its actor had restarted): a call
// the last execution started and did not answer, such as a command still
// running on the computer, is stopped as a live execution stops it, by
// resuming it with the stop already made.
async function stopStartedCall(
	toolSet: () => ToolSet,
	checkpoint: LoopCheckpoint | undefined,
	signal: AbortSignal,
) {
	const [started] =
		checkpoint?.phase === "tools" ? (checkpoint.pendingCalls ?? []) : [];
	if (!started?.started) return;
	const tools = toolSet();
	if (tools.specs.find((spec) => spec.name === started.name)?.readOnly) return;
	await resumeTool(tools, started, signal).catch(() => {});
}

// A new conversation's first turn gets a generated title alongside its reply.
// It may outlast the reply, so it has its own connection: the run's closes
// when the run ends.
async function titleFirstTurn(
	run: RunRecord,
	input: Message,
	signal: AbortSignal,
) {
	const { db, close } = createDatabase();
	try {
		if (run.attempt !== 1) return;
		// The conversation's first turn, not the first one in the model's window.
		const [first] = await db
			.select({ id: turns.id })
			.from(turns)
			.where(eq(turns.threadId, run.threadId))
			.orderBy(asc(turns.id))
			.limit(1);
		if (first?.id !== run.turnId) return;
		const [thread] = await db
			.select({ titleSource: threads.titleSource })
			.from(threads)
			.where(eq(threads.id, run.threadId));
		if (thread?.titleSource !== "input") return;
		const text = input.parts
			.flatMap((part) =>
				part.content.case === "text" ? [part.content.value] : [],
			)
			.join("\n");
		await generateThreadTitle(
			db,
			{ id: run.threadId, userId: run.userId },
			text,
			signal,
		);
	} catch (error) {
		console.warn("[Run] Title generation skipped", {
			runId: run.id,
			...errorDetails(error),
		});
	} finally {
		await close();
	}
}
