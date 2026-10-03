import { env } from "cloudflare:workers";
import { and, asc, eq, exists, gt, inArray, lte, or, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { emailFiles } from "@/db/schema/email-files";
import { files } from "@/db/schema/files";
import { messageFiles } from "@/db/schema/message-files";
import { messages } from "@/db/schema/messages";
import { ErrorReason } from "@/gen/heveta/v1/error_pb";
import { AppError, ErrorCode } from "@/lib/errors";
import type { MessagePart } from "@/modules/threads/types";

// An upload no message references is kept this long, for its message to be
// sent; after it, it is garbage.
export const temporaryUploadLifetimeMs = 24 * 60 * 60 * 1000;

// The files a message part references: an attachment or a file a tool
// showed, or the images the model read as a tool result.
export function partFileIds(part: MessagePart) {
	if (part.content.case === "file") return [part.content.value.id];
	if (part.content.case === "toolResult")
		return (part.content.value.images ?? []).map((image) => image.id);
	return [];
}

// A file is in use while a message or an email references it: a message's
// attachment or a file its reply showed, or an email's attachment.
const referenced = (db: Pick<Database, "select">) =>
	sql`(${exists(
		db
			.select({ fileId: messageFiles.fileId })
			.from(messageFiles)
			.where(eq(messageFiles.fileId, files.id)),
	)} or ${exists(
		db
			.select({ fileId: emailFiles.fileId })
			.from(emailFiles)
			.where(eq(emailFiles.fileId, files.id)),
	)})`;
const unreferenced = (db: Pick<Database, "select">) =>
	sql`not ${referenced(db)}`;

// Locks the files a message is about to reference, in its transaction, and
// returns them. A file may be referenced while it is stored and either
// referenced already or uploaded within a day: an older unreferenced one is
// garbage that cleanup may be removing, so claiming it never races cleanup.
export async function claimFiles(
	db: Database,
	userId: string,
	fileIds: string[],
) {
	const ids = [...new Set(fileIds)];
	if (!ids.length) return [];
	const cutoff = new Date(Date.now() - temporaryUploadLifetimeMs);
	const rows = await db
		.select({
			file: files,
			usable: sql<boolean>`${or(gt(files.createdAt, cutoff), referenced(db))}`,
		})
		.from(files)
		.where(
			and(
				eq(files.userId, userId),
				inArray(files.id, ids),
				eq(files.status, "stored"),
			),
		)
		.orderBy(asc(files.id))
		.for("update", { of: files });
	if (rows.length !== ids.length)
		throw new AppError(
			"Attachment not found",
			ErrorCode.NotFound,
			ErrorReason.ATTACHMENT_UNAVAILABLE,
		);
	if (rows.some((row) => !row.usable))
		throw new AppError(
			"An attachment is missing or expired. Upload it again.",
			ErrorCode.FailedPrecondition,
			ErrorReason.ATTACHMENT_UNAVAILABLE,
		);
	const byId = new Map(rows.map((row) => [row.file.id, row.file]));
	return ids.map((id) => byId.get(id)!);
}

// Records that a message references these (claimed) files.
export async function referenceFiles(
	db: Database,
	messageId: string,
	fileIds: string[],
) {
	const ids = [...new Set(fileIds)];
	if (!ids.length) return;
	await db
		.insert(messageFiles)
		.values(ids.map((fileId) => ({ messageId, fileId })))
		.onConflictDoNothing();
}

// The files a thread's messages reference. Call before deleting the thread,
// in the same transaction, then pass them to discardUnreferenced after it.
export async function threadFileIds(
	db: Database,
	userId: string,
	threadId: string,
) {
	const rows = await db
		.selectDistinct({ fileId: messageFiles.fileId })
		.from(messageFiles)
		.innerJoin(messages, eq(messages.id, messageFiles.messageId))
		.where(and(eq(messages.userId, userId), eq(messages.threadId, threadId)));
	return rows.map((row) => row.fileId);
}
// Of these files, those no message or email references any more are deleted:
// cleanup removes them within the hour. Their URLs are served from storage
// directly, so a deleted conversation's or email's files must not wait for
// the upload lifetime.
export async function discardUnreferenced(
	db: Database,
	userId: string,
	fileIds: string[],
) {
	if (!fileIds.length) return;
	await db
		.update(files)
		.set({ status: "deleting" })
		.where(
			and(
				eq(files.userId, userId),
				inArray(files.id, fileIds),
				unreferenced(db),
			),
		);
}

export async function deleteFile(db: Database, userId: string, fileId: string) {
	const key = await db.transaction(async (tx) => {
		const [file] = await tx
			.select()
			.from(files)
			.where(and(eq(files.id, fileId), eq(files.userId, userId)))
			.for("update");
		// Deletion is idempotent, including a racing cleanup of the same upload.
		if (!file) return undefined;
		const [deleting] = await tx
			.update(files)
			.set({ status: "deleting" })
			.where(and(eq(files.id, fileId), unreferenced(tx)))
			.returning({ id: files.id });
		if (!deleting)
			throw new AppError(
				"Files attached to messages or emails cannot be deleted",
				ErrorCode.FailedPrecondition,
			);
		return file.storageKey;
	});
	if (!key) return;
	// Marked first: no message can reference it from now on. A failed delete
	// of its object is retried by cleanup.
	await env.BUCKET.delete(key);
	await db
		.delete(files)
		.where(and(eq(files.id, fileId), eq(files.userId, userId)));
}

// Removes files nothing may use: those marked for deletion, and those no
// message or email references a day after their upload (never sent, or their
// messages or emails deleted). Their objects go first; a failed delete leaves the rows for the
// next run to repeat.
export async function cleanupFiles(db: Database) {
	const cutoff = new Date(Date.now() - temporaryUploadLifetimeMs);
	let removed = 0;
	// Bound each scheduled invocation. Remaining files are handled next hour.
	for (let batch = 0; batch < 10; batch++) {
		const garbage = await db.transaction((tx) =>
			tx
				.select({ id: files.id, key: files.storageKey })
				.from(files)
				.where(
					and(
						unreferenced(tx),
						or(eq(files.status, "deleting"), lte(files.createdAt, cutoff)),
					),
				)
				.orderBy(asc(files.createdAt), asc(files.id))
				.limit(100)
				.for("update", { skipLocked: true }),
		);
		if (!garbage.length) break;
		await env.BUCKET.delete(garbage.map((file) => file.key));
		await db.delete(files).where(
			and(
				inArray(
					files.id,
					garbage.map((file) => file.id),
				),
				unreferenced(db),
			),
		);
		removed += garbage.length;
		if (garbage.length < 100) break;
	}
	return removed;
}
