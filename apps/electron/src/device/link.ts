import WebSocket from "ws";

import {
	type BrokerMessage,
	type HostMessage,
	messageLimit,
	protocolVersion,
	readBrokerMessage,
} from "./protocol";

// Why the link stopped for good: the credential no longer works, another
// connection took this device's place, or the server speaks another protocol.
export type LinkEnd = "revoked" | "replaced" | "protocol";

interface LinkEvents {
	online(): void;
	// The connection dropped; the link is connecting again.
	offline(): void;
	message(message: BrokerMessage): void;
	ended(reason: LinkEnd): void;
}

const handshakeTimeout = 15_000;
const heartbeatInterval = 25_000;
const heartbeatTimeout = 10_000;
const maximumRetryDelay = 30_000;
// Close codes of the device broker (connection.ts on the server).
const closeReplaced = 4000;
const closeRevoked = 4401;

// This Mac's connection to the server's device broker: an outgoing WebSocket
// that says hello, answers with a heartbeat, and connects again by itself for
// as long as the device may. Everything about what the messages mean belongs
// to its owner.
export class DeviceLink {
	private socket?: WebSocket;
	private online = false;
	private stopped = false;
	private attempts = 0;
	private retry?: NodeJS.Timeout;
	private heartbeat?: NodeJS.Timeout;
	private deadline?: NodeJS.Timeout;

	constructor(
		private readonly origin: URL,
		private readonly credential: string,
		private readonly events: LinkEvents,
	) {}

	start() {
		this.connect();
	}

	send(message: HostMessage) {
		const socket = this.socket;
		if (!this.online || socket?.readyState !== WebSocket.OPEN) return;
		const encoded = JSON.stringify(message);
		// The broker refuses larger messages, and a peer that takes nothing in
		// is gone: either way this connection is of no more use.
		if (
			Buffer.byteLength(encoded) > messageLimit ||
			socket.bufferedAmount > 2 * messageLimit
		) {
			socket.terminate();
			return;
		}
		socket.send(encoded);
	}

	// Closes the connection, after `farewell` if it is still open. No event
	// follows.
	stop(farewell?: HostMessage) {
		if (farewell) this.send(farewell);
		this.stopped = true;
		this.online = false;
		this.clearTimers();
		const socket = this.socket;
		this.socket = undefined;
		if (!socket) return;
		socket.close();
		setTimeout(() => socket.terminate(), 1000).unref();
	}

	private clearTimers() {
		clearTimeout(this.retry);
		clearInterval(this.heartbeat);
		clearTimeout(this.deadline);
	}

	private connect() {
		const url = new URL("/device/connect", this.origin);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		const socket = new WebSocket(url, {
			headers: { authorization: `Bearer ${this.credential}` },
			handshakeTimeout,
			maxPayload: messageLimit,
			followRedirects: false,
		});
		this.socket = socket;
		const current = () => this.socket === socket && !this.stopped;
		const expect = (timeout: number) => {
			clearTimeout(this.deadline);
			this.deadline = setTimeout(() => socket.terminate(), timeout);
		};

		socket.on("unexpected-response", (_request, response) => {
			response.resume();
			if (!current()) return;
			if (response.statusCode === 401 || response.statusCode === 403)
				this.end("revoked");
			else socket.terminate();
		});
		// The broker greets first.
		socket.on("open", () => {
			if (current()) expect(handshakeTimeout);
		});
		socket.on("message", (data, isBinary) => {
			if (!current()) return;
			const raw = data.toString();
			if (raw === "pong") {
				clearTimeout(this.deadline);
				return;
			}
			let message: BrokerMessage | undefined;
			try {
				if (isBinary) throw new Error("Binary message");
				message = readBrokerMessage(JSON.parse(raw));
			} catch {
				socket.close(1007, "Invalid device message");
				return;
			}
			if (!message) return;
			if (message.type === "revoked") this.end("revoked");
			else if (message.type !== "hello") {
				if (this.online) this.events.message(message);
			} else if (message.version !== protocolVersion || this.online)
				this.end("protocol");
			else {
				clearTimeout(this.deadline);
				this.online = true;
				this.attempts = 0;
				this.heartbeat = setInterval(() => {
					socket.send("ping");
					expect(heartbeatTimeout);
				}, heartbeatInterval);
				this.events.online();
			}
		});
		// "close" follows every error and decides what happens next.
		socket.on("error", () => {});
		socket.on("close", (code) => {
			if (!current()) return;
			if (code === closeReplaced) {
				this.end("replaced");
				return;
			}
			if (code === closeRevoked) {
				this.end("revoked");
				return;
			}
			this.clearTimers();
			this.socket = undefined;
			if (this.online) {
				this.online = false;
				this.events.offline();
			}
			const delay = Math.min(maximumRetryDelay, 1000 * 2 ** this.attempts++);
			this.retry = setTimeout(
				() => this.connect(),
				delay + Math.random() * 300,
			);
		});
	}

	private end(reason: LinkEnd) {
		this.stop();
		this.events.ended(reason);
	}
}
