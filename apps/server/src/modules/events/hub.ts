import { DurableObject } from "cloudflare:workers";

import { errorDetails } from "@/lib/error-details";
import { closeSocket } from "@/lib/websocket";
import { liveEventSession } from "@/modules/auth/session";

// Set by the Worker once it has admitted the channel (admitWebSocket).
export const hubHeaders = { session: "x-heveta-session" };

// One per user: holds the event channels of all the user's devices and fans
// each committed change out to them (docs/sync.md). It accepts sockets through
// the hibernation API, so it sleeps between events at no duration cost while
// the devices stay connected; heartbeats are answered without waking it. It
// stores no events: a device that missed some reads the state again over RPC.
export class UserHub extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ctx.setWebSocketAutoResponse(
			new WebSocketRequestResponsePair("ping", "pong"),
		);
	}

	override async fetch(request: Request): Promise<Response> {
		const sessionId = request.headers.get(hubHeaders.session);
		if (
			request.headers.get("Upgrade")?.toLowerCase() !== "websocket" ||
			!sessionId
		)
			return new Response("Bad event channel request", { status: 400 });
		// No closeSession call can slip between this check and registration.
		// If revocation commits during the check, its close waits for this gate
		// and sees the newly registered socket; if earlier, admission refuses it.
		return this.ctx.blockConcurrencyWhile(async () => {
			try {
				if (!(await liveEventSession(sessionId)))
					return new Response("Session ended", { status: 401 });
			} catch (error) {
				// A failed admission must not reset the Hub's other connections.
				console.warn("[Events] Session check failed", errorDetails(error));
				return new Response("Unable to open event channel", { status: 503 });
			}
			const { 0: client, 1: server } = new WebSocketPair();
			this.ctx.acceptWebSocket(server, [sessionId]);
			return new Response(null, { status: 101, webSocket: client });
		});
	}

	// Frames are encoded UserEvent messages, sent in the order given.
	publish(frames: Uint8Array[]) {
		for (const socket of this.ctx.getWebSockets())
			for (const frame of frames) {
				try {
					socket.send(frame);
				} catch {
					// A socket that is already closing gets its close event.
					break;
				}
			}
	}

	closeSession(sessionId: string) {
		for (const socket of this.ctx.getWebSockets(sessionId))
			socket.close(4401, "Session ended");
	}

	// Devices only send heartbeats, which the auto-response answers.
	override webSocketMessage() {}

	override webSocketClose(socket: WebSocket, code: number, reason: string) {
		// Complete the closing handshake the device started.
		closeSocket(socket, code, reason);
	}
}
