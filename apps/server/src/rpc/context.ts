import {
	Code,
	ConnectError,
	createContextKey,
	type HandlerContext,
} from "@connectrpc/connect";

export const cfCtxStore = createContextKey<ExecutionContext | undefined>(
	undefined,
);

// The caller's IP address as seen by Cloudflare; empty outside Cloudflare.
export const clientAddressStore = createContextKey("");

interface AuthInfo {
	userId: string;
	// The signed-in session, which owns this device's event channel.
	sessionId: string;
}

export const AuthStore = createContextKey<AuthInfo | undefined>(undefined);

export function getAuthInfo(ctx: HandlerContext) {
	const authInfo = ctx.values.get(AuthStore);
	if (!authInfo) {
		throw new ConnectError("AuthInfo is not set", Code.Internal);
	}
	return authInfo;
}
