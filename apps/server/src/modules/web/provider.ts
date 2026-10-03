import { AppError, ErrorCode } from "@/lib/errors";

// What the web tools need from a search/fetch service. The tools depend on
// this shape only; services are combined in order (fallback.ts) and cached
// (cache.ts).
export interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
	// Publication date, when the service knows it.
	date?: string;
}

export interface WebPage {
	// Where the content came from, after redirects.
	url: string;
	title: string | null;
	// The page as Markdown.
	text: string;
}

export interface WebProvider {
	// For logs.
	name: string;
	search(
		query: string,
		options: { language?: string },
		signal: AbortSignal,
	): Promise<WebSearchResult[]>;
	fetch(url: string, signal: AbortSignal): Promise<WebPage>;
}

// Failures a provider reports. The message is read by the model; the code
// says whether another service could do better: a rate limit or outage
// (ResourceExhausted, Unavailable) could, a missing page or bad URL could not.
export const rateLimited = (service: string) =>
	new AppError(
		`Web ${service} is over its rate limit right now. Continue with what you have and tell the user that web ${service} is temporarily unavailable.`,
		ErrorCode.ResourceExhausted,
	);
export const unavailable = (service: string, status: number) =>
	new AppError(
		`Web ${service} failed (HTTP ${status}). Try again, or continue with what you have.`,
		ErrorCode.Unavailable,
	);
export const pageMissing = () =>
	new AppError(
		"The page does not exist. Try another source.",
		ErrorCode.NotFound,
	);
