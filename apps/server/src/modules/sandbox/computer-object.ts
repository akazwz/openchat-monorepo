import { DurableObject } from "cloudflare:workers";
import { and, inArray } from "drizzle-orm";

import { createDatabase } from "@/db/client";
import { runs } from "@/db/schema/runs";
import { errorDetails } from "@/lib/error-details";
import { closeSocket, upgradeRequest } from "@/lib/websocket";
import { announce, userEvents } from "@/modules/events/publish";
import { RunStatus } from "@/modules/runs/types";

import { idleTimeoutMs, type ExecOptions } from "./computer";
import { type ConnectionKind, connectionHeaders } from "./connections";
import type { Filesystem } from "./filesystem";
import { computerOwner } from "./machine";
import { NativeMachine, fallbackTimeoutMs } from "./native-machine";
import { Workspace } from "./workspace";

// Port of the VNC WebSocket inside the container (sandbox/screen.sh), which
// asks for the screen token in its URL.
const screenPort = 6080;
// Our idle alarm state, independent of any old SDK schedules.
const idleDeadlineKey = "computer-idle-deadline";

// A user's computer (docs/sandbox.md): our native Durable Object owns its
// container lifecycle, workspace, and viewing connections. The Worker calls
// these methods on its stub (machine.ts).
export class Computer extends DurableObject<Env> {
	readonly #machine = new NativeMachine(this.ctx.container!, {
		activity: () => this.#activity(),
		started: () => {
			this.#workspace.started();
			this.#screenToken = undefined;
		},
		stopped: async () => {
			this.#screenToken = undefined;
			await this.#workspace.stopped();
		},
		currentSnapshot: () => this.#workspace.currentSnapshot(),
		resumedSnapshot: (id, expiresAt) =>
			this.#workspace.resumedSnapshot(id, expiresAt),
	});
	readonly #workspace = new Workspace(this, this.ctx.storage, {
		running: () => this.ctx.container?.running === true,
		stop: async () => {
			if (this.#machine.pending || this.#connections.size)
				return false as const;
			await this.destroy();
		},
		activeRuns,
		changed: () => {
			const owner = computerOwner(this.ctx.id.name);
			if (owner) void announce(owner, [userEvents.computer()]);
		},
	});
	// People's open connections (screen, terminal) by session, from the
	// moment they are accepted: each ends itself (see #connect).
	#connections = new Map<string, Set<(code: number, reason: string) => void>>();
	// The screen's token (sandbox/screen.sh): websockify serves only a viewer
	// that presents it, and this object adds it to each viewer's connection
	// it relays, so a web page in the computer's own browser that connects to
	// localhost:6080 cannot. One per container, made when its screen is first
	// started here and dropped when a container starts or stops; after this
	// object restarts, the next start of the screen makes another, which
	// replaces the old one in the container.
	#screenToken: string | undefined;
	// A start of the screen in progress, which other callers wait for.
	#screen: Promise<string | undefined> | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		if (ctx.container?.running)
			void ctx.blockConcurrencyWhile(async () => {
				// Leave an existing instance intact until its R2 metadata has
				// been migrated; the migration RPC must remain callable.
				if ((await this.#workspace.migrateSnapshots()).ids.length) return;
				await ctx.container!.setInactivityTimeout(fallbackTimeoutMs);
				await this.#machine.ensureRunning();
				const due =
					(await ctx.storage.get<number>(idleDeadlineKey)) ??
					Date.now() + idleTimeoutMs;
				await ctx.storage.put(idleDeadlineKey, due);
				await ctx.storage.setAlarm(Math.max(due, Date.now() + 1000));
			});
	}

	async #activity() {
		const due = Date.now() + idleTimeoutMs;
		await this.ctx.storage.put(idleDeadlineKey, due);
		await this.ctx.storage.setAlarm(due);
	}

	override async alarm() {
		const due = await this.ctx.storage.get<number>(idleDeadlineKey);
		if (due === undefined) return;
		if (!this.ctx.container?.running) {
			await this.ctx.storage.delete(idleDeadlineKey);
			return;
		}
		if (due > Date.now()) {
			await this.ctx.storage.setAlarm(due);
			return;
		}
		if (this.#machine.pending || this.#connections.size) {
			await this.ctx.storage.setAlarm(Date.now() + 60_000);
			return;
		}
		// Saving makes native calls, which move the deadline. Recheck in the
		// stop operation so a request arriving during that save keeps it awake.
		const result = await this.#workspace.sleep();
		if (result !== "stopped")
			await this.ctx.storage.setAlarm(Date.now() + 60_000);
	}

	exec(command: string, options?: ExecOptions) {
		return this.#machine.exec(command, options);
	}
	startProcess(
		command: string,
		options: { processId: string; cwd: string; env: Record<string, string> },
	) {
		return this.#machine.startProcess(command, options);
	}
	getProcess(id: string) {
		return this.#machine.getProcess(id);
	}
	waitForExit(id: string) {
		return this.#machine.waitForExit(id);
	}
	killProcess(id: string) {
		return this.#machine.killProcess(id);
	}
	readTextFile(path: string) {
		return this.#machine.readFile(path, { encoding: "utf-8" });
	}
	readFile(path: string) {
		return this.#machine.readFile(path, { encoding: "none" });
	}

	listFiles(path: string) {
		return this.#machine.listFiles(path);
	}
	exists(path: string) {
		return this.#machine.exists(path);
	}
	mkdir(path: string, options: { recursive: true }) {
		return this.#machine.mkdir(path, options);
	}
	writeFile(path: string, content: string | ReadableStream<Uint8Array>) {
		return this.#machine.writeFile(path, content);
	}
	containerFetch(request: Request, port: number): Promise<Response>;
	containerFetch(
		url: string,
		init: { method: string; headers: Record<string, string>; body?: string },
		port: number,
	): Promise<Response>;
	containerFetch(
		request: Request | string,
		initOrPort:
			| number
			| { method: string; headers: Record<string, string>; body?: string },
		port?: number,
	) {
		return typeof initOrPort === "number"
			? this.#machine.containerFetch(request as Request, initOrPort)
			: this.#machine.containerFetch(new Request(request, initOrPort), port!);
	}
	createSnapshot() {
		return this.#machine.createSnapshot();
	}
	restoreSnapshotFilesystem(snapshot: { id: string }) {
		return this.#machine.restoreSnapshot(snapshot);
	}
	async destroy() {
		await this.#machine.destroy();
		await this.ctx.storage.delete(idleDeadlineKey);
		await this.ctx.storage.deleteAlarm();
	}

	// Before any use (see Workspace.ready): the container's generation, for
	// save(). A container just started also starts its screen, without
	// holding up the call that woke it: commands do not need the screen, and
	// what does waits for it (a viewer's connection here, the browser through
	// heveta-browser).
	async ready(runId?: string) {
		await this.#activity();
		const { generation, restored } = await this.#workspace.ready(runId);
		if (restored) void this.#startScreen();
		return generation;
	}

	save(generation: number) {
		return this.#workspace.save(generation);
	}

	release(runId: string) {
		return this.#workspace.release(runId);
	}

	snapshots() {
		return this.#workspace.snapshots();
	}

	migrateSnapshots(records?: Record<string, Filesystem | null>) {
		return this.#workspace.migrateSnapshots(records);
	}

	restart(discardUnsaved: boolean) {
		return this.#workspace.restart(discardUnsaved);
	}

	restoreSnapshot(snapshotId: string, discardUnsaved: boolean) {
		return this.#workspace.restore(snapshotId, discardUnsaved);
	}

	clearWorkspace(discardUnsaved: boolean) {
		return this.#workspace.clear(discardUnsaved);
	}

	// The screen, started where it is not working (heveta-screen), with this
	// container's token: the token, or undefined when the screen did not
	// start. Commands do not need it, so a screen that will not start is
	// logged, not an error.
	#startScreen() {
		this.#screen ??= (async () => {
			const started = Date.now();
			let outcome = "error";
			try {
				const token = (this.#screenToken ??= screenToken());
				const result = await this.exec("heveta-screen", {
					env: { SCREEN_TOKEN: token },
				});
				outcome = result.success ? "ok" : "failed";
				if (result.success) return token;
				console.warn("[Sandbox] Screen did not start", {
					exitCode: result.exitCode,
					stderr: result.stderr.slice(0, 500),
				});
				return undefined;
			} catch (error) {
				console.warn("[Sandbox] Screen did not start", errorDetails(error));
				return undefined;
			} finally {
				this.#screen = undefined;
				console.log("[Computer] Call", {
					method: "startScreen",
					outcome,
					totalMs: Date.now() - started,
				});
			}
		})();
		return this.#screen;
	}

	// A connection the Worker admitted (connections.ts); every other request
	// is rejected.
	override async fetch(request: Request) {
		const kind = request.headers.get(connectionHeaders.kind);
		const sessionId = request.headers.get(connectionHeaders.session);
		if (!kind || !sessionId || !["screen", "terminal"].includes(kind))
			return new Response("Not found", { status: 404 });
		return this.#connect(
			// Strip the Worker's admission headers before forwarding.
			upgradeRequest(request, {}),
			kind as ConnectionKind,
			sessionId,
		);
	}

	// Closes an ended session's connections, those still waiting for the
	// computer included.
	closeConnections(sessionId: string) {
		for (const end of this.#connections.get(sessionId) ?? [])
			end(4401, "Session ended");
	}

	// A connection to the computer's screen or a shell, accepted at once: the
	// computer may take minutes to wake, and a device that gives up meanwhile
	// (its page hidden, the panel closed) closes its end, which ends the
	// connection here too. Accepting only once the computer answered left a
	// connection nobody would ever close, keeping the computer awake. Once
	// awake, messages pass both ways until either end closes; what the device
	// sent meanwhile goes first. A subprotocol the device asks for is agreed
	// here, before the computer is reached, and only that one is asked of it.
	#connect(request: Request, kind: ConnectionKind, sessionId: string) {
		const accepted = Date.now();
		// When messages began to pass: how long the device waited for the
		// computer, logged when the connection ends.
		let relaying: number | undefined;
		const { 0: client, 1: device } = new WebSocketPair();
		device.accept();
		// Binary frames (VNC, the terminal's output) pass through as bytes; the
		// default Blob would not.
		device.binaryType = "arraybuffer";
		const [protocol] = (request.headers.get("Sec-WebSocket-Protocol") ?? "")
			.split(",")
			.map((name) => name.trim())
			.filter(Boolean);
		const open = this.#connections.get(sessionId) ?? new Set();
		this.#connections.set(sessionId, open);
		let container: WebSocket | undefined;
		let generation: number | undefined;
		const waiting: (string | ArrayBuffer)[] = [];
		let ended = false;
		const end = (code: number, reason: string) => {
			if (ended) return;
			ended = true;
			open.delete(end);
			if (!open.size) this.#connections.delete(sessionId);
			closeSocket(device, code, reason);
			if (container) closeSocket(container, code, reason);
			console.log("[Computer] Call", {
				method: "connect",
				kind,
				outcome: relaying === undefined ? "not connected" : "closed",
				code,
				reason,
				totalMs: Date.now() - accepted,
				waitMs: (relaying ?? Date.now()) - accepted,
			});
			// What the person changed there is saved when they leave, as the
			// agent's changes are after each call.
			if (generation !== undefined) void this.#saveLogged(generation);
		};
		open.add(end);
		device.addEventListener("message", (event) => {
			if (!container) waiting.push(event.data);
			else relay(container, event.data);
		});
		device.addEventListener("close", (event) => end(event.code, event.reason));
		device.addEventListener("error", () => end(1011, "Relay failed"));
		const relay = (to: WebSocket, data: string | ArrayBuffer) => {
			try {
				to.send(data);
			} catch {
				end(1011, "Relay failed");
			}
		};
		void (async () => {
			try {
				generation = await this.ready();
				if (ended) return;
				const token = kind === "screen" ? await this.#startScreen() : "";
				if (token === undefined) return end(1011, "The screen did not start");
				if (ended) return;
				const upstreamRequest = upgradeRequest(
					kind === "screen"
						? new Request(
								`http://localhost:${screenPort}/?${new URLSearchParams({ token })}`,
								request,
							)
						: request,
					{},
				);
				if (protocol)
					upstreamRequest.headers.set("Sec-WebSocket-Protocol", protocol);
				else upstreamRequest.headers.delete("Sec-WebSocket-Protocol");
				const upstream =
					kind === "screen"
						? await this.containerFetch(upstreamRequest, screenPort)
						: await this.#terminal(upstreamRequest);
				const socket = upstream.webSocket;
				if (!socket) return end(1011, "The computer refused the connection");
				socket.accept();
				socket.binaryType = "arraybuffer";
				if (ended) return closeSocket(socket, 1000, "Closed");
				container = socket;
				relaying = Date.now();
				socket.addEventListener("message", (event) =>
					relay(device, event.data),
				);
				socket.addEventListener("close", (event) =>
					end(event.code, event.reason),
				);
				socket.addEventListener("error", () => end(1011, "Relay failed"));
				for (const data of waiting.splice(0)) relay(socket, data);
			} catch (error) {
				console.warn("[Sandbox] Computer unavailable", errorDetails(error));
				end(1011, "The computer is unavailable");
			}
		})();
		const headers = new Headers();
		if (protocol) headers.set("Sec-WebSocket-Protocol", protocol);
		return new Response(null, { status: 101, webSocket: client, headers });
	}

	#terminal(request: Request) {
		return this.#machine.terminal(request);
	}

	// A failed save keeps the changes waiting, and settings show it (see
	// Workspace.save).
	async #saveLogged(generation: number) {
		try {
			await this.#workspace.save(generation);
		} catch (error) {
			console.warn("[Sandbox] Workspace not saved", {
				...errorDetails(error),
			});
		}
	}
}

// A screen token: 32 random bytes, in hex.
function screenToken() {
	return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

async function activeRuns(runIds: string[]) {
	const database = createDatabase();
	try {
		const active = await database.db
			.select({ id: runs.id })
			.from(runs)
			.where(
				and(
					inArray(runs.id, runIds),
					inArray(runs.status, [RunStatus.QUEUED, RunStatus.RUNNING]),
				),
			);
		return active.map((run) => run.id);
	} finally {
		await database.close();
	}
}
