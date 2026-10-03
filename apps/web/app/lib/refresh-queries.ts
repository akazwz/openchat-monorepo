import { focusManager, type QueryKey } from "@tanstack/react-query";

import { queryClient } from "./query-client";

// An invalidation event means even an unfinished first read may be stale.
// Cancel it before invalidating: React Query otherwise joins that first read.
// Inactive queries stay stale until mounted; active queries read current data,
// except, while the page is not on screen, those whose read wakes the user's
// computer (`meta.wakesComputer`): a background tab would keep it from
// sleeping. They read when the page is on screen again (their
// refetchOnWindowFocus).
export async function refreshQueries(queryKey: QueryKey) {
	await queryClient.cancelQueries({ queryKey });
	await queryClient.invalidateQueries({ queryKey, refetchType: "none" });
	// React Query's own view of whether the page is on screen, which its
	// refetchOnWindowFocus follows.
	const hidden = !focusManager.isFocused();
	await queryClient.refetchQueries({
		queryKey,
		type: "active",
		predicate: (query) => !(hidden && query.meta?.wakesComputer === true),
	});
}
