import { upgradeRequest } from "@/lib/websocket";
import { admitWebSocket } from "@/modules/auth/session";

import { userMachine } from "./machine";

// A person's live connection to their computer (docs/sandbox.md): its
// screen, VNC (RFB) over a WebSocket for the app's noVNC client, or a shell
// in the Sandbox SDK's terminal protocol for xterm.js.
export type ConnectionKind = "screen" | "terminal";

// Set by the Worker on a connection it admitted (admitWebSocket). The
// computer trusts them: no device's own headers reach it (upgradeRequest).
export const connectionHeaders = {
	kind: "x-heveta-connection",
	session: "x-heveta-session",
};

// GET /screen?user=… and GET /terminal?user=…&cols=…&rows=…: once admitted,
// the user's computer takes the connection (computer-object.ts). It wakes,
// restoring its workspace, and relays the socket to its container until
// either end closes or the session ends.
export async function openConnection(request: Request, kind: ConnectionKind) {
	const admission = await admitWebSocket(request);
	if (admission instanceof Response) return admission;
	return userMachine(admission.userId).fetch(
		upgradeRequest(request, {
			[connectionHeaders.kind]: kind,
			[connectionHeaders.session]: admission.sessionId,
		}),
	);
}

// Closes an ended session's connections to the user's computer. The caller
// retains the revoked session until this succeeds (as closeChannels).
export async function closeConnections(userId: string, sessionId: string) {
	await userMachine(userId).closeConnections(sessionId);
}
