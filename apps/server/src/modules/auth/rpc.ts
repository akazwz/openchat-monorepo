import type { ConnectRouter, HandlerContext } from "@connectrpc/connect";

import { AuthService } from "@/gen/heveta/v1/auth_pb";
import { requestLocale } from "@/lib/locale";
import { clientAddressStore, getAuthInfo } from "@/rpc/context";
import { getDB } from "@/rpc/database";

import { removeAvatar, setAvatar } from "./avatar";
import { limitRequest } from "./limits";
import { userResource } from "./rpc-codec";
import * as auth from "./service";
import { clearedSessionCookie, sessionOf } from "./session";

// Every public method is limited per client address. Nothing is limited per
// email: requests naming someone's email would use up their own allowance.
// Sending mail has its own limits, and each code its own guesses (service.ts).
const limit = (ctx: HandlerContext) =>
	limitRequest(ctx.values.get(clientAddressStore));

export function registerAuth(router: ConnectRouter) {
	router.service(AuthService, {
		async sendSignInCode(req, ctx) {
			await limit(ctx);
			return {
				challenge: await auth.sendSignInCode(
					getDB(ctx),
					req.email,
					ctx.values.get(clientAddressStore),
					requestLocale(ctx.requestHeader),
				),
			};
		},
		async signInWithEmailCode(req, ctx) {
			await limit(ctx);
			const { user, cookie } = await auth.signIn(
				getDB(ctx),
				req.challenge,
				req.code,
			);
			ctx.responseHeader.append("Set-Cookie", cookie);
			return { user: userResource(user) };
		},
		// Whichever account the cookie's session is of: the page asks when it
		// does not know, or was refused as another account.
		async getCurrentUser(_req, ctx) {
			const { userId } = await sessionOf(getDB(ctx), ctx.requestHeader);
			return { user: userResource(await auth.currentUser(getDB(ctx), userId)) };
		},
		async updateCurrentUser(req, ctx) {
			return {
				user: userResource(
					await auth.updateUsername(
						getDB(ctx),
						getAuthInfo(ctx).userId,
						req.username,
					),
				),
			};
		},
		async setAvatar(req, ctx) {
			return {
				user: userResource(
					await setAvatar(getDB(ctx), getAuthInfo(ctx).userId, req.image),
				),
			};
		},
		async removeAvatar(_req, ctx) {
			return {
				user: userResource(
					await removeAvatar(getDB(ctx), getAuthInfo(ctx).userId),
				),
			};
		},
		async signOut(_req, ctx) {
			await limit(ctx);
			await auth.signOut(getDB(ctx), ctx.requestHeader);
			ctx.responseHeader.append("Set-Cookie", clearedSessionCookie);
			return {};
		},
	});
}
