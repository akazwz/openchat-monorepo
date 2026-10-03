import { Code, ConnectError } from "@connectrpc/connect";

import { currentSession, isCurrentSession } from "~/features/auth/store";
import { socketUrl } from "~/features/events/event-channel";
import { ErrorDetailSchema, ErrorReason } from "~/gen/heveta/v1/error_pb";
import { deviceClient } from "~/lib/rpc-client";

// Why a Mac's screen is not on the page. The first five need its owner to do
// something on the Mac; the rest are the connection's.
export type DesktopFailure =
	| "offline"
	| "screenPermission"
	| "inputPermission"
	| "controlled"
	| "busy"
	| "capture"
	| "connection"
	| "ended";

export type DesktopEvent =
	| { type: "connected" }
	// `dropped`: it was connected, and the failure is the connection's own, so
	// trying again by itself is worth it.
	| { type: "failed"; failure: DesktopFailure; dropped: boolean };

const connectTimeoutMs = 30_000;
// A connection that drops may come back by itself (a change of network).
const disconnectedGraceMs = 15_000;
const heartbeatMs = 25_000;
const heartbeatTimeoutMs = 10_000;
const queuedCandidateLimit = 256;
const inputBufferLimit = 64 * 1024;
// The device broker's close code for a session that was ended, by the Mac or
// by signing out (connection.ts on the server); others are a lost connection.
const closedByDevice = 4000;
const closedBySession = 4401;

const refusals: Partial<Record<ErrorReason, DesktopFailure>> = {
	[ErrorReason.DEVICE_OFFLINE]: "offline",
	[ErrorReason.DEVICE_SCREEN_NOT_ALLOWED]: "screenPermission",
	[ErrorReason.DEVICE_INPUT_NOT_ALLOWED]: "inputPermission",
	[ErrorReason.DEVICE_CONTROLLED]: "controlled",
};

// The codes a Mac gives for ending a session (remote_error).
const deviceErrors: Record<string, DesktopFailure> = {
	screen_permission: "screenPermission",
	input_permission: "inputPermission",
	controlled: "controlled",
	busy: "busy",
	capture: "capture",
	connection: "connection",
	ended: "ended",
};

interface Signal {
	description?: RTCSessionDescriptionInit;
	candidate?: RTCIceCandidateInit;
}

// One session of watching, or controlling, a Mac's screen. The picture comes
// straight from the Mac over WebRTC (with a relay when no direct path
// exists); the server's device broker carries only the negotiation, over a
// WebSocket that also ends the session when either side leaves.
export class DesktopClient {
	private peer?: RTCPeerConnection;
	private socket?: WebSocket;
	private channel?: RTCDataChannel;
	private stopped = false;
	private wasConnected = false;
	private readonly request = new AbortController();
	private readonly owner = currentSession();
	// Candidates that arrived before the Mac's offer.
	private candidates: RTCIceCandidateInit[] = [];
	// Signals are applied one after another, in the order they came.
	private applying = Promise.resolve();
	private heartbeat?: ReturnType<typeof setInterval>;
	private heartbeatDeadline?: ReturnType<typeof setTimeout>;
	private connectDeadline?: ReturnType<typeof setTimeout>;

	constructor(
		private readonly deviceId: string,
		private readonly control: boolean,
		private readonly video: HTMLVideoElement,
		private readonly notify: (event: DesktopEvent) => void,
	) {}

	async start() {
		let session: Awaited<ReturnType<typeof deviceClient.startRemoteDesktop>>;
		try {
			session = await deviceClient.startRemoteDesktop(
				{ deviceId: this.deviceId, control: this.control },
				{ signal: this.request.signal },
			);
		} catch (error) {
			const refused = ConnectError.from(error);
			const reason = refused.findDetails(ErrorDetailSchema)[0]?.reason;
			this.fail(
				(reason !== undefined && refusals[reason]) ||
					(refused.code === Code.NotFound ? "offline" : "connection"),
			);
			return;
		}
		if (this.stopped || !isCurrentSession(this.owner)) return;

		const peer = new RTCPeerConnection({
			iceServers: session.iceServers.map(({ urls, username, credential }) => ({
				urls,
				username,
				credential,
			})),
		});
		this.peer = peer;
		peer.ontrack = ({ track }) => {
			this.video.srcObject = new MediaStream([track]);
			// Autoplay of a muted video is allowed; a refusal leaves the first
			// frame, and the next interaction plays it.
			this.video.play().catch(() => {});
		};
		// The Mac opens the channel input is sent on.
		peer.ondatachannel = ({ channel }) => {
			if (channel.label === "desktop") this.channel = channel;
			else channel.close();
		};
		peer.onicecandidate = ({ candidate }) => {
			if (candidate) this.signal({ candidate: candidate.toJSON() });
		};
		peer.onconnectionstatechange = () => {
			const state = peer.connectionState;
			if (state === "connected") {
				clearTimeout(this.connectDeadline);
				this.wasConnected = true;
				this.notify({ type: "connected" });
			} else if (state === "failed" || state === "closed")
				this.fail("connection");
			else if (state === "disconnected") {
				clearTimeout(this.connectDeadline);
				this.connectDeadline = setTimeout(
					() => this.fail("connection"),
					disconnectedGraceMs,
				);
			}
		};

		const socket = new WebSocket(
			socketUrl("/device/remote", this.owner.userId, {
				device: this.deviceId,
				session: session.sessionId,
			}),
		);
		this.socket = socket;
		this.connectDeadline = setTimeout(
			() => this.fail("connection"),
			connectTimeoutMs,
		);
		socket.onopen = () => {
			this.heartbeat = setInterval(() => {
				socket.send("ping");
				clearTimeout(this.heartbeatDeadline);
				this.heartbeatDeadline = setTimeout(
					() => this.fail("connection"),
					heartbeatTimeoutMs,
				);
			}, heartbeatMs);
		};
		socket.onmessage = ({ data }) => {
			if (data === "pong") {
				clearTimeout(this.heartbeatDeadline);
				return;
			}
			let message: { type?: string; code?: string; signal?: Signal };
			try {
				message = JSON.parse(data);
			} catch {
				return;
			}
			if (message.type === "remote_error")
				// A client that gives no code (the native one) says only that it
				// could not share the screen.
				this.fail(deviceErrors[message.code ?? ""] ?? "capture");
			else if (message.type === "signal" && message.signal)
				this.apply(peer, message.signal);
		};
		socket.onclose = ({ code }) =>
			this.fail(
				code === closedByDevice || code === closedBySession
					? "ended"
					: "connection",
			);
	}

	// A pointer or keyboard event for the Mac (the `computer` tool's shape).
	input(value: Record<string, unknown>) {
		if (
			this.control &&
			!this.stopped &&
			isCurrentSession(this.owner) &&
			this.channel?.readyState === "open" &&
			this.channel.bufferedAmount < inputBufferLimit
		)
			this.channel.send(JSON.stringify(value));
	}

	// Lets go of every key and button this session holds down on the Mac.
	release() {
		this.input({ action: "release" });
	}

	stop() {
		if (this.stopped) return;
		this.release();
		this.stopped = true;
		this.request.abort();
		clearInterval(this.heartbeat);
		clearTimeout(this.heartbeatDeadline);
		clearTimeout(this.connectDeadline);
		if (this.socket) {
			this.socket.onclose = null;
			this.socket.onmessage = null;
			this.socket.close();
		}
		if (this.peer) {
			this.peer.onconnectionstatechange = null;
			this.peer.ontrack = null;
			this.peer.ondatachannel = null;
			this.peer.onicecandidate = null;
			this.peer.close();
		}
		this.video.srcObject = null;
	}

	private signal(signal: Signal) {
		if (!this.stopped && this.socket?.readyState === WebSocket.OPEN)
			this.socket.send(JSON.stringify({ type: "signal", signal }));
	}

	private apply(peer: RTCPeerConnection, signal: Signal) {
		this.applying = this.applying
			.then(async () => {
				if (this.stopped || !isCurrentSession(this.owner)) return;
				if (signal.description?.type === "offer") {
					await peer.setRemoteDescription(signal.description);
					for (const candidate of this.candidates)
						await peer.addIceCandidate(candidate);
					this.candidates = [];
					await peer.setLocalDescription(await peer.createAnswer());
					if (peer.localDescription)
						this.signal({ description: peer.localDescription.toJSON() });
				} else if (signal.candidate) {
					if (peer.remoteDescription)
						await peer.addIceCandidate(signal.candidate);
					else if (this.candidates.length < queuedCandidateLimit)
						this.candidates.push(signal.candidate);
				}
			})
			.catch(() => this.fail("connection"));
	}

	private fail(failure: DesktopFailure) {
		if (this.stopped) return;
		const dropped = this.wasConnected && failure === "connection";
		this.stop();
		this.notify({ type: "failed", failure, dropped });
	}
}
