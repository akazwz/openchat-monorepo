import { create } from "zustand";
import { persist } from "zustand/middleware";

import { queryClient } from "~/lib/query-client";

import type { SessionOwner, User } from "./types";

// The session itself is an HttpOnly cookie: page scripts never see it, and
// the server checks it on every request. What the app keeps is which account
// this browser is signed in to, as it last knew, so a page opens at once;
// the server corrects it when it differs (session.ts).
interface AuthState {
	user: User | null;
	// A login instance, including a new login to the same account. Never
	// persisted.
	sessionVersion: number;
	// Signed in to this account (by this tab, or another one).
	signIn: (user: User) => void;
	signOut: () => void;
	// The signed-in user's own profile changed (e.g. a rename).
	updateUser: (user: User) => void;
}

const storageKey = "heveta-auth";
const profile = (user: User): User => ({
	id: user.id,
	username: user.username,
	email: user.email,
	avatarUrl: user.avatarUrl,
	revision: user.revision ?? 0,
});

export const useAuthStore = create<AuthState>()(
	persist(
		(set, get) => ({
			user: null,
			sessionVersion: 0,
			signIn: (user) => {
				set({
					user: profile(user),
					sessionVersion: get().sessionVersion + 1,
				});
				queryClient.clear();
			},
			signOut: () => {
				if (!get().user) return;
				set({ user: null, sessionVersion: get().sessionVersion + 1 });
				queryClient.clear();
			},
			updateUser: (user) => {
				const known = get().user;
				if (
					known?.id === user.id &&
					(user.revision ?? 0) >= (known.revision ?? 0)
				)
					set({ user: profile(user) });
			},
		}),
		{ name: storageKey, partialize: ({ user }) => ({ user }) },
	),
);

export function currentSession(): SessionOwner {
	const { user, sessionVersion } = useAuthStore.getState();
	return { userId: user?.id ?? "", sessionVersion };
}

export function isCurrentSession(owner: SessionOwner) {
	const state = useAuthStore.getState();
	return (
		(state.user?.id ?? "") === owner.userId &&
		state.sessionVersion === owner.sessionVersion
	);
}

// The account the server says this browser is signed in to (none, when
// signed out): a different one is a new login instance, the same one only
// updates its profile.
export function adoptUser(user: User | null) {
	const state = useAuthStore.getState();
	if (!user) state.signOut();
	else if (user.id !== state.user?.id) state.signIn(user);
	else state.updateUser(user);
}

// Tabs share one cookie, so one login: another tab's sign-in or sign-out is
// adopted here at once.
if (typeof window !== "undefined")
	window.addEventListener("storage", (event) => {
		if (event.key !== storageKey) return;
		try {
			adoptUser(event.newValue ? JSON.parse(event.newValue).state.user : null);
		} catch {
			// Not ours to read; the server's answer corrects it (session.ts).
		}
	});
