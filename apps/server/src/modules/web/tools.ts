import { AppError, ErrorCode } from "@/lib/errors";
import { textWindow } from "@/lib/text";
import type { LocalTool } from "@/runtime/tools";

import { cached } from "./cache";
import { fallback } from "./fallback";
import { jina } from "./jina";
import type { WebProvider } from "./provider";
import { tinyfish } from "./tinyfish";

const text = (value: unknown) => (typeof value === "string" ? value : "");
// A page is read in windows so one long page cannot crowd out the rest of
// the conversation; the model asks for the next window when it needs it.
const pageWindowChars = 20_000;

// The script a query is written in picks the results' language (the service
// defaults to US English). Kana and Hangul before Han: Japanese mixes kanji.
function queryLanguage(query: string) {
	if (/[぀-ヿ]/.test(query)) return "ja";
	if (/[가-힯]/.test(query)) return "ko";
	if (/\p{Script=Han}/u.test(query)) return "zh";
	return undefined;
}

function webUrl(value: string) {
	try {
		const url = new URL(value.trim());
		if (url.protocol === "http:" || url.protocol === "https:") return url.href;
	} catch {}
	throw new AppError(
		"The URL must be a full http or https address.",
		ErrorCode.InvalidArgument,
	);
}

// TinyFish is free within its limits; Jina, paid per use, takes over beyond
// them. One cache per isolate, shared by every run it serves.
const services = cached(fallback(tinyfish, jina));

export function webTools(provider: WebProvider = services): LocalTool[] {
	return [
		{
			name: "web_search",
			description:
				"Search the web. Returns up to 10 results with title, URL and snippet. Write the query in the language of the sources you want (Chinese for Chinese sources); make it short and specific.",
			parameters: {
				type: "object",
				properties: {
					query: { type: "string", description: "The search query." },
				},
				required: ["query"],
				additionalProperties: false,
			},
			readOnly: true,
			concurrent: true,
			execute: async (args, { signal }) => {
				const query = text(args.query).trim();
				if (!query)
					throw new AppError("The query is empty.", ErrorCode.InvalidArgument);
				const results = await provider.search(
					query,
					{ language: queryLanguage(query) },
					signal,
				);
				if (!results.length) return { output: "No results found." };
				return {
					output: results
						.slice(0, 10)
						.map((result, index) =>
							[
								`${index + 1}. ${result.title || result.url}`,
								`   ${result.url}`,
								...(result.snippet || result.date
									? [
											`   ${[result.date, result.snippet.replace(/\s+/g, " ")].filter(Boolean).join(" · ")}`,
										]
									: []),
							].join("\n"),
						)
						.join("\n"),
				};
			},
		},
		{
			name: "web_fetch",
			description: `Read a web page (or PDF) as Markdown. Long pages come in windows of ${pageWindowChars} characters; start at 0, and pass the offset the result names to read on.`,
			parameters: {
				type: "object",
				properties: {
					url: { type: "string", description: "The page's full URL." },
					start: {
						type: "integer",
						description: "Character offset to read from; 0 for the beginning.",
					},
				},
				required: ["url", "start"],
				additionalProperties: false,
			},
			readOnly: true,
			concurrent: true,
			execute: async (args, { signal }) => {
				const page = await provider.fetch(webUrl(text(args.url)), signal);
				if (!page.text.length)
					return { output: `${page.url}\nThe page has no readable text.` };
				// Only the window is copied out of the page, which may be
				// megabytes (a PDF) and stays in the cache for the next window.
				const shown = textWindow(
					page.text,
					typeof args.start === "number" && Number.isInteger(args.start)
						? args.start
						: 0,
					pageWindowChars,
				);
				const length = page.text.length;
				const whole = shown.start === 0 && shown.end === length;
				return {
					output: [
						...(page.title ? [`Title: ${page.title}`] : []),
						`URL: ${page.url}`,
						"",
						shown.text,
						...(whole
							? []
							: [
									"",
									`(Characters ${shown.start}–${shown.end} of ${length}.${shown.end < length ? ` Call web_fetch with start=${shown.end} to read on.` : ""})`,
								]),
					].join("\n"),
				};
			},
		},
	];
}
