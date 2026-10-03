import { Buffer } from "node:buffer";

import { env } from "cloudflare:workers";
import { and, eq, inArray } from "drizzle-orm";

import type { Database } from "@/db/client";
import { type File, files } from "@/db/schema/files";
import { AppError, ErrorCode } from "@/lib/errors";
import type { ModelFileSource } from "@/runtime/responses/model-files";

import { isModelFileType } from "./types";

// The files the model reads itself (images and PDFs), through the storage
// binding. Their records come first, all in one query, so a request's budget
// is spent by their recorded sizes before anything is read (runtime/responses/
// model-files.ts); then each one's data, as a data URL.
export function modelFileSource(db: Database, userId: string): ModelFileSource {
	const records = new Map<string, File>();
	return {
		async sizes(ids, signal) {
			signal.throwIfAborted();
			const rows = ids.length
				? await db
						.select()
						.from(files)
						.where(
							and(
								eq(files.userId, userId),
								inArray(files.id, ids),
								eq(files.status, "stored"),
							),
						)
				: [];
			for (const row of rows) records.set(row.id, row);
			return new Map(
				ids.map((id) => {
					const file = records.get(id);
					return [
						id,
						!file
							? new AppError("File not found", ErrorCode.NotFound)
							: !isModelFileType(file.mimeType)
								? new AppError(
										"Only images and PDFs can be sent to the model",
										ErrorCode.InvalidArgument,
									)
								: Number(file.size),
					];
				}),
			);
		},
		async read(id, signal) {
			const file = records.get(id);
			if (!file) throw new AppError("File not found", ErrorCode.NotFound);
			return readModelFile(file, signal);
		},
	};
}

async function readModelFile(file: File, signal: AbortSignal) {
	signal.throwIfAborted();
	const object = await env.BUCKET.get(file.storageKey);
	if (!object)
		throw new AppError(
			"An attached file is no longer available",
			ErrorCode.FailedPrecondition,
		);
	// The budget was spent by the recorded size; an object of another size is
	// not the file as stored, and is not read past it.
	if (object.size !== Number(file.size)) {
		await object.body.cancel();
		throw new AppError(
			"An attached file is no longer available",
			ErrorCode.FailedPrecondition,
		);
	}
	const reader = object.body.getReader();
	const abort = () => {
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		signal.throwIfAborted();
		const content = new Uint8Array(object.size);
		let offset = 0;
		while (true) {
			const { value, done } = await reader.read();
			signal.throwIfAborted();
			if (done) break;
			content.set(value, offset);
			offset += value.length;
		}
		// A short read is storage failing for now, not the file: the run
		// retries the request later (a plain error is transient to it).
		if (offset !== object.size)
			throw new Error("An attached file was read short");
		signal.throwIfAborted();
		return `data:${file.mimeType};base64,${Buffer.from(content.buffer).toString("base64")}`;
	} finally {
		signal.removeEventListener("abort", abort);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
