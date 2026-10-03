import { and, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import type { RunRecord } from "@/db/schema/runs";
import { runs } from "@/db/schema/runs";
import type { StepRecord } from "@/db/schema/steps";
import { AppError, ErrorCode } from "@/lib/errors";
import {
	claimFiles,
	partFileIds,
	referenceFiles,
} from "@/modules/files/lifecycle";
import { StepKind, StepStatus } from "@/modules/steps/types";
import {
	contentChunks,
	contentDigest,
	encodedTextChars,
	partModelChars,
	joinPart,
	omitPartBody,
	splitPart,
	type PartDescriptor,
} from "@/modules/threads/content";
import { decodeParts, type StoredMessagePart } from "@/modules/threads/storage";
import type { Message } from "@/modules/threads/types";
import type { LoopCheckpoint, StepUpdate } from "@/runtime/checkpoint";
import { modelFileId, modelFileParts } from "@/runtime/responses/model-files";
import type { ModelInput } from "@/runtime/responses/types";

import {
	finalizeArchive,
	importArchivePage,
	type ArchiveRecord,
	type RunSeal,
} from "./archive";
import { getRunById } from "./queries";
import { publicRun } from "./records";
import {
	isActiveRun,
	type PartChange,
	type RunEvent,
	RunStatus,
} from "./types";

export interface RunBatch {
	id: string;
	run: RunRecord;
	changes: PartChange[];
	checkpoint?: LoopCheckpoint | null;
	final: boolean;
	steps?: StepUpdate[];
	openStepStatus?: StepStatus;
}
type CheckpointPosition = Omit<
	LoopCheckpoint,
	"messages" | "pendingCalls" | "steps"
> & { epoch: number; items: number };
interface ArchiveCursor {
	section: number;
	ordinal: number;
	chunk: number;
	step: number;
	pages: number;
	digest: string;
}
interface LocalState {
	run: RunRecord;
	input: Message;
	output: Message;
	commitSeq: number;
	checkpoint?: CheckpointPosition;
	seal?: RunSeal;
	archive?: ArchiveCursor;
}
interface PreparedBatch {
	id: string;
	run: RunRecord;
	checkpoint?: CheckpointPosition | null;
	final: boolean;
	openStepStatus: StepStatus;
	fileIds: string[];
	at: Date;
}
interface LocalStep extends StepRecord {
	callId?: string;
}
interface ChangePosition {
	type: "part" | "textDelta";
	partId: string;
	generation: string;
	from: number;
	to: number;
	descriptor: PartDescriptor;
}
const json = (value: unknown) =>
	JSON.stringify(value, (_key, item: unknown) =>
		typeof item === "bigint" ? item.toString() : item,
	);
const runDates = (run: RunRecord) => {
	run.createdAt = new Date(run.createdAt);
	run.startedAt = run.startedAt ? new Date(run.startedAt) : null;
	run.finishedAt = run.finishedAt ? new Date(run.finishedAt) : null;
	return run;
};
const stepDates = (step: LocalStep): LocalStep => ({
	...step,
	createdAt: new Date(step.createdAt),
	startedAt: step.startedAt ? new Date(step.startedAt) : null,
	finishedAt: step.finishedAt ? new Date(step.finishedAt) : null,
});
const stepStatuses: Record<StepUpdate["status"], StepStatus> = {
	pending: StepStatus.PENDING,
	running: StepStatus.RUNNING,
	completed: StepStatus.COMPLETED,
	failed: StepStatus.FAILED,
};
const startCursor = (): ArchiveCursor => ({
	section: 0,
	ordinal: -1,
	chunk: -1,
	step: 0,
	pages: 0,
	digest: "",
});

// Only this Run's DO writes active state. Large bodies live in bounded rows;
// version heads expose exactly the chunks visible at a committed position.
export class LocalRunStorage {
	#native?: ModelInput;
	#itemDigests = new WeakMap<object, Promise<string>>();
	#stagedNative?: { id: string; items: ModelInput };
	constructor(private readonly storage: DurableObjectStorage) {
		for (const statement of [
			"CREATE TABLE IF NOT EXISTS local_state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)",
			"CREATE TABLE IF NOT EXISTS local_batches (id TEXT PRIMARY KEY, digest TEXT NOT NULL, value TEXT NOT NULL, committed INTEGER NOT NULL DEFAULT 0, result TEXT)",
			"CREATE TABLE IF NOT EXISTS local_parts (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE)",
			"CREATE TABLE IF NOT EXISTS part_heads (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL UNIQUE, value TEXT NOT NULL)",
			"CREATE TABLE IF NOT EXISTS part_versions (id TEXT NOT NULL, commit_seq INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(id,commit_seq))",
			"CREATE TABLE IF NOT EXISTS part_chunks (id TEXT NOT NULL, generation TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(id,generation,idx))",
			"CREATE TABLE IF NOT EXISTS batch_parts (batch_id TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(batch_id,id))",
			"CREATE TABLE IF NOT EXISTS batch_changes (batch_id TEXT NOT NULL, idx INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(batch_id,idx))",
			"CREATE TABLE IF NOT EXISTS local_steps (idx INTEGER PRIMARY KEY, value TEXT NOT NULL)",
			"CREATE TABLE IF NOT EXISTS batch_steps (batch_id TEXT NOT NULL, idx INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(batch_id,idx))",
			"CREATE TABLE IF NOT EXISTS native_items (epoch INTEGER NOT NULL, seq INTEGER NOT NULL, call_id TEXT, PRIMARY KEY(epoch,seq))",
			"CREATE INDEX IF NOT EXISTS native_call_idx ON native_items(epoch,call_id)",
			"CREATE TABLE IF NOT EXISTS native_chunks (epoch INTEGER NOT NULL, seq INTEGER NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(epoch,seq,idx))",
		])
			this.storage.sql.exec(statement);
	}
	#rows<T>(query: string, ...bindings: (string | number | null)[]): T[] {
		return Array.from(this.storage.sql.exec(query, ...bindings)) as T[];
	}
	state(): LocalState | undefined {
		const [row] = this.#rows<{ value: string }>(
			"SELECT value FROM local_state WHERE id=1",
		);
		if (!row) return undefined;
		const state = JSON.parse(row.value) as LocalState;
		runDates(state.run);
		for (const message of [state.input, state.output]) {
			message.createdAt = new Date(message.createdAt);
			message.updatedAt = new Date(message.updatedAt);
		}
		state.input.parts = decodeParts(
			state.input.parts as unknown as StoredMessagePart[],
		);
		if (state.seal) runDates(state.seal.run);
		return state;
	}
	#writeState(state: LocalState) {
		this.storage.sql.exec(
			"INSERT INTO local_state(id,value) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
			json(state),
		);
	}
	async initialize(run: RunRecord, input: Message, output: Message) {
		if (this.state()) return;
		this.storage.transactionSync(() => {
			if (this.state()) return;
			this.#writeState({
				run: {
					...run,
					status: RunStatus.QUEUED,
					startedAt: null,
					finishedAt: null,
					cancelRequested: false,
					revision: 1,
				},
				input,
				output: { ...output, parts: [] },
				commitSeq: 0,
			});
		});
		await this.storage.sync();
	}
	#descriptor(id: string): PartDescriptor | undefined {
		const [row] = this.#rows<{ value: string }>(
			"SELECT value FROM part_heads WHERE id=?",
			id,
		);
		return row ? JSON.parse(row.value) : undefined;
	}
	#body(descriptor: PartDescriptor, from = 0, to = descriptor.chunks) {
		return this.#rows<{ data: string }>(
			"SELECT data FROM part_chunks WHERE id=? AND generation=? AND idx>=? AND idx<? ORDER BY idx",
			descriptor.id,
			descriptor.generation,
			from,
			to,
		)
			.map((row) => row.data)
			.join("");
	}
	#putChunks(id: string, generation: string, text: string, from = 0) {
		let count = from;
		for (const chunk of contentChunks(text))
			this.storage.sql.exec(
				"INSERT INTO part_chunks(id,generation,idx,data) VALUES(?,?,?,?)",
				id,
				generation,
				count++,
				chunk,
			);
		return count;
	}
	async #prepare(batch: RunBatch) {
		const state = this.state();
		if (!state)
			throw new AppError("Run not initialized", ErrorCode.Unavailable);
		const next = batch.checkpoint;
		const samePrefix =
			next &&
			this.#native &&
			this.#native.length <= next.messages.length &&
			this.#native.every((item, i) => item === next.messages[i]);
		const newEpoch =
			next && !samePrefix
				? (state.checkpoint?.epoch ?? 0) + 1
				: (state.checkpoint?.epoch ?? 0);
		const from = samePrefix ? this.#native!.length : 0;
		const appended = next ? next.messages.slice(from) : [];
		const checkpoint =
			next === null
				? null
				: next
					? {
							version: next.version,
							phase: next.phase,
							omitted: next.omitted,
							tokensPerChar: next.tokensPerChar,
							lastStepIndex: next.lastStepIndex,
							epoch: newEpoch,
							items: next.messages.length,
						}
					: undefined;
		const itemDigests = next
			? await Promise.all(
					next.messages.map((item) => {
						let digest = this.#itemDigests.get(item);
						if (!digest) {
							digest = contentDigest(JSON.stringify(item));
							this.#itemDigests.set(item, digest);
						}
						return digest;
					}),
				)
			: undefined;
		const digest = await contentDigest(
			json({
				run: batch.run,
				changes: batch.changes,
				checkpoint: next
					? {
							phase: next.phase,
							version: next.version,
							omitted: next.omitted,
							tokensPerChar: next.tokensPerChar,
							lastStepIndex: next.lastStepIndex,
							items: itemDigests,
						}
					: next,
				steps: batch.steps ?? next?.steps,
				final: batch.final,
				openStepStatus: batch.openStepStatus,
			}),
		);
		const [existing] = this.#rows<{ digest: string }>(
			"SELECT digest FROM local_batches WHERE id=?",
			batch.id,
		);
		if (existing) {
			if (existing.digest !== digest)
				throw new AppError("Conflicting run batch", ErrorCode.Internal);
			return;
		}
		if (state.seal || !isActiveRun(state.run.status))
			throw new AppError("Run is already sealed", ErrorCode.FailedPrecondition);
		const at = new Date();
		const fileIds = new Set(
			batch.changes.flatMap((change) =>
				change.type === "part" ? partFileIds(change.part) : [],
			),
		);
		for (const item of state.checkpoint ? appended : [])
			for (const part of modelFileParts(item)) {
				const id = modelFileId(part);
				if (id) fileIds.add(id);
			}
		const prepared: PreparedBatch = {
			id: batch.id,
			run: batch.run,
			checkpoint,
			final: batch.final,
			openStepStatus: batch.openStepStatus ?? StepStatus.FAILED,
			fileIds: [...fileIds],
			at,
		};
		this.storage.transactionSync(() => {
			this.storage.sql.exec(
				"INSERT INTO local_batches(id,digest,value) VALUES(?,?,?)",
				batch.id,
				digest,
				json(prepared),
			);
			const dirty = new Map<string, PartDescriptor>();
			batch.changes.forEach((change, position) => {
				const id = change.type === "part" ? change.part.id : change.partId;
				let descriptor = dirty.get(id) ?? this.#descriptor(id);
				const previous = descriptor;
				if (change.type === "part") {
					const { meta, body } = splitPart(change.part);
					let ordinal = previous?.ordinal;
					if (ordinal === undefined) {
						const [identity] = this.#rows<{ ordinal: number }>(
							"SELECT ordinal FROM local_parts WHERE id=?",
							id,
						);
						ordinal = identity?.ordinal;
						if (ordinal === undefined) {
							ordinal = this.#rows<{ ordinal: number }>(
								"SELECT coalesce(max(ordinal),-1)+1 AS ordinal FROM local_parts",
							)[0].ordinal;
							this.storage.sql.exec(
								"INSERT INTO local_parts(id,ordinal) VALUES(?,?)",
								id,
								ordinal,
							);
						}
					}
					if (previous && previous.meta.content.case !== meta.content.case)
						throw new AppError("Run part type changed", ErrorCode.Internal);
					const generation = `${batch.id}:${position}`;
					const callId =
						meta.content.case === "toolCall"
							? meta.content.value.id
							: meta.content.case === "toolResult"
								? meta.content.value.toolCallId
								: id.split(":file:")[0];
					const call = next?.pendingCalls?.find(
						(pending) => pending.callId === callId,
					);
					const [tool] = this.#rows<{ value: string }>(
						"SELECT value FROM local_steps WHERE json_extract(value,'$.callId')=?",
						callId,
					);
					const operation =
						call?.stepIndex ??
						(tool ? (JSON.parse(tool.value) as LocalStep).index : undefined);
					descriptor = {
						id,
						ordinal,
						meta,
						generation,
						chars: body.length,
						modelChars: partModelChars(change.part),
						chunks: this.#putChunks(id, generation, body),
						stepIndex:
							previous?.stepIndex ??
							operation ??
							(state.checkpoint?.phase === "model"
								? state.checkpoint.lastStepIndex
								: null),
					};
				} else {
					if (
						!descriptor ||
						(descriptor.meta.content.case !== "text" &&
							descriptor.meta.content.case !== "reasoning")
					)
						throw new AppError(
							"Text part was not declared",
							ErrorCode.Internal,
						);
					descriptor = {
						...descriptor,
						chunks: this.#putChunks(
							id,
							descriptor.generation,
							change.text,
							descriptor.chunks,
						),
						chars: descriptor.chars + change.text.length,
						modelChars:
							descriptor.modelChars +
							(descriptor.meta.content.case === "text"
								? encodedTextChars(change.text)
								: 0),
					};
				}
				dirty.set(id, descriptor);
				const event: ChangePosition = {
					type: change.type,
					partId: id,
					generation: descriptor.generation,
					from: change.type === "textDelta" ? previous!.chunks : 0,
					to: descriptor.chunks,
					descriptor,
				};
				this.storage.sql.exec(
					"INSERT INTO batch_changes(batch_id,idx,value) VALUES(?,?,?)",
					batch.id,
					position,
					json(event),
				);
			});
			if (batch.final) {
				let position = batch.changes.length;
				for (const row of this.#rows<{ value: string }>(
					"SELECT value FROM part_heads WHERE json_extract(value,'$.meta.assistantText.status')='in_progress'",
				)) {
					const previous = JSON.parse(row.value) as PartDescriptor;
					const current = dirty.get(previous.id) ?? previous;
					if (current.meta.assistantText?.status !== "in_progress") continue;
					const descriptor: PartDescriptor = {
						...current,
						meta: {
							...current.meta,
							assistantText: {
								...current.meta.assistantText,
								status: "incomplete",
							},
						},
					};
					dirty.set(descriptor.id, descriptor);
					this.storage.sql.exec(
						"INSERT INTO batch_changes(batch_id,idx,value) VALUES(?,?,?)",
						batch.id,
						position++,
						json({
							type: "part",
							partId: descriptor.id,
							generation: descriptor.generation,
							from: 0,
							to: descriptor.chunks,
							descriptor,
						} satisfies ChangePosition),
					);
				}
			}
			for (const [id, descriptor] of dirty)
				this.storage.sql.exec(
					"INSERT INTO batch_parts(batch_id,id,value) VALUES(?,?,?)",
					batch.id,
					id,
					json(descriptor),
				);
			appended.forEach((item, offset) => {
				const seq = from + offset;
				const callId =
					"type" in item && item.type === "function_call" ? item.call_id : null;
				this.storage.sql.exec(
					"INSERT INTO native_items(epoch,seq,call_id) VALUES(?,?,?)",
					newEpoch,
					seq,
					callId,
				);
				let index = 0;
				for (const chunk of contentChunks(JSON.stringify(item)))
					this.storage.sql.exec(
						"INSERT INTO native_chunks(epoch,seq,idx,data) VALUES(?,?,?,?)",
						newEpoch,
						seq,
						index++,
						chunk,
					);
			});
			for (const update of batch.steps ?? next?.steps ?? []) {
				const [stored] = this.#rows<{ value: string }>(
					"SELECT value FROM local_steps WHERE idx=?",
					update.index,
				);
				const current = stored
					? stepDates(JSON.parse(stored.value))
					: undefined;
				if (
					current &&
					current.status !== StepStatus.PENDING &&
					current.status !== StepStatus.RUNNING
				)
					continue;
				const status = stepStatuses[update.status];
				const callId =
					next?.pendingCalls?.find((call) => call.stepIndex === update.index)
						?.callId ?? current?.callId;
				const step: LocalStep = {
					id: current?.id ?? crypto.randomUUID(),
					runId: state.run.id,
					index: update.index,
					kind: update.kind === "model" ? StepKind.MODEL : StepKind.TOOL,
					toolName: update.toolName ?? current?.toolName ?? "",
					status,
					responseId: update.responseId ?? current?.responseId ?? "",
					inputTokens: update.inputTokens ?? current?.inputTokens ?? null,
					outputTokens: update.outputTokens ?? current?.outputTokens ?? null,
					error: (update.error ?? current?.error ?? "").slice(0, 8_000),
					createdAt: current?.createdAt ?? at,
					startedAt:
						current?.startedAt ?? (status === StepStatus.RUNNING ? at : null),
					finishedAt:
						status === StepStatus.PENDING || status === StepStatus.RUNNING
							? null
							: at,
					...(callId ? { callId } : {}),
				};
				this.storage.sql.exec(
					"INSERT INTO batch_steps(batch_id,idx,value) VALUES(?,?,?)",
					batch.id,
					step.index,
					json(step),
				);
			}
		});
		this.#stagedNative = next
			? { id: batch.id, items: next.messages }
			: undefined;
		// Result bodies survive before PostgreSQL pins or control reads. A
		// restarted actor finishes this batch before classifying an operation.
		await this.storage.sync();
	}
	async resolvePending(db: Database) {
		const pending = this.#rows<{ id: string }>(
			"SELECT id FROM local_batches WHERE committed=0 ORDER BY rowid",
		);
		for (const row of pending) await this.#commit(db, row.id);
		return pending.some(
			(row) =>
				this.#rows(
					"SELECT 1 FROM batch_steps WHERE batch_id=? AND ((json_extract(value,'$.kind')=? AND json_extract(value,'$.status')=?) OR (json_extract(value,'$.kind')=? AND json_extract(value,'$.status') IN (?,?))) LIMIT 1",
					row.id,
					StepKind.MODEL,
					StepStatus.COMPLETED,
					StepKind.TOOL,
					StepStatus.COMPLETED,
					StepStatus.FAILED,
				).length > 0,
		);
	}
	async save(db: Database, batch: RunBatch) {
		await this.#prepare(batch);
		return this.#commit(db, batch.id);
	}
	async #commit(
		db: Database,
		id: string,
	): Promise<{ run: RunRecord; event?: RunEvent }> {
		const [row] = this.#rows<{
			value: string;
			committed: number;
			result: string | null;
		}>("SELECT value,committed,result FROM local_batches WHERE id=?", id);
		if (!row) throw new AppError("Run batch not found", ErrorCode.Internal);
		const prepared = JSON.parse(row.value) as PreparedBatch;
		runDates(prepared.run);
		prepared.at = new Date(prepared.at);
		if (row.committed) {
			const cached = JSON.parse(row.result!) as {
				run: RunRecord;
				changed: boolean;
				outputUpdatedAt: string;
			};
			runDates(cached.run);
			return {
				run: this.state()!.run,
				...(cached.changed
					? {
							event: {
								runId: cached.run.id,
								type: "change" as const,
								change: {
									revision: cached.run.revision,
									run: publicRun(cached.run),
									changes: this.#eventChanges(id),
									outputUpdatedAt: new Date(cached.outputUpdatedAt),
								},
							},
						}
					: {}),
			};
		}
		let control: RunRecord | undefined;
		if (
			prepared.checkpoint !== undefined ||
			prepared.final ||
			prepared.fileIds.length
		) {
			control = await getRunById(db, prepared.run.id);
			if (!control) throw new AppError("Run not found", ErrorCode.NotFound);
			if (!isActiveRun(control.status))
				throw new AppError("Run already ended", ErrorCode.FailedPrecondition);
		}
		if (prepared.fileIds.length) {
			await db.transaction(async (tx) => {
				const [run] = await tx
					.select()
					.from(runs)
					.where(
						and(
							eq(runs.id, prepared.run.id),
							eq(runs.userId, prepared.run.userId),
						),
					)
					.for("update");
				if (!run) throw new AppError("Run not found", ErrorCode.NotFound);
				await claimFiles(tx, run.userId, prepared.fileIds);
				await referenceFiles(tx, this.state()!.output.id, prepared.fileIds);
			});
		}
		let result!: { run: RunRecord; event?: RunEvent };
		this.storage.transactionSync(() => {
			const state = this.state()!;
			if (state.seal)
				throw new AppError("Run already sealed", ErrorCode.FailedPrecondition);
			state.commitSeq++;
			for (const part of this.#rows<{ id: string; value: string }>(
				"SELECT id,value FROM batch_parts WHERE batch_id=?",
				id,
			)) {
				const descriptor = JSON.parse(part.value) as PartDescriptor;
				this.storage.sql.exec(
					"INSERT INTO part_versions(id,commit_seq,value) VALUES(?,?,?)",
					part.id,
					state.commitSeq,
					part.value,
				);
				this.storage.sql.exec(
					"INSERT INTO part_heads(id,ordinal,value) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
					part.id,
					descriptor.ordinal,
					part.value,
				);
			}
			for (const step of this.#rows<{ idx: number; value: string }>(
				"SELECT idx,value FROM batch_steps WHERE batch_id=?",
				id,
			))
				this.storage.sql.exec(
					"INSERT INTO local_steps(idx,value) VALUES(?,?) ON CONFLICT(idx) DO UPDATE SET value=excluded.value",
					step.idx,
					step.value,
				);
			const before = json(publicRun(state.run));
			state.run.cancelRequested ||= control?.cancelRequested === true;
			if (!prepared.final) {
				state.run.status = prepared.run.status;
				state.run.startedAt ??= prepared.run.startedAt;
			}
			const changes = this.#eventChanges(id);
			if (changes.length || before !== json(publicRun(state.run))) {
				state.run.revision++;
				state.output.updatedAt = prepared.at;
				result = {
					run: state.run,
					event: {
						type: "change",
						runId: state.run.id,
						change: {
							revision: state.run.revision,
							run: publicRun(state.run),
							changes,
							outputUpdatedAt: state.output.updatedAt,
						},
					},
				};
			} else result = { run: state.run };
			if (prepared.checkpoint !== undefined)
				state.checkpoint = prepared.checkpoint ?? undefined;
			if (prepared.final) {
				const [manifest] = this.#rows<{ parts: number; chunks: number }>(
					"SELECT count(*) AS parts,coalesce(sum(json_extract(value,'$.chunks')),0) AS chunks FROM part_heads",
				);
				state.seal = {
					id: crypto.randomUUID(),
					run: {
						...prepared.run,
						startedAt: state.run.startedAt,
						finishedAt: prepared.at,
					},
					messageId: state.output.id,
					revision: state.run.revision + 1,
					openStepStatus: prepared.openStepStatus,
					parts: manifest.parts,
					chunks: manifest.chunks,
					steps: this.#rows<{ total: number }>(
						"SELECT count(*) AS total FROM local_steps",
					)[0].total,
				};
				state.archive = startCursor();
				state.checkpoint = undefined;
			}
			this.#writeState(state);
			this.storage.sql.exec(
				"UPDATE local_batches SET committed=1,result=? WHERE id=?",
				json({
					run: state.run,
					changed: Boolean(result.event),
					outputUpdatedAt: state.output.updatedAt,
				}),
				id,
			);
		});
		await this.storage.sync();
		if (this.#stagedNative?.id === id) this.#native = this.#stagedNative.items;
		const epoch = this.state()?.checkpoint?.epoch;
		if (epoch !== undefined) {
			this.storage.transactionSync(() => {
				this.storage.sql.exec(
					"DELETE FROM native_chunks WHERE epoch<>?",
					epoch,
				);
				this.storage.sql.exec("DELETE FROM native_items WHERE epoch<>?", epoch);
			});
		}
		if (
			control?.status === RunStatus.QUEUED &&
			!prepared.final &&
			result.run.status === RunStatus.RUNNING
		)
			await db
				.update(runs)
				.set({ status: RunStatus.RUNNING, startedAt: result.run.startedAt })
				.where(
					and(eq(runs.id, result.run.id), eq(runs.status, RunStatus.QUEUED)),
				);
		return result;
	}
	#eventChanges(id: string): PartChange[] {
		return this.#rows<{ value: string }>(
			"SELECT value FROM batch_changes WHERE batch_id=? ORDER BY idx",
			id,
		).map(({ value }) => {
			const change = JSON.parse(value) as ChangePosition;
			if (change.type === "textDelta")
				return {
					type: "textDelta",
					partId: change.partId,
					text: this.#body(change.descriptor, change.from, change.to),
				};
			const omitted = omitPartBody(change.descriptor, true);
			return {
				type: "part",
				part: joinPart(
					change.descriptor,
					omitted ? "" : this.#body(change.descriptor),
					omitted,
				),
			};
		});
	}
	async observeControl(control: RunRecord): Promise<RunEvent | undefined> {
		let event: RunEvent | undefined;
		this.storage.transactionSync(() => {
			const state = this.state();
			if (
				!state ||
				state.seal ||
				!control.cancelRequested ||
				state.run.cancelRequested
			)
				return;
			state.run.cancelRequested = true;
			state.run.revision++;
			state.commitSeq++;
			event = {
				runId: state.run.id,
				type: "change",
				change: {
					revision: state.run.revision,
					run: publicRun(state.run),
					changes: [],
					outputUpdatedAt: state.output.updatedAt,
				},
			};
			this.#writeState(state);
		});
		await this.storage.sync();
		return event;
	}
	checkpoint(): LoopCheckpoint | undefined {
		const state = this.state();
		const point = state?.checkpoint;
		if (!point) return undefined;
		const items: ModelInput = [];
		for (const row of this.#rows<{ seq: number }>(
			"SELECT seq FROM native_items WHERE epoch=? AND seq<? ORDER BY seq",
			point.epoch,
			point.items,
		)) {
			const body = this.#rows<{ data: string }>(
				"SELECT data FROM native_chunks WHERE epoch=? AND seq=? ORDER BY idx",
				point.epoch,
				row.seq,
			)
				.map((chunk) => chunk.data)
				.join("");
			items.push(JSON.parse(body));
		}
		if (items.length !== point.items)
			throw new AppError("Runtime context is incomplete", ErrorCode.Internal);
		this.#native = items;
		const { epoch: _epoch, items: _count, ...checkpoint } = point;
		const pendingCalls = this.#rows<{ value: string }>(
			"SELECT value FROM local_steps WHERE json_extract(value,'$.kind')=? AND json_extract(value,'$.status') IN (?,?) ORDER BY idx",
			StepKind.TOOL,
			StepStatus.PENDING,
			StepStatus.RUNNING,
		).map(({ value }) => {
			const step = stepDates(JSON.parse(value));
			const call = items.find(
				(item) =>
					"type" in item &&
					item.type === "function_call" &&
					item.call_id === step.callId,
			);
			if (!call || !("type" in call) || call.type !== "function_call")
				throw new AppError("Pending call is missing", ErrorCode.Internal);
			return {
				stepIndex: step.index,
				callId: call.call_id,
				name: call.name,
				arguments: call.arguments,
				started: step.startedAt !== null,
			};
		});
		return {
			...checkpoint,
			messages: items,
			...(point.phase === "tools" ? { pendingCalls } : {}),
		};
	}
	partsPage(at: number, after = -1) {
		return this.#rows<{ value: string }>(
			"SELECT v.value FROM local_parts p JOIN part_versions v ON v.id=p.id WHERE p.ordinal>? AND v.commit_seq=(SELECT max(x.commit_seq) FROM part_versions x WHERE x.id=p.id AND x.commit_seq<=?) ORDER BY p.ordinal LIMIT 32",
			after,
			at,
		).map(({ value }) => JSON.parse(value) as PartDescriptor);
	}
	bodyPage(part: PartDescriptor, after = -1) {
		return this.#rows<{ idx: number; data: string }>(
			"SELECT idx,data FROM part_chunks WHERE id=? AND generation=? AND idx>? AND idx<? ORDER BY idx LIMIT 10",
			part.id,
			part.generation,
			after,
			part.chunks,
		);
	}
	steps(): StepRecord[] {
		return this.#rows<{ value: string }>(
			"SELECT value FROM local_steps ORDER BY idx",
		).map(({ value }) => {
			const { callId: _callId, ...step } = stepDates(JSON.parse(value));
			return step;
		});
	}
	*textChunks(at = this.state()!.commitSeq): Generator<string> {
		let after = -1;
		let first = true;
		while (true) {
			const parts = this.partsPage(at, after);
			if (!parts.length) return;
			for (const part of parts) {
				if (part.meta.content.case !== "text") continue;
				if (!first) yield "\n";
				first = false;
				let chunk = -1;
				while (chunk + 1 < part.chunks) {
					const rows = this.bodyPage(part, chunk);
					if (!rows.length)
						throw new AppError(
							"Active text is incomplete",
							ErrorCode.Unavailable,
						);
					for (const row of rows) yield row.data;
					chunk = rows.at(-1)!.idx;
				}
			}
			after = parts.at(-1)!.ordinal;
		}
	}
	#archiveRecord(
		cursor: ArchiveCursor,
	): { record: ArchiveRecord; cursor: ArchiveCursor } | undefined {
		if (cursor.section === 0) {
			const [row] = this.#rows<{ value: string }>(
				"SELECT value FROM part_heads WHERE ordinal>? ORDER BY ordinal LIMIT 1",
				cursor.ordinal,
			);
			if (row) {
				const part = JSON.parse(row.value) as PartDescriptor;
				return {
					record: { kind: "part", value: part },
					cursor: { ...cursor, ordinal: part.ordinal },
				};
			}
			return this.#archiveRecord({
				...cursor,
				section: 1,
				ordinal: -1,
				chunk: -1,
			});
		}
		if (cursor.section === 1) {
			const [head] = this.#rows<{ value: string }>(
				"SELECT value FROM part_heads WHERE ordinal>=? AND json_extract(value,'$.chunks')>0 AND (ordinal>? OR json_extract(value,'$.chunks')>?) ORDER BY ordinal LIMIT 1",
				cursor.ordinal,
				cursor.ordinal,
				cursor.chunk + 1,
			);
			if (head) {
				const part = JSON.parse(head.value) as PartDescriptor;
				const after = part.ordinal === cursor.ordinal ? cursor.chunk : -1;
				const [row] = this.#rows<{ idx: number; data: string }>(
					"SELECT idx,data FROM part_chunks WHERE id=? AND generation=? AND idx>? AND idx<? ORDER BY idx LIMIT 1",
					part.id,
					part.generation,
					after,
					part.chunks,
				);
				if (!row || row.idx !== after + 1)
					throw new AppError("Sealed body is incomplete", ErrorCode.Internal);
				return {
					record: {
						kind: "chunk",
						partId: part.id,
						index: row.idx,
						data: row.data,
					},
					cursor: { ...cursor, ordinal: part.ordinal, chunk: row.idx },
				};
			}
			return this.#archiveRecord({ ...cursor, section: 2 });
		}
		if (cursor.section === 2) {
			const [row] = this.#rows<{ value: string }>(
				"SELECT value FROM local_steps WHERE idx>? ORDER BY idx LIMIT 1",
				cursor.step,
			);
			if (row) {
				const { callId: _callId, ...step } = stepDates(JSON.parse(row.value));
				return {
					record: { kind: "step", value: step },
					cursor: { ...cursor, step: step.index },
				};
			}
		}
		return undefined;
	}
	async archive(db: Database) {
		let state = this.state();
		if (!state?.seal) return;
		while (true) {
			const records: ArchiveRecord[] = [];
			let cursor = state.archive ?? startCursor();
			let bytes = 0;
			while (true) {
				const next = this.#archiveRecord(cursor);
				if (!next) break;
				const size = new TextEncoder().encode(json(next.record)).byteLength;
				if (records.length && bytes + size > 400 * 1024) break;
				records.push(next.record);
				bytes += size;
				cursor = next.cursor;
			}
			if (!records.length) break;
			const digest = await contentDigest(JSON.stringify(records));
			await importArchivePage(db, state.seal!, {
				index: cursor.pages,
				records,
				digest,
			});
			cursor = {
				...cursor,
				pages: cursor.pages + 1,
				digest: await contentDigest(cursor.digest + digest),
			};
			this.storage.transactionSync(() => {
				const current = this.state()!;
				current.archive = cursor;
				this.#writeState(current);
			});
			await this.storage.sync();
			state = this.state()!;
		}
		const final = await finalizeArchive(
			db,
			state.seal!,
			state.archive ?? startCursor(),
		);
		this.storage.transactionSync(() => {
			const current = this.state()!;
			current.run = final;
			this.#writeState(current);
		});
		await this.storage.sync();
	}
}
