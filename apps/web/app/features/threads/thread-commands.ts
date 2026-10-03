import { useToast } from "@astryxdesign/core/Toast";
import {
	useMutation,
	useMutationState,
	useQueryClient,
} from "@tanstack/react-query";
import { useCallback } from "react";

import { useAuthStore } from "~/features/auth/store";
import {
	messagesQuery,
	threadQuery,
	unlistThread,
	upsertThread,
} from "~/features/threads/queries";
import { useThreadCommands } from "~/features/threads/thread-controller";
import type { Thread } from "~/features/threads/types";
import { useT } from "~/i18n/use-t";
import { latestPending } from "~/lib/optimistic-values";
import { threadClient } from "~/lib/rpc-client";

// Commands on a conversation, as a command is everywhere in the app: what is
// on screen is the server's state (the query cache, kept current by the
// event channel) with the commands still in flight laid over it. While one
// is in flight the conversation shows as it will be; the server's answer is
// written into the cache before the command settles, so nothing flickers
// back; a refused command simply stops being laid over, and the conversation
// shows as the server has it (with any change another device made meanwhile).
const deleteKey = ["threads", "delete"] as const;
const renameKey = ["threads", "rename"] as const;

interface Rename {
	id: string;
	title: string;
}

export function useDeleteThread() {
	const t = useT();
	const toast = useToast();
	const queryClient = useQueryClient();
	const userId = useAuthStore((state) => state.user?.id ?? "");
	const { discardThread } = useThreadCommands();
	return useMutation({
		mutationKey: deleteKey,
		mutationFn: async (id: string) => {
			await threadClient.deleteThread({ threadId: id });
		},
		// Gone for good: its draft and cached messages go with it.
		onSuccess: (_data, id) => {
			unlistThread(userId, id);
			discardThread(id);
			queryClient.removeQueries({
				queryKey: messagesQuery(userId, id).queryKey,
			});
			queryClient.removeQueries({
				queryKey: threadQuery(userId, id).queryKey,
			});
		},
		onError: () =>
			toast({ type: "error", body: t("threads.deleteThreadFailed") }),
	});
}

export function useRenameThread() {
	const t = useT();
	const toast = useToast();
	const userId = useAuthStore((state) => state.user?.id ?? "");
	return useMutation({
		mutationKey: renameKey,
		mutationFn: async ({ id, title }: Rename) =>
			(
				await threadClient.updateThread({
					updateMask: { paths: ["title"] },
					thread: { id, title },
				})
			).thread,
		onSuccess: (updated) => {
			if (updated) upsertThread(userId, updated);
		},
		onError: () =>
			toast({ type: "error", body: t("threads.renameThreadFailed") }),
	});
}

// The conversations as they are about to be: those being deleted left out,
// those being renamed under their new title (the latest, if several).
export function useThreadsInFlight() {
	const deleting = useMutationState({
		filters: { mutationKey: deleteKey, status: "pending" },
		select: (mutation) => mutation.state.variables as string,
	});
	const edits = useMutationState({
		filters: { mutationKey: renameKey },
		select: (mutation) => ({
			variables: mutation.state.variables as Rename,
			status: mutation.state.status,
		}),
	});
	const renaming = latestPending(edits, ({ id }) => id);
	const show = useCallback(
		(thread: Thread): Thread | undefined => {
			if (deleting.includes(thread.id)) return undefined;
			const title = renaming.findLast(({ id }) => id === thread.id)?.title;
			return title === undefined ? thread : { ...thread, title };
		},
		[deleting, renaming],
	);
	const showAll = useCallback(
		(threads: Thread[]) =>
			threads.flatMap((thread) => {
				const shown = show(thread);
				return shown ? [shown] : [];
			}),
		[show],
	);
	return { show, showAll };
}
