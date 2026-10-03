import { and, desc, eq, lt, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import {
	agentConfig,
	findModel,
	type ModelOption,
	modelCatalog,
	type ReasoningEffort,
} from "@/config";
import type { Database } from "@/db/client";
import { messages, userMessage } from "@/db/schema/messages";
import { type RunRecord, runs, unfinishedRun } from "@/db/schema/runs";
import { threads } from "@/db/schema/threads";
import { type TurnRecord, turns } from "@/db/schema/turns";
import { withdrawnRequests } from "@/db/schema/withdrawn-requests";
import { ErrorReason } from "@/gen/heveta/v1/error_pb";
import { AppError, ErrorCode } from "@/lib/errors";
import { sha256 } from "@/lib/hash";
import { ownedDevice } from "@/modules/devices/credentials";
import {
	claimFiles,
	partFileIds,
	referenceFiles,
} from "@/modules/files/lifecycle";
import {
	fileReference,
	isImageMimeType,
	modelReadsFile,
} from "@/modules/files/types";
import { assignWorkspacePaths } from "@/modules/files/workspace-paths";
import { uploadsDir } from "@/modules/sandbox/uploads";
import { messageText } from "@/modules/threads/history";
import {
	threadColumns,
	threadFromRow,
	threadTitle,
} from "@/modules/threads/service";
import { decodeParts, encodeParts } from "@/modules/threads/storage";
import type { MessagePart } from "@/modules/threads/types";

import {
	lockRequest,
	lookupCondition,
	publicRun,
	snapshotFromRun,
	validateLookup,
	validRequestId,
} from "./records";
import {
	acceptanceTimeoutMs,
	isActiveRun,
	type RunInput,
	type RunLookup,
	RunStatus,
} from "./types";

async function requestHash(input: RunInput) {
	// Hash an explicit command shape, independent of property insertion order.
	const command =
		input.input.case === "newTurn"
			? [
					"newTurn",
					input.input.value.threadId,
					input.input.value.text,
					input.input.value.fileIds,
					input.modelId,
					input.reasoningEffort ?? "",
				]
			: [
					"retryTurn",
					input.input.value.turnId,
					input.input.value.previousRunId,
					input.modelId,
					input.reasoningEffort ?? "",
				];
	// Preserve old cloud request hashes while including explicit native targets.
	if (input.input.case === "newTurn" && input.input.value.deviceId)
		command.push(input.input.value.deviceId);
	return sha256(JSON.stringify(command));
}
function validateInput(input: RunInput) {
	if (!validRequestId(input.requestId))
		throw new AppError(
			"A unique request ID is required",
			ErrorCode.InvalidArgument,
		);
	if (input.input.case === "newTurn") {
		const { text, fileIds } = input.input.value;
		if (
			(!text.trim() && !fileIds.length) ||
			text.length > agentConfig.limits.messageChars ||
			fileIds.length > agentConfig.limits.attachments
		)
			throw new AppError(
				`Send text (up to ${agentConfig.limits.messageChars} characters) or up to ${agentConfig.limits.attachments} files`,
				ErrorCode.InvalidArgument,
			);
	} else if (input.input.case === "retryTurn") {
		if (!input.input.value.turnId || !input.input.value.previousRunId)
			throw new AppError(
				"A turn ID and previous run ID are required",
				ErrorCode.InvalidArgument,
			);
	} else throw new AppError("Input is required", ErrorCode.InvalidArgument);
}
// Only catalog models run. An explicit unknown id is rejected; an implicit
// fallback that has left the catalog resolves to the default model.
function resolveModel(requested: string, fallback: string): ModelOption {
	const model = findModel(requested || fallback);
	if (model) return model;
	if (requested)
		throw new AppError(
			"Unknown model",
			ErrorCode.InvalidArgument,
			ErrorReason.MODEL_UNKNOWN,
		);
	const defaultModel = findModel(modelCatalog.defaultModelId);
	if (!defaultModel)
		throw new AppError("Default model is not configured", ErrorCode.Internal);
	return defaultModel;
}
// A chosen effort must be one the model accepts. Without a choice, a retry
// keeps the previous attempt's effort when this model accepts it too; otherwise
// the model's default applies.
function resolveEffort(
	model: ModelOption,
	requested: ReasoningEffort | undefined,
	previous?: ReasoningEffort | null,
): ReasoningEffort | null {
	if (requested) {
		if (!model.reasoningEfforts.includes(requested))
			throw new AppError(
				"The selected model does not support this reasoning effort",
				ErrorCode.InvalidArgument,
			);
		return requested;
	}
	if (previous && model.reasoningEfforts.includes(previous)) return previous;
	return model.reasoningEfforts.length ? model.defaultReasoningEffort : null;
}
// The model reads attached images itself, and PDFs if it can (a PDF it
// cannot read is a file on the computer); it must read an attached image.
function requireFileSupport(
	model: ModelOption,
	files: { mimeType: string; size: bigint }[],
) {
	if (
		!model.reads.includes("image") &&
		files.some((file) => isImageMimeType(file.mimeType))
	)
		throw new AppError(
			"The selected model does not read images",
			ErrorCode.InvalidArgument,
			ErrorReason.MODEL_CANNOT_READ_FILES,
		);
	const read = files.filter((file) =>
		modelReadsFile(file.mimeType, model.reads),
	);
	if (
		read.reduce((bytes, file) => bytes + file.size, 0n) >
		BigInt(agentConfig.limits.modelFileBytes)
	)
		throw new AppError(
			`Attached images and PDFs must total no more than ${agentConfig.limits.modelFileBytes / 1024 / 1024} MB`,
			ErrorCode.InvalidArgument,
			ErrorReason.MODEL_FILES_TOO_LARGE,
		);
}
// The message's parts: its text, then its attachments, each given its place
// on the user's computer (sandbox/uploads.ts puts them there when it runs).
// A new input's parts; its attachments go into `uploads`, their message's
// own folder on the computer.
async function inputParts(
	db: Database,
	userId: string,
	input: { text: string; fileIds: string[] },
	model: ModelOption,
	uploads: string,
) {
	const parts: MessagePart[] = [];
	if (input.text)
		parts.push({ id: uuidv7(), content: { case: "text", value: input.text } });
	const claimed = await claimFiles(db, userId, input.fileIds);
	requireFileSupport(model, claimed);
	for (const file of await assignWorkspacePaths(db, claimed, uploads))
		parts.push({
			id: uuidv7(),
			content: { case: "file", value: fileReference(file) },
		});
	return parts;
}
// `armed` is the new attempt's run, if this accepts one: its actor is being
// armed for it since `armedAt` (`ready`, runs/delivery.ts), and the
// transaction ends within `acceptanceTimeoutMs` of that, before the armed
// actor looks for it.
export async function prepareRun(
	db: Database,
	userId: string,
	input: RunInput,
	armed: { id: string; armedAt: number; ready: Promise<void> },
	signal: AbortSignal,
) {
	signal.throwIfAborted();
	validateInput(input);
	const hash = await requestHash(input);
	const runId = armed.id;
	// Accepted only once the actor is armed: its arming, started with this
	// transaction, is awaited before the commit, and a failed one rolls the
	// transaction back.
	return db.transaction(async (tx) => {
		const accepted = await accept(tx);
		await armed.ready;
		return accepted;
	});
	async function accept(tx: Database) {
		const remainingMs = Math.floor(
			armed.armedAt + acceptanceTimeoutMs - Date.now(),
		);
		if (remainingMs <= 0)
			throw new AppError("Unable to start the reply", ErrorCode.Unavailable);
		await tx.execute(sql.raw(`set local transaction_timeout = ${remainingMs}`));
		await lockRequest(tx, userId, input.requestId);
		signal.throwIfAborted();
		// Resolve accepted commands before mutable target checks. A replay of an old
		// retry must still return that attempt after a newer turn/attempt exists.
		const [existing] = await tx
			.select()
			.from(runs)
			.where(and(eq(runs.userId, userId), eq(runs.requestId, input.requestId)))
			// Replays read the message below at this same revision. The request
			// advisory lock orders submissions, but does not lock actor commits.
			.for("share");
		// A new conversation's request answers with the conversation it
		// started, replayed or not.
		const startsThread =
			input.input.case === "newTurn" && !input.input.value.threadId;
		if (!existing) {
			const [withdrawn] = await tx
				.select({ requestId: withdrawnRequests.requestId })
				.from(withdrawnRequests)
				.where(
					and(
						eq(withdrawnRequests.userId, userId),
						eq(withdrawnRequests.requestId, input.requestId),
					),
				);
			if (withdrawn)
				throw new AppError(
					"The request was withdrawn",
					ErrorCode.FailedPrecondition,
					ErrorReason.REQUEST_WITHDRAWN,
				);
		}
		if (existing) {
			if (existing.requestHash !== hash)
				throw new AppError(
					"Request ID was used with different input",
					ErrorCode.AlreadyExists,
				);
			const [started] = startsThread
				? await tx
						.select(threadColumns)
						.from(threads)
						.where(eq(threads.id, existing.threadId))
				: [];
			return {
				run: existing,
				replay: true,
				thread: started && threadFromRow(started),
				snapshot: await snapshotFromRun(tx, existing),
			};
		}
		let requestedTurn: TurnRecord | undefined;
		if (input.input.case === "retryTurn") {
			[requestedTurn] = await tx
				.select()
				.from(turns)
				.where(
					and(eq(turns.id, input.input.value.turnId), eq(turns.userId, userId)),
				);
			if (!requestedTurn)
				throw new AppError("Turn not found", ErrorCode.NotFound);
		}
		const threadId =
			input.input.case === "newTurn"
				? input.input.value.threadId
				: requestedTurn!.threadId;
		// A new turn without a thread starts a conversation. The thread commits
		// with its first turn, and replays resolve through the request ID above.
		const [thread] =
			input.input.case === "newTurn" && !threadId
				? await tx
						.insert(threads)
						.values({
							userId,
							title: threadTitle(input.input.value.text),
							titleSource: "input",
						})
						.returning()
				: await tx
						.select()
						.from(threads)
						.where(and(eq(threads.id, threadId), eq(threads.userId, userId)))
						.for("update");
		if (!thread)
			throw new AppError(
				"Thread not found",
				ErrorCode.NotFound,
				ErrorReason.THREAD_NOT_FOUND,
			);
		// Every acceptance in a thread owns this lock. The retried attempt is
		// checked after acquiring it, so two retries cannot branch from one
		// attempt: it must be the latest attempt of the thread's latest turn.
		let previous: RunRecord | undefined;
		if (input.input.case === "retryTurn") {
			const [latest] = await tx
				.select({ id: turns.id })
				.from(turns)
				.where(eq(turns.threadId, thread.id))
				.orderBy(desc(turns.id))
				.limit(1);
			if (requestedTurn?.id !== latest?.id)
				throw new AppError(
					"Only the latest turn can be retried",
					ErrorCode.FailedPrecondition,
					ErrorReason.RUN_CHANGED,
				);
			[previous] = await tx
				.select()
				.from(runs)
				.where(eq(runs.turnId, requestedTurn!.id))
				.orderBy(desc(runs.attempt))
				.limit(1);
			if (previous?.id !== input.input.value.previousRunId)
				throw new AppError(
					"The latest attempt has changed",
					ErrorCode.FailedPrecondition,
					ErrorReason.RUN_CHANGED,
				);
		}
		// A queued run is always started by its armed actor, so an active one
		// is waited for, never replaced.
		const [active] = await tx
			.select({ id: runs.id })
			.from(runs)
			.where(and(eq(runs.threadId, thread.id), unfinishedRun(runs.status)))
			.limit(1);
		if (active)
			throw new AppError(
				"A run is already active in this thread",
				ErrorCode.FailedPrecondition,
				ErrorReason.RUN_ACTIVE,
			);
		const deviceId =
			input.input.case === "newTurn"
				? input.input.value.deviceId || null
				: previous!.deviceId;
		if (deviceId) await ownedDevice(tx, userId, deviceId);
		const createdAt = new Date();
		let turnId: string;
		let attempt = 1;
		let newParts: MessagePart[] | undefined;
		const inputMessageId = uuidv7();
		let model: ModelOption;
		let reasoningEffort: ReasoningEffort | null;
		if (input.input.case === "newTurn") {
			model = resolveModel(input.modelId, modelCatalog.defaultModelId);
			reasoningEffort = resolveEffort(model, input.reasoningEffort);
			newParts = await inputParts(
				tx,
				userId,
				input.input.value,
				model,
				`${uploadsDir}/${inputMessageId}`,
			);
			turnId = uuidv7();
			await tx
				.insert(turns)
				.values({ id: turnId, threadId: thread.id, userId, createdAt });
		} else {
			turnId = requestedTurn!.id;
			model = resolveModel(input.modelId, previous!.model);
			reasoningEffort = resolveEffort(
				model,
				input.reasoningEffort,
				previous!.reasoningEffort,
			);
			const [inputMessage] = await tx
				.select({ parts: messages.parts })
				.from(messages)
				.where(and(eq(messages.turnId, turnId), userMessage(messages.role)));
			if (inputMessage)
				requireFileSupport(
					model,
					decodeParts(inputMessage.parts).flatMap((part) =>
						part.content.case === "file" ? [part.content.value] : [],
					),
				);
			attempt = previous!.attempt + 1;
		}
		const [run] = await tx
			.insert(runs)
			.values({
				id: runId,
				threadId: thread.id,
				turnId,
				userId,
				requestId: input.requestId,
				requestHash: hash,
				deviceId,
				attempt,
				model: model.id,
				reasoningEffort,
				status: RunStatus.QUEUED,
				revision: 1,
				createdAt,
			})
			.returning();
		if (input.input.case === "newTurn") {
			await tx.insert(messages).values({
				id: inputMessageId,
				userId,
				threadId: thread.id,
				turnId,
				runId: null,
				role: "user",
				parts: encodeParts(newParts!),
				text: messageText(newParts!),
				createdAt,
				updatedAt: createdAt,
			});
			await referenceFiles(tx, inputMessageId, newParts!.flatMap(partFileIds));
		}
		await tx.insert(messages).values({
			userId,
			threadId: thread.id,
			turnId,
			runId,
			role: "assistant",
			parts: [],
			createdAt,
			updatedAt: createdAt,
		});
		await tx
			.update(threads)
			.set({ updatedAt: createdAt })
			.where(eq(threads.id, thread.id));
		signal.throwIfAborted();
		return {
			run,
			replay: false,
			// As it now is: its activity is this turn's.
			thread: startsThread
				? threadFromRow({
						...thread,
						updatedAt: createdAt,
						running: isActiveRun(run.status),
					})
				: undefined,
			// Read in the transaction that wrote it: the answer needs no second
			// transaction to read back what was just accepted.
			snapshot: await snapshotFromRun(tx, run),
		};
	}
}
export async function requestCancelRun(
	db: Database,
	userId: string,
	lookup: RunLookup,
) {
	validateLookup(lookup);
	const stopped = await db.transaction(async (tx) => {
		if (lookup.requestId) await lockRequest(tx, userId, lookup.requestId);
		const [run] = await tx
			.select()
			.from(runs)
			.where(lookupCondition(userId, lookup))
			.for("update");
		if (!run && lookup.requestId) {
			// Not taken yet, and now never: the send is withdrawn, under the
			// request's lock, so a copy still on its way is refused (prepareRun).
			await tx
				.insert(withdrawnRequests)
				.values({ userId, requestId: lookup.requestId })
				.onConflictDoNothing();
			return undefined;
		}
		if (!run) throw new AppError("Run not found", ErrorCode.NotFound);
		if (!isActiveRun(run.status) || run.cancelRequested) return publicRun(run);
		const [updated] = await tx
			.update(runs)
			.set({ cancelRequested: true })
			.where(eq(runs.id, run.id))
			.returning();
		return publicRun(updated);
	});
	// Said after the withdrawal has committed: an error inside the
	// transaction would have rolled it back.
	if (!stopped)
		throw new AppError(
			"The request was withdrawn",
			ErrorCode.NotFound,
			ErrorReason.REQUEST_WITHDRAWN,
		);
	return stopped;
}

// A withdrawal outlives any copy of its request by far after a day.
const withdrawalLifetimeMs = 24 * 60 * 60 * 1000;
export async function purgeWithdrawnRequests(db: Database) {
	await db
		.delete(withdrawnRequests)
		.where(
			lt(
				withdrawnRequests.createdAt,
				new Date(Date.now() - withdrawalLifetimeMs),
			),
		);
}
