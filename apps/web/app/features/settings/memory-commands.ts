import { refreshQueries } from "~/lib/refresh-queries";
import { memoryClient } from "~/lib/rpc-client";

import { memoriesQuery } from "./queries";

// Delete responses have no versioned snapshot. Keep optimistic deletions in
// mutation state, and reconcile from a fresh read before settling the command.
export async function deleteMemory(userId: string, memoryId: string) {
	await memoryClient.deleteMemory({ memoryId });
	await refreshQueries(memoriesQuery(userId).queryKey);
}

export async function deleteAllMemories(userId: string) {
	await memoryClient.deleteAllMemories({});
	await refreshQueries(memoriesQuery(userId).queryKey);
}
