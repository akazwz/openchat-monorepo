import { useEffect } from "react";
import { Navigate, Outlet } from "react-router";

import { confirmSession } from "~/features/auth/session";
import { WorkspaceFilesProvider } from "~/features/computer/workspace-files";
import { ThreadControllerProvider } from "~/features/threads/thread-controller";

import { useAuthStore } from "./store";

// Everything behind sign-in shares one thread controller, so drafts and sends
// survive moving between the conversation and settings layouts. It belongs to
// one session: another account signing in (in another tab) mounts a new one,
// so nothing of the previous session's carries over. Signing out, here or in
// another tab, leaves for the sign-in page at once.
export default function SignedInLayout() {
	const signedIn = useAuthStore((state) => Boolean(state.user));
	// The account this browser remembers opens the app at once; the server
	// says whether its session still stands.
	const session = useAuthStore(
		(state) => `${state.user?.id}:${state.sessionVersion}`,
	);
	useEffect(() => {
		void confirmSession();
	}, [session]);
	if (!signedIn) return <Navigate to="/signin" replace />;
	return (
		<ThreadControllerProvider key={session}>
			<WorkspaceFilesProvider>
				<Outlet />
			</WorkspaceFilesProvider>
		</ThreadControllerProvider>
	);
}
