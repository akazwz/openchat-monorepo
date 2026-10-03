import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { liveEventSession } from "@/modules/auth/session";
import { DeviceConnection, deviceHeaders } from "@/modules/devices/connection";
import { liveDeviceCredential } from "@/modules/devices/credentials";
import { deviceJobLifetimeMs } from "@/modules/devices/protocol";

vi.mock("@/modules/devices/credentials", () => ({
	liveDeviceCredential: vi.fn(),
}));
vi.mock("@/modules/auth/session", () => ({ liveEventSession: vi.fn() }));
vi.mock("@/modules/events/publish", () => ({
	announce: vi.fn(),
	userEvents: { devices: () => ({}) },
}));

class Socket {
	readyState = 1;
	sent: string[] = [];
	attachment: unknown;
	send(text: string) {
		this.sent.push(text);
	}
	close() {
		this.readyState = 3;
	}
	serializeAttachment(value: unknown) {
		this.attachment = structuredClone(value);
	}
	deserializeAttachment() {
		return structuredClone(this.attachment);
	}
}
const RealResponse = Response;
beforeEach(() => {
	vi.mocked(liveDeviceCredential).mockResolvedValue("owner");
	vi.mocked(liveEventSession).mockResolvedValue(true);
	vi.stubGlobal("WebSocket", { OPEN: 1, CLOSING: 2, CLOSED: 3 });
	vi.stubGlobal("WebSocketRequestResponsePair", class {});
	vi.stubGlobal(
		"WebSocketPair",
		class {
			0 = new Socket();
			1 = new Socket();
		},
	);
	vi.stubGlobal(
		"Response",
		class {
			constructor(
				body: BodyInit | null,
				init: ResponseInit & { webSocket?: unknown },
			) {
				if (init.status !== 101) return new RealResponse(body, init);
			}
		},
	);
});
afterEach(() => vi.unstubAllGlobals());
function setup() {
	const values = new Map<string, unknown>();
	const sockets: { socket: Socket; tags: string[] }[] = [];
	let gate = Promise.resolve();
	const ctx = {
		id: { name: "mac" },
		setWebSocketAutoResponse: vi.fn(),
		blockConcurrencyWhile: <T>(work: () => Promise<T>) => {
			const next = gate.then(work);
			gate = next.then(
				() => {},
				() => {},
			);
			return next;
		},
		storage: {
			get: async (key: string) => structuredClone(values.get(key)),
			put: async (key: string, value: unknown) => {
				values.set(key, structuredClone(value));
			},
			delete: async (key: string) => values.delete(key),
			setAlarm: vi.fn(),
			list: async ({ prefix }: { prefix: string }) =>
				new Map(
					[...values]
						.filter(([key]) => key.startsWith(prefix))
						.map(([key, value]) => [key, structuredClone(value)]),
				),
		},
		acceptWebSocket: (socket: Socket, tags: string[]) =>
			sockets.push({ socket, tags }),
		getWebSockets: (tag?: string) =>
			sockets
				.filter(
					({ socket, tags }) =>
						socket.readyState === 1 && (!tag || tags.includes(tag)),
				)
				.map(({ socket }) => socket),
	};
	const broker = new DeviceConnection(
		ctx as unknown as DurableObjectState,
		{} as Env,
	);
	return { broker, sockets, values, ctx };
}
async function host(broker: DeviceConnection) {
	return broker.fetch(
		new Request("https://app.invalid/device/connect", {
			headers: {
				Upgrade: "websocket",
				[deviceHeaders.id]: "mac",
				[deviceHeaders.user]: "owner",
				[deviceHeaders.role]: "host",
				[deviceHeaders.credential]: "hash",
			},
		}),
	);
}
const command = {
	id: "run:call",
	method: "shell",
	arguments: { command: "echo once", cwd: ".", timeout_seconds: 3 },
};

test("transport recovery collects the same job without executing it twice", async () => {
	const { broker, sockets } = setup();
	await host(broker);
	await broker.dispatch(JSON.stringify(command));
	await broker.dispatch(JSON.stringify(command));
	expect(
		sockets[0].socket.sent.filter(
			(message) => JSON.parse(message).type === "execute",
		),
	).toHaveLength(1);
	await host(broker);
	const current = sockets[1].socket;
	await broker.webSocketMessage(
		current as unknown as WebSocket,
		JSON.stringify({
			type: "status",
			screenAllowed: false,
			inputAllowed: false,
		}),
	);
	expect(current.sent.map((message) => JSON.parse(message).type)).toEqual([
		"hello",
		"collect",
	]);
	await broker.webSocketMessage(
		current as unknown as WebSocket,
		JSON.stringify({
			type: "result",
			id: command.id,
			result: { ok: true, value: { output: "once" } },
		}),
	);
	expect(JSON.parse(await broker.collect(command.id)).result.value.output).toBe(
		"once",
	);
	await expect(
		broker.dispatch(
			JSON.stringify({ ...command, arguments: { command: "different" } }),
		),
	).rejects.toThrow("different input");
});
test("cancellation persists while offline and resumes as cancellation", async () => {
	const { broker, sockets } = setup();
	await host(broker);
	await broker.dispatch(JSON.stringify(command));
	sockets[0].socket.close();
	await broker.cancelRun("run");
	await host(broker);
	await broker.webSocketMessage(
		sockets[1].socket as unknown as WebSocket,
		JSON.stringify({ type: "status" }),
	);
	expect(
		sockets[1].socket.sent.map((message) => JSON.parse(message).type),
	).toEqual(["hello", "cancel"]);
	expect(JSON.parse(await broker.job(command.id)).cancelled).toBe(true);
});
test("revoked credentials are refused inside the admission gate", async () => {
	const { broker, sockets } = setup();
	vi.mocked(liveDeviceCredential).mockResolvedValue(undefined);
	expect((await host(broker)).status).toBe(401);
	expect(sockets).toHaveLength(0);
});
test("offline unfinished jobs time out rather than remaining pending forever", async () => {
	const { broker, sockets, values } = setup();
	await host(broker);
	await broker.dispatch(JSON.stringify(command));
	sockets[0].socket.close();
	const job = JSON.parse(await broker.job(command.id));
	job.createdAt = Date.now() - deviceJobLifetimeMs - 1;
	values.set(`job:${command.id}`, job);
	await broker.alarm();
	expect(JSON.parse(await broker.job(command.id)).result.unknown).toBe(true);
});
test("only one person controls a device while observers remain allowed", async () => {
	const { broker, sockets } = setup();
	await host(broker);
	await broker.webSocketMessage(
		sockets[0].socket as unknown as WebSocket,
		JSON.stringify({ type: "status", screenAllowed: true, inputAllowed: true }),
	);
	const reservation = {
		id: "first",
		userId: "owner",
		browserSessionId: "browser",
		control: true,
		iceServers: [],
		expiresAt: Date.now() + 30_000,
	};
	expect(await broker.createRemoteSession(reservation)).toBeUndefined();
	expect(
		await broker.createRemoteSession({ ...reservation, id: "second" }),
	).toBe("controlled");
	expect(
		await broker.createRemoteSession({
			...reservation,
			id: "observer",
			control: false,
		}),
	).toBeUndefined();
});

test("simultaneous delivery persists and sends one native command", async () => {
	const { broker, sockets } = setup();
	await host(broker);
	await Promise.all([
		broker.dispatch(JSON.stringify(command)),
		broker.dispatch(JSON.stringify(command)),
	]);
	expect(
		sockets[0].socket.sent.filter(
			(message) => JSON.parse(message).type === "execute",
		),
	).toHaveLength(1);
});

test("explicit local shutdown ends pending calls without waiting for reconnection", async () => {
	const { broker, sockets } = setup();
	await host(broker);
	await broker.dispatch(JSON.stringify(command));
	await broker.webSocketMessage(
		sockets[0].socket as unknown as WebSocket,
		JSON.stringify({ type: "disabled" }),
	);
	const job = JSON.parse(await broker.job(command.id));
	expect(job.cancelled).toBe(true);
	expect(job.result).toMatchObject({ ok: false, unknown: true });
	expect(job.result.error).toContain("disabled");
	expect(broker.status().online).toBe(false);
	await host(broker);
	await broker.dispatch(JSON.stringify(command));
	expect(
		sockets[1].socket.sent.some(
			(message) => JSON.parse(message).type === "execute",
		),
	).toBe(false);
});
