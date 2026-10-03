import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { files, type NewFile } from "@/db/schema/files";
import { AppError, ErrorCode } from "@/lib/errors";
import { peek } from "@/lib/streams";

import {
	dimensionBytes,
	hasVerifiedType,
	imageDimensions,
	isImageMimeType,
	maxFileBytes,
	signatureBytes,
	sniffMimeType,
} from "./types";

export { claimFiles, deleteFile } from "./lifecycle";

async function createFile(db: Database, newFile: NewFile) {
	const [file] = await db.insert(files).values(newFile).returning();
	return file;
}
export async function getFile(db: Database, userId: string, fileId: string) {
	const [file] = await db
		.select()
		.from(files)
		.where(
			and(
				eq(files.id, fileId),
				eq(files.userId, userId),
				eq(files.status, "stored"),
			),
		);
	if (!file) throw new AppError("File not found", ErrorCode.NotFound);
	return file;
}
// A type as stored and served: lowercase, without parameters (charset and
// the like); anything that is not a type is unknown.
function normalMimeType(value: string) {
	const type = value.split(";")[0].trim().toLowerCase();
	return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)
		? type
		: "application/octet-stream";
}

// Stores a file for the user, streamed into storage without buffering it. It
// is kept once a message or an email references it (files/lifecycle.ts).
export async function storeFile(
	db: Database,
	userId: string,
	file: {
		content: ReadableStream<Uint8Array>;
		size: number;
		fileName: string;
		mimeType: string;
	},
) {
	const { size, fileName } = file;
	if (!Number.isSafeInteger(size) || size < 1 || size > maxFileBytes)
		throw new AppError(
			`Files must be between 1 byte and ${maxFileBytes / 1024 / 1024} MB`,
			ErrorCode.InvalidArgument,
		);
	if (!fileName.trim() || fileName.length > 255)
		throw new AppError("Invalid file name", ErrorCode.InvalidArgument);
	const declared = normalMimeType(file.mimeType);
	const signature = await peek(file.content, signatureBytes);
	// A recognized start decides the type; a file declared as one of those
	// types without its start is not one.
	const sniffed = sniffMimeType(signature.head);
	const mimeType = sniffed ?? declared;
	if (hasVerifiedType(declared) && sniffed !== declared) {
		await signature.stream.cancel();
		throw new AppError(
			"The file's content does not match its type",
			ErrorCode.InvalidArgument,
		);
	}
	let { stream } = signature;
	// An image's size comes from its start; the stream still yields it all.
	let dimensions: { width: number; height: number } | undefined;
	if (isImageMimeType(mimeType)) {
		const image = await peek(stream, dimensionBytes);
		stream = image.stream;
		dimensions = imageDimensions(image.head);
	}
	// The name travels in Content-Disposition, not the key: keys are limited
	// to 1024 bytes and an encoded non-ASCII name can exceed that.
	const storageKey = `files/${crypto.randomUUID()}`;
	// Record the pending upload before creating its object. If the request or
	// Worker stops midway, cleanup can still discover and remove that object.
	const pending = await createFile(db, {
		userId,
		storageKey,
		mimeType,
		fileName,
		size: BigInt(size),
		...dimensions,
		status: "uploading",
	});
	// Only verified images show in place; every other file downloads.
	const disposition = isImageMimeType(mimeType) ? "inline" : "attachment";
	await env.BUCKET.put(
		storageKey,
		// Storage needs the length up front; the stream must match it.
		stream.pipeThrough(new FixedLengthStream(size)),
		{
			httpMetadata: {
				contentType: mimeType,
				contentDisposition: `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
			},
		},
	);
	// Cleanup removes an upload still unfinished a day later.
	const [ready] = await db
		.update(files)
		.set({ status: "stored" })
		.where(
			and(
				eq(files.id, pending.id),
				eq(files.userId, userId),
				eq(files.status, "uploading"),
			),
		)
		.returning();
	if (!ready) {
		await env.BUCKET.delete(storageKey);
		throw new AppError(
			"The upload expired before it completed. Upload it again.",
			ErrorCode.FailedPrecondition,
		);
	}
	return ready;
}
// A stored file's content, streamed from storage.
export async function openFile(db: Database, userId: string, fileId: string) {
	const file = await getFile(db, userId, fileId);
	const object = await env.BUCKET.get(file.storageKey);
	if (!object)
		throw new AppError("The file is no longer stored", ErrorCode.NotFound);
	return object.body;
}
