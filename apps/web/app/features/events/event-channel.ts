import { fromBinary } from "@bufbuild/protobuf";

import { type UserEvent, UserEventSchema } from "~/gen/heveta/v1/event_pb";

interface EventChannelHandlers {
	event: (event: UserEvent) => void;
	// The channel opened, the first time or after an outage. Changes made while
	// it was closed are not replayed; read what is on screen again.
	connected: () => void;
	// Open, or not: dropped, or an attempt to open it failed. Nothing is
	// reported while the first attempt is under way.
	status: (connected: boolean) => void;
	// The server refused it, or may have: the session ended (closed with
	// 4401), or it never opened, which a page cannot tell from a lost
	// network (a WebSocket does not report its refusal).
	refused: () => void;
}

// A heartbeat finds a connection that died without closing (a sleeping
// laptop, a lost network). The hub answers it without waking up.
const heartbeatMs = 25_000;
const heartbeatTimeoutMs = 10_000;
const maxRetryMs = 15_000;

// The signed-in user's event channel (docs/sync.md): one WebSocket on which
// the server pushes every committed change, each binary frame a UserEvent.
// Reads and commands stay RPCs. It opens with the session cookie, for the
// account the page shows, and reconnects on its own until stopped.
export class EventChannel {
	#socket?: WebSocket;
	#stopped = false;
	#attempt = 0;
	#retry?: ReturnType<typeof setTimeout>;
	#heartbeat?: ReturnType<typeof setInterval>;
	#deadline?: ReturnType<typeof setTimeout>;

	constructor(
		private userId: string,
		private handlers: EventChannelHandlers,
	) {}

	start() {
		globalThis.addEventListener?.("online", this.#reconnectNow);
		globalThis.document?.addEventListener("visibilitychange", this.#onVisible);
		this.#open();
	}

	stop() {
		this.#stopped = true;
		globalThis.removeEventListener?.("online", this.#reconnectNow);
		globalThis.document?.removeEventListener(
			"visibilitychange",
			this.#onVisible,
		);
		clearTimeout(this.#retry);
		this.#drop(1000);
	}

	// Phones close background connections, and a sleeping laptop's can die
	// without closing: coming back reconnects at once, or checks the open
	// connection at once rather than at the next heartbeat.
	#onVisible = () => {
		if (globalThis.document?.visibilityState !== "visible") return;
		if (this.#socket?.readyState === WebSocket.OPEN) this.#ping(this.#socket);
		else this.#reconnectNow();
	};

	#reconnectNow = () => {
		if (this.#stopped || this.#socket) return;
		clearTimeout(this.#retry);
		this.#attempt = 0;
		this.#open();
	};

	#open() {
		if (this.#stopped || this.#socket) return;
		this.#listen(new WebSocket(socketUrl("/events", this.userId)));
	}

	#listen(socket: WebSocket) {
		socket.binaryType = "arraybuffer";
		this.#socket = socket;
		socket.onopen = () => {
			if (this.#socket !== socket) return;
			this.#attempt = 0;
			this.#startHeartbeat(socket);
			this.handlers.status(true);
			this.handlers.connected();
		};
		socket.onmessage = ({ data }) => {
			if (this.#socket !== socket) return;
			if (typeof data === "string") {
				if (data === "pong") clearTimeout(this.#deadline);
				return;
			}
			let event: UserEvent;
			try {
				event = fromBinary(UserEventSchema, new Uint8Array(data));
			} catch {
				// A frame this client cannot read is dropped; the next read
				// corrects whatever it described.
				return;
			}
			this.handlers.event(event);
		};
		let opened = false;
		socket.addEventListener("open", () => {
			opened = true;
		});
		socket.onclose = ({ code }) => {
			if (this.#socket !== socket) return;
			if (!opened || code === 4401) this.handlers.refused();
			this.#drop();
			this.#scheduleRetry();
		};
	}

	#startHeartbeat(socket: WebSocket) {
		clearInterval(this.#heartbeat);
		this.#heartbeat = setInterval(() => {
			if (socket.readyState === WebSocket.OPEN) this.#ping(socket);
		}, heartbeatMs);
	}

	#ping(socket: WebSocket) {
		socket.send("ping");
		clearTimeout(this.#deadline);
		this.#deadline = setTimeout(() => {
			// No answer: stop waiting on a dead connection and open a new one.
			if (this.#socket !== socket) return;
			this.#drop(4000);
			this.#scheduleRetry(true);
		}, heartbeatTimeoutMs);
	}

	// Detaches the current socket; its late events are ignored.
	#drop(code?: number) {
		clearInterval(this.#heartbeat);
		clearTimeout(this.#deadline);
		const socket = this.#socket;
		if (!socket) return;
		this.#socket = undefined;
		try {
			socket.close(code);
		} catch {
			// Already closing.
		}
		this.handlers.status(false);
	}

	#scheduleRetry(immediately = false) {
		if (this.#stopped) return;
		clearTimeout(this.#retry);
		const delay = immediately
			? 0
			: Math.min(500 * 2 ** this.#attempt++, maxRetryMs) *
				(0.5 + Math.random() / 2);
		this.#retry = setTimeout(() => this.#open(), delay);
	}
}

// A WebSocket address of this app's, for the account the page shows (the
// server refuses one whose session is of another; modules/auth/session.ts).
export function socketUrl(
	path: string,
	userId: string,
	params: Record<string, string> = {},
) {
	const url = new URL(path, globalThis.location.href);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	url.search = new URLSearchParams({ user: userId, ...params }).toString();
	return url.toString();
}
