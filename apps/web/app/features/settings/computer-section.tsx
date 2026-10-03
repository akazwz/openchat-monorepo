import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { useToast } from "@astryxdesign/core/Toast";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { useMutation, useQuery } from "@tanstack/react-query";
import { HardDrive, RotateCw, Trash2 } from "lucide-react";
import { useState } from "react";

import { QueryError } from "~/components/query-error";
import { useAuthStore } from "~/features/auth/store";
import {
	workspaceSnapshotsQuery,
	workspaceUsageQuery,
} from "~/features/computer/queries";
import { fileSize } from "~/features/files/kinds";
import { ErrorDetailSchema, ErrorReason } from "~/gen/heveta/v1/error_pb";
import { useLanguage } from "~/i18n/language";
import type { Message, MessageKey } from "~/i18n/messages";
import { translateMessage, useT } from "~/i18n/use-t";
import { computerClient } from "~/lib/rpc-client";

import { SettingsCard, SettingsRow } from "./settings-rows";

type Confirming =
	| { kind: "restart" }
	| { kind: "clear" }
	| { kind: "restore"; snapshotId: string; time: string };

// Asked when the latest changes could not be saved first: going on loses them.
const discardDescriptions: Record<Confirming["kind"], MessageKey> = {
	restart: "settings.discardRestartDescription",
	restore: "settings.discardRestoreDescription",
	clear: "settings.discardClearDescription",
};

const confirmations: Record<
	"restart" | "clear",
	{ title: MessageKey; description: MessageKey; action: MessageKey }
> = {
	restart: {
		title: "settings.restartConfirmTitle",
		description: "settings.restartConfirmDescription",
		action: "settings.restart",
	},
	clear: {
		title: "settings.clearConfirmTitle",
		description: "settings.clearConfirmDescription",
		action: "settings.clear",
	},
};

// The user's computer (docs/sandbox.md): what its workspace holds, and ways
// back when something went wrong: a restart, a snapshot to return to, or a
// clean workspace. The snapshots are the ones every change already made.
export function ComputerSection() {
	const t = useT();
	const locale = useLanguage((state) => state.locale);
	const toast = useToast();
	const [confirming, setConfirming] = useState<Confirming>();
	const [open, setOpen] = useState(false);
	// An action refused because the latest changes could not be saved, asked
	// again before they are discarded.
	const [discarding, setDiscarding] = useState<Confirming>();
	const [discardOpen, setDiscardOpen] = useState(false);
	const userId = useAuthStore((state) => state.user?.id ?? "");
	const usage = useQuery(workspaceUsageQuery(userId));
	const snapshots = useQuery(workspaceSnapshotsQuery(userId));
	const act = useMutation({
		mutationFn: async ({
			action,
			discardUnsaved,
		}: {
			action: Confirming;
			discardUnsaved: boolean;
		}) => {
			if (action.kind === "restart")
				await computerClient.restartComputer({ discardUnsaved });
			else if (action.kind === "clear")
				await computerClient.clearWorkspace({ discardUnsaved });
			else
				await computerClient.restoreWorkspaceSnapshot({
					snapshotId: action.snapshotId,
					discardUnsaved,
				});
		},
		onSuccess: (_result, { action }) => {
			toast({
				type: "info",
				body: t(
					action.kind === "restart"
						? "settings.restartSuccess"
						: action.kind === "clear"
							? "settings.clearSuccess"
							: "settings.restoreSuccess",
				),
			});
			// A cleared or restored workspace is read again when the computer
			// says it changed; a restart changes nothing, and reading now would
			// only start the computer again.
		},
		onError: (error, { action }) => {
			const refused = ConnectError.from(error);
			const reason = refused.findDetails(ErrorDetailSchema)[0]?.reason;
			if (reason === ErrorReason.WORKSPACE_UNSAVED) {
				setDiscarding(action);
				setDiscardOpen(true);
				return;
			}
			// A snapshot pruned since the list was read.
			if (refused.code === Code.NotFound) void snapshots.refetch();
			toast({
				type: "error",
				body: t(
					reason === ErrorReason.COMPUTER_BUSY
						? "settings.computerBusyError"
						: refused.code === Code.NotFound
							? "settings.snapshotGone"
							: "settings.computerActionFailed",
				),
			});
		},
	});
	// These change the computer itself and finish on it, so they show their
	// progress rather than a result: on the row that started one, with every
	// other action held until it ends.
	const running = act.isPending ? act.variables.action : undefined;
	const busy = Boolean(running);
	function confirm(action: Confirming) {
		setConfirming(action);
		setOpen(true);
	}
	const dialog:
		| { title: Message; description: Message; action: Message }
		| undefined =
		confirming?.kind === "restore"
			? {
					title: "settings.restoreConfirmTitle",
					description: {
						key: "settings.restoreConfirmDescription",
						values: { time: confirming.time },
					},
					action: "settings.restore",
				}
			: confirming
				? confirmations[confirming.kind]
				: undefined;
	const list = snapshots.data?.snapshots ?? [];
	const unsavedSince = snapshots.data?.unsavedSince;
	return (
		<VStack gap={6}>
			<Banner
				status="info"
				title={t("settings.computerRetentionTitle")}
				description={t("settings.computerRetention")}
			/>
			{unsavedSince && (
				<Banner
					status="warning"
					title={t("settings.unsavedChanges", {
						time: timestampDate(unsavedSince).toLocaleString(locale, {
							dateStyle: "medium",
							timeStyle: "short",
						}),
					})}
				/>
			)}
			<SettingsCard title={t("settings.workspace")}>
				<SettingsRow
					title={t("settings.storageUsed")}
					icon={HardDrive}
					description={t("settings.storageUsedDescription")}
					control={
						usage.isLoading ? (
							<Spinner
								size="sm"
								aria-label={t("settings.calculatingStorageUsed")}
							/>
						) : usage.isError ? (
							<HStack gap={2} vAlign="center">
								<Text color="secondary">{t("settings.usageLoadFailed")}</Text>
								<Button
									label={t("common.retry")}
									size="sm"
									variant="secondary"
									isLoading={usage.isFetching}
									onClick={() => void usage.refetch()}
								/>
							</HStack>
						) : (
							<Text color="secondary">
								{usage.data ? fileSize(usage.data.bytes) : "—"}
							</Text>
						)
					}
				/>
				<SettingsRow
					title={t("settings.restartComputerTitle")}
					icon={RotateCw}
					description={t("settings.restartComputerDescription")}
					control={
						<Button
							label={t("settings.restart")}
							size="sm"
							variant="secondary"
							isLoading={running?.kind === "restart"}
							isDisabled={busy}
							onClick={() => confirm({ kind: "restart" })}
						/>
					}
				/>
				<SettingsRow
					title={t("settings.clearWorkspaceTitle")}
					icon={Trash2}
					description={t("settings.clearWorkspaceDescription")}
					control={
						// A rare, destructive action stays quiet here; the dialog's
						// action carries the destructive style.
						<Button
							label={t("settings.clear")}
							size="sm"
							variant="secondary"
							isLoading={running?.kind === "clear"}
							isDisabled={busy}
							onClick={() => confirm({ kind: "clear" })}
						/>
					}
				/>
			</SettingsCard>
			<VStack gap={1.5}>
				<Text type="supporting" weight="semibold" color="secondary">
					{t("settings.snapshots")}
				</Text>
				<Text type="supporting" color="secondary">
					{t("settings.snapshotsRetention")}
				</Text>
				{snapshots.isLoading ? (
					<HStack justify="center" padding={4}>
						<Spinner aria-label={t("settings.loadingSnapshots")} />
					</HStack>
				) : snapshots.isError ? (
					<QueryError
						title={t("settings.snapshotsLoadFailed")}
						pending={snapshots.isFetching}
						onRetry={() => void snapshots.refetch()}
					/>
				) : list.length ? (
					// Its rows' own inset plus this one line their text up with the
					// settings rows above.
					<Card variant="muted" width="100%" padding={2}>
						<List hasDividers>
							{list.map((snapshot) => {
								const current =
									snapshot.id === snapshots.data?.currentSnapshotId;
								const time = snapshot.createTime
									? timestampDate(snapshot.createTime)
									: undefined;
								const expires = snapshot.expireTime
									? timestampDate(snapshot.expireTime).toLocaleString(locale, {
											dateStyle: "medium",
											timeStyle: "short",
										})
									: undefined;
								return (
									<ListItem
										key={snapshot.id}
										label={
											time ? (
												<Timestamp
													value={time.toISOString()}
													format="date_time"
												/>
											) : (
												"—"
											)
										}
										description={
											expires
												? t(
														current
															? "settings.currentSnapshotExpires"
															: "settings.snapshotExpires",
														{ time: expires },
													)
												: current
													? t("settings.currentSnapshot")
													: undefined
										}
										endContent={
											current ? undefined : (
												<Button
													label={t("settings.restore")}
													size="sm"
													variant="secondary"
													isLoading={
														running?.kind === "restore" &&
														running.snapshotId === snapshot.id
													}
													isDisabled={busy}
													onClick={() =>
														confirm({
															kind: "restore",
															snapshotId: snapshot.id,
															// The dialog's text is a string, which
															// Timestamp cannot render into.
															time:
																time?.toLocaleString(locale, {
																	dateStyle: "medium",
																	timeStyle: "short",
																}) ?? "",
														})
													}
												/>
											)
										}
									/>
								);
							})}
						</List>
					</Card>
				) : (
					<Text color="secondary">{t("settings.noSnapshots")}</Text>
				)}
			</VStack>
			{dialog && (
				<AlertDialog
					isOpen={open}
					onOpenChange={setOpen}
					title={translateMessage(t, dialog.title)}
					description={translateMessage(t, dialog.description)}
					actionLabel={translateMessage(t, dialog.action)}
					actionVariant={
						confirming?.kind === "clear" ? "destructive" : "primary"
					}
					cancelLabel={t("settings.cancel")}
					onAction={() => {
						setOpen(false);
						if (confirming && !busy)
							act.mutate({ action: confirming, discardUnsaved: false });
					}}
				/>
			)}
			{discarding && (
				<AlertDialog
					isOpen={discardOpen}
					onOpenChange={setDiscardOpen}
					title={t("settings.discardConfirmTitle")}
					description={t(discardDescriptions[discarding.kind])}
					actionLabel={t("settings.discardAction")}
					actionVariant="destructive"
					cancelLabel={t("settings.cancel")}
					onAction={() => {
						setDiscardOpen(false);
						if (!busy) act.mutate({ action: discarding, discardUnsaved: true });
					}}
				/>
			)}
		</VStack>
	);
}
