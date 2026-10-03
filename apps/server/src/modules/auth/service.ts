import {
	and,
	count,
	desc,
	eq,
	gt,
	isNotNull,
	isNull,
	lt,
	or,
	sql,
} from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { z } from "zod";

import { emailBudget } from "@/config";
import type { Database } from "@/db/client";
import { sessions } from "@/db/schema/sessions";
import { type User, users } from "@/db/schema/users";
import { verificationCodes } from "@/db/schema/verification-codes";
import { ErrorReason } from "@/gen/heveta/v1/error_pb";
import { errorDetails } from "@/lib/error-details";
import { AppError, ErrorCode } from "@/lib/errors";
import { sha256 } from "@/lib/hash";
import type { Locale } from "@/lib/locale";
import { advisoryLock } from "@/lib/sql";
import { sendSignInCodeEmail } from "@/modules/auth/email";
import { closeDeviceViewers } from "@/modules/devices/service";
import { announce, closeChannels, userEvents } from "@/modules/events/publish";
import { closeConnections } from "@/modules/sandbox/connections";

import { requireInvitation } from "./invitations";
import { clientNetwork } from "./limits";
import { endSessionOf, startSession } from "./session";

const codeLifetimeMs = 600_000;
const codeCooldownMs = 60_000;
// A code is retired after this many wrong guesses, which only a holder of its
// challenge can make. An email receives at most `dailyCodeLimit` codes a day
// requested from one client network, and `dailyEmailCodeLimit` from all of
// them together, which bounds guessing to a few hundred attempts a day
// against a million possible codes, and the mail sent to it. That total can
// be used up by others; invitation checks and per-network request limits
// remain in place.
const codeAttemptLimit = 5;
const dailyCodeLimit = 10;
const dailyEmailCodeLimit = 50;

const invalidCode = () =>
	new AppError(
		"Invalid or expired verification code",
		ErrorCode.InvalidArgument,
		ErrorReason.SIGN_IN_CODE_INVALID,
	);

export function emailAddress(input: string) {
	const email = input.trim().toLowerCase();
	if (!z.email().safeParse(email).success)
		throw new AppError("Invalid email", ErrorCode.InvalidArgument);
	return email;
}
const usernamePattern = /^[\p{L}\p{N}_-]{2,40}$/u;
function usernameValue(input: string) {
	const username = input.trim();
	if (!usernamePattern.test(username))
		throw new AppError(
			"Username must contain 2–40 letters, numbers, underscores or hyphens",
			ErrorCode.InvalidArgument,
		);
	return username;
}
// A new account's name: the email's local part, reduced to allowed characters.
function defaultUsername(email: string) {
	const local = Array.from(email.split("@")[0].normalize("NFKC"))
		.filter((character) => /[\p{L}\p{N}_-]/u.test(character))
		.slice(0, 32)
		.join("");
	return local.length >= 2 ? local : `user${local}`;
}
// Checks the code sent for a challenge, in its own transaction: a wrong guess
// must be counted even though the caller's request then fails. Returns the
// email it was sent to.
async function consumeCode(db: Database, challenge: string, code: string) {
	if (!/^\d{6}$/.test(code)) throw invalidCode();
	const email = await db.transaction(async (tx) => {
		const now = new Date();
		const [pending] = await tx
			.select()
			.from(verificationCodes)
			.where(
				and(
					eq(verificationCodes.id, challenge),
					isNull(verificationCodes.usedAt),
					gt(verificationCodes.expiresAt, now),
				),
			)
			.for("update");
		if (!pending) return undefined;
		const matches = pending.code === code;
		const attempts = pending.attempts + (matches ? 0 : 1);
		await tx
			.update(verificationCodes)
			.set({
				attempts,
				usedAt: matches || attempts >= codeAttemptLimit ? now : null,
			})
			.where(eq(verificationCodes.id, pending.id));
		return matches ? pending.email : undefined;
	});
	if (!email) throw invalidCode();
	return email;
}

// An address with an account, or invited to create one (invitations.ts), gets
// a code; the answer does not tell the two apart, and an invited address's
// first sign-in creates its account. Returns the
// code's challenge. Codes are independent of one another: requesting one
// neither replaces nor holds back a code someone else requested.
export async function sendSignInCode(
	db: Database,
	input: string,
	clientAddress: string,
	locale: Locale,
) {
	const email = emailAddress(input);
	// Only invited addresses or existing accounts receive codes.
	await requireInvitation(db, email);
	const requesterHash = await sha256(clientNetwork(clientAddress));
	// The code to send, or none when this client's last one still stands.
	const { challenge, code } = await db.transaction(async (tx) => {
		// One request for an address at a time, its first included, which has
		// no earlier code to lock.
		await advisoryLock(tx, "sign-in-code", email);
		const [recent] = await tx
			.select()
			.from(verificationCodes)
			.where(
				and(
					eq(verificationCodes.email, email),
					eq(verificationCodes.requesterHash, requesterHash),
					isNull(verificationCodes.usedAt),
				),
			)
			.orderBy(desc(verificationCodes.id))
			.limit(1);
		// This client's code sent a moment ago stays the one to use.
		if (recent && Date.now() - recent.createdAt.getTime() < codeCooldownMs)
			return { challenge: recent.id, code: undefined };
		const [today] = await tx
			.select({
				all: count(),
				fromRequester: count(
					sql`case when ${verificationCodes.requesterHash} = ${requesterHash} then 1 end`,
				),
			})
			.from(verificationCodes)
			.where(
				and(
					eq(verificationCodes.email, email),
					gt(verificationCodes.createdAt, new Date(Date.now() - 86400_000)),
				),
			);
		if (
			today.fromRequester >= dailyCodeLimit ||
			today.all >= dailyEmailCodeLimit
		)
			throw new AppError(
				"Too many codes requested today. Try again tomorrow.",
				ErrorCode.ResourceExhausted,
				ErrorReason.SIGN_IN_CODES_EXHAUSTED,
			);
		// The share of the account's sending quota that codes have (config.ts
		// emailBudget), for all addresses together. Counted by expiry, which
		// is indexed: a code expires a fixed time after it is made.
		const [sentToday] = await tx
			.select({ all: count() })
			.from(verificationCodes)
			.where(
				gt(
					verificationCodes.expiresAt,
					new Date(Date.now() - 86400_000 + codeLifetimeMs),
				),
			);
		if (sentToday.all >= emailBudget.signInCodesPerDay)
			throw new AppError(
				"No more sign-in codes are sent today.",
				ErrorCode.ResourceExhausted,
				ErrorReason.SIGN_IN_CODES_PAUSED,
			);
		const [row] = await tx
			.insert(verificationCodes)
			.values({
				email,
				requesterHash,
				code: customAlphabet("0123456789", 6)(),
				expiresAt: new Date(Date.now() + codeLifetimeMs),
			})
			.returning({ id: verificationCodes.id, code: verificationCodes.code });
		return { challenge: row.id, code: row.code };
	});
	if (code === undefined) return challenge;
	try {
		await sendSignInCodeEmail(email, code, locale);
	} catch {
		// Never sent: it neither holds back the next request nor counts
		// toward the day's codes.
		await db
			.delete(verificationCodes)
			.where(eq(verificationCodes.id, challenge));
		throw new AppError(
			"Unable to send email. Please request a new code.",
			ErrorCode.Unavailable,
			ErrorReason.SIGN_IN_CODE_NOT_SENT,
		);
	}
	return challenge;
}

// Finds the account for a verified address, creating it on first sign-in.
async function accountFor(db: Database, email: string): Promise<User> {
	const [created] = await db
		.insert(users)
		.values({ email, username: defaultUsername(email) })
		.onConflictDoNothing({ target: users.email })
		.returning();
	if (created) return created;
	const [existing] = await db
		.select()
		.from(users)
		.where(eq(users.email, email));
	return existing;
}

// The account, and the cookie of its new session.
export async function signIn(db: Database, challenge: string, code: string) {
	const email = await consumeCode(db, challenge, code);
	const user = await accountFor(db, email);
	return { user, cookie: await startSession(db, user.id) };
}

export async function currentUser(db: Database, userId: string) {
	const [user] = await db.select().from(users).where(eq(users.id, userId));
	if (!user) throw new AppError("User not found", ErrorCode.NotFound);
	return user;
}

export async function updateUsername(
	db: Database,
	userId: string,
	input: string,
) {
	const [user] = await db
		.update(users)
		.set({
			username: usernameValue(input),
			revision: sql`${users.revision} + 1`,
		})
		.where(eq(users.id, userId))
		.returning();
	if (!user) throw new AppError("User not found", ErrorCode.NotFound);
	await announce(userId, [userEvents.user(user)]);
	return user;
}

// An ended session's open connections close at once: its devices' event
// channels and their connections to the computer.
async function endSession(db: Database, userId: string, sessionId: string) {
	try {
		await Promise.all([
			closeChannels(userId, sessionId),
			closeConnections(userId, sessionId),
			closeDeviceViewers(db, userId, sessionId),
		]);
		await db.delete(sessions).where(eq(sessions.id, sessionId));
	} catch (error) {
		// Already revoked. Keep the row for the next cleanup, including when
		// the Worker stops after revocation but before contacting the Hub.
		console.warn("[Auth] Session channel closure pending", {
			sessionId,
			...errorDetails(error),
		});
	}
}
// Signing out ends the session the request's cookie holds.
export async function signOut(db: Database, headers: Headers) {
	const ended = await endSessionOf(db, headers);
	if (ended) await endSession(db, ended.userId, ended.id);
}
// Expired sessions and codes older than a day have no further use. An expired
// session ends like a revoked one: its open connections close.
export async function purgeExpiredAuthRecords(db: Database) {
	const now = new Date();
	const expired = await db
		.update(sessions)
		.set({ revokedAt: sql`coalesce(${sessions.revokedAt}, ${now})` })
		.where(or(lt(sessions.expiresAt, now), isNotNull(sessions.revokedAt)))
		.returning({ userId: sessions.userId, id: sessions.id });
	for (const session of expired)
		await endSession(db, session.userId, session.id);
	await db
		.delete(verificationCodes)
		.where(lt(verificationCodes.expiresAt, new Date(Date.now() - 86400_000)));
}
