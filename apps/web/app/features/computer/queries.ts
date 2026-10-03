import { queryOptions } from "@tanstack/react-query";

import { computerClient } from "~/lib/rpc-client";

// What is on the user's computer: its workspace's files, size, and
// snapshots. They share a prefix, so the event that the workspace changed
// (a save, a restored snapshot; docs/sync.md) marks them all stale at once.
export const computerKey = (userId: string) => ["users", userId, "computer"];

// Reading the files or the size wakes the computer, so a page not on screen
// leaves them stale and reads them when it is again (refreshQueries).
const wakesComputer = {
	meta: { wakesComputer: true },
	refetchOnWindowFocus: (query: { state: { isInvalidated: boolean } }) =>
		query.state.isInvalidated,
} as const;

// Opened again, a folder is read again: it may have changed since.
export const computerFilesQuery = (userId: string, path: string) =>
	queryOptions({
		queryKey: [...computerKey(userId), "files", path],
		queryFn: ({ signal }) =>
			computerClient.listComputerFiles({ path }, { signal }),
		enabled: Boolean(userId),
		refetchOnMount: "always",
		...wakesComputer,
	});
export const workspaceUsageQuery = (userId: string) =>
	queryOptions({
		queryKey: [...computerKey(userId), "usage"],
		queryFn: ({ signal }) => computerClient.getWorkspaceUsage({}, { signal }),
		enabled: Boolean(userId),
		...wakesComputer,
	});
export const workspaceSnapshotsQuery = (userId: string) =>
	queryOptions({
		queryKey: [...computerKey(userId), "snapshots"],
		queryFn: ({ signal }) =>
			computerClient.listWorkspaceSnapshots({}, { signal }),
		enabled: Boolean(userId),
	});
