import { DurableObject } from "cloudflare:workers";

import { sha256 } from "@/lib/hash";
import { closeSocket } from "@/lib/websocket";
import { liveEventSession } from "@/modules/auth/session";
import { announce, userEvents } from "@/modules/events/publish";

import { liveDeviceCredential } from "./credentials";
import {
	deviceJobLifetimeMs,
	deviceMessageBytes,
	deviceProtocolVersion,
	object,
	validCommandId,
	type DeviceCommand,
	type DeviceJob,
	type DeviceResult,
	type DeviceStatus,
	type RemoteDesktopRefusal,
	type RemoteDesktopSession,
} from "./protocol";

export const deviceHeaders = {
	id: "x-heveta-device",
	user: "x-heveta-owner",
	role: "x-heveta-role",
	credential: "x-heveta-device-hash",
	session: "x-heveta-browser-session",
};
type SocketIdentity =
	| {
			role: "host";
			userId: string;
			tokenHash: string;
			screenAllowed: boolean;
			inputAllowed: boolean;
	  }
	| { role: "viewer"; session: RemoteDesktopSession };

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (object(value))
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
}

// One broker per device. Jobs and cancellations survive DO restarts;
// sockets use hibernation and the native process owns actual execution.
export class DeviceConnection extends DurableObject<Env> {
	private waiters = new Map<string, Set<() => void>>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair("ping", "pong"),
		);
	}

	private host() {
		return this.ctx
			.getWebSockets("host")
			.find((socket) => socket.readyState === WebSocket.OPEN);
	}
	status(): DeviceStatus {
		const host = this.host();
		const identity = host?.deserializeAttachment() as
			| SocketIdentity
			| undefined;
		return {
			online: Boolean(host),
			screenAllowed: identity?.role === "host" && identity.screenAllowed,
			inputAllowed: identity?.role === "host" && identity.inputAllowed,
		};
	}
	private notify(id: string) {
		for (const wake of this.waiters.get(id) ?? []) wake();
		this.waiters.delete(id);
	}
	private sendHost(message: unknown) {
		const host = this.host();
		if (!host) return false;
		try {
			host.send(JSON.stringify(message));
			return true;
		} catch {
			return false;
		}
	}
	private async changed(userId: string) {
		await announce(userId, [userEvents.devices()]);
	}

	override async fetch(request: Request): Promise<Response> {
		const id = request.headers.get(deviceHeaders.id);
		const userId = request.headers.get(deviceHeaders.user);
		const role = request.headers.get(deviceHeaders.role);
		if (
			request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
			!id ||
			id !== this.ctx.id.name ||
			!userId
		)
			return new Response("Invalid device handshake", { status: 400 });
		return this.ctx.blockConcurrencyWhile(async () => {
			let identity: SocketIdentity;
			let tags: string[];
			if (role === "host") {
				const tokenHash = request.headers.get(deviceHeaders.credential) ?? "";
				if ((await liveDeviceCredential(id, tokenHash)) !== userId)
					return new Response("Device access revoked", { status: 401 });
				for (const previous of this.ctx.getWebSockets("host"))
					closeSocket(previous, 4000, "Connection replaced");
				identity = {
					role: "host",
					userId,
					tokenHash,
					screenAllowed: false,
					inputAllowed: false,
				};
				tags = ["host"];
			} else if (role === "viewer") {
				const sessionId =
					new URL(request.url).searchParams.get("session") ?? "";
				const session = await this.ctx.storage.get<RemoteDesktopSession>(
					`remote:${sessionId}`,
				);
				if (
					!session ||
					session.userId !== userId ||
					session.browserSessionId !==
						request.headers.get(deviceHeaders.session) ||
					session.expiresAt <= Date.now() ||
					!(await liveEventSession(session.browserSessionId))
				)
					return new Response("Remote session expired", { status: 401 });
				if (!this.status().online || !this.status().screenAllowed)
					return new Response("Screen capture is unavailable", { status: 409 });
				if (this.ctx.getWebSockets("viewer").length >= 8)
					return new Response("Too many viewers", { status: 429 });
				if (this.ctx.getWebSockets(sessionId).length)
					return new Response("Remote session already connected", {
						status: 409,
					});
				session.expiresAt = Date.now() + 7_000_000;
				await this.ctx.storage.put(`remote:${session.id}`, session);
				identity = { role: "viewer", session };
				tags = ["viewer", sessionId, session.browserSessionId];
			} else return new Response("Unknown device role", { status: 400 });
			const { 0: client, 1: server } = new WebSocketPair();
			server.serializeAttachment(identity);
			this.ctx.acceptWebSocket(server, tags);
			await this.ctx.storage.setAlarm(Date.now() + 60_000);
			if (identity.role === "viewer") {
				server.send(
					JSON.stringify({ type: "ready", version: deviceProtocolVersion }),
				);
				this.sendHost({
					type: "remote_start",
					sessionId: identity.session.id,
					control: identity.session.control,
					iceServers: identity.session.iceServers,
				});
			} else {
				server.send(
					JSON.stringify({ type: "hello", version: deviceProtocolVersion }),
				);
				// A replaced transport cannot keep a stale media/control session.
				for (const viewer of this.ctx.getWebSockets("viewer"))
					closeSocket(viewer, 4000, "Device reconnected");
			}
			return new Response(null, { status: 101, webSocket: client });
		});
	}

	async dispatch(encoded: string) {
		const command = JSON.parse(encoded) as DeviceCommand;
		if (
			!validCommandId(command.id) ||
			new TextEncoder().encode(JSON.stringify(command)).length >
				deviceMessageBytes
		)
			throw new Error("Invalid device command");
		const hash = await sha256(canonical([command.method, command.arguments]));
		return this.ctx.blockConcurrencyWhile(async () => {
			const key = `job:${command.id}`;
			let job = await this.ctx.storage.get<DeviceJob>(key);
			if (job) {
				if (job.hash !== hash)
					throw new Error("Device command ID reused with different input");
				return JSON.stringify(job ?? null);
			}
			if (!this.host()) throw new Error("Device is offline");
			job = { command, hash, createdAt: Date.now(), cancelled: false };
			await this.ctx.storage.put(key, job);
			await this.ctx.storage.setAlarm(Date.now() + 60_000);
			// Once persisted, a lost send has an unknown outcome. Resume asks the
			// native journal about this ID; it never turns an absent result into a new call.
			this.sendHost({ type: "execute", ...command });
			return JSON.stringify(job ?? null);
		});
	}
	private async getJob(id: string) {
		return this.ctx.storage.get<DeviceJob>(`job:${id}`);
	}
	async job(id: string) {
		return JSON.stringify((await this.getJob(id)) ?? null);
	}
	async waitJob(id: string) {
		const job = await this.getJob(id);
		if (!job || job.result) return JSON.stringify(job ?? null);
		await new Promise<void>((resolve) => {
			let timer: ReturnType<typeof setTimeout>;
			const wake = () => {
				clearTimeout(timer);
				this.waiters.get(id)?.delete(wake);
				resolve();
			};
			timer = setTimeout(wake, 20_000);
			const set = this.waiters.get(id) ?? new Set();
			set.add(wake);
			this.waiters.set(id, set);
		});
		return JSON.stringify((await this.getJob(id)) ?? null);
	}
	async collect(id: string) {
		const job = await this.getJob(id);
		if (job && !job.result) this.sendHost({ type: "collect", id });
		return JSON.stringify(job ?? null);
	}
	async cancel(id: string) {
		const job = await this.getJob(id);
		if (!job || job.result) return;
		job.cancelled = true;
		await this.ctx.storage.put(`job:${id}`, job);
		this.sendHost({ type: "cancel", id });
		this.notify(id);
	}

	async cancelRun(runId: string) {
		for (const job of (
			await this.ctx.storage.list<DeviceJob>({ prefix: `job:${runId}:` })
		).values())
			await this.cancel(job.command.id);
	}

	// Reserves a session for a viewer about to connect, or says why not.
	async createRemoteSession(
		session: RemoteDesktopSession,
	): Promise<RemoteDesktopRefusal | undefined> {
		return this.ctx.blockConcurrencyWhile(async () => {
			const state = this.status();
			if (!state.online) return "offline";
			if (!state.screenAllowed) return "screen";
			if (session.control && !state.inputAllowed) return "input";
			const sessions = await this.ctx.storage.list<RemoteDesktopSession>({
				prefix: "remote:",
			});
			for (const [key, existing] of sessions) {
				if (existing.expiresAt <= Date.now())
					await this.ctx.storage.delete(key);
				else if (session.control && existing.control) return "controlled";
			}
			await this.ctx.storage.put(`remote:${session.id}`, session);
			return undefined;
		});
	}
	async closeBrowserSession(sessionId: string) {
		for (const socket of this.ctx.getWebSockets(sessionId)) {
			const identity = socket.deserializeAttachment() as SocketIdentity;
			if (identity.role === "viewer") await this.endRemote(identity.session.id);
			closeSocket(socket, 4401, "Session ended");
		}
	}
	private async endRemote(id: string) {
		await this.ctx.storage.delete(`remote:${id}`);
		this.sendHost({ type: "remote_stop", sessionId: id });
	}
	async revoke() {
		this.sendHost({ type: "revoked" });
		await this.disconnect("Device access revoked");
	}
	private async disconnect(reason: string) {
		for (const socket of this.ctx.getWebSockets())
			closeSocket(socket, 4401, reason);
		for (const [key, job] of await this.ctx.storage.list<DeviceJob>({
			prefix: "job:",
		})) {
			if (!job.result) {
				job.cancelled = true;
				job.result = {
					ok: false,
					error: `${reason}; execution outcome is unknown`,
					unknown: true,
				};
				await this.ctx.storage.put(key, job);
				this.notify(job.command.id);
			}
		}
		for (const key of (
			await this.ctx.storage.list({ prefix: "remote:" })
		).keys())
			await this.ctx.storage.delete(key);
	}

	override async webSocketMessage(
		socket: WebSocket,
		message: string | ArrayBuffer,
	) {
		if (
			typeof message !== "string" ||
			new TextEncoder().encode(message).length > deviceMessageBytes
		) {
			closeSocket(socket, 1009, "Message too large");
			return;
		}
		let data: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(message);
			if (!object(parsed)) throw new Error();
			data = parsed;
		} catch {
			closeSocket(socket, 1007, "Invalid device message");
			return;
		}
		const identity = socket.deserializeAttachment() as SocketIdentity;
		if (identity.role === "host") {
			if (socket !== this.host()) return;
			if (data.type === "disabled") {
				await this.disconnect("Device access disabled");
				await this.changed(identity.userId);
			} else if (data.type === "status") {
				identity.screenAllowed = data.screenAllowed === true;
				identity.inputAllowed = data.inputAllowed === true;
				socket.serializeAttachment(identity);
				for (const viewer of this.ctx.getWebSockets("viewer")) {
					const remote = (
						viewer.deserializeAttachment() as Extract<
							SocketIdentity,
							{ role: "viewer" }
						>
					).session;
					if (
						!identity.screenAllowed ||
						(remote.control && !identity.inputAllowed)
					) {
						await this.endRemote(remote.id);
						closeSocket(viewer, 4000, "Permission changed");
					}
				}
				const pending = await this.ctx.storage.list<DeviceJob>({
					prefix: "job:",
				});
				for (const job of pending.values())
					if (!job.result)
						this.sendHost({
							type: job.cancelled ? "cancel" : "collect",
							id: job.command.id,
						});
				await this.changed(identity.userId);
			} else if (
				data.type === "result" &&
				validCommandId(data.id) &&
				object(data.result)
			) {
				const job = await this.getJob(data.id);
				if (!job || job.result) return;
				const result = data.result;
				if (
					!(result.ok === true && object(result.value)) &&
					!(result.ok === false && typeof result.error === "string")
				)
					return;
				job.result = result as unknown as DeviceResult;
				await this.ctx.storage.put(`job:${data.id}`, job);
				this.notify(data.id);
			} else if (data.type === "signal" && typeof data.sessionId === "string") {
				for (const viewer of this.ctx.getWebSockets(data.sessionId))
					viewer.send(message);
			} else if (
				data.type === "remote_error" &&
				typeof data.sessionId === "string"
			) {
				for (const viewer of this.ctx.getWebSockets(data.sessionId)) {
					viewer.send(message);
					closeSocket(viewer, 4000, "Remote desktop unavailable");
				}
				await this.endRemote(data.sessionId);
			}
		} else {
			if (!(await liveEventSession(identity.session.browserSessionId))) {
				await this.endRemote(identity.session.id);
				closeSocket(socket, 4401, "Session ended");
				return;
			}
			if (data.type === "signal" && object(data.signal))
				this.sendHost({
					type: "signal",
					sessionId: identity.session.id,
					signal: data.signal,
				});
		}
	}
	override async webSocketClose(
		socket: WebSocket,
		code: number,
		reason: string,
	) {
		const identity = socket.deserializeAttachment() as SocketIdentity;
		closeSocket(socket, code, reason);
		if (identity.role === "viewer") await this.endRemote(identity.session.id);
		else if (!this.host()) {
			for (const viewer of this.ctx.getWebSockets("viewer"))
				closeSocket(viewer, 4000, "Device disconnected");
			await this.changed(identity.userId);
			for (const id of this.waiters.keys()) this.notify(id);
		}
	}
	override async webSocketError(socket: WebSocket) {
		await this.webSocketClose(socket, 1011, "Connection failed");
	}
	override async alarm() {
		for (const socket of this.ctx.getWebSockets()) {
			const identity = socket.deserializeAttachment() as SocketIdentity;
			if (identity.role === "host") {
				if (
					(await liveDeviceCredential(
						this.ctx.id.name ?? "",
						identity.tokenHash,
					)) !== identity.userId
				)
					await this.revoke();
			} else if (
				identity.session.expiresAt <= Date.now() ||
				!(await liveEventSession(identity.session.browserSessionId))
			) {
				await this.endRemote(identity.session.id);
				closeSocket(socket, 4401, "Session ended");
			}
		}
		for (const [key, job] of await this.ctx.storage.list<DeviceJob>({
			prefix: "job:",
		})) {
			if (!job.result && Date.now() - job.createdAt > deviceJobLifetimeMs) {
				await this.cancel(job.command.id);
				job.result = {
					ok: false,
					error: "Device task timed out; execution outcome is unknown",
					unknown: true,
				};
				await this.ctx.storage.put(key, job);
				this.notify(job.command.id);
			} else if (job.result && Date.now() - job.createdAt > 7 * 86400_000)
				await this.ctx.storage.delete(key);
		}
		for (const [
			key,
			session,
		] of await this.ctx.storage.list<RemoteDesktopSession>({
			prefix: "remote:",
		}))
			if (session.expiresAt <= Date.now()) await this.ctx.storage.delete(key);
		if (
			this.ctx.getWebSockets().length ||
			(await this.ctx.storage.list({ prefix: "job:", limit: 1 })).size
		)
			await this.ctx.storage.setAlarm(Date.now() + 60_000);
	}
}
