import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { Divider } from "@astryxdesign/core/Divider";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { useClipboard } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import {
	HStack,
	Layout,
	LayoutContent,
	VStack,
} from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import {
	MetadataList,
	MetadataListItem,
} from "@astryxdesign/core/MetadataList";
import { ScrollableArea } from "@astryxdesign/core/ScrollableArea";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { useToast } from "@astryxdesign/core/Toast";
import { Token } from "@astryxdesign/core/Token";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { pageTitle } from "@heveta/brand";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import {
	Check,
	Copy,
	Inbox,
	Paperclip,
	RefreshCw,
	Send,
	Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";

import { AppPageHeader as PageHeader } from "~/components/app-page-header";
import { QueryError } from "~/components/query-error";
import { useAuthStore } from "~/features/auth/store";
import { FileCard } from "~/features/files/file-card";
import {
	type Email,
	type EmailAddress,
	EmailFolder,
} from "~/gen/heveta/v1/mail_pb";
import { useT } from "~/i18n/use-t";
import { refreshQueries } from "~/lib/refresh-queries";
import { mailClient } from "~/lib/rpc-client";

import { emailQuery, emailsQuery, mailboxQuery, mailKey } from "./queries";

const folderPath = (folder: EmailFolder) =>
	folder === EmailFolder.SENT ? "/mail/sent" : "/mail";

const isNotFound = (error: unknown) =>
	error != null && ConnectError.from(error).code === Code.NotFound;

const person = ({ address, name }: EmailAddress) => name || address;
const fullPerson = ({ address, name }: EmailAddress) =>
	name ? `${name} <${address}>` : address;

// When it arrived or was sent: the time alone today, the date before, as a
// mail list does; the date and time on the email itself.
function MailTime({ at, isFull }: { at: Date; isFull?: boolean }) {
	const today = at.toDateString() === new Date().toDateString();
	return (
		<Timestamp
			value={at.toISOString()}
			format={isFull ? "date_time" : today ? "time" : "date"}
			// On the email, a value like the others beside it.
			type={isFull ? "body" : undefined}
			color={isFull ? "primary" : undefined}
		/>
	);
}

// The full main region scrolls below the shared header.
function MailLayout({
	header,
	children,
}: {
	header: ReactNode;
	children: ReactNode;
}) {
	return (
		<Layout
			height="fill"
			header={header}
			content={
				<LayoutContent padding={3}>
					<VStack gap={4}>{children}</VStack>
				</LayoutContent>
			}
		/>
	);
}

// The agent's address, to give out, and how much of its sending limit it
// used.
function MailboxSummary() {
	const t = useT();
	const { isMobile } = useAppShellMobile();
	const userId = useAuthStore((state) => state.user?.id ?? "");
	const { data, isLoading, isFetching, refetch } = useQuery(
		mailboxQuery(userId),
	);
	const { copy, isCopied } = useClipboard({ announce: t("mail.copied") });
	if (isLoading) return <Skeleton width={100} height={20} />;
	if (!data)
		return (
			<IconButton
				label={t("common.retry")}
				tooltip={t("mail.mailboxLoadFailed")}
				icon={<Icon icon={RefreshCw} size="sm" />}
				variant="ghost"
				size="sm"
				isDisabled={isFetching}
				onClick={() => void refetch()}
			/>
		);
	// The address is what people come for; how much of the day's sending is
	// used is said on hover.
	return (
		<HStack gap={1} vAlign="center">
			{!isMobile && (
				<Text type="supporting" color="secondary" maxLines={1}>
					{data.address}
				</Text>
			)}
			<IconButton
				label={t("mail.copyAddress")}
				tooltip={`${t("mail.copyAddress")} · ${t("mail.usage", {
					used: data.recipientsUsed,
					limit: data.recipientLimit,
				})}`}
				icon={
					<Icon icon={isCopied ? Check : Copy} size="sm" color="secondary" />
				}
				variant="ghost"
				size="sm"
				onClick={() => void copy(data.address)}
			/>
		</HStack>
	);
}

// A row as mail apps show one: who it is from (or to), then its subject and
// the start of its text; its time, and whether it has attachments, at the end.
function EmailRow({ email }: { email: Email }) {
	const t = useT();
	const sent = email.folder === EmailFolder.SENT;
	const who = sent
		? t("mail.toList", {
				names: [...email.to, ...email.cc, ...email.bcc].map(person).join(", "),
			})
		: email.from
			? person(email.from)
			: "";
	return (
		<ListItem
			label={who}
			href={`/mail/${email.id}`}
			description={
				<VStack gap={0.5}>
					<Text maxLines={1}>{email.subject || t("mail.noSubject")}</Text>
					{email.snippet && (
						<Text type="supporting" maxLines={1}>
							{email.snippet}
						</Text>
					)}
				</VStack>
			}
			endContent={
				<HStack gap={2} vAlign="center">
					{email.unread && (
						<StatusDot variant="accent" label={t("mail.unread")} />
					)}
					{email.unconfirmed && (
						<Token label={t("mail.unconfirmed")} size="sm" color="orange" />
					)}
					{email.attachmentCount > 0 && (
						<Icon
							icon={Paperclip}
							size="sm"
							color="secondary"
							label={t("mail.attachments", { count: email.attachmentCount })}
						/>
					)}
					{email.time && <MailTime at={timestampDate(email.time)} />}
				</HStack>
			}
		/>
	);
}

function FolderEmails({ folder }: { folder: EmailFolder }) {
	const t = useT();
	const userId = useAuthStore((state) => state.user?.id ?? "");
	const address = useQuery(mailboxQuery(userId)).data?.address ?? "";
	const {
		data,
		isLoading,
		isError,
		isFetching,
		refetch,
		hasNextPage,
		fetchNextPage,
		isFetchingNextPage,
		isFetchNextPageError,
	} = useInfiniteQuery(emailsQuery(userId, folder));
	const emails = data?.pages.flatMap((page) => page.emails) ?? [];
	if (isLoading)
		return (
			<HStack justify="center" padding={6}>
				<Spinner aria-label={t("mail.loadingEmails")} />
			</HStack>
		);
	if (isError && !emails.length)
		return (
			<QueryError
				title={t("mail.emailsLoadFailed")}
				pending={isFetching}
				onRetry={() => {
					void refetch();
				}}
			/>
		);
	if (!emails.length)
		return folder === EmailFolder.SENT ? (
			<EmptyState
				icon={<Icon icon={Send} />}
				title={t("mail.sentEmptyTitle")}
				description={t("mail.sentEmptyDescription", { address })}
			/>
		) : (
			<EmptyState
				icon={<Icon icon={Inbox} />}
				title={t("mail.inboxEmptyTitle")}
				description={t("mail.inboxEmptyDescription", { address })}
			/>
		);
	return (
		<VStack gap={3}>
			<List hasDividers>
				{emails.map((email) => (
					<EmailRow key={email.id} email={email} />
				))}
			</List>
			{isFetchNextPageError && (
				<QueryError
					title={t("mail.emailsLoadFailed")}
					pending={isFetching}
					onRetry={() => {
						void fetchNextPage();
					}}
				/>
			)}
			{hasNextPage && !isFetchNextPageError && (
				<HStack justify="center">
					<Button
						label={t("mail.loadMore")}
						variant="secondary"
						isLoading={isFetchingNextPage}
						onClick={() => {
							void fetchNextPage();
						}}
					/>
				</HStack>
			)}
		</VStack>
	);
}

// A folder of the agent's mailbox: the address and its limit, the folders as
// tabs, then the emails, newest first.
function MailboxPage({ folder }: { folder: EmailFolder }) {
	const t = useT();
	return (
		<>
			<title>{pageTitle(t("mail.title"))}</title>
			<MailLayout
				header={
					<PageHeader
						title={t("mail.title")}
						detail={
							<ScrollableArea axis="inline" label={t("mail.folders")}>
								<TabList
									value={folderPath(folder)}
									onChange={() => {}}
									size="sm"
									aria-label={t("mail.folders")}
								>
									<Tab
										value="/mail"
										label={t("mail.inbox")}
										aria-label={t("mail.inbox")}
										href="/mail"
										icon={<Icon icon={Inbox} size="sm" />}
									/>
									<Tab
										value="/mail/sent"
										label={t("mail.sent")}
										aria-label={t("mail.sent")}
										href="/mail/sent"
										icon={<Icon icon={Send} size="sm" />}
									/>
								</TabList>
							</ScrollableArea>
						}
						end={<MailboxSummary />}
					/>
				}
			>
				<FolderEmails folder={folder} />
			</MailLayout>
		</>
	);
}

function EmailBody({ email }: { email: Email }) {
	const t = useT();
	const sent = email.folder === EmailFolder.SENT;
	const people = (list: EmailAddress[]) => list.map(fullPerson).join(", ");
	return (
		<VStack gap={4}>
			{email.unconfirmed && (
				<Banner status="warning" title={t("mail.unconfirmedDescription")} />
			)}
			<MetadataList>
				{email.from && (
					<MetadataListItem label={t("mail.from")}>
						<HStack gap={2} vAlign="center" wrap="wrap">
							<Text>{fullPerson(email.from)}</Text>
							{/* Only a sender Cloudflare's mail server vouched for is
							who the From address says (docs/email.md). */}
							{!sent && !email.senderVerified && (
								<Token
									label={t("mail.senderUnverified")}
									description={t("mail.senderUnverifiedDescription")}
									size="sm"
									color="orange"
								/>
							)}
						</HStack>
					</MetadataListItem>
				)}
				{email.replyTo.length > 0 && (
					<MetadataListItem label={t("mail.replyTo")}>
						<Text>{people(email.replyTo)}</Text>
					</MetadataListItem>
				)}
				<MetadataListItem label={t("mail.to")}>
					<Text>{people(email.to)}</Text>
				</MetadataListItem>
				{email.cc.length > 0 && (
					<MetadataListItem label={t("mail.cc")}>
						<Text>{people(email.cc)}</Text>
					</MetadataListItem>
				)}
				{sent && email.bcc.length > 0 && (
					<MetadataListItem label={t("mail.bcc")}>
						<Text>{people(email.bcc)}</Text>
					</MetadataListItem>
				)}
				{email.time && (
					<MetadataListItem label={t("mail.date")}>
						<MailTime at={timestampDate(email.time)} isFull />
					</MetadataListItem>
				)}
			</MetadataList>
			<Divider />
			{email.text ? (
				<Text type="plain" as="div">
					{email.text}
				</Text>
			) : (
				<Text color="secondary">{t("mail.noText")}</Text>
			)}
			{email.attachments.length > 0 && (
				<HStack gap={2} wrap="wrap">
					{email.attachments.map((file) => (
						<FileCard
							key={file.id}
							url={file.url}
							fileName={file.fileName}
							size={file.size}
						/>
					))}
				</HStack>
			)}
		</VStack>
	);
}

// One email: who it is from and to, when, its text, and its attachments.
// Received mail can be deleted; sent mail is the record of what the agent
// sent, which its limit counts (docs/email.md).
function EmailPage({ emailId }: { emailId: string }) {
	const t = useT();
	const toast = useToast();
	const navigate = useNavigate();
	const userId = useAuthStore((state) => state.user?.id ?? "");
	const {
		data: email,
		error,
		isLoading,
		isFetching,
		refetch,
	} = useQuery(emailQuery(userId, emailId));
	const [deleteOpen, setDeleteOpen] = useState(false);
	// Deleted, it is gone from here too: the page leaves for the inbox, and
	// until it has, the email stays on screen (a reread says it is not found).
	const remove = useMutation({
		mutationFn: () => mailClient.deleteEmail({ emailId }),
		onSuccess: () => {
			void navigate("/mail", { replace: true });
			void refreshQueries(mailKey(userId));
		},
		onError: () => toast({ type: "error", body: t("mail.deleteFailed") }),
	});
	// Opened, it is read: the unread count and list follow on the mail event.
	const unread = email?.unread === true;
	useEffect(() => {
		if (unread) void mailClient.markEmailRead({ emailId }).catch(() => {});
	}, [unread, emailId]);
	const sent = email?.folder === EmailFolder.SENT;
	const back = {
		href: folderPath(email?.folder ?? EmailFolder.INBOX),
		label: t(sent ? "mail.backToSent" : "mail.backToInbox"),
	};
	if (isNotFound(error) && remove.isIdle)
		return (
			<>
				<title>{pageTitle(t("mail.notFoundTitle"))}</title>
				<Layout
					height="fill"
					header={<PageHeader title={t("mail.title")} back={back} />}
					content={
						<Center axis="both" padding={6} height="100%">
							<EmptyState
								title={t("mail.notFoundTitle")}
								headingLevel={1}
								description={t("mail.notFoundDescription")}
								actions={
									<Button
										label={t("mail.goToMail")}
										variant="primary"
										href="/mail"
									/>
								}
							/>
						</Center>
					}
				/>
			</>
		);
	const subject = email ? email.subject || t("mail.noSubject") : undefined;
	const deleteButton = email && !sent && (
		<IconButton
			label={t("mail.delete")}
			tooltip={t("mail.delete")}
			icon={<Icon icon={Trash2} size="sm" color="secondary" />}
			variant="ghost"
			isDisabled={remove.isPending}
			onClick={() => setDeleteOpen(true)}
		/>
	);
	return (
		<>
			<title>{pageTitle(subject)}</title>
			<MailLayout
				header={<PageHeader title={subject} back={back} end={deleteButton} />}
			>
				{isLoading ? (
					<HStack justify="center" padding={6}>
						<Spinner aria-label={t("mail.loadingEmails")} />
					</HStack>
				) : !email ? (
					<QueryError
						title={t("mail.emailLoadFailed")}
						pending={isFetching}
						onRetry={() => {
							void refetch();
						}}
					/>
				) : (
					<EmailBody email={email} />
				)}
			</MailLayout>
			<AlertDialog
				isOpen={deleteOpen}
				onOpenChange={setDeleteOpen}
				title={t("mail.deleteTitle")}
				description={t("mail.deleteDescription")}
				actionLabel={t("mail.deleteAction")}
				cancelLabel={t("mail.cancel")}
				onAction={() => {
					setDeleteOpen(false);
					remove.mutate();
				}}
			/>
		</>
	);
}

// /mail and /mail/sent are the folders; /mail/<id> is an email.
export default function MailPage() {
	const { emailId } = useParams();
	const { pathname } = useLocation();
	if (emailId) return <EmailPage key={emailId} emailId={emailId} />;
	return (
		<MailboxPage
			folder={pathname === "/mail/sent" ? EmailFolder.SENT : EmailFolder.INBOX}
		/>
	);
}

// A page that fails to render replaces only itself: the side nav stays, and
// so do the drafts and replies held above it (thread-controller.tsx).
export function ErrorBoundary() {
	const t = useT();
	return (
		<>
			<title>{pageTitle(t("common.errorTitle"))}</title>
			<Layout
				height="fill"
				header={<PageHeader title={t("mail.title")} />}
				content={
					<Center axis="both" padding={6} height="100%">
						<EmptyState
							title={t("common.errorTitle")}
							headingLevel={1}
							description={t("mail.pageErrorDescription")}
							actions={
								<Button
									label={t("mail.goToMail")}
									variant="primary"
									href="/mail"
								/>
							}
						/>
					</Center>
				}
			/>
		</>
	);
}
