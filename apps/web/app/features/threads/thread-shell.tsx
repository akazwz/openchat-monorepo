import { AppShell } from "@astryxdesign/core/AppShell";
import { Badge } from "@astryxdesign/core/Badge";
import { ContextMenu } from "@astryxdesign/core/ContextMenu";
import { useHotkeys, useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { VStack } from "@astryxdesign/core/Layout";
import { MobileNav } from "@astryxdesign/core/MobileNav";
import { MoreMenu } from "@astryxdesign/core/MoreMenu";
import {
	SideNav,
	SideNavCollapseButton,
	SideNavHeading,
	SideNavItem,
	SideNavSection,
	useSideNavCollapse,
} from "@astryxdesign/core/SideNav";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { BrandMark, brandName } from "@heveta/brand";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
	FolderOpen,
	Mail,
	Monitor,
	PanelLeftClose,
	PanelLeftOpen,
	PenLine,
	Search,
	SquarePen,
	SquareTerminal,
	Trash2,
} from "lucide-react";
import { lazy, type ReactNode, Suspense, useState } from "react";
import {
	Outlet,
	PrefetchPageLinks,
	useLocation,
	useNavigate,
	useParams,
} from "react-router";

import { QueryError } from "~/components/query-error";
import { AccountMenu } from "~/features/auth/components/account-menu";
import { useAuthStore } from "~/features/auth/store";
import { mailboxQuery } from "~/features/mail/queries";
import { DeleteThreadDialog } from "~/features/threads/dialogs/delete-thread-dialog";
import { SearchThreadsDialog } from "~/features/threads/dialogs/search-threads-dialog";
import { threadsQuery } from "~/features/threads/queries";
import { useThreadsInFlight } from "~/features/threads/thread-commands";
import { displayTitle } from "~/features/threads/title";
import type { Thread } from "~/features/threads/types";
import { useT } from "~/i18n/use-t";

// The rename form and its libraries (react-hook-form, zod) load with the
// first rename, not with the conversations.
const RenameThreadDialog = lazy(
	() => import("~/features/threads/dialogs/rename-thread-dialog"),
);

const collapsedKey = "heveta-sidebar-collapsed";
function readCollapsed() {
	try {
		return localStorage.getItem(collapsedKey) === "1";
	} catch {
		return false;
	}
}

// The collapsed rail's first item, in place of the header's collapse toggle.
function ExpandItem() {
	const t = useT();
	const { isCollapsed, toggle } = useSideNavCollapse();
	return isCollapsed ? (
		<SideNavItem
			label={t("threads.expandSidebar")}
			icon={PanelLeftOpen}
			onClick={toggle}
		/>
	) : null;
}
function ExpandedOnly({ children }: { children: ReactNode }) {
	return useSideNavCollapse().isCollapsed ? null : children;
}

// AppShell with only a SideNav: the nav carries the product identity; the page
// header renders the mobile toggle where it is needed.
export default function ThreadShell() {
	const t = useT();
	const { threadId: activeId } = useParams();
	const userId = useAuthStore((state) => state.user?.id ?? "");
	const [mobileOpen, setMobileOpen] = useState(false);
	const [collapsed, setCollapsedState] = useState(readCollapsed);
	function setCollapsed(next: boolean) {
		setCollapsedState(next);
		try {
			localStorage.setItem(collapsedKey, next ? "1" : "0");
		} catch {}
	}
	const [searchOpen, setSearchOpen] = useState(false);
	const navigate = useNavigate();
	const location = useLocation();
	// Targets outlive their dialog's open state, so the text holds while it closes.
	const [deleteTarget, setDeleteTarget] = useState<Thread | null>(null);
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [renameTarget, setRenameTarget] = useState<Thread | null>(null);
	const [renameOpen, setRenameOpen] = useState(false);
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
	} = useInfiniteQuery(threadsQuery(userId));
	// As they are about to be, with deletions and renames in flight.
	const { showAll } = useThreadsInFlight();
	const threads = showAll(data?.pages.flatMap((page) => page.items) ?? []);
	const closeNavigation = () => setMobileOpen(false);
	const unreadMail = useQuery(mailboxQuery(userId)).data?.unreadCount ?? 0;
	// ⌘K / Ctrl+K opens search from anywhere, the composer included, as in ChatGPT.
	useHotkeys([
		{
			keys: "mod+k",
			allowInInputs: true,
			onPress: () => {
				closeNavigation();
				setSearchOpen(true);
			},
		},
	]);

	const navItems = (
		<>
			<ExpandItem />
			{/* An action, as in ChatGPT and Claude: never shown as the current page. */}
			<SideNavItem
				label={t("threads.newThread")}
				icon={SquarePen}
				href="/"
				onClick={closeNavigation}
			/>
			<SideNavItem
				label={t("threads.searchThreads")}
				icon={Search}
				onClick={() => {
					closeNavigation();
					setSearchOpen(true);
				}}
			/>
			<SideNavItem
				label={t("computer.title")}
				icon={Monitor}
				href="/computer"
				isSelected={location.pathname === "/computer"}
				onClick={closeNavigation}
			/>
			<SideNavItem
				label={t("computer.terminal")}
				icon={SquareTerminal}
				href="/computer/terminal"
				isSelected={location.pathname === "/computer/terminal"}
				onClick={closeNavigation}
			/>
			<SideNavItem
				label={t("computer.files")}
				icon={FolderOpen}
				href="/computer/files"
				isSelected={location.pathname === "/computer/files"}
				onClick={closeNavigation}
			/>
			{/* The agent's mailbox (docs/email.md), a page of its own, with how
			many emails nobody has read. */}
			<SideNavItem
				label={t("mail.title")}
				icon={Mail}
				href="/mail"
				isSelected={location.pathname.startsWith("/mail")}
				onClick={closeNavigation}
				endContent={
					unreadMail ? <Badge label={String(unreadMail)} /> : undefined
				}
			/>
		</>
	);
	const account = (
		<AccountMenu
			onNavigate={closeNavigation}
			onOpenSettings={() => {
				closeNavigation();
				// Settings' "back" returns here.
				void navigate("/settings", {
					state: { returnTo: location.pathname },
				});
			}}
		/>
	);
	const hasNoHover = useMediaQuery("(hover: none)");
	const recent = (
		<SideNavSection title={t("threads.recent")}>
			{isLoading && (
				<VStack padding={4} align="center">
					<Spinner aria-label={t("threads.loadingThreads")} size="sm" />
				</VStack>
			)}
			{isError && (
				<QueryError
					title={t("threads.threadsListLoadFailed")}
					pending={isFetching}
					onRetry={() => {
						void (isFetchNextPageError ? fetchNextPage() : refetch());
					}}
				/>
			)}
			{!isLoading && !isError && !threads.length && (
				<VStack paddingInline={3} paddingBlock={2}>
					<Text type="supporting">{t("threads.noThreads")}</Text>
				</VStack>
			)}
			{threads.map((thread) => (
				<ThreadRow
					key={thread.id}
					thread={thread}
					isSelected={activeId === thread.id}
					hasNoHover={hasNoHover}
					onNavigate={closeNavigation}
					onRename={() => {
						closeNavigation();
						setRenameTarget(thread);
						setRenameOpen(true);
					}}
					onDelete={() => {
						closeNavigation();
						setDeleteTarget(thread);
						setDeleteOpen(true);
					}}
				/>
			))}
			{hasNextPage && (
				<SideNavItem
					label={t("threads.loadMore")}
					isDisabled={isFetching}
					endContent={
						isFetchingNextPage ? (
							<Spinner aria-label={t("threads.loadingMoreThreads")} size="sm" />
						) : undefined
					}
					onClick={() => {
						void fetchNextPage();
					}}
				/>
			)}
		</SideNavSection>
	);

	return (
		<>
			{/* Each page's code loads when it is first opened, one import after
			another: opening settings waited on three round trips before it
			showed. Its modules are fetched ahead, all at once, so it opens at
			once; so are the mailbox's. */}
			<PrefetchPageLinks page="/settings" />
			<PrefetchPageLinks page="/mail" />
			<PrefetchPageLinks page="/computer" />
			<PrefetchPageLinks page="/computer/terminal" />
			<PrefetchPageLinks page="/computer/files" />
			<AppShell
				mobileNav={{
					isOpen: mobileOpen,
					onOpenChange: setMobileOpen,
					hasToggle: false,
					// MobileNav's default side is "auto", read from the focused
					// trigger; a tap on a phone focuses nothing, so it fell back to
					// the end edge. The nav drawer always opens from the start edge.
					content: (
						<MobileNav
							side="start"
							header={
								<SideNavHeading
									heading={brandName}
									icon={<BrandMark size={20} />}
								/>
							}
						>
							{/* The drawer's content region is a plain scroller, so one
							full-height column, its ends spread apart, keeps the account
							at the bottom. A long list still scrolls the whole drawer. */}
							<VStack height="100%" justify="between">
								<VStack>
									{navItems}
									{recent}
								</VStack>
								{account}
							</VStack>
						</MobileNav>
					),
				}}
				sideNav={
					<SideNav
						aria-label={t("threads.threadNav")}
						// As in mainstream agent apps, the toggle sits beside the product
						// name at the top (not a link, which would nest the button) and
						// the account stays at the bottom.
						collapsible={{
							isCollapsed: collapsed,
							onCollapsedChange: setCollapsed,
							hasButton: false,
						}}
						header={
							<SideNavHeading
								heading={brandName}
								icon={<BrandMark size={20} />}
								headerEndContent={
									<Tooltip content={t("threads.collapseSidebar")}>
										<SideNavCollapseButton>
											{/* Secondary like the nav items' icons below it: a
											ghost button's icon defaults to the text color. */}
											<Icon icon={PanelLeftClose} size="sm" color="secondary" />
										</SideNavCollapseButton>
									</Tooltip>
								}
							/>
						}
						topContent={navItems}
						// The account sits in the footer's icon row: SideNav renders that
						// row even when empty, and its gap left the account 16px above
						// the edge instead of the footer's 8px. In the collapsed rail it
						// is an icon anyway; expanded, its explicit size keeps it a row.
						footerIcons={account}
					>
						{/* Conversation titles have no icons, so the collapsed rail
						omits the list. */}
						<ExpandedOnly>{recent}</ExpandedOnly>
					</SideNav>
				}
			>
				<Outlet />
			</AppShell>
			<SearchThreadsDialog isOpen={searchOpen} onOpenChange={setSearchOpen} />
			<DeleteThreadDialog
				thread={deleteTarget}
				isOpen={deleteOpen}
				onClose={() => setDeleteOpen(false)}
			/>
			{/* A closed Dialog keeps its children mounted, so it would need its
			code from the start: it is rendered from the first rename on. Not
			only while open: DialogHeader focuses its title when it mounts, so a
			form arriving in an open dialog lost its autofocus to the title, and
			an unmounted Dialog does not return focus to what opened it. */}
			{renameTarget && (
				<Suspense>
					<RenameThreadDialog
						thread={renameTarget}
						isOpen={renameOpen}
						onClose={() => setRenameOpen(false)}
					/>
				</Suspense>
			)}
		</>
	);
}

// A conversation in the side nav, as in ChatGPT: its menu ("…") shows on the
// row under the pointer, the current conversation, a row with keyboard focus,
// and while the menu is open; screens without hover always show it.
// Right-click, or a long press on touch, opens the same actions.
//
// SideNavItem lays a row with actions out differently from one without (the
// link moves into a row wrapper), so `actions` is always given and only the
// menu inside it comes and goes: switching layouts remounted the link, which
// dropped its keyboard focus. Hover and focus are tracked on a stack around
// the whole row, since SideNavItem passes such handlers to the link alone and
// the menu sits beside it, not in it.
function ThreadRow({
	thread,
	isSelected,
	hasNoHover,
	onNavigate,
	onRename,
	onDelete,
}: {
	thread: Thread;
	isSelected: boolean;
	hasNoHover: boolean;
	onNavigate: () => void;
	onRename: () => void;
	onDelete: () => void;
}) {
	const t = useT();
	const [isHovered, setIsHovered] = useState(false);
	const [hasFocus, setHasFocus] = useState(false);
	const [isMenuOpen, setIsMenuOpen] = useState(false);
	const title = displayTitle(t, thread);
	const label = t("threads.manageThread", { title });
	const items = [
		{ label: t("threads.rename"), icon: PenLine, onClick: onRename },
		{
			label: t("threads.delete"),
			icon: Trash2,
			variant: "destructive" as const,
			onClick: onDelete,
		},
	];
	const showsMenu =
		hasNoHover || isSelected || isHovered || hasFocus || isMenuOpen;
	return (
		<ContextMenu items={items} label={label} presentation="adaptive">
			<VStack
				onMouseEnter={() => setIsHovered(true)}
				onMouseLeave={() => setIsHovered(false)}
				onFocus={() => setHasFocus(true)}
				onBlur={(event) => {
					if (!event.currentTarget.contains(event.relatedTarget))
						setHasFocus(false);
				}}
			>
				<SideNavItem
					label={title}
					href={`/threads/${thread.id}`}
					isSelected={isSelected}
					onClick={onNavigate}
					// A reply still being written here, as in ChatGPT and Claude: a
					// long one goes on while its person is elsewhere. Not on the
					// conversation open now, whose reply shows itself being written.
					// Passive, so it sits inside the row's link, beside the menu
					// (`actions`), and names itself to a screen reader with the title.
					endContent={
						thread.running && !isSelected ? (
							<Spinner size="sm" aria-label={t("threads.replying")} />
						) : undefined
					}
					actions={
						// an element even when empty, so the row keeps its layout (see above)
						<>
							{showsMenu && (
								<MoreMenu
									label={label}
									// The default three dots, one level below the row's title
									// like other row-level controls.
									icon={
										<Icon icon="moreHorizontal" size="sm" color="secondary" />
									}
									presentation="popover"
									alignment="end"
									onOpenChange={setIsMenuOpen}
									items={items}
								/>
							)}
						</>
					}
				/>
			</VStack>
		</ContextMenu>
	);
}
