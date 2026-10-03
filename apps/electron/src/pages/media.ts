import type { MediaApi, MediaCommand, MediaEvent } from "./media-api";

declare global {
	interface Window {
		hevetaMedia: MediaApi;
	}
}

// The page that shares this Mac's screen. It is never shown: it captures the
// main display once, however many people watch, and holds one peer connection
// to each of them. The main process relays the negotiation, decides who may
// control, and carries out the input this page receives (device/remote.ts).
const connectTimeout = 30_000;
// A connection that drops may come back by itself (a change of network).
const reconnectTimeout = 15_000;
const queuedCandidateLimit = 256;
const inputMessageLimit = 64 * 1024;
const video = {
	maxWidth: 2560,
	maxHeight: 1600,
	frameRate: 30,
	bitrate: 8_000_000,
};

interface Peer {
	connection: RTCPeerConnection;
	channel: RTCDataChannel;
	// Candidates that arrived before the answer.
	candidates: RTCIceCandidateInit[];
	// Signals are applied one after another, in the order they came.
	applying: Promise<void>;
	deadline?: ReturnType<typeof setTimeout>;
}

const peers = new Map<string, Peer>();
let stream: MediaStream | undefined;
let capturing: Promise<MediaStream> | undefined;

const send = (event: MediaEvent) => window.hevetaMedia.send(event);

function stopCapturingIfUnwatched() {
	if (peers.size || !stream) return;
	for (const track of stream.getTracks()) track.stop();
	stream = undefined;
}

function close(sessionId: string) {
	const peer = peers.get(sessionId);
	if (!peer) return;
	peers.delete(sessionId);
	clearTimeout(peer.deadline);
	peer.connection.onconnectionstatechange = null;
	peer.connection.onicecandidate = null;
	peer.channel.onmessage = null;
	peer.channel.onclose = null;
	peer.connection.close();
	stopCapturingIfUnwatched();
}

function fail(
	sessionId: string,
	code: "capture" | "connection",
	cause: unknown,
) {
	if (!peers.has(sessionId)) return;
	close(sessionId);
	send({
		type: "failed",
		sessionId,
		code,
		detail: cause instanceof Error ? `${cause.name}: ${cause.message}` : code,
	});
}

// The main display. The main process chooses it when it answers this request
// (its display media handler); no picker is shown.
function capture() {
	if (stream) return Promise.resolve(stream);
	capturing ??= navigator.mediaDevices
		.getDisplayMedia({
			audio: false,
			video: {
				width: { max: video.maxWidth },
				height: { max: video.maxHeight },
				frameRate: { max: video.frameRate },
			},
		})
		.then((captured) => {
			stream = captured;
			for (const track of captured.getVideoTracks()) {
				// Text on a screen should stay sharp rather than smooth.
				track.contentHint = "detail";
				track.onended = () => {
					for (const sessionId of peers.keys())
						fail(sessionId, "capture", new Error("The capture ended"));
				};
			}
			// Everyone may have left while the capture was starting.
			stopCapturingIfUnwatched();
			return captured;
		})
		.finally(() => {
			capturing = undefined;
		});
	return capturing;
}

async function start(command: Extract<MediaCommand, { type: "start" }>) {
	const { sessionId } = command;
	close(sessionId);
	const connection = new RTCPeerConnection({ iceServers: command.iceServers });
	const channel = connection.createDataChannel("desktop", { ordered: true });
	const peer: Peer = {
		connection,
		channel,
		candidates: [],
		applying: Promise.resolve(),
	};
	peers.set(sessionId, peer);
	const failConnection = (reason: string) =>
		fail(sessionId, "connection", new Error(reason));
	peer.deadline = setTimeout(
		() => failConnection("Timed out connecting"),
		connectTimeout,
	);
	connection.onicecandidate = ({ candidate }) => {
		if (candidate)
			send({
				type: "signal",
				sessionId,
				signal: { candidate: { ...candidate.toJSON() } },
			});
	};
	connection.onconnectionstatechange = () => {
		const state = connection.connectionState;
		if (state === "connected") clearTimeout(peer.deadline);
		else if (state === "failed" || state === "closed")
			failConnection(`The connection ${state}`);
		else if (state === "disconnected") {
			clearTimeout(peer.deadline);
			peer.deadline = setTimeout(
				() => failConnection("The connection dropped"),
				reconnectTimeout,
			);
		}
	};
	channel.onclose = () => failConnection("The viewer left");
	channel.onmessage = ({ data }) => {
		if (typeof data !== "string" || data.length > inputMessageLimit) return;
		let input: unknown;
		try {
			input = JSON.parse(data);
		} catch {
			return;
		}
		send({ type: "input", sessionId, input });
	};

	let media: MediaStream;
	try {
		media = await capture();
	} catch (error) {
		fail(sessionId, "capture", error);
		return;
	}
	// Stopped, or started over, while the capture was starting.
	if (peers.get(sessionId) !== peer) return;
	try {
		for (const track of media.getVideoTracks())
			connection.addTrack(track, media);
		await connection.setLocalDescription(await connection.createOffer());
		const description = connection.localDescription;
		if (peers.get(sessionId) === peer && description)
			send({
				type: "signal",
				sessionId,
				signal: {
					description: { type: description.type, sdp: description.sdp },
				},
			});
	} catch (error) {
		fail(sessionId, "connection", error);
	}
}

// A sharp picture over a smooth one: when the network cannot carry both, the
// frame rate gives way, not the resolution.
async function preferSharpness(connection: RTCPeerConnection) {
	for (const sender of connection.getSenders()) {
		if (sender.track?.kind !== "video") continue;
		const parameters = sender.getParameters();
		const [encoding] = parameters.encodings;
		if (!encoding) continue;
		encoding.maxBitrate = video.bitrate;
		encoding.maxFramerate = video.frameRate;
		parameters.degradationPreference = "maintain-resolution";
		await sender.setParameters(parameters);
	}
}

async function applySignal(
	peer: Peer,
	signal: Extract<MediaCommand, { type: "signal" }>["signal"],
) {
	const { connection } = peer;
	if (signal.description?.type === "answer") {
		await connection.setRemoteDescription(
			signal.description as RTCSessionDescriptionInit,
		);
		await preferSharpness(connection);
		for (const candidate of peer.candidates)
			await connection.addIceCandidate(candidate);
		peer.candidates = [];
	} else if (signal.candidate) {
		if (connection.remoteDescription)
			await connection.addIceCandidate(signal.candidate);
		else if (peer.candidates.length < queuedCandidateLimit)
			peer.candidates.push(signal.candidate);
	}
}

window.hevetaMedia.onCommand((command) => {
	if (command.type === "start") void start(command);
	else if (command.type === "stop") close(command.sessionId);
	else {
		const peer = peers.get(command.sessionId);
		if (!peer) return;
		peer.applying = peer.applying
			.then(() => {
				if (peers.get(command.sessionId) === peer)
					return applySignal(peer, command.signal);
			})
			.catch((error: unknown) => fail(command.sessionId, "connection", error));
	}
});
