import { and, eq, gt, isNull, sql } from "drizzle-orm";

import { createDatabase, type Database } from "@/db/client";
import { sessions } from "@/db/schema/sessions";
import { AppError, ErrorCode } from "@/lib/errors";
import { sha256 } from "@/lib/hash";

// A signed-in session is an HttpOnly cookie holding a random token (see the
// sessions table). Page scripts never see it, so script injected into the
// app cannot carry it off; the browser sends it only on requests this app
// makes itself (SameSite=Strict), never on ones another site starts. The
// __Host- prefix keeps it to this exact host, over HTTPS (localhost counts).
const cookieName = "__Host-heveta_session";
export const sessionLifetimeMs = 30 * 86400_000;
// A session in use is renewed once a day: one used within its lifetime stays
// signed in.
const renewalMs = 86400_000;

// The account the page acts for, which a request states (the header on
// requests, `user` on a WebSocket's address). A session cookie is shared by
// every tab, and another tab may have signed in to another account: a page
// still showing the first must not act as the second. A header another site
// cannot send also keeps requests that change something from being forged.
export const actingUserHeader = "x-heveta-user";

const cookieAttributes = "Path=/; HttpOnly; Secure; SameSite=Strict";
const sessionCookie = (token: string, expiresAt: Date) =>
	`${cookieName}=${token}; ${cookieAttributes}; Max-Age=${Math.floor(
		(expiresAt.getTime() - Date.now()) / 1000,
	)}`;
export const clearedSessionCookie = `${cookieName}=; ${cookieAttributes}; Max-Age=0`;

function sessionToken(headers: Headers) {
	for (const pair of headers.get("cookie")?.split(";") ?? []) {
		const [name, ...value] = pair.trim().split("=");
		if (name === cookieName) return value.join("=") || undefined;
	}
	return undefined;
}

const unauthenticated = (message: string) =>
	new AppError(message, ErrorCode.Unauthenticated);

// Starts a session for the account; the cookie that carries it.
export async function startSession(db: Database, userId: string) {
	const token = crypto.randomUUID() + crypto.randomUUID();
	const expiresAt = new Date(Date.now() + sessionLifetimeMs);
	await db
		.insert(sessions)
		.values({ userId, tokenHash: await sha256(token), expiresAt });
	return sessionCookie(token, expiresAt);
}

// The live session a request's cookie holds, of whichever account. What an
// element loads (an image) cannot say which account it is for.
export async function sessionOf(db: Database, headers: Headers) {
	const token = sessionToken(headers);
	if (!token) throw unauthenticated("Not signed in");
	const [session] = await db
		.select()
		.from(sessions)
		.where(
			and(
				eq(sessions.tokenHash, await sha256(token)),
				gt(sessions.expiresAt, new Date()),
				isNull(sessions.revokedAt),
			),
		);
	if (!session) throw unauthenticated("Session expired");
	return { ...session, token };
}

// The live session a request's cookie holds, of the account the request
// says it acts for. With `renew`, a session due for renewal is extended and
// the cookie to send back with it returned.
export async function authenticate(
	db: Database,
	headers: Headers,
	actingUser: string | null,
	options: { renew?: boolean } = {},
) {
	const session = await sessionOf(db, headers);
	if (actingUser !== session.userId)
		throw unauthenticated("Signed in to another account");
	let cookie: string | undefined;
	if (
		options.renew &&
		session.expiresAt.getTime() - Date.now() < sessionLifetimeMs - renewalMs
	) {
		const expiresAt = new Date(Date.now() + sessionLifetimeMs);
		const [renewed] = await db
			.update(sessions)
			.set({ expiresAt })
			.where(and(eq(sessions.id, session.id), isNull(sessions.revokedAt)))
			.returning({ id: sessions.id });
		if (!renewed) throw unauthenticated("Session ended");
		cookie = sessionCookie(session.token, expiresAt);
	}
	return { userId: session.userId, sessionId: session.id, cookie };
}

// Revoke first. Keep the row until its channels have closed, so failed
// delivery can be retried by sign-out or scheduled cleanup.
export async function endSessionOf(db: Database, headers: Headers) {
	const token = sessionToken(headers);
	if (!token) return undefined;
	const [ended] = await db
		.update(sessions)
		.set({ revokedAt: sql`coalesce(${sessions.revokedAt}, now())` })
		.where(eq(sessions.tokenHash, await sha256(token)))
		.returning({ id: sessions.id, userId: sessions.userId });
	return ended;
}

// Rechecked by the Hub inside its admission gate: the Worker's earlier
// check may have preceded a sign-out. Only trusted Worker requests name it.
export async function liveEventSession(sessionId: string) {
	const database = createDatabase();
	try {
		const [session] = await database.db
			.select({ id: sessions.id })
			.from(sessions)
			.where(
				and(
					eq(sessions.id, sessionId),
					isNull(sessions.revokedAt),
					gt(sessions.expiresAt, new Date()),
				),
			);
		return Boolean(session);
	} finally {
		await database.close();
	}
}

// Whether a page of this very host opened the WebSocket. A browser lets any
// site open one to any address, sending this site's cookies with it when the
// sites are related (another of our subdomains).
function fromThisHost(request: Request) {
	const origin = request.headers.get("origin");
	if (!origin) return false;
	try {
		return new URL(origin).host === request.headers.get("host");
	} catch {
		return false;
	}
}

// A WebSocket a page of this app opens for the account it shows
// (`?user=…`): the session it acts for, or the response refusing it.
export async function admitWebSocket(
	request: Request,
): Promise<{ userId: string; sessionId: string } | Response> {
	if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
		return new Response("Expected a WebSocket upgrade", { status: 426 });
	if (!fromThisHost(request))
		return new Response("Not opened by this app", { status: 403 });
	const database = createDatabase();
	try {
		const { userId, sessionId } = await authenticate(
			database.db,
			request.headers,
			new URL(request.url).searchParams.get("user"),
		);
		return { userId, sessionId };
	} catch (error) {
		if (error instanceof AppError && error.code === ErrorCode.Unauthenticated)
			return new Response(error.message, { status: 401 });
		throw error;
	} finally {
		await database.close();
	}
}
