import { useToast } from "@astryxdesign/core/Toast";
import { useMutation, useMutationState } from "@tanstack/react-query";
import { useMemo } from "react";

import { useT } from "~/i18n/use-t";
import { latestPending } from "~/lib/optimistic-values";
import { authClient } from "~/lib/rpc-client";

import { authErrorMessage } from "./errors";
import { useAuthStore } from "./store";
import type { User } from "./types";

// The signed-in user's profile as the app shows it: the account as the
// server last said, with a new username in flight laid over it, the way
// conversations are shown (threads/thread-commands.ts). The server's answer
// is adopted before the rename settles; a refused one stops being laid over.
const usernameKey = ["profile", "username"] as const;

export function useSetUsername() {
	const t = useT();
	const toast = useToast();
	return useMutation({
		mutationKey: usernameKey,
		mutationFn: async (username: string) =>
			(await authClient.updateCurrentUser({ username })).user,
		onSuccess: (user) => {
			if (user) useAuthStore.getState().updateUser(user);
		},
		onError: (error) =>
			toast({
				type: "error",
				body: t(authErrorMessage(error, "settings.usernameUpdateFailed")),
			}),
	});
}

export function useProfile(): User | null {
	const user = useAuthStore((state) => state.user);
	const edits = useMutationState({
		filters: { mutationKey: usernameKey },
		select: (mutation) => ({
			variables: mutation.state.variables as string,
			status: mutation.state.status,
		}),
	});
	const username = latestPending(edits, () => "username")[0];
	return useMemo(
		() => (user && username !== undefined ? { ...user, username } : user),
		[user, username],
	);
}
