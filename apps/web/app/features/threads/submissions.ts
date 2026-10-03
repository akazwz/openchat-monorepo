import { Code, ConnectError } from "@connectrpc/connect";

import { isCurrentSession } from "~/features/auth/store";
import type { SessionOwner } from "~/features/auth/types";
import { modelFileBytes } from "~/features/files/kinds";
import { modelsKey } from "~/features/models/model-choice";
import { cancelRun, type RunLookup } from "~/features/runs/run-api";
import { isRunningReply, type RunSnapshot } from "~/features/runs/run-state";
import { retryTurn, startTurn } from "~/features/turns/turn-api";
import { ErrorDetailSchema, ErrorReason } from "~/gen/heveta/v1/error_pb";
import type {
	Thread,
	Message as ThreadMessage,
} from "~/gen/heveta/v1/thread_pb";
import type { Message } from "~/i18n/messages";
import { queryClient } from "~/lib/query-client";

import {
	draftKey,
	isDraftLocked,
	type Submission,
	type ThreadDraft,
	type ThreadDrafts,
	type TurnCommand,
} from "./drafts";
import {
	listedReply,
	messagesQuery,
	seedMessages,
	upsertThread,
} from "./queries";

interface PendingStart {
	controller: AbortController;
	draft: ThreadDraft;
	submission: Submission;
}
interface PendingCancel {
	controller: AbortController;
	draft: ThreadDraft;
	promise: Promise<RunSnapshot | undefined>;
}
interface SubmissionEvents {
	accepted(owner: SessionOwner, snapshot: RunSnapshot): void;
	updated(owner: SessionOwner, snapshot: RunSnapshot): void;
	created(draft: ThreadDraft, sourceKey: string): void | Promise<void>;
	error(message: Message): void;
	// A message was not sent; it is back in its draft with the reason.
	failed(draft: ThreadDraft): void;
}
const cancellationKey = (owner: SessionOwner, lookup: RunLookup) =>
	`${owner.sessionVersion}:${owner.userId}:${lookup.case}:${lookup.value}`;

// A request the server answered with one of these codes was not committed: it
// is reported as is, and resending cannot succeed until something changes.
const rejectionCodes = new Set([
	Code.InvalidArgument,
	Code.FailedPrecondition,
	Code.NotFound,
	Code.PermissionDenied,
	Code.AlreadyExists,
	Code.ResourceExhausted,
]);
function rejectionMessage(
	error: unknown,
	owner: SessionOwner,
	threadId: string,
): Message | undefined {
	if (!(error instanceof ConnectError) || !rejectionCodes.has(error.code))
		return undefined;
	const refreshMessages = () => {
		if (threadId)
			void queryClient.invalidateQueries({
				queryKey: messagesQuery(owner.userId, threadId).queryKey,
			});
	};
	switch (error.findDetails(ErrorDetailSchema)[0]?.reason) {
		case ErrorReason.MODEL_UNKNOWN:
			void queryClient.invalidateQueries({ queryKey: modelsKey });
			return "threads.modelUnavailable";
		case ErrorReason.MODEL_CANNOT_READ_FILES:
			return "threads.modelCannotReadFiles";
		case ErrorReason.MODEL_FILES_TOO_LARGE:
			return {
				key: "threads.filesTooLargeMB",
				values: { max: modelFileBytes / 1024 / 1024 },
			};
		// A copy of a send already withdrawn (a stop before it was taken).
		case ErrorReason.REQUEST_WITHDRAWN:
			return "threads.sendWithdrawn";
		case ErrorReason.RUN_ACTIVE:
			refreshMessages();
			return "threads.runActive";
		case ErrorReason.RUN_CHANGED:
			refreshMessages();
			return "threads.runChanged";
		case ErrorReason.ATTACHMENT_UNAVAILABLE:
			return "threads.attachmentUnavailable";
		case ErrorReason.THREAD_NOT_FOUND:
			return "threads.threadNotFound";
		default:
			return error.code === Code.ResourceExhausted
				? "threads.tooManyRequests"
				: "threads.sendFailed";
	}
}

// How long a send whose outcome is unknown waits before it is sent again,
// by attempt: a second, doubling up to half a minute.
const resendDelay = (attempt: number) => Math.min(30_000, 1000 * 2 ** attempt);

// Commands and draft acknowledgement live together. They do not own a progress
// subscription: changing the selected thread cannot stop an accepted server run.
export class ThreadSubmissions {
	private active = true;
	private revision = 0;
	private listeners = new Set<() => void>();
	private starts = new Map<string, PendingStart>();
	private cancellations = new Map<string, PendingCancel>();
	// Sends whose outcome is unknown, waiting to go out again, and how many
	// times each has been sent.
	private resends = new Map<Submission, ReturnType<typeof setTimeout>>();
	private attempts = new Map<Submission, number>();
	constructor(
		private drafts: ThreadDrafts,
		private events: SubmissionEvents,
	) {}
	subscribe = (listener: () => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};
	getSnapshot = () => this.revision;
	private changed() {
		this.revision++;
		for (const listener of this.listeners) listener();
	}
	private current(draft: ThreadDraft) {
		return (
			this.active && isCurrentSession(draft.owner) && this.drafts.has(draft)
		);
	}
	// A stop was asked for in this conversation and is not settled yet. A stop
	// asked while sending belongs to that send: a refused send (back in the
	// composer) ends it too.
	isCancelling(draft: ThreadDraft) {
		return (
			(isDraftLocked(draft) && Boolean(draft.submission?.cancelRequested)) ||
			[...this.cancellations.values()].some(
				(request) => request.draft === draft,
			)
		);
	}
	attach() {
		this.active = true;
	}
	detach() {
		this.active = false;
		for (const request of this.starts.values()) request.controller.abort();
		for (const request of this.cancellations.values())
			request.controller.abort();
		for (const timer of this.resends.values()) clearTimeout(timer);
		this.starts.clear();
		this.cancellations.clear();
		this.resends.clear();
		this.attempts.clear();
	}
	discard(threadId: string) {
		for (const request of this.starts.values())
			if (request.draft.threadId === threadId) request.controller.abort();
	}
	start(draft: ThreadDraft, input: TurnCommand) {
		if (!this.current(draft) || isDraftLocked(draft)) return;
		this.send(draft, this.drafts.begin(draft, input));
	}
	private send(draft: ThreadDraft, submission: Submission) {
		clearTimeout(this.resends.get(submission));
		this.resends.delete(submission);
		if (this.starts.has(submission.requestId)) return;
		const request = { controller: new AbortController(), draft, submission };
		this.starts.set(submission.requestId, request);
		this.changed();
		void this.execute(request);
	}
	// A send whose outcome is unknown goes out again with the same request ID:
	// the server takes a request once, and answers a repeat with its run.
	private resendLater(draft: ThreadDraft, submission: Submission) {
		const attempt = this.attempts.get(submission) ?? 0;
		this.attempts.set(submission, attempt + 1);
		this.drafts.setSubmission(
			draft,
			submission,
			"sending",
			"threads.offlineWillResend",
		);
		this.resends.set(
			submission,
			setTimeout(() => {
				if (this.current(draft) && draft.submission === submission)
					this.send(draft, submission);
			}, resendDelay(attempt)),
		);
	}
	// After an outage, the sends waiting to go out again go now.
	resendAll(owner: SessionOwner) {
		for (const draft of this.drafts.unconfirmed(owner))
			if (draft.submission && this.resends.has(draft.submission))
				this.send(draft, draft.submission);
	}
	// Whether a send of this session waits for the run of this request.
	awaited(owner: SessionOwner, requestId: string) {
		return this.drafts
			.unconfirmed(owner)
			.some((draft) => draft.submission?.requestId === requestId);
	}
	cancel(draft: ThreadDraft, reply?: ThreadMessage) {
		if (!this.current(draft) || this.isCancelling(draft)) return;
		const submission = draft.submission;
		// A sent message stays sent; stopping stops its reply. The send may
		// have been taken already; if not, the stop follows once it is.
		if (submission && isDraftLocked(draft)) {
			this.drafts.requestCancellation(draft, submission);
			void this.requestCancellation(draft, {
				case: "requestId",
				value: submission.requestId,
			});
		} else if (reply && isRunningReply(reply) && !reply.runCancelRequested)
			void this.requestCancellation(draft, {
				case: "runId",
				value: reply.runId,
			});
	}
	// A run's snapshot names the request that started it, so it confirms that
	// submission whether it comes before the command's response (the event
	// channel usually delivers it first) or instead of a lost one.
	acknowledge(owner: SessionOwner, snapshot: RunSnapshot) {
		if (!this.active) return;
		for (const draft of this.drafts.unconfirmed(owner)) {
			const submission = draft.submission;
			if (!submission || !this.confirms(draft, submission, snapshot)) continue;
			this.accept(draft, submission, snapshot);
			void this.honorCancellation(draft, submission, snapshot);
		}
	}
	private confirms(
		draft: ThreadDraft,
		submission: Submission,
		snapshot: RunSnapshot,
	) {
		return !(
			(draft.threadId && snapshot.run.threadId !== draft.threadId) ||
			snapshot.run.requestId !== submission.requestId ||
			(submission.input.kind === "retry" &&
				snapshot.run.turnId !== submission.input.turnId)
		);
	}
	// `thread` is the conversation StartTurn's response says it started; an
	// acknowledgement from an event comes after that conversation's own event.
	private accept(
		draft: ThreadDraft,
		submission: Submission,
		snapshot: RunSnapshot,
		thread?: Thread,
	) {
		if (!this.confirms(draft, submission, snapshot))
			throw new Error("Run acknowledgement changed");
		clearTimeout(this.resends.get(submission));
		this.resends.delete(submission);
		this.attempts.delete(submission);
		// Show the persisted messages before the draft drops its optimistic
		// copy, so the transcript never renders a frame without the message.
		this.events.accepted(draft.owner, snapshot);
		if (!draft.threadId && submission.input.kind === "start")
			this.opened(draft, snapshot, thread);
		this.drafts.accept(draft, submission);
	}
	// The server created this conversation with its first turn. The draft moves
	// to it and stays visible at its old key until the page has navigated.
	private opened(draft: ThreadDraft, snapshot: RunSnapshot, thread?: Thread) {
		const sourceKey = draftKey(draft.owner, "");
		const { userId } = draft.owner;
		const { threadId } = snapshot.run;
		// Its only messages are this first turn's, so its list is known without
		// reading it; events had no list to update until now. One already read
		// (the conversation was opened from the side nav meanwhile) is kept.
		if (!queryClient.getQueryData(messagesQuery(userId, threadId).queryKey))
			seedMessages(userId, threadId, [
				snapshot.inputMessage,
				snapshot.outputMessage,
			]);
		this.drafts.move(draft, threadId);
		if (thread) upsertThread(userId, thread);
		void Promise.resolve(this.events.created(draft, sourceKey)).finally(() =>
			this.drafts.followed(draft.owner, ""),
		);
	}
	// A failure is reported where the command came from: a message goes back
	// to the composer with its reason; a regeneration reports it once.
	// A send stopped before the server took it: its request stops going out,
	// a message comes back to its composer, and a regeneration gives the
	// reply it would have replaced back. Nothing failed, so nothing is toasted.
	private withdraw(draft: ThreadDraft, submission: Submission) {
		clearTimeout(this.resends.get(submission));
		this.resends.delete(submission);
		this.attempts.delete(submission);
		submission.withdrawn = true;
		if (submission.input.kind === "retry")
			this.drafts.settle(draft, submission);
		else
			this.drafts.setSubmission(
				draft,
				submission,
				"retryable",
				"threads.sendWithdrawn",
			);
		this.starts.get(submission.requestId)?.controller.abort();
	}
	private fail(draft: ThreadDraft, submission: Submission, message: Message) {
		this.attempts.delete(submission);
		if (submission.input.kind === "retry") {
			this.drafts.settle(draft, submission);
			this.events.error(message);
		} else {
			this.drafts.setSubmission(draft, submission, "retryable", message);
			this.events.failed(draft);
		}
	}
	private async execute(request: PendingStart) {
		const { draft, submission } = request;
		const { signal } = request.controller;
		try {
			const input = submission.input;
			// An empty thread ID starts a new conversation with this turn.
			const { snapshot, thread } =
				input.kind === "retry"
					? await retryTurn(
							{
								turnId: input.turnId,
								previousRunId: input.previousRunId,
								requestId: submission.requestId,
								modelId: input.modelId,
								reasoningEffort: input.reasoningEffort,
							},
							signal,
						)
					: await startTurn(
							{
								threadId: draft.threadId,
								requestId: submission.requestId,
								input: {
									text: input.text,
									fileIds: input.files.map((file) => file.id),
								},
								modelId: input.modelId,
								deviceId: input.deviceId ?? "",
								reasoningEffort: input.reasoningEffort,
							},
							signal,
						);
			if (!this.current(draft)) return;
			this.accept(draft, submission, snapshot, thread);
			await this.honorCancellation(draft, submission, snapshot);
		} catch (error) {
			// Settled meanwhile: refused, or withdrawn (its request was aborted).
			if (
				!this.current(draft) ||
				draft.submission !== submission ||
				submission.phase !== "sending"
			)
				return;
			const rejection = rejectionMessage(error, draft.owner, draft.threadId);
			if (rejection) this.fail(draft, submission, rejection);
			else this.resendLater(draft, submission);
		} finally {
			if (this.starts.get(submission.requestId) === request)
				this.starts.delete(submission.requestId);
			this.changed();
		}
	}
	private requestCancellation(draft: ThreadDraft, lookup: RunLookup) {
		const key = cancellationKey(draft.owner, lookup);
		const existing = this.cancellations.get(key);
		if (existing) return existing.promise;
		const controller = new AbortController();
		const submission =
			lookup.case === "requestId" ? draft.submission : undefined;
		const promise = (async () => {
			try {
				const snapshot = await cancelRun(lookup, controller.signal);
				if (!this.current(draft) || controller.signal.aborted) return;
				if (draft.threadId && snapshot.run.threadId !== draft.threadId)
					throw new Error("Run thread changed");
				if (submission) this.accept(draft, submission, snapshot);
				else this.events.updated(draft.owner, snapshot);
				return snapshot;
			} catch (error) {
				if (!this.current(draft) || controller.signal.aborted) return;
				// Not taken yet, and now never (the server refuses it from here
				// on): the send is withdrawn.
				if (
					submission &&
					error instanceof ConnectError &&
					error.findDetails(ErrorDetailSchema)[0]?.reason ===
						ErrorReason.REQUEST_WITHDRAWN
				) {
					this.withdraw(draft, submission);
					return;
				}
				const reply =
					lookup.case === "runId"
						? listedReply(draft.owner.userId, draft.threadId, lookup.value)
						: undefined;
				if (reply && (!isRunningReply(reply) || reply.runCancelRequested))
					return;
				this.events.error("threads.stopUnconfirmed");
			} finally {
				if (this.cancellations.get(key)?.controller === controller)
					this.cancellations.delete(key);
				this.changed();
			}
		})();
		this.cancellations.set(key, { controller, draft, promise });
		this.changed();
		return promise;
	}
	private async honorCancellation(
		draft: ThreadDraft,
		submission: Submission,
		snapshot: RunSnapshot,
	) {
		if (!submission.cancelRequested || !this.current(draft)) return;
		await this.cancellations.get(
			cancellationKey(draft.owner, {
				case: "requestId",
				value: submission.requestId,
			}),
		)?.promise;
		if (!this.current(draft)) return;
		const reply =
			listedReply(draft.owner.userId, snapshot.run.threadId, snapshot.run.id) ??
			snapshot.outputMessage;
		if (isRunningReply(reply) && !reply.runCancelRequested)
			await this.requestCancellation(draft, {
				case: "runId",
				value: snapshot.run.id,
			});
	}
}
