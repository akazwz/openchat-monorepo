import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { liveEventSession } from "@/modules/auth/session";
import { hubHeaders, UserHub } from "@/modules/events/hub";

vi.mock("@/modules/auth/session", () => ({ liveEventSession: vi.fn() }));

// The Workers runtime's socket pair and 101 response, which Node lacks.
class FakeSocket {
	sent: Uint8Array[] = [];
	closed?: { code: number; reason: string };
	send(frame: Uint8Array) {
		if (this.closed) throw new Error("Socket is closed");
		this.sent.push(frame);
	}
	close(code: number, reason: string) {
		this.closed = { code, reason };
	}
}
class UpgradeResponse {
	status: number;
	webSocket: FakeSocket | null;
	constructor(
		_body: unknown,
		init: { status: number; webSocket?: FakeSocket },
	) {
		this.status = init.status;
		this.webSocket = init.webSocket ?? null;
	}
}

function hub() {
	const values = new Map<string, unknown>();
	const storage = {
		list: async ({ prefix }: { prefix: string }) =>
			new Map([...values].filter(([key]) => key.startsWith(prefix))),
		put: async (key: string, value: unknown) => {
			values.set(key, value);
		},
		delete: async (keys: string[]) => {
			for (const key of keys) values.delete(key);
		},
		transaction: async <T>(fn: (txn: unknown) => Promise<T>) => fn(storage),
	};
	const sockets: { socket: FakeSocket; tags: string[] }[] = [];
	// The hub of the user "owner".
	const ctx = {
		blockConcurrencyWhile: vi.fn(<T>(fn: () => Promise<T>) => fn()),
		id: { equals: (other: unknown) => other === "hub:owner" },
		storage,
		setWebSocketAutoResponse: vi.fn(),
		acceptWebSocket: (socket: FakeSocket, tags: string[]) => {
			sockets.push({ socket, tags });
		},
		getWebSockets: (tag?: string) =>
			sockets
				.filter((entry) => !tag || entry.tags.includes(tag))
				.map((entry) => entry.socket),
	};
	return {
		hub: new UserHub(
			ctx as unknown as DurableObjectState,
			{
				USER_HUBS: { idFromName: (name: string) => `hub:${name}` },
			} as unknown as Env,
		),
		ctx,
		sockets,
		values,
	};
}

function upgrade(sessionId: string) {
	return new Request("https://hub.invalid/events", {
		headers: { Upgrade: "websocket", [hubHeaders.session]: sessionId },
	});
}

beforeEach(() => {
	vi.mocked(liveEventSession).mockResolvedValue(true);
	vi.useFakeTimers({ now: 1_000_000, toFake: ["Date"] });
	vi.stubGlobal(
		"WebSocketPair",
		class {
			0 = new FakeSocket();
			1 = new FakeSocket();
		},
	);
	vi.stubGlobal(
		"WebSocketRequestResponsePair",
		class {
			constructor(
				readonly request: string,
				readonly response: string,
			) {}
		},
	);
	vi.stubGlobal("Response", UpgradeResponse);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

test("each frame reaches every device in order; ending a session closes only its channels", async () => {
	const { hub: user, sockets } = hub();
	await user.fetch(upgrade("s1"));
	await user.fetch(upgrade("s1"));
	await user.fetch(upgrade("s2"));
	const [first, second] = [new Uint8Array([1]), new Uint8Array([2])];
	user.publish([first, second]);
	for (const { socket } of sockets)
		expect(socket.sent).toEqual([first, second]);
	user.closeSession("s1");
	expect(sockets.map(({ socket }) => socket.closed?.code)).toEqual([
		4401,
		4401,
		undefined,
	]);
	// A closed channel is skipped; the others still get later frames.
	user.publish([first]);
	expect(sockets[2].socket.sent).toHaveLength(3);
});

test("an upgrade admitted by the Worker before sign-out is refused by the Hub afterwards", async () => {
	const { hub: user, ctx, sockets } = hub();
	await user.fetch(upgrade("s1"));
	user.closeSession("s1");
	vi.mocked(liveEventSession).mockResolvedValue(false);
	expect((await user.fetch(upgrade("s1"))).status).toBe(401);
	expect(ctx.blockConcurrencyWhile).toHaveBeenCalledTimes(2);
	user.publish([new Uint8Array([1])]);
	expect(sockets).toHaveLength(1);
	expect(sockets[0].socket.sent).toHaveLength(0);
});

test("a failed database check refuses admission without breaking existing channels", async () => {
	const { hub: user, sockets } = hub();
	await user.fetch(upgrade("s1"));
	vi.mocked(liveEventSession).mockRejectedValueOnce(
		new Error("database unavailable"),
	);
	expect((await user.fetch(upgrade("s2"))).status).toBe(503);
	user.publish([new Uint8Array([1])]);
	expect(sockets).toHaveLength(1);
	expect(sockets[0].socket.sent).toHaveLength(1);
});
