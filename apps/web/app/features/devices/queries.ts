import { queryOptions } from "@tanstack/react-query";

import { deviceClient } from "~/lib/rpc-client";
export const devicesQuery = (userId: string) =>
	queryOptions({
		queryKey: ["users", userId, "devices"],
		queryFn: async ({ signal }) =>
			(await deviceClient.listDevices({}, { signal })).devices,
		enabled: Boolean(userId),
		refetchOnMount: "always",
	});
