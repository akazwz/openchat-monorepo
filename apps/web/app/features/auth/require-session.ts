import { redirect } from "react-router";

import { useAuthStore } from "./store";

// Pages need a signed-in session. Without one, sign-in comes first and then
// returns to the page that was opened.
export async function requireSession({ request }: { request: Request }) {
	if (useAuthStore.getState().user) return null;
	const { pathname, search } = new URL(request.url);
	return redirect(
		pathname === "/"
			? "/signin"
			: `/signin?${new URLSearchParams({ next: pathname + search })}`,
	);
}

// The sign-in page is for signed-out visitors; anyone signed in goes on.
export async function requireSignedOut({ request }: { request: Request }) {
	return useAuthStore.getState().user
		? redirect(afterSignIn(new URL(request.url).searchParams.get("next")))
		: null;
}

// Where sign-in leads: the page that was asked for, when it is one of this
// app's (a path, never another site), or the home page.
export function afterSignIn(next: string | null) {
	return next?.startsWith("/") && !next.startsWith("//") ? next : "/";
}
