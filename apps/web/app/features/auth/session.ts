import { Code, ConnectError } from "@connectrpc/connect";

import {
	adoptUser,
	currentSession,
	isCurrentSession,
	useAuthStore,
} from "~/features/auth/store";
import { nativeBridge } from "~/features/devices/native";
import { authClient } from "~/lib/rpc-client";

export function isUnauthenticated(error: unknown) {
	return error instanceof ConnectError && error.code === Code.Unauthenticated;
}

// Asks the server which account the session cookie is of, and follows it:
// signed out, or signed in to another account since (in another tab), the
// app becomes that. Asked when the app opens and whenever the server refuses
// a request as unauthenticated; concurrent asks share one request. A failure
// to reach the server changes nothing.
// Deduplication belongs to a login instance, including the signed-out one.
let confirming:
	| { owner: ReturnType<typeof currentSession>; promise: Promise<void> }
	| undefined;
export function confirmSession() {
	if (confirming && isCurrentSession(confirming.owner))
		return confirming.promise;
	const owner = currentSession();
	const promise = (async () => {
		try {
			const { user } = await authClient.getCurrentUser(
				{},
				{ timeoutMs: 10_000 },
			);
			if (isCurrentSession(owner)) {
				adoptUser(user ?? null);
				await nativeBridge()?.syncUser(user?.id ?? "");
			}
		} catch (error) {
			if (isCurrentSession(owner) && isUnauthenticated(error)) {
				adoptUser(null);
				await nativeBridge()?.syncUser("");
			}
		} finally {
			if (confirming?.owner === owner) confirming = undefined;
		}
	})();
	confirming = { owner, promise };
	return promise;
}

// The server ends the session and clears its cookie, then the app follows.
// Only the server can clear an HttpOnly cookie: until it has, this browser
// is still signed in, so a failure leaves it so.
export async function signOut() {
	const owner = currentSession();
	await authClient.signOut({}, { timeoutMs: 10_000 });
	if (isCurrentSession(owner)) {
		useAuthStore.getState().signOut();
		await nativeBridge()?.syncUser("");
	}
}
