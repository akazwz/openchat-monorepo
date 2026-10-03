import type { MutationStatus } from "@tanstack/react-query";

// Choose the latest intent first, then decide whether it is still pending.
// Filtering to pending first resurrects an older intent when a newer one ends.
export function latestPending<T>(
	mutations: readonly { variables: T; status: MutationStatus }[],
	identity: (variables: T) => string,
): T[] {
	const latest = new Map<string, (typeof mutations)[number]>();
	for (const mutation of mutations) {
		if (mutation.status !== "idle")
			latest.set(identity(mutation.variables), mutation);
	}
	return [...latest.values()].flatMap((mutation) =>
		mutation.status === "pending" ? [mutation.variables] : [],
	);
}
