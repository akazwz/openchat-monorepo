import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";

import type { Config } from "@react-router/dev/config";

// The page's Content Security Policy, for every page the app serves (Workers
// Static Assets' _headers, which the build copies from public/). Scripts run
// only from the app itself, the inline ones index.html carries (React
// Router's, per build, and the color mode's), and Cloudflare Web Analytics, whose
// beacon Cloudflare adds to the page as it is served (it reports to the
// app's own address; the script's path carries a version, so the host is
// named). Nothing else is loaded from elsewhere:
// a reply's Markdown cannot pull in a remote image, and injected markup could
// send nothing out. Styles stay inline: Astryx adds <style> elements at run
// time. KaTeX's fonts include data: URLs; images are the app's own, blob:
// previews of files being attached, and data: (the screen's cursor).
function contentSecurityPolicy(inlineScripts: string[]) {
	const hashes = inlineScripts.map(
		(script) =>
			`'sha256-${createHash("sha256").update(script).digest("base64")}'`,
	);
	return [
		"default-src 'self'",
		`script-src 'self' ${hashes.join(" ")} https://static.cloudflareinsights.com`,
		"style-src 'self' 'unsafe-inline'",
		"img-src 'self' data: blob:",
		"font-src 'self' data:",
		"connect-src 'self'",
		"frame-src 'none'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'self'",
		"frame-ancestors 'none'",
	].join("; ");
}

export default {
	ssr: false,
	prerender: false,
	async buildEnd({ reactRouterConfig }) {
		const client = path.join(reactRouterConfig.buildDirectory, "client");
		const html = await readFile(path.join(client, "index.html"), "utf8");
		const inline = [
			...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g),
		].map((match) => match[1] ?? "");
		const external = html.match(/<script[^>]*\ssrc=/g) ?? [];
		// Every script is accounted for, or one would be blocked in production.
		if (inline.length + external.length !== html.split("<script").length - 1)
			throw new Error("index.html has a script the policy did not read");
		await appendFile(
			path.join(client, "_headers"),
			`\n/*\n  Content-Security-Policy: ${contentSecurityPolicy(inline)}\n`,
		);
	},
} satisfies Config;
