import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";

import { createDatabase } from "@/db/client";
import { files } from "@/db/schema/files";
import { failureResponse } from "@/lib/http-errors";
import { sessionOf } from "@/modules/auth/session";

import { isImageMimeType } from "./types";

// GET /files/<id>: a stored file, for its owner's session alone. Pages load
// images from it directly, so it asks only for the session, not which
// account the page is for (modules/auth/session.ts); another account's
// file, or one being deleted, is not found.
export async function fileContent(request: Request): Promise<Response> {
	const id = new URL(request.url).pathname.slice("/files/".length);
	if (
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
	)
		return new Response("Not found", { status: 404 });
	const database = createDatabase();
	let key: string | undefined;
	try {
		const { userId } = await sessionOf(database.db, request.headers);
		const [file] = await database.db
			.select({ key: files.storageKey })
			.from(files)
			.where(
				and(
					eq(files.id, id),
					eq(files.userId, userId),
					eq(files.status, "stored"),
				),
			);
		key = file?.key;
	} catch (error) {
		return failureResponse(error, "File");
	} finally {
		await database.close();
	}
	if (!key) return new Response("Not found", { status: 404 });
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
	const contentType =
		object.httpMetadata?.contentType ?? "application/octet-stream";
	headers.set("Content-Type", contentType);
	headers.set("Content-Length", String(object.size));
	headers.set("ETag", object.httpEtag);
	// The browser keeps it for this session only; another account signed in
	// on it must not see it from its cache.
	headers.set("Cache-Control", "private, no-store");
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Content-Security-Policy", "sandbox; default-src 'none'");
	// Files share the application origin: only verified images render in
	// place; anything else downloads, under the name stored with it.
	if (
		!isImageMimeType(contentType) &&
		!headers.get("Content-Disposition")?.startsWith("attachment")
	)
		headers.set("Content-Disposition", "attachment");
	return new Response(body, { headers });
}
