// The WebSocket handshake a device sent, as the Durable Object that takes the
// connection (and past it, the computer) needs it.
const handshakeHeaders = [
	"Upgrade",
	"Connection",
	"Sec-WebSocket-Key",
	"Sec-WebSocket-Version",
	"Sec-WebSocket-Protocol",
	"Sec-WebSocket-Extensions",
];

// A device's WebSocket request as the Worker passes it on, once it has
// admitted it (its session is live and the account's): its handshake and
// the Worker's own headers, nothing else the device sent. A device's headers
// would otherwise reach the Durable Object as the Worker's (one naming
// another session or connection) and the computer's sandbox as its caller's.
export function upgradeRequest(request: Request, own: Record<string, string>) {
	const headers = new Headers(own);
	for (const name of handshakeHeaders) {
		const value = request.headers.get(name);
		if (value !== null) headers.set(name, value);
	}
	return new Request(request.url, { headers });
}

// Closes a socket with a code it may send: 1005 and 1006 are reserved codes
// that report a close, and cannot be sent. One already closed stays so.
export function closeSocket(socket: WebSocket, code: number, reason: string) {
	try {
		socket.close(code === 1005 || code === 1006 ? 1000 : code, reason);
	} catch {
		// Already closed.
	}
}
