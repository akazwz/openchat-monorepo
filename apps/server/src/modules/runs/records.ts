import { and, eq, or, sql, getColumns } from "drizzle-orm";

import type { Database } from "@/db/client";
import { messages } from "@/db/schema/messages";
import { type RunRecord, runs } from "@/db/schema/runs";
import { AppError, ErrorCode } from "@/lib/errors";
import { advisoryLock } from "@/lib/sql";
import { archivedParts } from "@/modules/threads/content-store";
import { messageFromRow } from "@/modules/threads/storage";

import type { Run, RunLookup, RunSnapshot } from "./types";

export const validRequestId = (id: string) => /^[\w-]{16,128}$/.test(id);
export function validateLookup(lookup: RunLookup) {
	if (Boolean(lookup.runId) === Boolean(lookup.requestId))
		throw new AppError(
			"Provide either run_id or request_id",
			ErrorCode.InvalidArgument,
		);
	if (lookup.requestId && !validRequestId(lookup.requestId))
		throw new AppError("Invalid request_id", ErrorCode.InvalidArgument);
}
export const lookupCondition = (userId: string, lookup: RunLookup) =>
	and(
		eq(runs.userId, userId),
		lookup.requestId
			? eq(runs.requestId, lookup.requestId)
			: eq(runs.id, lookup.runId!),
	);
export async function lockRequest(
	db: Database,
	userId: string,
	requestId: string,
) {
	await advisoryLock(db, "run-request", userId, requestId);
}
export function publicRun(row: RunRecord): Run {
	return {
		id: row.id,
		threadId: row.threadId,
		requestId: row.requestId,
		turnId: row.turnId,
		attempt: row.attempt,
		model: row.model,
		deviceId: row.deviceId,
		reasoningEffort: row.reasoningEffort,
		status: row.status,
		createdAt: row.createdAt,
		startedAt: row.startedAt,
		finishedAt: row.finishedAt,
		cancelRequested: row.cancelRequested,
	};
}
// A run's messages: its turn's input and its own output.
export async function loadRunMessages(db: Database, run: RunRecord) {
	const rows = await db
		.select({ ...getColumns(messages), text: sql<string>`''` })
		.from(messages)
		.where(
			and(
				eq(messages.userId, run.userId),
				eq(messages.threadId, run.threadId),
				eq(messages.turnId, run.turnId),
				or(eq(messages.role, "user"), eq(messages.runId, run.id)),
			),
		);
	const input = rows.find((row) => row.role === "user");
	const output = rows.find((row) => row.runId === run.id);
	if (!input || !output)
		throw new AppError("Run messages not found", ErrorCode.Internal);
	return { input: messageFromRow(input), output: messageFromRow(output) };
}
export async function snapshotFromRun(
	db: Database,
	run: RunRecord,
): Promise<RunSnapshot> {
	const { input, output } = await loadRunMessages(db, run);
	if (run.status === 1 || run.status === 2)
		return {
			run: publicRun({
				...run,
				status: 1,
				startedAt: null,
				finishedAt: null,
				cancelRequested: false,
			}),
			inputMessage: input,
			outputMessage: { ...output, parts: [] },
			revision: 1,
		};
	output.parts = await archivedParts(db, output.id, { omitLongOutputs: true });
	return {
		run: publicRun(run),
		inputMessage: input,
		outputMessage: output,
		revision: run.revision,
	};
}
