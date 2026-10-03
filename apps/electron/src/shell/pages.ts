import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { protocol, type Session } from "electron";

// The client's own pages (the window's title band and status panel, the
// screen-sharing page) are served from a scheme of their own rather than
// file://, as Electron recommends: a standard, secure origin with no access
// to the disk beyond the files listed here.
const scheme = "heveta-shell";
const host = "pages";

const files: Record<string, string> = {
	"/shell.html": "text/html; charset=utf-8",
	"/shell.css": "text/css; charset=utf-8",
	"/shell.js": "text/javascript; charset=utf-8",
	"/theme.css": "text/css; charset=utf-8",
	"/media.html": "text/html; charset=utf-8",
	"/media.js": "text/javascript; charset=utf-8",
};

export const pageOrigin = `${scheme}://${host}`;
export const pageUrl = (name: "shell" | "media") =>
	`${pageOrigin}/${name}.html`;

// Must run before the app is ready.
export function registerPageScheme() {
	protocol.registerSchemesAsPrivileged([
		{ scheme, privileges: { standard: true, secure: true } },
	]);
}

export function servePages(session: Session) {
	session.protocol.handle(scheme, async (request) => {
		const url = new URL(request.url);
		const type = url.host === host ? files[url.pathname] : undefined;
		if (!type || request.method !== "GET")
			return new Response(null, { status: 404 });
		return new Response(
			await readFile(join(__dirname, "pages", url.pathname)),
			{
				headers: { "content-type": type, "cache-control": "no-store" },
			},
		);
	});
}
