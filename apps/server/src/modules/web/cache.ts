import type { WebPage, WebProvider, WebSearchResult } from "./provider";

// Recent results, kept in the isolate's memory: reading a long page window by
// window, or the same search twice, does not call the service again. Short
// enough that time-sensitive pages (weather, prices) stay current.
const ttlMs = 15 * 60_000;
const maxPages = 50;
// The pages' text together, so a few very long ones (a PDF can be megabytes)
// cannot crowd the isolate's 128 MB, which the runs it serves share with
// their model requests (a request with a full file budget holds its files'
// data several times over while it is sent, see lib/openai.ts): 4M
// characters is 8 MB at most, and still holds a book-length PDF (a 500-page
// book is about 1.5M characters) while it is read window by window.
const maxPageChars = 4_000_000;
const maxSearches = 200;

class Recent<T> {
	#entries = new Map<string, { value: T; expires: number; size: number }>();
	#size = 0;
	constructor(
		readonly limit: number,
		// How much of `maxSize` an entry takes.
		readonly sizeOf: (value: T) => number = () => 0,
		readonly maxSize = Number.POSITIVE_INFINITY,
	) {}
	get(key: string) {
		const entry = this.#entries.get(key);
		if (!entry) return undefined;
		if (entry.expires > Date.now()) return entry.value;
		this.#delete(key);
		return undefined;
	}
	set(key: string, value: T) {
		const size = this.sizeOf(value);
		this.#delete(key);
		// One entry too large for the whole cache is not kept.
		if (size > this.maxSize) return;
		this.#entries.set(key, { value, expires: Date.now() + ttlMs, size });
		this.#size += size;
		// Maps keep insertion order: the first key is the oldest.
		while (this.#entries.size > this.limit || this.#size > this.maxSize)
			this.#delete(this.#entries.keys().next().value as string);
	}
	#delete(key: string) {
		const entry = this.#entries.get(key);
		if (!entry) return;
		this.#entries.delete(key);
		this.#size -= entry.size;
	}
}

export function cached(provider: WebProvider): WebProvider {
	const pages = new Recent<WebPage>(
		maxPages,
		(page) => page.text.length,
		maxPageChars,
	);
	const searches = new Recent<WebSearchResult[]>(maxSearches);
	return {
		name: provider.name,
		async search(query, options, signal) {
			const key = `${options.language ?? ""}\n${query}`;
			const hit = searches.get(key);
			if (hit) return hit;
			const results = await provider.search(query, options, signal);
			searches.set(key, results);
			return results;
		},
		async fetch(url, signal) {
			const hit = pages.get(url);
			if (hit) return hit;
			const page = await provider.fetch(url, signal);
			pages.set(url, page);
			return page;
		},
	};
}
