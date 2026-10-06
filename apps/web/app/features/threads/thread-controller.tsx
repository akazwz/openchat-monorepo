import { useToast } from "@astryxdesign/core/Toast";
import { create } from "@bufbuild/protobuf";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useMatch, useNavigate, useParams } from "react-router";

import { confirmSession } from "~/features/auth/session";
import { isCurrentSession, useAuthStore } from "~/features/auth/store";
import type { SessionOwner } from "~/features/auth/types";
import { computerKey } from "~/features/computer/queries";
import { devicesQuery } from "~/features/devices/queries";
import { EventChannel } from "~/features/events/event-channel";
import { isImage, maxMessageChars } from "~/features/files/kinds";
import { mailKey } from "~/features/mail/queries";
import { readsImages, useModelChoice } from "~/features/models/model-choice";
import { isRunningReply, type RunSnapshot } from "~/features/runs/run-state";
import { createRunSync } from "~/features/runs/run-sync";
import { memoriesQuery } from "~/features/settings/queries";
import { FileSchema } from "~/gen/heveta/v1/file_pb";
import { ReasoningEffort } from "~/gen/heveta/v1/model_pb";
import {
	MessagePartSchema,
	MessageRole,
	MessageSchema,
	type Message as ThreadMessage,
} from "~/gen/heveta/v1/thread_pb";
import type { Message as I18nMessage } from "~/i18n/messages";
import { translateMessage, useT } from "~/i18n/use-t";
import { useDesktopPendingWork } from "~/lib/desktop";
import { queryClient } from "~/lib/query-client";
import { refreshQueries } from "~/lib/refresh-queries";

import {
	DraftError,
	draftKey,
	isDraftLocked,
	type Submission,
	type ThreadDraft,
	ThreadDrafts,
	type TurnCommand,
} from "./drafts";
import {
	mainThreadQuery,
	messagesQuery,
	removeThread,
	showThreadActivity,
	showThreadRun,
	showRun,
	threadQuery,
	upsertThread,
} from "./queries";
import { ThreadSubmissions } from "./submissions";
import { displayTitle, threadTitle } from "./title";

// The sent message, shown in the transcript until the server's copy replaces
// it. Its images use the local previews, which stay valid until then.
function pendingMessage(submission: Submission | undefined) {
	if (submission?.phase !== "sending" || submission.input.kind !== "start")
		return undefined;
	return create(MessageSchema, {
		id: submission.requestId,
		role: MessageRole.USER,
		parts: [
			...submission.attachments.map((attachment) =>
				create(MessagePartSchema, {
					id: attachment.id,
					content: {
						case: "file",
						value: create(FileSchema, {
							url: attachment.previewUrl ?? "",
							fileName: attachment.name,
							mimeType: attachment.file?.mimeType ?? attachment.mimeType,
							size: BigInt(attachment.size),
							width: attachment.file?.width,
							height: attachment.file?.height,
						}),
					},
				}),
			),
			...(submission.input.text
				? [
						create(MessagePartSchema, {
							id: `${submission.requestId}:text`,
							content: { case: "text", value: submission.input.text },
						}),
					]
				: []),
		],
	});
}

// Each draft is one conversation view. A new conversation keeps its draft when
// the server assigns its id, so the view survives that navigation unmounted.
const viewKeys = new WeakMap<ThreadDraft, number>();
let nextViewKey = 0;
function viewKey(draft: ThreadDraft) {
	let key = viewKeys.get(draft);
	if (key === undefined) {
		key = nextViewKey++;
		viewKeys.set(draft, key);
	}
	return key;
}

// The latest reply of a conversation's list, whose run the composer follows:
// whether a reply is being made, and what stopping stops.
const latestReply = (data: { pages: { items: ThreadMessage[] }[] }) =>
	data.pages[0]?.items
		.filter((message) => message.role === MessageRole.ASSISTANT)
		.at(-1);

// This provider composes thread drafts and commands, and applies the user's
// events. Each has its own lifecycle; UI remounts never take ownership of a
// server execution. It belongs to one session: a new one mounts it anew
// (signed-in-layout.tsx).
function useController() {
	const t = useT();
	const toast = useToast();
	const navigate = useNavigate();
	const params = useParams();
	const userId = useAuthStore((state) => state.user?.id ?? "");
	// The home page shows the main conversation, once which one that is has
	// been read; /new, a conversation not yet made.
	const isHome = Boolean(useMatch("/"));
	const isNew = Boolean(useMatch("/new"));
	const { data: mainThread } = useQuery(mainThreadQuery(userId));
	const routeThreadId =
		params.threadId ?? (isHome ? (mainThread?.id ?? "") : "");
	const sessionVersion = useAuthStore((state) => state.sessionVersion);
	const owner = { userId, sessionVersion };
	const [drafts] = useState(() => new ThreadDrafts());
	useSyncExternalStore(
		drafts.subscribe,
		drafts.getSnapshot,
		drafts.getSnapshot,
	);
	const draft = drafts.get(owner, routeThreadId);
	useDesktopPendingWork("drafts", drafts.hasPendingWork);
	// The conversation on screen. It runs ahead of the URL while a new
	// conversation's page is navigating to its address.
	const threadId = draft.threadId;
	// Whether the user's event channel (docs/sync.md) is down: dropped, or not
	// opened at the first try. While it first connects nothing is known lost.
	const [disconnected, setDisconnected] = useState(false);
	// What the conversation's list shows of its latest reply.
	const { data: reply } = useInfiniteQuery({
		...messagesQuery(userId, threadId),
		select: latestReply,
	});
	const replyRunning = Boolean(reply && isRunningReply(reply));
	// The draft of the conversation on screen; none while settings are.
	const onConversation = isHome || isNew || Boolean(routeThreadId);
	const visibleKey = onConversation ? draftKey(owner, routeThreadId) : "";
	const visible = useRef(visibleKey);
	visible.current = visibleKey;
	const callbacks = {
		accepted: (session: SessionOwner, snapshot: RunSnapshot) => {
			if (!isCurrentSession(session)) return;
			showRun(session.userId, snapshot);
			// Its conversation moves up at once, before the event says so, and
			// shows a reply being written.
			showThreadRun(session.userId, snapshot.run);
		},
		updated: (session: SessionOwner, snapshot: RunSnapshot) => {
			if (!isCurrentSession(session)) return;
			showRun(session.userId, snapshot);
			showThreadRun(session.userId, snapshot.run);
			submissions.acknowledge(session, snapshot);
		},
		created: async (entry: ThreadDraft, sourceKey: string) => {
			if (visible.current === sourceKey)
				await navigate(`/threads/${entry.threadId}`, { replace: true });
		},
		error: (message: I18nMessage) =>
			toast({ type: "error", body: translateMessage(t, message) }),
		// A message that failed where it is on screen is back in its composer
		// with the reason; one sent from elsewhere says where it went back to.
		failed: (entry: ThreadDraft) => {
			if (draftKey(entry.owner, entry.threadId) === visible.current) return;
			const thread = entry.threadId
				? queryClient.getQueryData(
						threadQuery(entry.owner.userId, entry.threadId).queryKey,
					)
				: undefined;
			toast({
				type: "error",
				body: t("threads.sendFailedElsewhere", {
					title: thread ? displayTitle(t, thread) : t("threads.newThread"),
				}),
			});
		},
	};
	const events = useRef(callbacks);
	events.current = callbacks;
	const [submissions] = useState(
		() =>
			new ThreadSubmissions(drafts, {
				accepted: (...args) => events.current.accepted(...args),
				updated: (...args) => events.current.updated(...args),
				created: (...args) => events.current.created(...args),
				error: (...args) => events.current.error(...args),
				failed: (...args) => events.current.failed(...args),
			}),
	);
	// The user's event channel: every committed change, from any device, is
	// applied here. A run's progress updates it like a command's response.
	const [runSync] = useState(() =>
		createRunSync({
			snapshot: (session, snapshot) =>
				events.current.updated(session, snapshot),
			awaited: (session, requestId) => submissions.awaited(session, requestId),
		}),
	);
	useEffect(() => {
		if (!userId) return;
		const session = { userId, sessionVersion };
		const channel = new EventChannel(userId, {
			status: (open) => {
				if (isCurrentSession(session)) setDisconnected(!open);
			},
			refused: () => void confirmSession(),
			// Changes made while the channel was closed are not replayed: read
			// again everything this user has on screen, and send again at once
			// the messages whose outcome was lost.
			connected: () => {
				void refreshQueries(["users", userId]);
				submissions.resendAll(session);
			},
			event: ({ event }) => {
				if (!isCurrentSession(session)) return;
				switch (event.case) {
					case "run": {
						// Every event carries its run: the side nav shows whether a
						// reply is still being written in any conversation, loaded or
						// not; only a loaded one's messages take the event (run-sync).
						const run = event.value.event.value?.run;
						if (run) showThreadRun(userId, run);
						runSync(session, event.value);
						break;
					}
					case "thread":
						upsertThread(userId, event.value);
						break;
					case "threadActivity":
						if (event.value.activeTime)
							showThreadActivity(
								userId,
								event.value.threadId,
								event.value.activeTime,
							);
						break;
					case "threadDeleted":
						removeThread(userId, event.value);
						// Deleted elsewhere: its draft and any send still going to it
						// go too, as when deleted here (thread-commands.ts).
						submissions.discard(event.value);
						drafts.discard(session, event.value);
						break;
					case "memory":
						void refreshQueries(memoriesQuery(userId).queryKey);
						break;
					case "user":
						useAuthStore.getState().updateUser(event.value);
						break;
					case "devices":
						void refreshQueries(devicesQuery(userId).queryKey);
						break;
					case "computer":
						void refreshQueries(computerKey(userId));
						break;
					case "mail":
						void refreshQueries(mailKey(userId));
						break;
				}
			},
		});
		channel.start();
		return () => {
			channel.stop();
			setDisconnected(false);
		};
	}, [userId, sessionVersion, runSync, submissions, drafts]);
	useSyncExternalStore(
		submissions.subscribe,
		submissions.getSnapshot,
		submissions.getSnapshot,
	);
	useEffect(() => {
		submissions.attach();
		return () => {
			submissions.detach();
			drafts.clear();
		};
	}, [drafts, submissions]);
	const locked = isDraftLocked(draft);
	// A reply is being made: the message is being sent, or its run goes on.
	const isPending = locked || replyRunning;
	const isCancelling =
		submissions.isCancelling(draft) ||
		Boolean(replyRunning && reply?.runCancelRequested);
	const modelChoice = useModelChoice();
	// Images stay in the draft when the chosen model cannot read them; sending
	// waits until they are removed or another model is chosen. A PDF it cannot
	// read goes as a file on the computer.
	const imagesUnsupported =
		!readsImages(modelChoice.model) &&
		draft.attachments.some((attachment) =>
			isImage(attachment.file?.mimeType ?? attachment.mimeType),
		);
	const canSend =
		Boolean(userId) &&
		!imagesUnsupported &&
		!isPending &&
		draft.message.length <= maxMessageChars &&
		Boolean(draft.message.trim() || draft.attachments.length) &&
		draft.attachments.every((attachment) => attachment.file);
	const submission = draft.submission;
	// Created once per submission and phase: a new object every render would
	// make the transcript render again at every key press.
	const pending = useMemo(
		() => pendingMessage(submission),
		// oxlint-disable-next-line react/exhaustive-deps -- the phase changes on the same submission.
		[submission, submission?.phase],
	);
	const sent = submission?.input;
	// Everything a command needs, as it is now; the commands themselves stay
	// the same functions (below), so what only issues commands never renders
	// again for a change it does not show.
	const latest = useRef({
		draft,
		owner,
		reply,
		locked,
		canSend,
		isPending,
		modelChoice,
	});
	latest.current = {
		draft,
		owner,
		reply,
		locked,
		canSend,
		isPending,
		modelChoice,
	};
	const commands = useMemo(() => {
		const start = (input: TurnCommand) => {
			const { draft, owner, isPending } = latest.current;
			if (!isPending && isCurrentSession(owner))
				submissions.start(draft, input);
		};
		return {
			setMessage: (message: string) =>
				drafts.setMessage(latest.current.draft, message),
			send: () => {
				const { draft, canSend, modelChoice } = latest.current;
				if (canSend)
					start({
						kind: "start",
						deviceId: draft.deviceId ?? "",
						text: draft.message,
						files: draft.attachments.flatMap((attachment) =>
							attachment.file ? [attachment.file] : [],
						),
						modelId: modelChoice.requested.modelId,
						reasoningEffort: modelChoice.requested.effort,
					});
			},
			// Retries the turn's latest attempt, which produced this reply.
			regenerate: (message: ThreadMessage) => {
				if (message.turnId && message.runId)
					start({
						kind: "retry",
						turnId: message.turnId,
						previousRunId: message.runId,
						// Empty keeps the model and effort of the attempt being retried.
						modelId: "",
						reasoningEffort: ReasoningEffort.UNSPECIFIED,
					});
			},
			stop: () =>
				submissions.cancel(latest.current.draft, latest.current.reply),
			upload: async (file: File) => {
				const { draft, owner, locked } = latest.current;
				if (locked) return;
				try {
					await drafts.upload(draft, file);
				} catch (error) {
					if (isCurrentSession(owner))
						toast({
							type: "error",
							body: translateMessage(
								t,
								error instanceof DraftError
									? error.reason
									: "threads.uploadFailedGeneric",
							),
						});
				}
			},
			removeAttachment: (id: string) =>
				drafts.removeAttachment(latest.current.draft, id),
			discardThread: (id: string) => {
				submissions.discard(id);
				drafts.discard(latest.current.owner, id);
			},
			chooseDevice: (id: string) => drafts.setDevice(latest.current.draft, id),
			chooseModel: (modelId: string, effort: ReasoningEffort) =>
				latest.current.modelChoice.choose(modelId, effort),
			retryModels: () => latest.current.modelChoice.retryCatalog(),
		};
	}, [drafts, submissions, t, toast]);
	const isReconnecting = replyRunning && disconnected;
	const activeReply = replyRunning ? reply : undefined;
	const replacedRunId =
		locked && sent?.kind === "retry" ? sent.previousRunId : undefined;
	// A new conversation is titled by its first message before it exists;
	// an image-only message has no text, so it shows as untitled while sent.
	const pendingTitle =
		!threadId && pending && sent?.kind === "start"
			? threadTitle(sent.text) || t("threads.untitled")
			: "";
	const key = viewKey(draft);
	const conversation = useMemo(
		() => ({
			threadId,
			viewKey: key,
			pendingMessage: pending,
			pendingTitle,
			isPending,
			isCancelling,
			isDraftLocked: locked,
			// A reply goes on while its progress is not arriving.
			isReconnecting,
			canStop: isPending,
			// The message is being sent: its reply has no message yet.
			isSending: locked,
			// The reply a regeneration replaces, while it is being sent: the new
			// attempt takes its place at once, as in ChatGPT and Claude, and a
			// refused one gives it back. Once the server takes it, the list
			// itself swaps the attempts (queries.ts, placeRun).
			replacedRunId,
			// The latest reply, while its run goes on.
			activeReply,
		}),
		[
			threadId,
			key,
			pending,
			pendingTitle,
			isPending,
			isCancelling,
			locked,
			isReconnecting,
			replacedRunId,
			activeReply,
		],
	);
	// What the composer shows; it changes with every key press, and only the
	// composer reads it.
	const composer = {
		draft,
		canSend,
		models: modelChoice.models,
		model: modelChoice.model,
		effort: modelChoice.effort,
		effortFor: modelChoice.effortFor,
		modelsFailed: modelChoice.catalogFailed,
		modelsRetrying: modelChoice.catalogRetrying,
		imagesUnsupported,
	};
	return { commands, conversation, composer };
}
type Controller = ReturnType<typeof useController>;
const CommandsContext = createContext<Controller["commands"] | null>(null);
const ConversationContext = createContext<Controller["conversation"] | null>(
	null,
);
const ComposerContext = createContext<Controller["composer"] | null>(null);
export function ThreadControllerProvider({
	children,
}: {
	children: ReactNode;
}) {
	const { commands, conversation, composer } = useController();
	return (
		<CommandsContext value={commands}>
			<ConversationContext value={conversation}>
				<ComposerContext value={composer}>{children}</ComposerContext>
			</ConversationContext>
		</CommandsContext>
	);
}
function required<T>(value: T | null): T {
	if (!value) throw new Error("ThreadControllerProvider missing");
	return value;
}
// The commands on the conversation on screen: the same functions for the
// provider's whole life.
export const useThreadCommands = () => required(useContext(CommandsContext));
// Where the conversation on screen stands: a new value only when it changes.
export const useConversationState = () =>
	required(useContext(ConversationContext));
// The composer's draft and choices, new at every key press.
export const useComposerState = () => required(useContext(ComposerContext));
