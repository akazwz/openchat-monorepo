import { create } from "@bufbuild/protobuf";
import { QueryObserver } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";

import {
	deleteAllMemories,
	deleteMemory,
} from "~/features/settings/memory-commands";
import { memoriesQuery } from "~/features/settings/queries";
import {
	ListMemoriesResponseSchema,
	MemorySchema,
} from "~/gen/heveta/v1/memory_pb";
import { queryClient } from "~/lib/query-client";
import { refreshQueries } from "~/lib/refresh-queries";
import { memoryClient } from "~/lib/rpc-client";

import { deferred } from "./deferred";
vi.mock("~/lib/rpc-client", () => ({
	memoryClient: {
		listMemories: vi.fn(),
		deleteMemory: vi.fn(),
		deleteAllMemories: vi.fn(),
	},
}));
const options = memoriesQuery("a");
const memory = (id: string) => create(MemorySchema, { id, content: id });
const response = (...ids: string[]) =>
	create(ListMemoriesResponseSchema, { memories: ids.map(memory) });
let unsubscribe: (() => void) | undefined;
afterEach(() => {
	unsubscribe?.();
	queryClient.clear();
	vi.resetAllMocks();
});
function observe() {
	const observer = new QueryObserver(queryClient, { ...options, retry: false });
	unsubscribe = observer.subscribe(() => {});
	return observer;
}

it("memory event during first load replaces the stale unfinished read", async () => {
	const old = deferred<ReturnType<typeof response>>();
	vi.mocked(memoryClient.listMemories)
		.mockReturnValueOnce(old.promise)
		.mockResolvedValueOnce(response("new"));
	observe();
	await refreshQueries(options.queryKey);
	old.resolve(response("old"));
	await Promise.resolve();
	expect(memoryClient.listMemories).toHaveBeenCalledTimes(2);
	expect(queryClient.getQueryData(options.queryKey)?.map((m) => m.id)).toEqual([
		"new",
	]);
});

it.each(["all", "one"])(
	"late %s deletion response cannot erase newer memory or resurrect deleted data",
	async (kind) => {
		const pending = deferred<never>();
		vi.mocked(memoryClient.deleteAllMemories).mockReturnValueOnce(
			pending.promise,
		);
		vi.mocked(memoryClient.deleteMemory).mockReturnValueOnce(pending.promise);
		vi.mocked(memoryClient.listMemories).mockResolvedValue(response("new"));
		observe();
		await vi.waitFor(() =>
			expect(queryClient.getQueryData(options.queryKey)).toBeDefined(),
		);
		const command =
			kind === "all" ? deleteAllMemories("a") : deleteMemory("a", "old");
		await refreshQueries(options.queryKey); // New memory arrives before delete response.
		pending.resolve(undefined as never);
		await command;
		expect(
			queryClient.getQueryData(options.queryKey)?.map((m) => m.id),
		).toEqual(["new"]);
	},
);
