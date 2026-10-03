import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import {
	pixel,
	proportional,
	Table,
	type TableColumn,
} from "@astryxdesign/core/Table";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { useToast } from "@astryxdesign/core/Toast";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import {
	useIsMutating,
	useMutation,
	useMutationState,
	useQuery,
} from "@tanstack/react-query";
import { Brain, Trash2 } from "lucide-react";
import { useState } from "react";

import { QueryError } from "~/components/query-error";
import { useAuthStore } from "~/features/auth/store";
import { useT } from "~/i18n/use-t";

import { deleteMemory, deleteAllMemories } from "./memory-commands";
import { memoriesQuery } from "./queries";

const deleteKey = ["memories", "delete"] as const;
const clearKey = ["memories", "clear"] as const;

interface MemoryRow extends Record<string, unknown> {
	id: string;
	content: string;
	updated: string;
}

// What the agent remembers about the signed-in user, as ChatGPT's "Manage
// memories": each entry in full, deletable one by one or all at once.
export function MemorySection() {
	const t = useT();
	const userId = useAuthStore((state) => state.user?.id ?? "");
	const toast = useToast();
	const query = memoriesQuery(userId);
	const { data, isLoading, isError, isFetching, refetch } = useQuery(query);
	const [clearOpen, setClearOpen] = useState(false);
	// Pending mutations are an optimistic overlay. Their responses carry no
	// snapshot/version, so reconcile by reading, never by replacing the cache.
	const remove = useMutation({
		mutationKey: deleteKey,
		mutationFn: (memoryId: string) => deleteMemory(userId, memoryId),
		onError: () =>
			toast({ type: "error", body: t("settings.deleteMemoryFailed") }),
	});
	const clear = useMutation({
		mutationKey: clearKey,
		mutationFn: () => deleteAllMemories(userId),
		onError: () =>
			toast({ type: "error", body: t("settings.clearMemoriesFailed") }),
	});
	const deleting = useMutationState({
		filters: { mutationKey: deleteKey, status: "pending" },
		select: (mutation) => mutation.state.variables as string,
	});
	const clearing = useIsMutating({ mutationKey: clearKey }) > 0;
	const memories = clearing
		? []
		: (data ?? []).filter((memory) => !deleting.includes(memory.id));
	const rows: MemoryRow[] = memories.map((memory) => ({
		id: memory.id,
		content: memory.content,
		updated: memory.updateTime
			? timestampDate(memory.updateTime).toISOString()
			: "",
	}));
	const columns: TableColumn<MemoryRow>[] = [
		{
			key: "content",
			header: t("settings.memoryContent"),
			width: proportional(1),
			renderCell: (row) => (
				<VStack gap={0.5}>
					<Text>{row.content}</Text>
					{row.updated && (
						<Text type="supporting" color="secondary">
							{t("settings.memoryUpdatedLabel")}{" "}
							<Timestamp value={row.updated} format="date_time" />
						</Text>
					)}
				</VStack>
			),
		},
		{
			key: "actions",
			header: "",
			width: pixel(56),
			align: "end",
			renderCell: (row) => (
				<IconButton
					label={t("settings.deleteMemory")}
					tooltip={t("settings.delete")}
					icon={<Icon icon={Trash2} size="sm" color="secondary" />}
					variant="ghost"
					size="sm"
					onClick={() => remove.mutate(row.id)}
				/>
			),
		},
	];
	return (
		<VStack gap={4}>
			<HStack gap={3} vAlign="center">
				<StackItem size="fill">
					<Text color="secondary">{t("settings.memoryDescription")}</Text>
				</StackItem>
				{rows.length > 0 && (
					// A rare, destructive action stays quiet here; the confirmation
					// dialog's action carries the destructive style.
					<Button
						label={t("settings.clearAllMemories")}
						variant="secondary"
						size="sm"
						onClick={() => setClearOpen(true)}
					/>
				)}
			</HStack>
			{isLoading ? (
				<HStack justify="center" padding={6}>
					<Spinner aria-label={t("settings.loadingMemories")} />
				</HStack>
			) : isError ? (
				<QueryError
					title={t("settings.memoriesLoadFailed")}
					pending={isFetching}
					onRetry={() => {
						void refetch();
					}}
				/>
			) : rows.length ? (
				// A card like the other settings groups: Table runs its rows to its
				// container's padding edges, which bare in the page overshot the
				// column's text by the page padding on each side.
				<Card variant="muted" width="100%">
					<Table data={rows} columns={columns} idKey="id" verticalAlign="top" />
				</Card>
			) : (
				<EmptyState
					icon={<Icon icon={Brain} />}
					title={t("settings.noMemoriesTitle")}
					description={t("settings.noMemoriesDescription")}
				/>
			)}
			<AlertDialog
				isOpen={clearOpen}
				onOpenChange={setClearOpen}
				title={t("settings.clearAllMemoriesTitle")}
				description={t("settings.clearAllMemoriesDescription", {
					count: rows.length,
				})}
				actionLabel={t("settings.clearAllMemories")}
				cancelLabel={t("settings.cancel")}
				onAction={() => {
					setClearOpen(false);
					clear.mutate();
				}}
			/>
		</VStack>
	);
}
