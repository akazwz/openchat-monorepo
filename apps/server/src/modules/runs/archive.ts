import { and, count, eq, inArray, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
	messagePartChunks,
	messageParts,
	runArchivePages,
	runArchives,
} from "@/db/schema/message-content";
import { messageFiles } from "@/db/schema/message-files";
import { messages } from "@/db/schema/messages";
import { type RunRecord, runs } from "@/db/schema/runs";
import { type StepRecord, steps } from "@/db/schema/steps";
import { AppError, ErrorCode } from "@/lib/errors";
import { discardUnreferenced, partFileIds } from "@/modules/files/lifecycle";
import { StepStatus } from "@/modules/steps/types";
import { contentDigest, type PartDescriptor } from "@/modules/threads/content";
import { decodeParts } from "@/modules/threads/storage";

import { isActiveRun, RunStatus } from "./types";

export type ArchiveRecord =
	| { kind: "part"; value: PartDescriptor }
	| { kind: "chunk"; partId: string; index: number; data: string }
	| { kind: "step"; value: StepRecord };
export interface RunSeal {
	id: string;
	run: RunRecord;
	messageId: string;
	revision: number;
	openStepStatus: StepStatus;
	parts: number;
	chunks: number;
	steps: number;
}
export interface ArchivePage {
	index: number;
	records: ArchiveRecord[];
	digest: string;
}

export async function importArchivePage(
	db: Database,
	seal: RunSeal,
	page: ArchivePage,
) {
	const hash = await contentDigest(JSON.stringify(page.records));
	if (hash !== page.digest)
		throw new AppError("Archive page digest mismatch", ErrorCode.Internal);
	return db.transaction(async (tx) => {
		const [run] = await tx
			.select()
			.from(runs)
			.where(eq(runs.id, seal.run.id))
			.for("update");
		if (!run || run.userId !== seal.run.userId)
			throw new AppError("Run not found", ErrorCode.NotFound);
		await tx
			.insert(runArchives)
			.values({ runId: run.id, sealId: seal.id })
			.onConflictDoNothing();
		const [archive] = await tx
			.select()
			.from(runArchives)
			.where(eq(runArchives.runId, run.id));
		if (archive.sealId !== seal.id)
			throw new AppError("Archive identity mismatch", ErrorCode.Internal);
		const [previous] = await tx
			.select()
			.from(runArchivePages)
			.where(
				and(
					eq(runArchivePages.runId, run.id),
					eq(runArchivePages.index, page.index),
				),
			);
		if (previous) {
			if (previous.digest !== hash)
				throw new AppError("Conflicting archive page", ErrorCode.Internal);
			return;
		}
		if (!isActiveRun(run.status) || archive.pages !== page.index)
			throw new AppError(
				"Archive page order mismatch",
				ErrorCode.FailedPrecondition,
			);
		const heads = page.records.flatMap((record) =>
			record.kind === "part"
				? [
						{
							messageId: seal.messageId,
							id: record.value.id,
							ordinal: record.value.ordinal,
							meta: record.value.meta,
							chunks: record.value.chunks,
							chars: record.value.chars,
							modelChars: record.value.modelChars,
							stepIndex: record.value.stepIndex,
						},
					]
				: [],
		);
		const blocks = page.records.flatMap((record) =>
			record.kind === "chunk"
				? [
						{
							messageId: seal.messageId,
							partId: record.partId,
							index: record.index,
							data: record.data,
						},
					]
				: [],
		);
		const operations = page.records.flatMap((record) =>
			record.kind === "step" ? [record.value] : [],
		);
		if (heads.length) await tx.insert(messageParts).values(heads);
		if (blocks.length) await tx.insert(messagePartChunks).values(blocks);
		if (operations.length) await tx.insert(steps).values(operations);
		await tx
			.insert(runArchivePages)
			.values({ runId: run.id, index: page.index, digest: hash });
		await tx
			.update(runArchives)
			.set({
				pages: page.index + 1,
				records: archive.records + page.records.length,
				digest: await contentDigest(archive.digest + hash),
			})
			.where(eq(runArchives.runId, run.id));
	});
}

export async function finalizeArchive(
	db: Database,
	seal: RunSeal,
	expected: { pages: number; digest: string },
): Promise<RunRecord> {
	return db.transaction(async (tx) => {
		const [run] = await tx
			.select()
			.from(runs)
			.where(eq(runs.id, seal.run.id))
			.for("update");
		if (!run || run.userId !== seal.run.userId)
			throw new AppError("Run not found", ErrorCode.NotFound);
		if (expected.pages === 0)
			await tx
				.insert(runArchives)
				.values({ runId: run.id, sealId: seal.id })
				.onConflictDoNothing();
		const [archive] = await tx
			.select()
			.from(runArchives)
			.where(eq(runArchives.runId, run.id));
		if (
			!archive ||
			archive.sealId !== seal.id ||
			archive.pages !== expected.pages ||
			archive.digest !== expected.digest
		)
			throw new AppError("Archive is incomplete", ErrorCode.FailedPrecondition);
		if (!isActiveRun(run.status)) {
			if (run.revision !== seal.revision)
				throw new AppError(
					"Archive final version mismatch",
					ErrorCode.Internal,
				);
			return run;
		}
		const [partCount] = await tx
			.select({ total: count() })
			.from(messageParts)
			.where(eq(messageParts.messageId, seal.messageId));
		const [chunkCount] = await tx
			.select({ total: count() })
			.from(messagePartChunks)
			.where(eq(messagePartChunks.messageId, seal.messageId));
		const [stepCount] = await tx
			.select({ total: count() })
			.from(steps)
			.where(eq(steps.runId, run.id));
		if (
			partCount.total !== seal.parts ||
			chunkCount.total !== seal.chunks ||
			stepCount.total !== seal.steps ||
			archive.records !== seal.parts + seal.chunks + seal.steps
		)
			throw new AppError("Archive manifest mismatch", ErrorCode.Internal);
		const invalid = await tx.execute(
			sql`select p.id from message_parts p left join message_part_chunks c on c.message_id=p.message_id and c.part_id=p.id where p.message_id=${seal.messageId} group by p.id,p.chunks having count(c.index) <> p.chunks or coalesce(max(c.index),-1) <> p.chunks-1 limit 1`,
		);
		if (invalid.rows.length)
			throw new AppError("Archive chunk manifest mismatch", ErrorCode.Internal);
		const cancelled =
			run.cancelRequested && seal.run.status !== RunStatus.COMPLETED;
		const openStatus = cancelled ? StepStatus.CANCELLED : seal.openStepStatus;
		await tx
			.update(steps)
			.set({ status: StepStatus.CANCELLED, finishedAt: seal.run.finishedAt })
			.where(
				and(eq(steps.runId, run.id), eq(steps.status, StepStatus.PENDING)),
			);
		await tx
			.update(steps)
			.set({ status: openStatus, finishedAt: seal.run.finishedAt })
			.where(
				and(eq(steps.runId, run.id), eq(steps.status, StepStatus.RUNNING)),
			);
		await tx
			.update(messages)
			.set({
				updatedAt: seal.run.finishedAt!,
				text: sql`coalesce((select string_agg(body, chr(10) order by ordinal) from (select p.ordinal, coalesce(string_agg(c.data, '' order by c.index), '') as body from message_parts p left join message_part_chunks c on c.message_id = p.message_id and c.part_id = p.id where p.message_id = ${seal.messageId} and p.meta->'content'->>'case' = 'text' group by p.ordinal) as bodies), '')`,
			})
			.where(and(eq(messages.id, seal.messageId), eq(messages.runId, run.id)));
		// Active/private pins are retained until this transaction. Only this
		// message's unused pins are released; other message/email pins remain.
		const heads = await tx
			.select({ meta: messageParts.meta })
			.from(messageParts)
			.where(eq(messageParts.messageId, seal.messageId));
		const keep = new Set(
			heads.flatMap(({ meta }) => decodeParts([meta]).flatMap(partFileIds)),
		);
		const references = await tx
			.select()
			.from(messageFiles)
			.where(eq(messageFiles.messageId, seal.messageId));
		const released = references
			.map((row) => row.fileId)
			.filter((id) => !keep.has(id));
		if (released.length) {
			await tx
				.delete(messageFiles)
				.where(
					and(
						eq(messageFiles.messageId, seal.messageId),
						inArray(messageFiles.fileId, released),
					),
				);
			await discardUnreferenced(tx, run.userId, released);
		}
		const [final] = await tx
			.update(runs)
			.set({
				status: cancelled ? RunStatus.CANCELLED : seal.run.status,
				startedAt: seal.run.startedAt,
				finishedAt: seal.run.finishedAt,
				error: cancelled ? "" : seal.run.error,
				revision: seal.revision,
			})
			.where(eq(runs.id, run.id))
			.returning();
		return final;
	});
}
