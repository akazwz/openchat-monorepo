import { Code, ConnectError, type Interceptor } from "@connectrpc/connect";

import { AuthService } from "~/gen/heveta/v1/auth_pb";

import { currentSession, isCurrentSession, useAuthStore } from "./store";

// The header naming the account a page acts for; the server refuses a
// request whose session is of another (modules/auth/session.ts there).
export const actingUserHeader = "x-heveta-user";

// What a request of this app's own (an upload, a download) sends to say which
// account the page acts for.
export function actingHeaders(): Record<string, string> {
	const user = useAuthStore.getState().user;
	return user ? { [actingUserHeader]: user.id } : {};
}

// Methods that act for no account: signing in and out, and asking which
// account is signed in. Same list as the server's.
const publicMethods = new Set([
	"SendSignInCode",
	"SignInWithEmailCode",
	"GetCurrentUser",
	"SignOut",
]);

// The browser sends the session cookie itself. Every other request names the
// account the page shows; one refused as unauthenticated makes the app ask
// which account is signed in (`refused`, session.ts). A response that arrives
// after the page changed accounts is dropped.
export function createAuthInterceptor(refused: () => void): Interceptor {
	return (next) => async (request) => {
		if (
			request.service.typeName === AuthService.typeName &&
			publicMethods.has(request.method.name)
		)
			return next(request);
		const owner = currentSession();
		const { user } = useAuthStore.getState();
		if (!user) throw new ConnectError("Not signed in", Code.Unauthenticated);
		request.header.set(actingUserHeader, user.id);
		let response: Awaited<ReturnType<typeof next>>;
		try {
			response = await next(request);
		} catch (error) {
			if (!isCurrentSession(owner))
				throw new ConnectError("Session changed", Code.Canceled);
			if (error instanceof ConnectError && error.code === Code.Unauthenticated)
				refused();
			throw error;
		}
		if (!isCurrentSession(owner))
			throw new ConnectError("Session changed", Code.Canceled);
		return response;
	};
}
