import { isCurrentSession } from "~/features/auth/store";
import type { SessionOwner } from "~/features/auth/types";
import {
	fileSize,
	isImage,
	maxAttachments,
	maxFileBytes,
	modelFileBytes,
	isModelFileType,
} from "~/features/files/kinds";
import {
	keepLocalImage,
	releaseLocalImages,
} from "~/features/files/local-images";
import type { File as StoredFile } from "~/gen/heveta/v1/file_pb";
import type { ReasoningEffort } from "~/gen/heveta/v1/model_pb";
import type { Message } from "~/i18n/messages";
import { fileClient, uploadFile } from "~/lib/rpc-client";

// A draft operation that failed for a reason to show the person, carrying it
// as a Message rather than an already-translated string (this module renders
// nothing itself).
export class DraftError extends Error {
	constructor(readonly reason: Message) {
		super(typeof reason === "string" ? reason : reason.key);
	}
}

// modelId is a catalog id and reasoningEffort one of that model's efforts;
// empty or UNSPECIFIED lets the server choose (the default for a new turn, the
// previous attempt's for a retry).
export type TurnCommand =
	| {
			kind: "start";
			deviceId?: string;
			text: string;
			files: StoredFile[];
			modelId: string;
			reasoningEffort: ReasoningEffort;
	  }
	| {
			kind: "retry";
			turnId: string;
			previousRunId: string;
			modelId: string;
			reasoningEffort: ReasoningEffort;
	  };
// A message or regeneration from its composer until the server takes it:
// "sending", sent again with the same request ID while its outcome is
// unknown (the server takes a request once), or "retryable", refused by the
// server and back in the composer with the reason.
export interface Submission {
	requestId: string;
	input: TurnCommand;
	phase: "sending" | "retryable";
	// Why it is back, or why it is taking a while.
	error?: Message;
	// Back because it was stopped before the server took it, not refused.
	withdrawn?: boolean;
	cancelRequested?: boolean;
	// A sent message leaves the composer at once, as in mainstream chat apps.
	// Its files wait here until the server confirms the turn; a failed send
	// hands both back to the composer.
	attachments: Attachment[];
}
interface Attachment {
	id: string;
	name: string;
	size: number;
	// As the browser types the chosen file; the server's type, once uploaded,
	// is `file.mimeType`.
	mimeType: string;
	// Images only.
	previewUrl?: string;
	// Of the upload, 0 to 1.
	progress: number;
	controller: AbortController;
	file?: StoredFile;
}
export interface ThreadDraft {
	owner: SessionOwner;
	threadId: string;
	message: string;
	deviceId?: string;
	attachments: Attachment[];
	submission?: Submission;
}

export function draftKey(owner: SessionOwner, threadId: string) {
	return `${owner.sessionVersion}:${owner.userId}:${threadId}`;
}
export function isDraftLocked(draft: ThreadDraft) {
	return Boolean(draft.submission && draft.submission.phase !== "retryable");
}
// This store belongs to the layout provider, never to a responsive UI subtree.
// A submission retains its input until the server confirms it was persisted.
export class ThreadDrafts {
	private drafts = new Map<string, ThreadDraft>();
	// A moved draft stays visible at its old key until the page has followed
	// it to the new thread, so the view never shows an empty draft in between.
	private moved = new Map<string, ThreadDraft>();
	private listeners = new Set<() => void>();
	private revision = 0;
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	getSnapshot = () => this.revision;
	get hasPendingWork() {
		return [...this.drafts.values()].some((draft) =>
			Boolean(draft.message || draft.attachments.length || draft.submission),
		);
	}
	private changed() {
		this.revision++;
		for (const listener of this.listeners) listener();
	}
	get(owner: SessionOwner, threadId: string) {
		const key = draftKey(owner, threadId);
		const moved = this.moved.get(key);
		if (moved && this.has(moved)) return moved;
		let draft = this.drafts.get(key);
		if (!draft) {
			draft = { owner, threadId, message: "", attachments: [] };
			this.drafts.set(key, draft);
		}
		return draft;
	}
	has(draft: ThreadDraft) {
		return this.drafts.get(draftKey(draft.owner, draft.threadId)) === draft;
	}
	// The session's drafts whose sent message the server has not confirmed.
	unconfirmed(owner: SessionOwner) {
		return [...this.drafts.values()].filter(
			(draft) =>
				draft.owner.userId === owner.userId &&
				draft.owner.sessionVersion === owner.sessionVersion &&
				isDraftLocked(draft),
		);
	}
	move(draft: ThreadDraft, threadId: string) {
		if (!this.has(draft)) return;
		const key = draftKey(draft.owner, draft.threadId);
		this.drafts.delete(key);
		this.moved.set(key, draft);
		draft.threadId = threadId;
		this.drafts.set(draftKey(draft.owner, threadId), draft);
		this.changed();
	}
	// The page now shows the moved draft at its own key.
	followed(owner: SessionOwner, threadId: string) {
		this.moved.delete(draftKey(owner, threadId));
	}
	setDevice(draft: ThreadDraft, deviceId: string) {
		if (
			!this.has(draft) ||
			!isCurrentSession(draft.owner) ||
			isDraftLocked(draft) ||
			draft.deviceId === deviceId
		)
			return;
		draft.deviceId = deviceId;
		if (draft.submission?.phase === "retryable") draft.submission = undefined;
		this.changed();
	}
	setMessage(draft: ThreadDraft, message: string) {
		if (
			!this.has(draft) ||
			!isCurrentSession(draft.owner) ||
			draft.message === message
		)
			return;
		draft.message = message;
		// Editing a failed message makes it a new one; an in-flight send stays.
		if (draft.submission?.phase === "retryable") draft.submission = undefined;
		this.changed();
	}
	begin(draft: ThreadDraft, input: TurnCommand) {
		const submission: Submission = {
			requestId: crypto.randomUUID(),
			input:
				input.kind === "start"
					? { ...input, files: input.files.map((file) => ({ ...file })) }
					: { ...input },
			phase: "sending",
			attachments: [],
		};
		if (input.kind === "start") {
			submission.attachments = draft.attachments;
			draft.message = "";
			draft.attachments = [];
		}
		draft.submission = submission;
		this.changed();
		return submission;
	}
	setSubmission(
		draft: ThreadDraft,
		submission: Submission,
		phase: Submission["phase"],
		error?: Message,
	) {
		if (!this.has(draft) || draft.submission !== submission) return;
		submission.phase = phase;
		submission.error = error;
		if (phase === "retryable") this.restore(draft, submission);
		this.changed();
	}
	// Drops a failed regeneration; it has no draft content to hand back.
	settle(draft: ThreadDraft, submission: Submission) {
		if (!this.has(draft) || draft.submission !== submission) return;
		draft.submission = undefined;
		this.changed();
	}
	requestCancellation(draft: ThreadDraft, submission: Submission) {
		if (!this.has(draft) || draft.submission !== submission) return;
		submission.cancelRequested = true;
		this.changed();
	}
	// Files cannot be added while a send is unconfirmed, so the draft has
	// none of its own; text typed meanwhile is kept after the failed message.
	private restore(draft: ThreadDraft, submission: Submission) {
		if (submission.input.kind !== "start") return;
		const text = submission.input.text;
		draft.message = [text, draft.message].filter(Boolean).join("\n\n");
		draft.attachments = [...submission.attachments, ...draft.attachments];
		submission.attachments = [];
	}
	accept(draft: ThreadDraft, submission: Submission) {
		if (!this.has(draft) || draft.submission !== submission) return;
		for (const attachment of submission.attachments) {
			// A sent image's local copy goes on showing it in the server's copy
			// of the message until that one's image has loaded (local-images.ts).
			if (attachment.file && attachment.previewUrl)
				keepLocalImage(attachment.file.id, attachment.previewUrl);
			else this.release(attachment);
		}
		submission.attachments = [];
		draft.submission = undefined;
		this.changed();
	}
	private release(attachment: Attachment) {
		attachment.controller.abort();
		if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
	}
	private deleteUploaded(owner: SessionOwner, file: StoredFile) {
		if (!isCurrentSession(owner)) return;
		// The server rejects deletion after a message claims the file. Network
		// failures and uploads with no response are covered by temporary-file GC.
		void fileClient.deleteFile({ fileId: file.id }).catch(() => {});
	}
	private detachAttachment(draft: ThreadDraft, attachment: Attachment) {
		if (!this.has(draft) || !draft.attachments.includes(attachment)) return;
		draft.attachments = draft.attachments.filter((item) => item !== attachment);
		this.release(attachment);
		if (attachment.file) this.deleteUploaded(draft.owner, attachment.file);
		this.changed();
	}
	removeAttachment(draft: ThreadDraft, id: string) {
		if (
			!this.has(draft) ||
			!isCurrentSession(draft.owner) ||
			isDraftLocked(draft)
		)
			return;
		const attachment = draft.attachments.find((item) => item.id === id);
		if (!attachment) return;
		draft.submission = undefined;
		this.detachAttachment(draft, attachment);
	}
	async upload(draft: ThreadDraft, file: File) {
		if (
			!this.has(draft) ||
			isDraftLocked(draft) ||
			!isCurrentSession(draft.owner)
		)
			return;
		if (!file.size) throw new DraftError("threads.emptyFileNotAllowed");
		if (file.size > maxFileBytes)
			throw new DraftError({
				key: "threads.fileTooLarge",
				values: { max: fileSize(maxFileBytes) },
			});
		if (draft.attachments.length >= maxAttachments)
			throw new DraftError({
				key: "threads.maxAttachmentsPerMessage",
				values: { max: maxAttachments },
			});
		const modelBytes = [
			...draft.attachments,
			{ size: file.size, mimeType: file.type },
		]
			.filter((item) => isModelFileType(item.mimeType))
			.reduce((bytes, item) => bytes + item.size, 0);
		if (isModelFileType(file.type) && modelBytes > modelFileBytes)
			throw new DraftError({
				key: "threads.modelFilesTooLarge",
				values: { max: fileSize(modelFileBytes) },
			});
		const attachment: Attachment = {
			id: crypto.randomUUID(),
			name: file.name,
			size: file.size,
			mimeType: file.type,
			previewUrl: isImage(file.type) ? URL.createObjectURL(file) : undefined,
			progress: 0,
			controller: new AbortController(),
		};
		draft.attachments.push(attachment);
		draft.submission = undefined;
		this.changed();
		const { signal } = attachment.controller;
		try {
			const uploaded = await uploadFile(file, {
				signal,
				onProgress: (share) => {
					attachment.progress = share;
					this.changed();
				},
			});
			if (
				signal.aborted ||
				!this.has(draft) ||
				!isCurrentSession(draft.owner)
			) {
				this.deleteUploaded(draft.owner, uploaded);
				return;
			}
			attachment.file = uploaded;
			this.changed();
		} catch {
			if (signal.aborted || !isCurrentSession(draft.owner)) return;
			// An unrelated regeneration may have locked this draft while uploading.
			// Remove only the failed upload, preserving that submission and its lock.
			this.detachAttachment(draft, attachment);
			throw new DraftError({
				key: "threads.uploadFailedNamed",
				values: { name: file.name },
			});
		}
	}
	discard(owner: SessionOwner, threadId: string) {
		const key = draftKey(owner, threadId);
		const draft = this.drafts.get(key);
		if (!draft) return;
		this.drafts.delete(key);
		// An unconfirmed submission may already own its files remotely.
		for (const attachment of draft.submission?.attachments ?? [])
			this.release(attachment);
		for (const attachment of draft.attachments) {
			this.release(attachment);
			// An unconfirmed submission may already own these files remotely.
			if (!isDraftLocked(draft) && attachment.file)
				this.deleteUploaded(owner, attachment.file);
		}
		this.changed();
	}
	clear() {
		this.moved.clear();
		for (const draft of this.drafts.values())
			this.discard(draft.owner, draft.threadId);
		releaseLocalImages();
	}
}
