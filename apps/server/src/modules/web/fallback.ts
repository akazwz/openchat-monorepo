import { AppError, ErrorCode } from "@/lib/errors";

import type { WebProvider } from "./provider";

// Another service may get through where one hit its limit, timed out, or
// was blocked; a missing page or a bad URL is the same everywhere.
const final = new Set<string>([
	ErrorCode.NotFound,
	ErrorCode.InvalidArgument,
	ErrorCode.PermissionDenied,
]);

async function firstThatWorks<T>(
	providers: WebProvider[],
	operation: string,
	signal: AbortSignal,
	call: (provider: WebProvider) => Promise<T>,
): Promise<T> {
	let failure: unknown;
	for (const provider of providers) {
		try {
			return await call(provider);
		} catch (error) {
			// Only the run's own cancellation stops here; a provider timeout
			// is a failure like any other.
			if (signal.aborted) throw error;
			if (error instanceof AppError && final.has(error.code)) throw error;
			failure = error;
			console.warn("[Web] Provider failed", {
				provider: provider.name,
				operation,
				code: error instanceof AppError ? error.code : undefined,
				message: error instanceof Error ? error.message : undefined,
			});
		}
	}
	throw failure;
}

// The providers in order, each taking over when the previous one fails.
export function fallback(...providers: WebProvider[]): WebProvider {
	return {
		name: providers.map((provider) => provider.name).join("+"),
		search: (query, options, signal) =>
			firstThatWorks(providers, "search", signal, (provider) =>
				provider.search(query, options, signal),
			),
		fetch: (url, signal) =>
			firstThatWorks(providers, "fetch", signal, (provider) =>
				provider.fetch(url, signal),
			),
	};
}
