import { join } from "node:path";

import {
	app,
	BrowserWindow,
	desktopCapturer,
	type DesktopCapturerSource,
	screen,
	type Session,
	type Streams,
} from "electron";

import type { MediaCommand, MediaEvent } from "../pages/media-api";
import { pageUrl } from "../shell/pages";
import { DesktopInput } from "./input";
import { type Permissions, readPermissions } from "./permissions";
import {
	type BrokerMessage,
	type HostMessage,
	isId,
	isRecord,
	type RemoteError,
	type Signal,
} from "./protocol";

const viewerLimit = 8;
// The server ends a session after about two hours (connection.ts); this is
// the same limit kept here, for a session the server could not end.
const sessionLifetime = 7_000_000;
const startTimeout = 15_000;
const inputRateLimit = 1000;
// The longer side of a screenshot the agent takes, in pixels.
const screenshotSize = 1920;

// What each failure reads as in the log; the person watching sees the web
// app's words for its code.
const errors: Record<RemoteError, string> = {
	screen_permission: "Screen Recording permission is required",
	input_permission: "Accessibility permission is required",
	controlled: "Another person is controlling this Mac",
	busy: "Too many people are viewing this Mac",
	capture: "The screen could not be captured",
	connection: "The connection could not be made",
	ended: "The session ended",
};

interface RemoteSession {
	control: boolean;
	expiry: NodeJS.Timeout;
	// Input events in the current second, to refuse a flood.
	inputWindow: number;
	inputCount: number;
}

interface RemoteEvents {
	// Whether this Mac may be reached at all, now.
	allowed(): boolean;
	send(message: HostMessage): void;
	// The number of viewers changed.
	changed(): void;
}

// People watching, and one at a time controlling, this Mac's main display
// from the web app. The picture travels browser to browser over WebRTC: a
// hidden page of the client's own (pages/media.ts) captures the screen and
// holds the peer connections, the server only relays their negotiation.
// Input arrives on that page's data channel and is carried out here.
export class RemoteDesktop {
	readonly input = new DesktopInput();
	private sessions = new Map<string, RemoteSession>();
	private window?: BrowserWindow;
	private windowReady?: Promise<BrowserWindow>;
	// The display handed to the page's next capture request.
	private source?: DesktopCapturerSource;

	constructor(
		private readonly session: Session,
		private readonly events: RemoteEvents,
	) {
		// The media page is the only one that may capture, only the screen, and
		// only while someone is watching. Nothing else on this session is
		// granted anything.
		session.setPermissionCheckHandler(() => false);
		session.setPermissionRequestHandler(
			(contents, permission, callback, details) =>
				callback(
					this.fromMediaPage(contents) &&
						permission === "media" &&
						// A screen capture names no camera or microphone.
						"mediaTypes" in details &&
						details.mediaTypes?.length === 0,
				),
		);
		session.setDisplayMediaRequestHandler((request, callback) => {
			const source = this.source;
			if (
				source &&
				this.sessions.size &&
				request.frame === this.window?.webContents.mainFrame
			)
				callback({ video: source });
			// Electron takes no streams as a refusal.
			else (callback as (streams?: Streams) => void)();
		});
	}

	get viewers() {
		return this.sessions.size;
	}
	get isControlled() {
		return [...this.sessions.values()].some((session) => session.control);
	}

	// One still picture of the main display, for the agent.
	async screenshot() {
		const { width, height } = screen.getPrimaryDisplay().size;
		const scale = Math.min(1, screenshotSize / Math.max(width, height));
		const source = await this.mainDisplay({
			width: Math.round(width * scale),
			height: Math.round(height * scale),
		});
		if (source.thumbnail.isEmpty()) throw new Error(errors.capture);
		return {
			image: new Uint8Array(source.thumbnail.toPNG()),
			...source.thumbnail.getSize(),
		};
	}

	async start(message: Extract<BrokerMessage, { type: "remote_start" }>) {
		const id = message.sessionId;
		if (this.sessions.has(id)) return;
		const refusal = this.refusal(message.control);
		if (refusal) {
			this.report(id, refusal);
			return;
		}
		// A person takes over whatever the agent was holding down.
		if (message.control) this.input.release();
		const session: RemoteSession = {
			control: message.control,
			expiry: setTimeout(() => this.stop(id, "ended"), sessionLifetime),
			inputWindow: Date.now(),
			inputCount: 0,
		};
		this.sessions.set(id, session);
		this.events.changed();
		try {
			this.source = await this.mainDisplay({ width: 0, height: 0 });
			const window = await this.mediaWindow();
			// Stopped, or access turned off, while this was getting ready.
			if (this.sessions.get(id) !== session) return;
			this.command(window, {
				type: "start",
				sessionId: id,
				iceServers: message.iceServers,
			});
		} catch (error) {
			console.warn("[Heveta] Screen sharing could not start", error);
			if (this.sessions.get(id) === session) this.stop(id, "capture");
		}
	}

	signal(sessionId: string, signal: Signal) {
		if (this.sessions.has(sessionId) && this.window)
			this.command(this.window, { type: "signal", sessionId, signal });
	}

	// Ends a session; with `error`, the person watching is told why.
	stop(id: string, error?: RemoteError) {
		const session = this.sessions.get(id);
		if (!session) return;
		if (error) this.report(id, error);
		clearTimeout(session.expiry);
		this.sessions.delete(id);
		if (session.control) this.input.release();
		if (this.window && !this.window.isDestroyed())
			this.command(this.window, { type: "stop", sessionId: id });
		if (!this.sessions.size) this.closeWindow();
		this.events.changed();
	}

	stopAll(error?: RemoteError) {
		for (const id of this.sessions.keys()) this.stop(id, error);
		this.input.release();
	}

	// A permission taken away ends what needed it: every session without the
	// screen, the controlling one without input.
	permissionsChanged(permissions: Permissions) {
		if (!permissions.screen) this.stopAll("screen_permission");
		else if (!permissions.input)
			for (const [id, session] of this.sessions)
				if (session.control) this.stop(id, "input_permission");
	}

	private refusal(control: boolean): RemoteError | undefined {
		const permissions = readPermissions();
		if (!this.events.allowed()) return "ended";
		if (!permissions.screen) return "screen_permission";
		if (this.sessions.size >= viewerLimit) return "busy";
		if (control && !permissions.input) return "input_permission";
		if (control && this.isControlled) return "controlled";
		return undefined;
	}

	private report(sessionId: string, code: RemoteError) {
		this.events.send({
			type: "remote_error",
			sessionId,
			code,
			error: errors[code],
		});
	}

	private async mainDisplay(thumbnailSize: { width: number; height: number }) {
		if (!readPermissions().screen) throw new Error(errors.screen_permission);
		const sources = await desktopCapturer.getSources({
			types: ["screen"],
			thumbnailSize,
		});
		const main = String(screen.getPrimaryDisplay().id);
		const source = sources.find((entry) => entry.display_id === main);
		if (!source) throw new Error(errors.capture);
		return source;
	}

	private fromMediaPage(contents: Electron.WebContents | null) {
		return (
			this.sessions.size > 0 &&
			!!contents &&
			contents === this.window?.webContents &&
			contents.getURL() === pageUrl("media")
		);
	}

	// The hidden page that captures and sends the screen. It exists only
	// while someone is watching.
	private mediaWindow() {
		this.windowReady ??= new Promise<BrowserWindow>((resolve, reject) => {
			const window = new BrowserWindow({
				show: false,
				webPreferences: {
					session: this.session,
					preload: join(__dirname, "preload/media.js"),
					sandbox: true,
					contextIsolation: true,
					nodeIntegration: false,
					// A page nobody sees must still send every frame.
					backgroundThrottling: false,
					devTools: !app.isPackaged,
				},
			});
			this.window = window;
			const contents = window.webContents;
			contents.setWindowOpenHandler(() => ({ action: "deny" }));
			contents.on("will-navigate", (event) => event.preventDefault());
			contents.on("render-process-gone", () => this.stopAll("capture"));
			const timer = setTimeout(
				() => reject(new Error("The media page did not start")),
				startTimeout,
			);
			// The page says so once its script is listening.
			contents.ipc.once("media:ready", () => {
				clearTimeout(timer);
				resolve(window);
			});
			contents.ipc.on("media:event", (event, value: unknown) => {
				if (event.senderFrame === contents.mainFrame) this.onMediaEvent(value);
			});
			window.loadURL(pageUrl("media")).catch((error: unknown) => {
				clearTimeout(timer);
				reject(error);
			});
		});
		return this.windowReady;
	}

	private closeWindow() {
		this.window?.destroy();
		this.window = undefined;
		this.windowReady = undefined;
		this.source = undefined;
	}

	private command(window: BrowserWindow, command: MediaCommand) {
		window.webContents.send("media:command", command);
	}

	private onMediaEvent(value: unknown) {
		if (!isRecord(value) || !isId(value.sessionId)) return;
		const message = value as unknown as MediaEvent;
		const session = this.sessions.get(message.sessionId);
		if (!session || !this.events.allowed()) return;
		if (message.type === "signal")
			this.events.send({
				type: "signal",
				sessionId: message.sessionId,
				signal: message.signal,
			});
		else if (message.type === "failed") {
			console.warn("[Heveta] Screen sharing failed", message.detail);
			this.stop(message.sessionId, message.code);
		} else if (message.type === "input" && session.control)
			this.perform(message.sessionId, session, message.input);
	}

	private perform(id: string, session: RemoteSession, input: unknown) {
		const now = Date.now();
		if (now - session.inputWindow > 1000) {
			session.inputWindow = now;
			session.inputCount = 0;
		}
		if (++session.inputCount > inputRateLimit) {
			this.stop(id, "ended");
			return;
		}
		try {
			this.input.perform(input);
		} catch {
			// A key this Mac has no code for is skipped; without the permission
			// nothing can be sent at all.
			if (!readPermissions().input) this.stop(id, "input_permission");
		}
	}
}
