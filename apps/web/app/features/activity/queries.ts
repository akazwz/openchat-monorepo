import { queryOptions } from "@tanstack/react-query";

import { scheduleClient } from "~/lib/rpc-client";

// The agent's schedules. The agent makes and deletes them in conversations,
// and each moves on when it runs, so the page reads them whenever it opens
// or its window is looked at again.
export const schedulesQuery = (userId: string) =>
	queryOptions({
		queryKey: ["users", userId, "schedules"],
		queryFn: async ({ signal }) =>
			(await scheduleClient.listSchedules({}, { signal })).schedules,
		enabled: Boolean(userId),
		refetchOnMount: "always",
		refetchOnWindowFocus: "always",
	});
