import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { ChatLayout, ChatMessageList } from "@astryxdesign/core/Chat";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import {
	HStack,
	Layout,
	LayoutContent,
	LayoutHeader,
	StackItem,
	VStack,
} from "@astryxdesign/core/Layout";
import { MobileNavToggle } from "@astryxdesign/core/MobileNav";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { pageTitle } from "@heveta/brand";
import {
	useInfiniteQuery,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { SquarePen } from "lucide-react";
import { useCallback } from "react";

import { QueryError } from "~/components/query-error";
import { useProfile } from "~/features/auth/profile";
import { useAuthStore } from "~/features/auth/store";
import { isRunningReply } from "~/features/runs/run-state";
import {
	AssistantBubble,
	ChatBubble,
	ChatBubbleMemoized,
} from "~/features/threads/components/chat-bubble";
import { ChatComposer } from "~/features/threads/components/chat-composer";
import {
	messagesQuery,
	threadQuery,
	threadsQuery,
} from "~/features/threads/queries";
import { useThreadsInFlight } from "~/features/threads/thread-commands";
import {
	useConversationState,
	useThreadCommands,
} from "~/features/threads/thread-controller";
import { displayTitle } from "~/features/threads/title";
import { MessageRole, MessageSchema } from "~/gen/heveta/v1/thread_pb";
import type { MessageKey } from "~/i18n/messages";
import { type Translate, useT } from "~/i18n/use-t";

function timeGreeting(t: Translate, hour = new Date().getHours()) {
	const key: MessageKey =
		hour >= 5 && hour < 11
			? "threads.greetingMorning"
			: hour >= 11 && hour < 13
				? "threads.greetingMidday"
				: hour >= 13 && hour < 18
					? "threads.greetingAfternoon"
					: "threads.greetingEvening";
	return t(key);
}

const isNotFound = (error: unknown) =>
	error != null && ConnectError.from(error).code === Code.NotFound;

// Phones only, where it holds the drawer toggle and "新对话". On desktop the
// conversation has no bar above it, as in Astryx's AI Chat template and
// ChatGPT: the scroll area then spans the full height, so its scrollbar runs
// edge to edge instead of starting below a bar yet passing the composer. The
// title stays in the side nav's selected row, the tab, and for assistive
// technology. `title` is undefined while it is still loading.
function PageHeader({ title }: { title?: string }) {
	const t = useT();
	const { isMobile } = useAppShellMobile();
	if (!isMobile)
		return title ? <VisuallyHidden as="h1">{title}</VisuallyHidden> : null;
	return (
		<LayoutHeader padding={3}>
			<HStack gap={2} vAlign="center">
				<MobileNavToggle label={t("threads.openNav")} />
				<StackItem size="fill">
					{title === undefined ? (
						// One heading line, so the header keeps its height when it loads.
						<Skeleton width={160} height={20} />
					) : (
						<Heading level={4} accessibilityLevel={1} maxLines={1}>
							{title}
						</Heading>
					)}
				</StackItem>
				{title !== "" && (
					<IconButton
						label={t("threads.newThread")}
						tooltip={t("threads.newThread")}
						icon={<Icon icon={SquarePen} size="sm" />}
						variant="ghost"
						href="/"
					/>
				)}
			</HStack>
		</LayoutHeader>
	);
}

export default function ThreadPage() {
	const t = useT();
	const userId = useAuthStore((state) => state.user?.id ?? "");
	const username = useProfile()?.username ?? "";
	const {
		// The conversation on screen; it runs ahead of the URL while a new
		// conversation's page navigates to its address.
		threadId,
		isPending,
		isSending,
		viewKey,
		pendingMessage,
		pendingTitle,
		replacedRunId,
		isCancelling,
		isReconnecting,
	} = useConversationState();
	const { regenerate } = useThreadCommands();
	const {
		data,
		error,
		isLoading,
		isError,
		isFetching,
		refetch,
		hasNextPage,
		fetchNextPage,
		isFetchNextPageError,
	} = useInfiniteQuery(messagesQuery(userId, threadId));
	// One function for the list's whole life: ChatMessageList observes the top
	// of the transcript again whenever it changes.
	const loadOlder = useCallback(async () => {
		await fetchNextPage();
	}, [fetchNextPage]);
	const isInterrupted = isCancelling || isReconnecting;
	// The conversation's own record carries its title, so conversations beyond
	// the side nav's loaded pages (opened from search or a link) are titled too.
	// The side nav's copy shows at once and is refreshed when stale.
	const queryClient = useQueryClient();
	const sideNavKey = threadsQuery(userId).queryKey;
	const { data: thread, error: threadError } = useQuery({
		...threadQuery(userId, threadId),
		initialData: () =>
			queryClient
				.getQueryData(sideNavKey)
				?.pages.flatMap((page) => page.items)
				.find((item) => item.id === threadId),
		initialDataUpdatedAt: () =>
			queryClient.getQueryState(sideNavKey)?.dataUpdatedAt,
	});
	const notFound =
		Boolean(threadId) && (isNotFound(error) || isNotFound(threadError));
	const { show } = useThreadsInFlight();
	const shownThread = thread && show(thread);
	const title = !threadId
		? pendingTitle
		: shownThread
			? displayTitle(t, shownThread)
			: threadError
				? ""
				: undefined;
	// Every message shows from the list, the reply being made too: run events
	// update it there (docs/sync.md).
	// A reply being regenerated gives its place to the new attempt's loader.
	const messages = (
		data?.pages
			.slice()
			.reverse()
			.flatMap((page) => page.items) ?? []
	).filter(
		(message) =>
			!(
				replacedRunId &&
				message.role === MessageRole.ASSISTANT &&
				message.runId === replacedRunId
			),
	);
	const empty = !messages.length && !isSending && !isLoading && !isError;
	const loading = isLoading && !messages.length && !isSending;
	const { isMobile } = useAppShellMobile();
	const composer = (
		<ChatComposer
			disabled={Boolean(threadId) && (isLoading || (isError && !data))}
		/>
	);
	// AI Chat Landing: one line, a greeting by name, as in Claude and Gemini.
	// It is the page's heading; the composer under it says what to do.
	const greeting = (
		<Text type="display-3" as={threadId ? "p" : "h1"} justify="center">
			{username
				? t("threads.greetingWithName", {
						greeting: timeGreeting(t),
						name: username,
					})
				: timeGreeting(t)}
		</Text>
	);
	// A deleted or foreign conversation: nothing to show and nothing to send to.
	if (notFound)
		return (
			<>
				<title>{pageTitle(t("threads.threadNotFoundTitle"))}</title>
				<Layout
					height="fill"
					header={<PageHeader title="" />}
					content={
						<Center axis="both" padding={6} height="100%">
							<EmptyState
								title={t("threads.threadNotFoundTitle")}
								headingLevel={1}
								description={t("threads.threadNotFoundDescription")}
								actions={
									<Button
										label={t("threads.newThread")}
										variant="primary"
										href="/"
									/>
								}
							/>
						</Center>
					}
				/>
			</>
		);
	// On desktop a new conversation centers the prompt and composer together (AI Chat
	// Landing). Phones keep the composer docked at the bottom, within thumb reach.
	// The content padding matches ChatLayout's dock, and the theme gives the
	// composer the transcript's 800px column (packages/brand/src/theme/heveta.ts)
	// in both places,
	// so it keeps its width when the first message docks it.
	if (empty && !isMobile)
		return (
			<>
				<title>{pageTitle(title || undefined)}</title>
				<Layout
					height="fill"
					header={<PageHeader title={title} />}
					content={
						<LayoutContent padding={3}>
							<VStack gap={8} vAlign="center" minHeight="100%">
								{greeting}
								{composer}
							</VStack>
						</LayoutContent>
					}
				/>
			</>
		);
	return (
		<>
			<title>{pageTitle(title || undefined)}</title>
			<Layout
				height="fill"
				header={<PageHeader title={title} />}
				content={
					// ChatLayout owns scrolling, auto-follow, and the docked composer;
					// it needs a bounded flex-column parent.
					<VStack height="100%" minHeight={0}>
						<ChatLayout
							key={viewKey}
							density="balanced"
							composer={composer}
							emptyState={
								loading ? (
									<Spinner aria-label={t("threads.loadingMessages")} />
								) : (
									greeting
								)
							}
						>
							{empty || loading ? null : (
								<ChatMessageList
									align="top"
									isStreaming={isPending}
									aria-label={t("threads.messageList")}
									scrollToTopAction={
										hasNextPage && !isFetching && !isError
											? loadOlder
											: undefined
									}
								>
									{isError && (
										<QueryError
											title={t(
												isFetchNextPageError
													? "threads.olderMessagesLoadFailed"
													: "threads.messagesLoadFailed",
											)}
											pending={isFetching}
											onRetry={() => {
												void (isFetchNextPageError
													? fetchNextPage()
													: refetch());
											}}
										/>
									)}
									{messages.map((message, index) => {
										const last = index === messages.length - 1;
										const running = isRunningReply(message);
										return (
											<ChatBubbleMemoized
												key={message.id}
												message={message}
												pending={running}
												isInterrupted={running && isInterrupted}
												// Only the latest reply can be made again, and not
												// while a reply is being made. The command is the
												// same function every render, so the replies above
												// stay as they were rendered.
												canRegenerate={
													!isPending && last && Boolean(message.runId)
												}
												onRegenerate={regenerate}
											/>
										);
									})}
									{pendingMessage && <ChatBubble message={pendingMessage} />}
									{/* The message is on its way; a stop or a lost connection
									while it is shows by the composer, and this keeps its loader
									(hidden, it left an empty reply). */}
									{isSending && (
										<AssistantBubble message={create(MessageSchema)} pending />
									)}
								</ChatMessageList>
							)}
						</ChatLayout>
					</VStack>
				}
			/>
		</>
	);
}

// A conversation that fails to render replaces only this page, not the app:
// the side nav stays, and so do the drafts and replies held above it
// (thread-controller.tsx). Opening another conversation leaves it.
export function ErrorBoundary() {
	const t = useT();
	return (
		<>
			<title>{pageTitle(t("common.errorTitle"))}</title>
			<Layout
				height="fill"
				header={<PageHeader title="" />}
				content={
					<Center axis="both" padding={6} height="100%">
						<EmptyState
							title={t("common.errorTitle")}
							headingLevel={1}
							description={t("threads.pageErrorDescription")}
							actions={
								<Button
									label={t("threads.newThread")}
									variant="primary"
									href="/"
								/>
							}
						/>
					</Center>
				}
			/>
		</>
	);
}
