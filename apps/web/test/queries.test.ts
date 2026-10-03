import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { InfiniteQueryObserver } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readSnapshot } from "~/features/runs/run-state";
import {
	applyRunChangeToList,
	messagesQuery,
	showRun,
	showThreadActivity,
	showThreadRun,
	threadQuery,
	threadsQuery,
	unlistThread,
	upsertThread,
} from "~/features/threads/queries";
import {
	PartChangeSchema,
	RunChangeSchema,
	RunSchema,
	RunSnapshotSchema,
} from "~/gen/heveta/v1/run_pb";
import { RunStatus } from "~/gen/heveta/v1/run_status_pb";
import {
	type GetThreadResponse,
	GetThreadResponseSchema,
	type ListMessagesResponse,
	ListMessagesResponseSchema,
	type ListThreadsResponse,
	ListThreadsResponseSchema,
	type Message,
	MessageRole,
	MessageSchema,
	type Thread,
	ThreadSchema,
} from "~/gen/heveta/v1/thread_pb";
import { queryClient } from "~/lib/query-client";
import { threadClient } from "~/lib/rpc-client";

vi.mock("~/lib/rpc-client", () => ({
	threadClient: {
		listThreads: vi.fn(),
		listMessages: vi.fn(),
		getThread: vi.fn(),
	},
}));
const listThreads = vi.mocked(threadClient.listThreads);
const getThread = vi.mocked(threadClient.getThread);
const listMessages = vi.mocked(threadClient.listMessages);

const userId = "user-1";
const threadId = "thread-1";
const thread = (n: number) =>
	create(ThreadSchema, { id: `thread-${String(n).padStart(2, "0")}` });
function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}
const threadIds = () =>
	queryClient
		.getQueryData(threadsQuery(userId).queryKey)
		?.pages.map((page) => page.items.map((item: Thread) => item.id));
const messageIds = () =>
	queryClient
		.getQueryData(messagesQuery(userId, threadId).queryKey)
		?.pages.map((page) => page.items.map((item: Message) => item.id));

beforeEach(() => queryClient.clear());
afterEach(() => vi.resetAllMocks());

describe("upsertThread", () => {
	it("uses the newest known version across list and detail caches", async () => {
		listThreads.mockResolvedValueOnce(
			create(ListThreadsResponseSchema, {
				threads: [
					create(ThreadSchema, { id: threadId, title: "Newest", revision: 4 }),
				],
			}),
		);
		await queryClient.fetchInfiniteQuery(threadsQuery(userId));
		upsertThread(
			userId,
			create(ThreadSchema, { id: threadId, title: "Old", revision: 2 }),
		);
		expect(
			queryClient.getQueryData(threadQuery(userId, threadId).queryKey)?.title,
		).toBe("Newest");
		queryClient.setQueryData(
			threadQuery(userId, threadId).queryKey,
			create(ThreadSchema, { id: threadId, title: "Even newer", revision: 5 }),
		);
		upsertThread(
			userId,
			create(ThreadSchema, { id: threadId, title: "Late", revision: 3 }),
		);
		expect(
			queryClient.getQueryData(threadsQuery(userId).queryKey)?.pages[0].items[0]
				.title,
		).toBe("Even newer");
	});

	it("keeps the newer title when an older event has later activity", async () => {
		listThreads.mockResolvedValueOnce(
			create(ListThreadsResponseSchema, { threads: [] }),
		);
		await queryClient.fetchInfiniteQuery(threadsQuery(userId));
		upsertThread(
			userId,
			create(ThreadSchema, {
				id: threadId,
				title: "New",
				revision: 3,
				activeTime: timestampFromMs(100),
				running: false,
			}),
		);
		upsertThread(
			userId,
			create(ThreadSchema, {
				id: threadId,
				title: "Old",
				revision: 2,
				activeTime: timestampFromMs(200),
				running: true,
			}),
		);
		for (const value of [
			queryClient.getQueryData(threadQuery(userId, threadId).queryKey),
			queryClient.getQueryData(threadsQuery(userId).queryKey)?.pages[0]
				.items[0],
		]) {
			expect(value).toMatchObject({
				title: "New",
				revision: 3,
				activeTime: timestampFromMs(200),
				running: true,
			});
		}
	});

	it("replays out-of-order title events over an older in-flight list response", async () => {
		const response = deferred<ListThreadsResponse>();
		listThreads.mockReturnValueOnce(response.promise);
		const reading = queryClient.fetchInfiniteQuery(threadsQuery(userId));
		upsertThread(
			userId,
			create(ThreadSchema, { id: threadId, title: "New", revision: 3 }),
		);
		upsertThread(
			userId,
			create(ThreadSchema, { id: threadId, title: "Old", revision: 2 }),
		);
		response.resolve(
			create(ListThreadsResponseSchema, {
				threads: [
					create(ThreadSchema, {
						id: threadId,
						title: "Original",
						revision: 1,
					}),
				],
			}),
		);
		await reading;
		expect(
			queryClient.getQueryData(threadsQuery(userId).queryKey)?.pages[0]
				.items[0],
		).toMatchObject({ title: "New", revision: 3 });
	});

	it("deletion dominates late records, activity and list responses after detail cache removal", async () => {
		const response = deferred<ListThreadsResponse>();
		listThreads.mockReturnValueOnce(response.promise);
		const reading = queryClient.fetchInfiniteQuery(threadsQuery(userId));
		const old = create(ThreadSchema, {
			id: threadId,
			title: "Deleted",
			revision: 3,
		});
		upsertThread(userId, old);
		unlistThread(userId, threadId);
		queryClient.removeQueries({
			queryKey: threadQuery(userId, threadId).queryKey,
		});
		upsertThread(userId, old);
		showThreadActivity(userId, threadId, timestampFromMs(200));
		response.resolve(create(ListThreadsResponseSchema, { threads: [old] }));
		await reading;
		expect(threadIds()).toEqual([[]]);
		expect(
			queryClient.getQueryData(threadQuery(userId, threadId).queryKey),
		).toBeUndefined();
		expect(getThread).not.toHaveBeenCalled();
		await expect(
			queryClient.fetchQuery(threadQuery(userId, threadId)),
		).rejects.toMatchObject({ code: 5 });
		// A new login/cache has no history from the previous login.
		queryClient.clear();
		upsertThread(userId, old);
		expect(
			queryClient.getQueryData(threadQuery(userId, threadId).queryKey)?.id,
		).toBe(threadId);
	});

	it("rejects a detail response that arrives after its deletion", async () => {
		const response = deferred<GetThreadResponse>();
		getThread.mockReturnValueOnce(response.promise);
		const reading = queryClient.fetchQuery(threadQuery(userId, threadId));
		unlistThread(userId, threadId);
		response.resolve(
			create(GetThreadResponseSchema, {
				thread: { id: threadId, revision: 1 },
			}),
		);
		await expect(reading).rejects.toMatchObject({ code: 5 });
		expect(
			queryClient.getQueryData(threadQuery(userId, threadId).queryKey),
		).toBeUndefined();
	});

	async function loadFirstPage() {
		listThreads.mockResolvedValueOnce(
			create(ListThreadsResponseSchema, {
				threads: [thread(9), thread(8)],
				nextPageToken: "page-2",
			}),
		);
		await queryClient.fetchInfiniteQuery(threadsQuery(userId));
	}

	it("lists a new conversation first", async () => {
		await loadFirstPage();
		upsertThread(userId, thread(10));
		expect(threadIds()).toEqual([["thread-10", "thread-09", "thread-08"]]);
	});

	it("updates a listed conversation in place", async () => {
		await loadFirstPage();
		upsertThread(userId, create(ThreadSchema, { id: "thread-08", title: "A" }));
		const data = queryClient.getQueryData(threadsQuery(userId).queryKey);
		expect(data?.pages[0].items.map((item) => item.title)).toEqual(["", "A"]);
	});

	it("leaves a conversation of a page not loaded yet to that page", async () => {
		await loadFirstPage();
		upsertThread(userId, thread(5));
		expect(threadIds()).toEqual([["thread-09", "thread-08"]]);
		listThreads.mockResolvedValueOnce(
			create(ListThreadsResponseSchema, {
				threads: [thread(7), thread(5)],
				nextPageToken: "",
			}),
		);
		await new InfiniteQueryObserver(
			queryClient,
			threadsQuery(userId),
		).fetchNextPage();
		expect(threadIds()).toEqual([
			["thread-09", "thread-08"],
			["thread-07", "thread-05"],
		]);
		// Everything is loaded: any conversation now has its place.
		upsertThread(userId, thread(1));
		upsertThread(userId, thread(6));
		expect(threadIds()).toEqual([
			["thread-09", "thread-08"],
			["thread-07", "thread-06", "thread-05", "thread-01"],
		]);
	});

	// Activity only grows: a newer turn moves a conversation up, and a record
	// read before it (a rename arriving late) changes its title, not its place.
	it("moves a conversation up by its activity, never back down", async () => {
		const at = (ms: number) => timestampFromMs(ms);
		listThreads.mockResolvedValueOnce(
			create(ListThreadsResponseSchema, {
				threads: [
					create(ThreadSchema, { id: "thread-09", activeTime: at(2000) }),
					create(ThreadSchema, { id: "thread-08", activeTime: at(1000) }),
				],
				nextPageToken: "page-2",
			}),
		);
		await queryClient.fetchInfiniteQuery(threadsQuery(userId));
		showThreadActivity(userId, "thread-08", at(3000));
		expect(threadIds()).toEqual([["thread-08", "thread-09"]]);
		upsertThread(
			userId,
			create(ThreadSchema, {
				id: "thread-08",
				title: "B",
				activeTime: at(1000),
			}),
		);
		const data = queryClient.getQueryData(threadsQuery(userId).queryKey);
		expect(data?.pages[0].items.map((item) => [item.id, item.title])).toEqual([
			["thread-08", "B"],
			["thread-09", ""],
		]);
		// The last listed one, with more not loaded, keeps its place.
		upsertThread(
			userId,
			create(ThreadSchema, {
				id: "thread-09",
				title: "C",
				activeTime: at(2000),
			}),
		);
		expect(threadIds()).toEqual([["thread-08", "thread-09"]]);
	});

	it("does not create the list", () => {
		upsertThread(userId, thread(1));
		expect(threadIds()).toBeUndefined();
	});

	// A read already under way when a conversation is deleted or renamed
	// elsewhere answers with it as it was.
	it("keeps changes that arrive while the list is read", async () => {
		await loadFirstPage();
		const response = deferred<ListThreadsResponse>();
		listThreads.mockReturnValueOnce(response.promise);
		const reading = queryClient.refetchQueries({
			queryKey: threadsQuery(userId).queryKey,
		});
		unlistThread(userId, "thread-08");
		upsertThread(userId, create(ThreadSchema, { id: "thread-09", title: "A" }));
		response.resolve(
			create(ListThreadsResponseSchema, {
				threads: [thread(9), thread(8)],
				nextPageToken: "page-2",
			}),
		);
		await reading;
		const data = queryClient.getQueryData(threadsQuery(userId).queryKey);
		expect(data?.pages[0].items.map((item) => [item.id, item.title])).toEqual([
			["thread-09", "A"],
		]);
	});
});

// Whether a reply is being written in a conversation (Thread.running) is known
// as of its activity, the time its latest run began: records, its activity,
// and every event of its runs say so, and may arrive in any order.
describe("showThreadRun", () => {
	const at = (ms: number) => timestampFromMs(ms);
	const run = (ms: number, status: RunStatus) =>
		create(RunSchema, {
			id: `run-${ms}`,
			threadId: "thread-08",
			createTime: at(ms),
			status,
		});
	const record = (id: string, ms: number, running = false) =>
		create(ThreadSchema, { id, activeTime: at(ms), running });
	const list = (...threads: Thread[]) =>
		create(ListThreadsResponseSchema, { threads, nextPageToken: "page-2" });
	const shown = () =>
		queryClient
			.getQueryData(threadsQuery(userId).queryKey)
			?.pages[0].items.map((item) => [item.id, item.running]);

	it("shows a reply until its run finishes, in any order", async () => {
		listThreads.mockResolvedValueOnce(
			list(record("thread-09", 2000), record("thread-08", 1000)),
		);
		await queryClient.fetchInfiniteQuery(threadsQuery(userId));
		showThreadActivity(userId, "thread-08", at(3000));
		expect(shown()).toEqual([
			["thread-08", true],
			["thread-09", false],
		]);
		// Its events while it runs change nothing, and write nothing.
		const writes = vi.fn();
		const unsubscribe = queryClient.getQueryCache().subscribe(writes);
		showThreadRun(userId, run(3000, RunStatus.RUNNING));
		unsubscribe();
		expect(writes).not.toHaveBeenCalled();
		showThreadRun(userId, run(3000, RunStatus.COMPLETED));
		expect(shown()).toEqual([
			["thread-08", false],
			["thread-09", false],
		]);
		// Finished, it stays finished: its activity, a record read before it
		// finished, and an earlier run's event arrive late.
		showThreadActivity(userId, "thread-08", at(3000));
		upsertThread(userId, record("thread-08", 3000, true));
		showThreadRun(userId, run(1000, RunStatus.RUNNING));
		expect(shown()).toEqual([
			["thread-08", false],
			["thread-09", false],
		]);
		// A later run's first event may come before its activity.
		showThreadRun(userId, run(4000, RunStatus.QUEUED));
		expect(shown()).toEqual([
			["thread-08", true],
			["thread-09", false],
		]);
	});

	// A conversation that begins a run while not listed is read, then listed;
	// its run may finish while that read is under way.
	it("lists a conversation read as its run ended meanwhile", async () => {
		listThreads.mockResolvedValueOnce(list(record("thread-09", 2000)));
		await queryClient.fetchInfiniteQuery(threadsQuery(userId));
		const response = deferred<GetThreadResponse>();
		getThread.mockReturnValueOnce(response.promise);
		showThreadActivity(userId, "thread-08", at(3000));
		showThreadRun(userId, run(3000, RunStatus.FAILED));
		response.resolve(
			create(GetThreadResponseSchema, {
				thread: record("thread-08", 3000, true),
			}),
		);
		await vi.waitFor(() =>
			expect(shown()).toEqual([
				["thread-08", false],
				["thread-09", false],
			]),
		);
	});

	it("keeps what runs did while the list is read", async () => {
		listThreads.mockResolvedValueOnce(
			list(record("thread-09", 2000), record("thread-08", 3000, true)),
		);
		await queryClient.fetchInfiniteQuery(threadsQuery(userId));
		// The run finishes, then another begins in the other conversation,
		// while a read that saw neither is under way.
		const response = deferred<ListThreadsResponse>();
		listThreads.mockReturnValueOnce(response.promise);
		const reading = queryClient.refetchQueries({
			queryKey: threadsQuery(userId).queryKey,
		});
		showThreadRun(userId, run(3000, RunStatus.FAILED));
		showThreadRun(
			userId,
			create(RunSchema, {
				id: "run-5000",
				threadId: "thread-09",
				createTime: at(5000),
				status: RunStatus.RUNNING,
			}),
		);
		response.resolve(
			list(record("thread-08", 3000, true), record("thread-09", 2000)),
		);
		await reading;
		expect(shown()).toEqual([
			["thread-09", true],
			["thread-08", false],
		]);
	});
});

// Turn `n`'s run at `attempt` and `revision`: its input "m<n>a" and its
// reply "m<n>b<attempt>", which sort in the order they were written.
function turnRun(n: number, attempt = 1, revision = 1, text = "") {
	const run = create(RunSchema, {
		id: `run-${n}-${attempt}`,
		threadId,
		turnId: `turn-${n}`,
		requestId: `request-${n}-${attempt}`,
		attempt,
		status: RunStatus.RUNNING,
	});
	return readSnapshot(
		create(RunSnapshotSchema, {
			run,
			revision,
			inputMessage: create(MessageSchema, {
				id: `m${n}a`,
				threadId,
				turnId: run.turnId,
				role: MessageRole.USER,
			}),
			outputMessage: create(MessageSchema, {
				id: `m${n}b${attempt}`,
				threadId,
				turnId: run.turnId,
				runId: run.id,
				role: MessageRole.ASSISTANT,
				parts: [{ id: "text", content: { case: "text", value: text } }],
			}),
		}),
	);
}
const listed = (...runs: ReturnType<typeof turnRun>[]) =>
	create(ListMessagesResponseSchema, {
		messages: runs.flatMap((run) => [run.inputMessage, run.outputMessage]),
		nextPageToken: "",
	});
const replyText = (id: string) =>
	queryClient
		.getQueryData(messagesQuery(userId, threadId).queryKey)
		?.pages.flatMap((page) => page.items)
		.find((item) => item.id === id)?.parts[0]?.content.value;

describe("showRun", () => {
	it("does not create a conversation's list", () => {
		showRun(userId, turnRun(1));
		expect(messageIds()).toBeUndefined();
	});

	// Events and responses arrive out of order: an older copy of a reply, or
	// an earlier attempt of a turn, never replaces what is shown.
	it("shows a run; a newer copy of its reply and a later attempt stay", async () => {
		listMessages.mockResolvedValueOnce(listed(turnRun(1, 1, 2, "new")));
		await queryClient.fetchInfiniteQuery(messagesQuery(userId, threadId));
		showRun(userId, turnRun(1, 1, 1, "old"));
		expect(replyText("m1b1")).toBe("new");
		// A regeneration replaces the attempt it retries.
		showRun(userId, turnRun(1, 2));
		expect(messageIds()).toEqual([["m1a", "m1b2"]]);
		showRun(userId, turnRun(1, 1, 3, "late"));
		expect(messageIds()).toEqual([["m1a", "m1b2"]]);
		showRun(userId, turnRun(2));
		expect(messageIds()).toEqual([["m1a", "m1b2", "m2a", "m2b1"]]);
	});

	it("applies runs that arrive while the list loads", async () => {
		const response = deferred<ListMessagesResponse>();
		listMessages.mockReturnValueOnce(response.promise);
		const loading = queryClient.fetchInfiniteQuery(
			messagesQuery(userId, threadId),
		);
		showRun(userId, turnRun(2));
		// Read before the run's messages were written.
		response.resolve(listed(turnRun(1)));
		await loading;
		expect(messageIds()).toEqual([["m1a", "m1b1", "m2a", "m2b1"]]);
		// Once applied, they are not applied again to a later read.
		listMessages.mockResolvedValueOnce(listed(turnRun(1)));
		await queryClient.refetchQueries({
			queryKey: messagesQuery(userId, threadId).queryKey,
		});
		expect(messageIds()).toEqual([["m1a", "m1b1"]]);
	});

	it("drops the runs of a read that was cancelled", async () => {
		const { queryKey } = messagesQuery(userId, threadId);
		listMessages.mockReturnValueOnce(deferred<ListMessagesResponse>().promise);
		const loading = queryClient
			.fetchInfiniteQuery(messagesQuery(userId, threadId))
			.catch(() => undefined);
		showRun(userId, turnRun(1, 1, 1, "partial"));
		await queryClient.cancelQueries({ queryKey });
		await loading;
		// A later read has the finished reply; the partial one stays dropped.
		listMessages.mockResolvedValueOnce(listed(turnRun(1, 1, 5, "done")));
		await queryClient.fetchInfiniteQuery(messagesQuery(userId, threadId));
		expect(replyText("m1b1")).toBe("done");
	});
});

describe("applyRunChangeToList", () => {
	const change = (revision: number, text: string) =>
		create(RunChangeSchema, {
			revision,
			run: turnRun(1).run,
			changes: [
				create(PartChangeSchema, {
					change: { case: "textDelta", value: { partId: "text", text } },
				}),
			],
		});

	it("applies to the reply, to a list being read, or asks for the run", async () => {
		expect(applyRunChangeToList(userId, change(2, "a"))).toBe("unloaded");
		const response = deferred<ListMessagesResponse>();
		listMessages.mockReturnValueOnce(response.promise);
		const loading = queryClient.fetchInfiniteQuery(
			messagesQuery(userId, threadId),
		);
		expect(applyRunChangeToList(userId, change(2, "b"))).toBe("applied");
		response.resolve(listed(turnRun(1, 1, 1, "a")));
		await loading;
		expect(replyText("m1b1")).toBe("ab");
		expect(applyRunChangeToList(userId, change(3, "c"))).toBe("applied");
		expect(replyText("m1b1")).toBe("abc");
		// A missed revision: the run's snapshot fills it in.
		expect(applyRunChangeToList(userId, change(5, "e"))).toBe("snapshot");
		expect(replyText("m1b1")).toBe("abc");
	});
});
