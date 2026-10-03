import type { Interceptor } from "@connectrpc/connect";

import { actingUserHeader, authenticate } from "@/modules/auth/session";

import { AuthStore } from "./context";
import { getDB } from "./database";

// Signing in cannot require the session it starts; signing out works without
// one, to clear a cookie whose session is gone; and asking who is signed in
// is how a page learns which account it is for (GetCurrentUser reads the
// session itself).
const publicMethods = new Set([
	"SendSignInCode",
	"SignInWithEmailCode",
	"GetCurrentUser",
	"SignOut",
]);

// Every other method acts for the session its cookie holds, of the account
// the page says it acts for (modules/auth/session.ts). A session due for
// renewal gets its renewed cookie back with the response.
export const authInterceptor: Interceptor = (next) => async (req) => {
	if (
		req.service.typeName === "heveta.v1.AuthService" &&
		publicMethods.has(req.method.name)
	)
		return next(req);
	const { cookie, ...identity } = await authenticate(
		getDB({ values: req.contextValues }),
		req.header,
		req.header.get(actingUserHeader),
		{ renew: true },
	);
	req.contextValues.set(AuthStore, identity);
	const res = await next(req);
	if (cookie) res.header.append("Set-Cookie", cookie);
	return res;
};
