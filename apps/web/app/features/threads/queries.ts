import { create } from "@bufbuild/protobuf";
import { type Timestamp, timestampMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import {
	type InfiniteData,
	infiniteQueryOptions,
	type QueryKey,
	queryOptions,
} from "@tanstack/react-query";

import {
	applyRunChange,
	isActiveRun,
	type RunSnapshot,
	SnapshotRequired,
} from "~/features/runs/run-state";
import type { Message, Thread } from "~/features/threads/types";
import type { Run, RunChange } from "~/gen/heveta/v1/run_pb";
import { MessageRole, ThreadSchema } from "~/gen/heveta/v1/thread_pb";
import { queryClient } from "~/lib/query-client";
import { threadClient } from "~/lib/rpc-client";

interface Page<T> {
	items: T[];
	nextPageToken: string;
}
type ThreadsData = InfiniteData<Page<Thread>, string>;
// Deleted IDs never come back. Keep these alongside this account's cache
// until sign-out/clear, including when a detail query is removed or GC'd.
const deletedThreadsKey = (userId: string) => [
	"users",
	userId,
	"deletedThreads",
];
const isDeletedThread = (userId: string, threadId: string) =>
	queryClient
		.getQueryData<readonly string[]>(deletedThreadsKey(userId))
		?.includes(threadId) ?? false;
export const threadsQuery = (userId: string) =>
	infiniteQueryOptions({
		queryKey: ["users", userId, "threads"],
		initialPageParam: "",
		queryFn: async ({ signal, pageParam }): Promise<Page<Thread>> => {
			const res = await threadClient.listThreads(
				{ pageSize: 50, pageToken: pageParam },
				{ signal },
			);
			return {
				items: res.threads.filter(
					(thread) => !isDeletedThread(userId, thread.id),
				),
				nextPageToken: res.nextPageToken,
			};
		},
		getNextPageParam: (page) => page.nextPageToken || undefined,
		enabled: Boolean(userId),
	});
// One conversation's record (its title). A conversation the send flow just
// created is seeded here, so its page never waits for this request.
export const threadQuery = (userId: string, threadId: string) =>
	queryOptions({
		queryKey: ["users", userId, "thread", threadId],
		queryFn: async ({ signal }): Promise<Thread> => {
			if (isDeletedThread(userId, threadId))
				throw new ConnectError("Thread deleted", Code.NotFound);
			const { thread } = await threadClient.getThread({ threadId }, { signal });
			if (isDeletedThread(userId, threadId))
				throw new ConnectError("Thread deleted", Code.NotFound);
			if (!thread) throw new Error("Thread response is missing");
			return thread;
		},
		enabled: Boolean(userId && threadId),
	});
export const messagesQuery = (userId: string, threadId: string) =>
	infiniteQueryOptions({
		queryKey: ["users", userId, "messages", threadId],
		initialPageParam: "",
		queryFn: async ({ signal, pageParam }): Promise<Page<Message>> => {
			const res = await threadClient.listMessages(
				{ threadId, pageSize: 50, pageToken: pageParam },
				{ signal },
			);
			return { items: res.messages, nextPageToken: res.nextPageToken };
		},
		getNextPageParam: (page) => page.nextPageToken || undefined,
		enabled: Boolean(userId && threadId),
	});
// A tool result whole, for one whose output its listed message left out
// (ToolResult.output_omitted). A result never changes once made.
export const toolResultQuery = (
	userId: string,
	messageId: string,
	toolCallId: string,
) =>
	queryOptions({
		queryKey: ["users", userId, "toolResult", messageId, toolCallId],
		queryFn: async ({ signal }) => {
			const { result } = await threadClient.getToolResult(
				{ messageId, toolCallId },
				{ signal },
			);
			if (!result) throw new Error("Tool result response is missing");
			return result;
		},
		staleTime: Number.POSITIVE_INFINITY,
	});
// Puts an item a paged list lacks into the loaded page it belongs to. The
// server reads the list in `paging` order, each page starting after the
// previous one's last item (its cursor), so an item belongs to the first page
// holding one that comes after it, or to the last page once there is no next
// one. An item after every loaded page arrives with the page that has not
// been read yet; inserting it now would list it twice once that page loads.
function insertIntoPages<T extends { id: string }>(
	pages: Page<T>[],
	item: T,
	order: (a: T, b: T) => number,
	paging: (a: T, b: T) => number = newestFirst,
): Page<T>[] {
	const index = pages.findIndex(
		(page) =>
			!page.nextPageToken ||
			page.items.some((other) => paging(item, other) < 0),
	);
	return index === -1
		? pages
		: pages.map((page, i) =>
				i === index
					? { ...page, items: [...page.items, item].sort(order) }
					: page,
			);
}
const newestFirst = (a: { id: string }, b: { id: string }) =>
	a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
const oldestFirst = (a: { id: string }, b: { id: string }) =>
	-newestFirst(a, b);
// Conversations, as the server lists them: the most recently active first.
const activeAt = (thread: Thread) =>
	thread.activeTime ? timestampMs(thread.activeTime) : 0;
const mostActiveFirst = (a: Thread, b: Thread) =>
	activeAt(b) - activeAt(a) || newestFirst(a, b);

// Changes that arrived while a query was being read: the response may be
// older than they are, so they apply again on top of it. Each merge compares
// versions/activity; arrival order need not match commit order.
const arrivedWhileFetching = new Map<string, ((data: unknown) => unknown)[]>();
queryClient.getQueryCache().subscribe((event) => {
	const hash = event.query.queryHash;
	const updates = arrivedWhileFetching.get(hash);
	if (!updates) return;
	if (event.type === "removed") arrivedWhileFetching.delete(hash);
	if (event.type !== "updated") return;
	const { action } = event;
	// `manual` is setQueryData's own write, not the response.
	if (action.type === "success" && !action.manual) {
		arrivedWhileFetching.delete(hash);
		queryClient.setQueryData(event.query.queryKey, (data: unknown) =>
			updates.reduce((next, update) => update(next), data),
		);
	} else if (event.query.state.fetchStatus !== "fetching")
		// The read failed or was cancelled: no response to correct. A cancelled
		// read reverts to the data these changes were already written to.
		arrivedWhileFetching.delete(hash);
});
// Writes a change from an event into a query, and again into its response if
// it is being read. A change that leaves the data as it is (the same object)
// writes nothing, so nothing reading it renders again: a run's events come at
// every commit of its reply, and each would have redrawn the side nav.
function applyChange<T>(
	queryKey: QueryKey,
	update: (data: T | undefined) => T | undefined,
) {
	const query = queryClient.getQueryCache().find({ queryKey, exact: true });
	if (query?.state.fetchStatus === "fetching")
		arrivedWhileFetching.set(query.queryHash, [
			...(arrivedWhileFetching.get(query.queryHash) ?? []),
			update as (data: unknown) => unknown,
		]);
	const known = queryClient.getQueryData<T>(queryKey);
	const next = update(known);
	if (next !== known) queryClient.setQueryData<T>(queryKey, next);
}

// A conversation's record from the server: its page and its side nav row,
// at its place by its activity. The later of its known activity and the
// record's is kept (`latestActivity`): a record read before a newer turn (a
// rename, a generated title) must not move it back down, nor show a reply
// being written after its run was seen to finish.
export function upsertThread(userId: string, thread: Thread) {
	if (isDeletedThread(userId, thread.id)) return;
	// The detail and list may have been read at different times. Preserve
	// the newest record either knows, then apply it to both projections.
	const detail = queryClient.getQueryData(
		threadQuery(userId, thread.id).queryKey,
	);
	const listed = queryClient
		.getQueryData(threadsQuery(userId).queryKey)
		?.pages.flatMap((page) => page.items)
		.find((item) => item.id === thread.id);
	if (detail) thread = latestActivity(thread, detail);
	if (listed) thread = latestActivity(thread, listed);
	applyChange<Thread>(threadQuery(userId, thread.id).queryKey, (known) =>
		isDeletedThread(userId, thread.id)
			? known
			: known
				? latestActivity(thread, known)
				: thread,
	);
	applyChange<ThreadsData>(threadsQuery(userId).queryKey, (data) => {
		if (!data || isDeletedThread(userId, thread.id)) return data;
		const known = data.pages
			.flatMap((page) => page.items)
			.find((item) => item.id === thread.id);
		return placeThread(data, known ? latestActivity(thread, known) : thread);
	});
}
// A run began in a conversation (another device's, or this one's): it moves
// up, and a reply is being written in it. One not in the list yet is read, and
// placed as it is, unless `readUnlisted` is off (a conversation this device
// just started is placed with its record).
export function showThreadActivity(
	userId: string,
	threadId: string,
	time: Timestamp,
	readUnlisted = true,
) {
	showRunAt(userId, threadId, time, true, readUnlisted);
}
// A run's state, from any of its events: whether a reply is still being
// written in its conversation. An earlier run's says nothing new; a later
// one's moves the conversation up as its activity would.
export function showThreadRun(userId: string, run: Run) {
	if (run.createTime)
		showRunAt(userId, run.threadId, run.createTime, isActiveRun(run), false);
}
function showRunAt(
	userId: string,
	threadId: string,
	time: Timestamp,
	running: boolean,
	readUnlisted: boolean,
) {
	if (isDeletedThread(userId, threadId)) return;
	let listed = false;
	// The conversation as this says it is now, or the same object when that is
	// what is known already.
	const moved = (thread: Thread) => {
		const next = latestActivity(
			create(ThreadSchema, { ...thread, activeTime: time, running }),
			thread,
		);
		return activeAt(next) === activeAt(thread) &&
			next.running === thread.running
			? thread
			: next;
	};
	applyChange<Thread>(threadQuery(userId, threadId).queryKey, (known) =>
		known ? moved(known) : known,
	);
	applyChange<ThreadsData>(threadsQuery(userId).queryKey, (data) => {
		const known = data?.pages
			.flatMap((page) => page.items)
			.find((item) => item.id === threadId);
		listed = Boolean(known);
		if (!data || !known) return data;
		const next = moved(known);
		return next === known ? data : placeThread(data, next);
	});
	if (
		readUnlisted &&
		!listed &&
		queryClient.getQueryData(threadsQuery(userId).queryKey)
	)
		void queryClient
			.fetchQuery(threadQuery(userId, threadId))
			.then(() => {
				// As the cache has it, not as the response did: events that came
				// during the read (its run finishing) were applied again on top
				// of the response there (applyChange), and the response alone
				// could list the conversation with a reply long finished.
				const thread = queryClient.getQueryData(
					threadQuery(userId, threadId).queryKey,
				);
				if (thread) upsertThread(userId, thread);
			})
			.catch(() => {});
}
// Two copies of a conversation, the incoming one's record with the later
// activity of the two, and whether a reply is being written as of it
// (Thread.running): each copy's says so as of its own activity, the time its
// latest run began. The later time is the later state; at the same time both
// speak of the same run, which only finishes once, so a copy that saw it
// finish wins over one read before.
function latestActivity(thread: Thread, known: Thread) {
	// Title and activity change independently. A later activity must not
	// make an older title authoritative, nor vice versa.
	if (thread.revision < known.revision)
		thread = create(ThreadSchema, {
			...thread,
			title: known.title,
			revision: known.revision,
		});
	const incoming = activeAt(thread);
	const current = activeAt(known);
	if (incoming > current) return thread;
	const running =
		incoming < current ? known.running : thread.running && known.running;
	return incoming === current && running === thread.running
		? thread
		: create(ThreadSchema, {
				...thread,
				activeTime: known.activeTime,
				running,
			});
}
// Takes a conversation out of the pages and puts it back at its place. One
// listed never moves down (its activity only grows), so when no loaded page
// holds anything after it, it stays in the page it was in.
function placeThread(data: ThreadsData, thread: Thread): ThreadsData {
	const listedIn = data.pages.findIndex((page) =>
		page.items.some((item) => item.id === thread.id),
	);
	const pages = data.pages.map((page) => ({
		...page,
		items: page.items.filter((item) => item.id !== thread.id),
	}));
	const placed = insertIntoPages(
		pages,
		thread,
		mostActiveFirst,
		mostActiveFirst,
	);
	return {
		...data,
		pages:
			placed === pages && listedIn !== -1
				? pages.map((page, index) =>
						index === listedIn
							? {
									...page,
									items: [...page.items, thread].sort(mostActiveFirst),
								}
							: page,
					)
				: placed,
	};
}
// A deleted conversation leaves the side nav.
export function unlistThread(userId: string, threadId: string) {
	const key = deletedThreadsKey(userId);
	queryClient.setQueryDefaults(key, { gcTime: Infinity });
	queryClient.setQueryData<readonly string[]>(key, (ids = []) =>
		ids.includes(threadId) ? ids : [...ids, threadId],
	);
	applyChange<ThreadsData>(threadsQuery(userId).queryKey, (data) =>
		data
			? {
					...data,
					pages: data.pages.map((page) => ({
						...page,
						items: page.items.filter((item) => item.id !== threadId),
					})),
				}
			: data,
	);
}
// A conversation deleted elsewhere also leaves a page showing it, which reads
// it again and finds it gone.
export function removeThread(userId: string, threadId: string) {
	unlistThread(userId, threadId);
	void queryClient.invalidateQueries({
		queryKey: threadQuery(userId, threadId).queryKey,
	});
	void queryClient.invalidateQueries({
		queryKey: messagesQuery(userId, threadId).queryKey,
	});
}
type MessagesData = InfiniteData<Page<Message>, string>;

// A conversation that holds only the given messages, as one just created by
// its first turn: its list is complete without reading it.
export function seedMessages(
	userId: string,
	threadId: string,
	items: Message[],
) {
	queryClient.setQueryData<MessagesData>(
		messagesQuery(userId, threadId).queryKey,
		{ pages: [{ items, nextPageToken: "" }], pageParams: [""] },
	);
}

// The reply the list shows for a turn: its latest attempt's.
const shownReply = (items: Message[], turnId: string) =>
	items.find(
		(item) => item.role === MessageRole.ASSISTANT && item.turnId === turnId,
	);

// A run's messages in a conversation's list: its input, if missing, and its
// reply, which replaces the turn's earlier attempt (a regeneration) and an
// older copy of itself. A later attempt already shown, or a newer copy of the
// reply, stays: events and responses can arrive out of order.
function placeRun(data: MessagesData, snapshot: RunSnapshot): MessagesData {
	const { run, inputMessage, outputMessage, revision } = snapshot;
	const shown = shownReply(
		data.pages.flatMap((page) => page.items),
		run.turnId,
	);
	if (
		shown &&
		(shown.runAttempt > run.attempt ||
			(shown.runId === run.id && shown.runRevision >= revision))
	)
		return data;
	let pages = data.pages.map((page) => ({
		...page,
		items: page.items.filter((item) => item !== shown),
	}));
	for (const item of [inputMessage, outputMessage])
		if (!pages.some((page) => page.items.some(({ id }) => id === item.id)))
			pages = insertIntoPages(pages, item, oldestFirst);
	return { ...data, pages };
}

// Shows a run in its conversation's list. A list that is not loaded yet
// reads it when it is: creating it here would hold only this run, and the
// fresh copy would keep the conversation's history from ever being read.
export function showRun(userId: string, snapshot: RunSnapshot) {
	applyChange<MessagesData>(
		messagesQuery(userId, snapshot.run.threadId).queryKey,
		(data) => data && placeRun(data, snapshot),
	);
}

// A run's change applied to its reply in the list, when it follows it.
function changeReply(data: MessagesData, change: RunChange): MessagesData {
	const reply = data.pages
		.flatMap((page) => page.items)
		.find((item) => item.runId === change.run?.id);
	if (!reply) return data;
	let next: Message;
	try {
		next = applyRunChange(reply, change);
	} catch (error) {
		if (error instanceof SnapshotRequired) return data;
		throw error;
	}
	return next === reply
		? data
		: {
				...data,
				pages: data.pages.map((page) => ({
					...page,
					items: page.items.map((item) => (item === reply ? next : item)),
				})),
			};
}

// Applies a run's change to its conversation's list. "unloaded": nobody shows
// the conversation, which is read when opened; "snapshot": the list lacks the
// reply or the change does not follow it, and the run's snapshot fills it in.
export function applyRunChangeToList(
	userId: string,
	change: RunChange,
): "applied" | "unloaded" | "snapshot" {
	const run = change.run;
	if (!run) return "snapshot";
	const { queryKey } = messagesQuery(userId, run.threadId);
	const query = queryClient.getQueryCache().find({ queryKey, exact: true });
	const data = query?.state.data as MessagesData | undefined;
	if (data) {
		const items = data.pages.flatMap((page) => page.items);
		const reply = items.find((item) => item.runId === run.id);
		if (!reply)
			// A later attempt shown makes this one's change moot.
			return (shownReply(items, run.turnId)?.runAttempt ?? 0) > run.attempt
				? "applied"
				: "snapshot";
		try {
			applyRunChange(reply, change);
		} catch (error) {
			if (error instanceof SnapshotRequired) return "snapshot";
			throw error;
		}
	} else if (query?.state.fetchStatus !== "fetching") return "unloaded";
	// Being read for the first time: it applies to the response.
	applyChange<MessagesData>(queryKey, (current) =>
		current ? changeReply(current, change) : current,
	);
	return "applied";
}

// A run's reply as the conversation's list has it.
export function listedReply(userId: string, threadId: string, runId: string) {
	return queryClient
		.getQueryData<MessagesData>(messagesQuery(userId, threadId).queryKey)
		?.pages.flatMap((page) => page.items)
		.find((item) => item.runId === runId);
}
