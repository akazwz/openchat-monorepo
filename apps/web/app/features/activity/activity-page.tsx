import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import {
	HStack,
	Layout,
	LayoutContent,
	VStack,
} from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { useToast } from "@astryxdesign/core/Toast";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { brandName, pageTitle } from "@heveta/brand";
import {
	useInfiniteQuery,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { CalendarClock } from "lucide-react";
import { useState } from "react";

import { AppPageHeader } from "~/components/app-page-header";
import { QueryError } from "~/components/query-error";
import {
	currentSession,
	isCurrentSession,
	useAuthStore,
} from "~/features/auth/store";
import {
	mainThreadQuery,
	threadQuery,
	threadsQuery,
} from "~/features/threads/queries";
import { displayTitle } from "~/features/threads/title";
import { type Schedule, ScheduleUnit } from "~/gen/heveta/v1/schedule_pb";
import type { MessageKey } from "~/i18n/messages";
import { useT } from "~/i18n/use-t";
import { scheduleClient } from "~/lib/rpc-client";

import { schedulesQuery } from "./queries";

const repeats: Partial<Record<ScheduleUnit, MessageKey>> = {
	[ScheduleUnit.MINUTE]: "activity.everyMinute",
	[ScheduleUnit.HOUR]: "activity.everyHour",
	[ScheduleUnit.DAY]: "activity.everyDay",
	[ScheduleUnit.WEEK]: "activity.everyWeek",
	[ScheduleUnit.MONTH]: "activity.everyMonth",
};

// What the agent is doing now and is set to do later: the conversations it
// is working in, and its schedules, each opening its own conversation. The
// agent makes schedules when asked to in a conversation; here they are seen
// and deleted.
export default function ActivityPage() {
	const t = useT();
	const toast = useToast();
	const cache = useQueryClient();
	const userId = useAuthStore((state) => state.user?.id ?? "");
	const schedules = useQuery(schedulesQuery(userId));
	const mainId = useQuery(mainThreadQuery(userId)).data?.id ?? "";
	const { data: main } = useQuery(threadQuery(userId, mainId));
	const side = useInfiniteQuery(threadsQuery(userId));
	const working = [
		...(main?.running ? [main] : []),
		...(side.data?.pages.flatMap((page) => page.items) ?? []).filter(
			(thread) => thread.running,
		),
	];
	const [removing, setRemoving] = useState<Schedule>();
	const [removeOpen, setRemoveOpen] = useState(false);
	async function remove(schedule: Schedule) {
		const owner = currentSession();
		try {
			await scheduleClient.deleteSchedule({ scheduleId: schedule.id });
		} catch {
			if (isCurrentSession(owner))
				toast({ type: "error", body: t("activity.deleteFailed") });
		}
		if (isCurrentSession(owner))
			await cache.invalidateQueries({
				queryKey: schedulesQuery(userId).queryKey,
			});
	}
	const repeat = (schedule: Schedule) => {
		const key = repeats[schedule.everyUnit];
		return key && schedule.everyCount
			? t(key, { count: String(schedule.everyCount) })
			: t("activity.once");
	};
	const empty =
		!working.length && schedules.data !== undefined && !schedules.data.length;
	return (
		<>
			<title>{pageTitle(t("activity.title"))}</title>
			<Layout
				height="fill"
				header={<AppPageHeader title={t("activity.title")} />}
				content={
					<LayoutContent padding={4}>
						<Center axis="horizontal">
							<VStack width="100%" maxWidth={800} gap={6}>
								{working.length > 0 && (
									<VStack gap={1.5}>
										<Text type="supporting" weight="semibold" color="secondary">
											{t("activity.inProgress")}
										</Text>
										<Card variant="muted" width="100%" padding={2}>
											<List>
												{working.map((thread) => (
													<ListItem
														key={thread.id}
														label={displayTitle(t, thread)}
														href={thread.main ? "/" : `/threads/${thread.id}`}
														startContent={
															<Spinner
																size="sm"
																aria-label={t("activity.working")}
															/>
														}
													/>
												))}
											</List>
										</Card>
									</VStack>
								)}
								{schedules.isLoading ? (
									<HStack justify="center" padding={4}>
										<Spinner aria-label={t("activity.loading")} />
									</HStack>
								) : schedules.isError ? (
									<QueryError
										title={t("activity.loadFailed")}
										pending={schedules.isFetching}
										onRetry={() => void schedules.refetch()}
									/>
								) : schedules.data?.length ? (
									<VStack gap={1.5}>
										<Text type="supporting" weight="semibold" color="secondary">
											{t("activity.scheduled")}
										</Text>
										<Card variant="muted" width="100%" padding={2}>
											<List>
												{schedules.data.map((schedule) => (
													<ListItem
														key={schedule.id}
														label={
															<Text maxLines={2}>{schedule.instructions}</Text>
														}
														description={
															<HStack gap={2} vAlign="center">
																{schedule.nextTime && (
																	<Timestamp
																		value={timestampDate(
																			schedule.nextTime,
																		).getTime()}
																		format="date_time"
																		type="supporting"
																	/>
																)}
																<Text type="supporting" color="secondary">
																	{repeat(schedule)}
																</Text>
															</HStack>
														}
														startContent={
															<Icon icon={CalendarClock} color="secondary" />
														}
														endContent={
															<HStack gap={1}>
																<Button
																	size="sm"
																	variant="ghost"
																	label={t("activity.open")}
																	href={`/threads/${schedule.threadId}`}
																/>
																<Button
																	size="sm"
																	variant="ghost"
																	label={t("activity.delete")}
																	onClick={() => {
																		setRemoving(schedule);
																		setRemoveOpen(true);
																	}}
																/>
															</HStack>
														}
													/>
												))}
											</List>
										</Card>
									</VStack>
								) : null}
								{empty && (
									<EmptyState
										icon={
											<Icon icon={CalendarClock} size="lg" color="secondary" />
										}
										title={t("activity.emptyTitle")}
										headingLevel={2}
										description={t("activity.emptyDescription", {
											name: brandName,
										})}
									/>
								)}
							</VStack>
						</Center>
					</LayoutContent>
				}
			/>
			<AlertDialog
				isOpen={removeOpen}
				onOpenChange={setRemoveOpen}
				title={t("activity.deleteTitle")}
				description={t("activity.deleteDescription")}
				actionLabel={t("activity.delete")}
				cancelLabel={t("activity.cancel")}
				onAction={() => {
					setRemoveOpen(false);
					if (removing) void remove(removing);
				}}
			/>
		</>
	);
}

export function ErrorBoundary() {
	const t = useT();
	return (
		<Layout
			height="fill"
			header={<AppPageHeader title={t("common.errorTitle")} />}
			content={
				<Center axis="both" padding={6} height="100%">
					<EmptyState title={t("common.errorTitle")} headingLevel={1} />
				</Center>
			}
		/>
	);
}
