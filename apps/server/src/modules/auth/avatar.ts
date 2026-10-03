import { env } from "cloudflare:workers";
import { and, asc, eq, lte, sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import { createDatabase, type Database } from "@/db/client";
import { avatarGarbage } from "@/db/schema/avatar-garbage";
import { users } from "@/db/schema/users";
import { errorDetails } from "@/lib/error-details";
import { AppError, ErrorCode } from "@/lib/errors";
import { failureResponse } from "@/lib/http-errors";
import { announce, userEvents } from "@/modules/events/publish";
import { sniffMimeType } from "@/modules/files/types";

import { sessionOf } from "./session";

// A profile photo is its own R2 object per version: replacing it stores a
// new object and points the account at it, then removes the old one, so the
// account never names an object that is not all there.
const avatarTypes = ["image/jpeg", "image/png", "image/webp"];
export const maxAvatarBytes = 512 * 1024;
const avatarKey = (userId: string, version: string) =>
	`avatars/${userId}/${version}`;
export const avatarUrl = (userId: string, version: string | null) =>
	version ? `/${avatarKey(userId, version)}` : "";

// Points the account at `version` (null for none), returning the account and
// the version it replaced. The row lock orders concurrent changes, so each
// one removes exactly the object it replaced.
async function pointAvatar(
	db: Database,
	userId: string,
	version: string | null,
) {
	return db.transaction(async (tx) => {
		const [current] = await tx
			.select({ version: users.avatarVersion })
			.from(users)
			.where(eq(users.id, userId))
			.for("update");
		if (!current) throw new AppError("User not found", ErrorCode.NotFound);
		if (version) {
			// Claim the pending upload. Cleanup holds this same row while it
			// deletes an expired object, so a removed upload cannot be published.
			const [pending] = await tx
				.delete(avatarGarbage)
				.where(eq(avatarGarbage.key, avatarKey(userId, version)))
				.returning();
			if (!pending)
				throw new AppError(
					"Profile photo upload expired",
					ErrorCode.FailedPrecondition,
				);
		}
		const [user] = await tx
			.update(users)
			.set({ avatarVersion: version, revision: sql`${users.revision} + 1` })
			.where(eq(users.id, userId))
			.returning();
		if (!user) throw new AppError("User not found", ErrorCode.NotFound);
		if (current.version)
			await tx.insert(avatarGarbage).values({
				key: avatarKey(userId, current.version),
				deleteAfter: new Date(),
			});
		return { user, replaced: current.version };
	});
}

// Once the account points elsewhere, the replaced photo is removed and the
// account's devices learn of the change.
async function changed(
	db: Database,
	{ user, replaced }: Awaited<ReturnType<typeof pointAvatar>>,
) {
	await announce(user.id, [userEvents.user(user)]);
	if (replaced) {
		try {
			await deleteGarbage(db, avatarKey(user.id, replaced));
		} catch (error) {
			console.warn("[Avatar] Old photo cleanup pending", errorDetails(error));
		}
	}
	return user;
}

async function deleteGarbage(db: Database, key: string) {
	await db.transaction(async (tx) => {
		const [garbage] = await tx
			.select()
			.from(avatarGarbage)
			.where(
				and(
					eq(avatarGarbage.key, key),
					lte(avatarGarbage.deleteAfter, new Date()),
				),
			)
			.for("update", { skipLocked: true });
		if (!garbage) return;
		await env.BUCKET.delete(key);
		await tx.delete(avatarGarbage).where(eq(avatarGarbage.key, key));
	});
}

export async function purgeAvatarGarbage(db: Database) {
	const garbage = await db
		.select()
		.from(avatarGarbage)
		.where(lte(avatarGarbage.deleteAfter, new Date()))
		.orderBy(asc(avatarGarbage.deleteAfter))
		.limit(100);
	for (const { key } of garbage) await deleteGarbage(db, key);
}

export async function setAvatar(
	db: Database,
	userId: string,
	image: Uint8Array,
) {
	const mimeType = sniffMimeType(image);
	if (!image.length || image.length > maxAvatarBytes)
		throw new AppError(
			"A profile photo is at most 512 KB",
			ErrorCode.InvalidArgument,
		);
	if (!mimeType || !avatarTypes.includes(mimeType))
		throw new AppError(
			"A profile photo is a JPEG, PNG, or WebP image",
			ErrorCode.InvalidArgument,
		);
	const version = uuidv7();
	// Register before writing R2 so interrupted/failed uploads are collected.
	await db.insert(avatarGarbage).values({
		key: avatarKey(userId, version),
		deleteAfter: new Date(Date.now() + 86400_000),
	});
	await env.BUCKET.put(avatarKey(userId, version), image, {
		httpMetadata: { contentType: mimeType },
	});
	return changed(db, await pointAvatar(db, userId, version));
}

export async function removeAvatar(db: Database, userId: string) {
	return changed(db, await pointAvatar(db, userId, null));
}

// GET /avatars/<user>/<version>: an account's profile photo, for that
// account's own sessions alone. Like a file (files/content.ts), it asks only
// for the session, since pages load it directly; to anyone else it is not
// found.
export async function avatarContent(request: Request): Promise<Response> {
	const [userId, version, ...rest] = new URL(request.url).pathname
		.slice("/avatars/".length)
		.split("/");
	if (!userId || !version || rest.length)
		return new Response("Not found", { status: 404 });
	const database = createDatabase();
	try {
		const session = await sessionOf(database.db, request.headers);
		if (session.userId !== userId)
			return new Response("Not found", { status: 404 });
	} catch (error) {
		return failureResponse(error, "Avatar");
	} finally {
		await database.close();
	}
	const key = avatarKey(userId, version);
	let object: R2Object | null;
	let body: ReadableStream | null = null;
	if (request.method === "HEAD") object = await env.BUCKET.head(key);
	else {
		const stored = await env.BUCKET.get(key);
		object = stored;
		body = stored?.body ?? null;
	}
	if (!object) return new Response("Not found", { status: 404 });
	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set("Content-Length", String(object.size));
	headers.set("ETag", object.httpEtag);
	// Another account signed in on this browser must not see it from its
	// cache.
	headers.set("Cache-Control", "private, no-store");
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Content-Security-Policy", "sandbox; default-src 'none'");
	return new Response(body, { headers });
}
