import { env } from "cloudflare:workers";

import { AppError, ErrorCode } from "@/lib/errors";

import {
	pageMissing,
	rateLimited,
	unavailable,
	type WebPage,
	type WebProvider,
	type WebSearchResult,
} from "./provider";

// TinyFish Search and Fetch (docs.tinyfish.ai): free within per-key rate
// limits (Search 30/min and 500/hour, Fetch 150 URLs/min and 1,000/day);
// over them it answers 429 and there is no paid tier, so it goes first and
// Jina takes over (see fallback.ts).
const searchEndpoint = "https://api.search.tinyfish.ai";
const fetchEndpoint = "https://api.fetch.tinyfish.ai";
// Network bounds for one call, not a run budget.
const searchTimeoutMs = 30_000;
const fetchTimeoutMs = 60_000;

const headers = () => ({ "X-API-Key": env.TINYFISH_API_KEY });

function failure(service: "search" | "fetch", response: Response) {
	return response.status === 429
		? rateLimited(service)
		: unavailable(service, response.status);
}

// Per-URL fetch failures. Only a missing page or a bad URL is final; for
// the rest another service may still get through.
function pageError(code: string) {
	switch (code) {
		case "page_not_found":
			return pageMissing();
		case "invalid_url":
		case "invalid_redirect_url":
			return new AppError("The URL is not valid.", ErrorCode.InvalidArgument);
		default:
			return new AppError(
				`Could not read the page (${code || "unknown error"}). Try another source.`,
				ErrorCode.Unavailable,
			);
	}
}

interface SearchResponse {
	results?: { title?: string; url?: string; snippet?: string; date?: string }[];
}
interface FetchResponse {
	results?: {
		url: string;
		final_url?: string;
		title?: string | null;
		text?: string | null;
	}[];
	errors?: { url: string; error: string }[];
}

export const tinyfish: WebProvider = {
	name: "tinyfish",

	async search(query, { language }, signal): Promise<WebSearchResult[]> {
		const url = new URL(searchEndpoint);
		url.searchParams.set("query", query);
		// Location follows from the language; both default to US English.
		if (language) url.searchParams.set("language", language);
		const response = await fetch(url, {
			headers: headers(),
			signal: AbortSignal.any([signal, AbortSignal.timeout(searchTimeoutMs)]),
		});
		if (!response.ok) throw failure("search", response);
		const body = await response.json<SearchResponse>();
		return (body.results ?? []).flatMap((result) =>
			result.url
				? [
						{
							title: result.title ?? "",
							url: result.url,
							snippet: result.snippet ?? "",
							...(result.date ? { date: result.date } : {}),
						},
					]
				: [],
		);
	},

	async fetch(url, signal): Promise<WebPage> {
		const response = await fetch(fetchEndpoint, {
			method: "POST",
			headers: { ...headers(), "Content-Type": "application/json" },
			body: JSON.stringify({
				urls: [url],
				format: "markdown",
				per_url_timeout_ms: fetchTimeoutMs - 5_000,
			}),
			signal: AbortSignal.any([signal, AbortSignal.timeout(fetchTimeoutMs)]),
		});
		if (!response.ok) throw failure("fetch", response);
		const body = await response.json<FetchResponse>();
		const [page] = body.results ?? [];
		if (!page) throw pageError(body.errors?.[0]?.error ?? "");
		return {
			url: page.final_url ?? page.url,
			title: page.title ?? null,
			text: typeof page.text === "string" ? page.text : "",
		};
	},
};
