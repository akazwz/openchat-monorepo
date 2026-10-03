import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { useAuthStore } from "~/features/auth/store";
import { readSnapshot } from "~/features/runs/run-state";
import { ThreadDrafts, type TurnCommand } from "~/features/threads/drafts";
import { ThreadSubmissions } from "~/features/threads/submissions";
import { startTurn } from "~/features/turns/turn-api";
import { UserSchema } from "~/gen/heveta/v1/auth_pb";
import { ReasoningEffort } from "~/gen/heveta/v1/model_pb";
import { RunSchema, RunSnapshotSchema } from "~/gen/heveta/v1/run_pb";
import { RunStatus } from "~/gen/heveta/v1/run_status_pb";
import { MessageRole, MessageSchema } from "~/gen/heveta/v1/thread_pb";
import { queryClient } from "~/lib/query-client";

vi.mock("~/lib/rpc-client", () => ({}));
vi.mock("~/features/turns/turn-api", () => ({
	startTurn: vi.fn(),
	retryTurn: vi.fn(),
}));
vi.mock("~/features/runs/run-api", () => ({ cancelRun: vi.fn() }));

const threadId = "thread-1";
const owner = { userId: "user-1", sessionVersion: 1 };
const message: TurnCommand = {
	kind: "start",
	text: "hello",
	files: [],
	modelId: "",
	reasoningEffort: ReasoningEffort.UNSPECIFIED,
};
const snapshotOf = (requestId: string) =>
	readSnapshot(
		create(RunSnapshotSchema, {
			run: create(RunSchema, {
				id: "run-1",
				threadId,
				turnId: "turn-1",
				requestId,
				attempt: 1,
				status: RunStatus.RUNNING,
			}),
			revision: 1,
			inputMessage: create(MessageSchema, {
				id: "message-1",
				threadId,
				turnId: "turn-1",
				role: MessageRole.USER,
			}),
			outputMessage: create(MessageSchema, {
				id: "message-2",
				threadId,
				turnId: "turn-1",
				runId: "run-1",
				role: MessageRole.ASSISTANT,
			}),
		}),
	);
const settled = () => new Promise((resolve) => setTimeout(resolve));

function sending() {
	const drafts = new ThreadDrafts();
	const events = {
		accepted: vi.fn(),
		updated: vi.fn(),
		created: vi.fn(),
		error: vi.fn(),
		failed: vi.fn(),
	};
	const submissions = new ThreadSubmissions(drafts, events);
	const draft = drafts.get(owner, threadId);
	submissions.start(draft, message);
	const requestId = draft.submission?.requestId ?? "";
	return { draft, events, submissions, snapshot: snapshotOf(requestId) };
}

beforeEach(() => {
	queryClient.clear();
	useAuthStore.setState({
		user: create(UserSchema, { id: owner.userId }),
		sessionVersion: owner.sessionVersion,
	});
});
afterEach(() => vi.resetAllMocks());

// The event channel usually delivers the run before StartTurn's response:
// the sent message must give way to the server's copy then, not show twice
// until the response.
it("a run's event confirms the message that started it; the late response changes nothing", async () => {
	let respond!: (value: Awaited<ReturnType<typeof startTurn>>) => void;
	vi.mocked(startTurn).mockReturnValue(
		new Promise((resolve) => {
			respond = resolve;
		}),
	);
	const { draft, events, submissions, snapshot } = sending();
	await settled();
	submissions.acknowledge(owner, snapshot);
	expect(draft.submission).toBeUndefined();
	expect(events.accepted).toHaveBeenCalledWith(owner, snapshot);
	respond({ snapshot });
	await settled();
	expect(draft.submission).toBeUndefined();
	expect(draft.message).toBe("");
	expect(events.error).not.toHaveBeenCalled();
});

// A send whose outcome is unknown (the connection dropped) is sent again with
// the same request ID, which the server takes once; meanwhile its run's
// event confirms it, and another request's run confirms nothing.
it("a send whose outcome is unknown goes out again as the same request until its run confirms it", async () => {
	vi.useFakeTimers();
	try {
		const lost = new ConnectError("offline", Code.Unavailable);
		vi.mocked(startTurn).mockRejectedValue(lost);
		const { draft, submissions, snapshot } = sending();
		await vi.advanceTimersByTimeAsync(0);
		expect(draft.submission?.phase).toBe("sending");
		expect(startTurn).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1000);
		expect(startTurn).toHaveBeenCalledTimes(2);
		// Reconnecting sends it at once.
		submissions.resendAll(owner);
		await vi.advanceTimersByTimeAsync(0);
		expect(startTurn).toHaveBeenCalledTimes(3);
		const requestIds = vi
			.mocked(startTurn)
			.mock.calls.map(([input]) => input.requestId);
		expect(new Set(requestIds)).toEqual(new Set([snapshot.run.requestId]));
		submissions.acknowledge(owner, snapshotOf("another-request"));
		expect(draft.submission?.phase).toBe("sending");
		submissions.acknowledge(owner, snapshot);
		expect(draft.submission).toBeUndefined();
		// Nothing is sent again once it is confirmed.
		await vi.advanceTimersByTimeAsync(60_000);
		expect(startTurn).toHaveBeenCalledTimes(3);
	} finally {
		vi.useRealTimers();
	}
});
