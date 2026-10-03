import { env } from "cloudflare:workers";

import {
	pageMissing,
	rateLimited,
	unavailable,
	type WebPage,
	type WebProvider,
	type WebSearchResult,
} from "./provider";

// Jina Reader (r.jina.ai) and Search (s.jina.ai), paid per token on the key
// (a search costs 10,000 tokens; a page its output length), with 500 and 100
// requests a minute. It takes over when TinyFish's free limits run out: more
// usage costs more instead of failing.
const readerEndpoint = "https://r.jina.ai/";
const searchEndpoint = "https://s.jina.ai/";
const timeoutMs = 60_000;

const headers = () => ({
	Authorization: `Bearer ${env.JINA_API_KEY}`,
	Accept: "application/json",
});

function failure(service: "search" | "fetch", response: Response) {
	return response.status === 429
		? rateLimited(service)
		: unavailable(service, response.status);
}

interface SearchResponse {
	data?: {
		title?: string;
		url?: string;
		description?: string;
		date?: string;
	}[];
}
interface ReaderResponse {
	data?: {
		title?: string;
		url?: string;
		content?: string;
		httpStatus?: number;
	};
}

export const jina: WebProvider = {
	name: "jina",

	async search(query, _options, signal): Promise<WebSearchResult[]> {
		const url = new URL(searchEndpoint);
		url.searchParams.set("q", query);
		const response = await fetch(url, {
			// The result list only: reading pages is web_fetch's job.
			headers: { ...headers(), "X-Respond-With": "no-content" },
			signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
		});
		if (!response.ok) throw failure("search", response);
		const body = await response.json<SearchResponse>();
		return (body.data ?? []).flatMap((result) =>
			result.url
				? [
						{
							title: result.title ?? "",
							url: result.url,
							snippet: result.description ?? "",
							...(result.date ? { date: result.date } : {}),
						},
					]
				: [],
		);
	},

	async fetch(url, signal): Promise<WebPage> {
		const response = await fetch(`${readerEndpoint}${url}`, {
			headers: { ...headers(), "X-Retain-Images": "none" },
			signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
		});
		if (!response.ok) throw failure("fetch", response);
		const { data } = await response.json<ReaderResponse>();
		// The target's own status: a missing page still comes back as a page.
		if (data?.httpStatus === 404 || data?.httpStatus === 410)
			throw pageMissing();
		return {
			url: data?.url ?? url,
			title: data?.title || null,
			text: data?.content ?? "",
		};
	},
};
