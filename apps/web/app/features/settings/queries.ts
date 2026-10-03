import { queryOptions } from "@tanstack/react-query";

import { memoryClient } from "~/lib/rpc-client";

// What the agent remembers about the user. Apart from the memory section,
// since the thread controller marks it stale on the `memory` event and
// importing the section put its whole page in the signed-in layout.
export const memoriesQuery = (userId: string) =>
	queryOptions({
		queryKey: ["users", userId, "memories"],
		queryFn: async ({ signal }) =>
			(await memoryClient.listMemories({}, { signal })).memories,
		enabled: Boolean(userId),
		// The agent may have changed them since the section was last open.
		refetchOnMount: "always",
	});
