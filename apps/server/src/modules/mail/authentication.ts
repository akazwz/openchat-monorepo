import type { Header } from "postal-mime";

// Cloudflare's mail server, as it names itself in the results it adds.
const cloudflareServer = "mx.cloudflare.net";

// A header value without its comments (parenthesized, possibly nested),
// which only explain the results (RFC 5322 CFWS). Quoted strings are kept
// whole: a parenthesis inside one is not a comment.
function withoutComments(value: string) {
	let text = "";
	let depth = 0;
	let quoted = false;
	for (let index = 0; index < value.length; index++) {
		const char = value[index];
		if (char === "\\" && (quoted || depth)) {
			if (!depth) text += char + (value[index + 1] ?? "");
			index++;
		} else if (quoted) {
			text += char;
			if (char === '"') quoted = false;
		} else if (char === "(") depth++;
		else if (char === ")" && depth) depth--;
		else if (!depth) {
			text += char;
			if (char === '"') quoted = true;
		}
	}
	return text;
}

// The DMARC result Cloudflare's mail server found for an email's From domain
// (measured on a delivered message, docs/email.md): the Authentication-Results
// header (RFC 8601) it puts on top of the message. A sender can write such a
// header too, claiming anything, but below Cloudflare's; so only the topmost
// counts, and only when it is Cloudflare's. Null when there is none: the From
// address is then unverified.
export function dmarcResult(headers: Header[], fromAddress: string) {
	const top = headers.find((header) => header.key === "authentication-results");
	if (!top) return null;
	const [server, ...results] = withoutComments(top.value)
		.split(";")
		.map((part) => part.trim());
	if (server.toLowerCase() !== cloudflareServer) return null;
	const fromDomain = fromAddress.slice(fromAddress.lastIndexOf("@") + 1);
	for (const result of results) {
		// "dmarc=pass header.from=example.com policy.dmarc=reject"
		const [verdict, ...properties] = result.split(/\s+/);
		const [method, value] = verdict.split("=");
		if (method.toLowerCase() !== "dmarc" || !value) continue;
		// About this email's From domain, which the result must name: without
		// it, it could be about another domain.
		const domain = properties
			.map((property) => property.split("="))
			.find(([name]) => name.toLowerCase() === "header.from")?.[1];
		if (!domain || domain.toLowerCase() !== fromDomain.toLowerCase())
			return null;
		return value.toLowerCase();
	}
	return null;
}
