import {
	CommandPalette,
	CommandPaletteFooter,
	CommandPaletteInput,
} from "@astryxdesign/core/CommandPalette";
import { Kbd } from "@astryxdesign/core/Kbd";
import { HStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import type {
	SearchableItem,
	SearchSource,
} from "@astryxdesign/core/Typeahead";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { useAuthStore } from "~/features/auth/store";
import { threadsQuery } from "~/features/threads/queries";
import { displayTitle } from "~/features/threads/title";
import type { Thread } from "~/features/threads/types";
import { type Translate, useT } from "~/i18n/use-t";
import { threadClient } from "~/lib/rpc-client";

const toItems = (threads: Thread[], t: Translate): SearchableItem[] =>
	threads.map((thread) => ({ id: thread.id, label: displayTitle(t, thread) }));

// Waits out fast typing; a newer keystroke aborts the wait and the request.
function pause(ms: number, signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}

// Astryx CommandPalette: server search as you type, arrow keys and Enter to
// open a result. Before typing it lists the side nav's recent conversations.
export function SearchThreadsDialog({
	isOpen,
	onOpenChange,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const t = useT();
	const userId = useAuthStore((state) => state.user?.id ?? "");
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [failed, setFailed] = useState(false);
	const source = useMemo((): SearchSource => {
		let controller: AbortController | null = null;
		// The palette discards superseded results; an abort only ends the work.
		async function run(load: (signal: AbortSignal) => Promise<Thread[]>) {
			controller?.abort();
			const current = new AbortController();
			controller = current;
			setFailed(false);
			try {
				return toItems(await load(current.signal), t);
			} catch {
				if (!current.signal.aborted) setFailed(true);
				return [];
			}
		}
		return {
			bootstrap: () =>
				run(async () => {
					const data = await queryClient.fetchInfiniteQuery(
						threadsQuery(userId),
					);
					return data.pages[0]?.items.slice(0, 8) ?? [];
				}),
			search: (query) =>
				run(async (signal) => {
					await pause(150, signal);
					const { threads } = await threadClient.listThreads(
						// The API accepts at most 200 characters.
						{ pageSize: 50, query: query.trim().slice(0, 200) },
						{ signal },
					);
					return threads;
				}),
			cancel: () => controller?.abort(),
		};
	}, [queryClient, userId, t]);
	return (
		<CommandPalette
			isOpen={isOpen}
			onOpenChange={onOpenChange}
			label={t("threads.searchThreads")}
			width={560}
			searchSource={source}
			input={
				<CommandPaletteInput
					label={t("threads.searchThreads")}
					placeholder={t("threads.searchThreadsPlaceholder")}
				/>
			}
			emptyBootstrapText={
				failed ? t("threads.threadsLoadFailed") : t("threads.noThreads")
			}
			emptySearchText={
				failed ? t("threads.searchFailed") : t("threads.noSearchResults")
			}
			// The default renders the bare label, which a long title overflows
			// with no ellipsis; one line with an ellipsis reads as a title.
			renderItem={(item) => <Text maxLines={1}>{item.label}</Text>}
			onValueChange={(id) => {
				void navigate(`/threads/${id}`);
			}}
			// Astryx's zh-CN catalog lacks the default hints' labels.
			footer={
				<CommandPaletteFooter>
					<HStack gap={1} vAlign="center">
						<Kbd keys="up" />
						<Kbd keys="down" />
						{t("threads.selectHint")}
					</HStack>
					<HStack gap={1} vAlign="center">
						<Kbd keys="enter" />
						{t("threads.openHint")}
					</HStack>
					<HStack gap={1} vAlign="center">
						<Kbd keys="escape" />
						{t("threads.closeHint")}
					</HStack>
				</CommandPaletteFooter>
			}
		/>
	);
}
