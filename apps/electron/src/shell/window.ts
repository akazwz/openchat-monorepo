import { join } from "node:path";

import {
	app,
	BrowserWindow,
	dialog,
	type IpcMainEvent,
	nativeTheme,
	powerMonitor,
	type Rectangle,
	screen,
	type Session,
	shell,
	WebContentsView,
} from "electron";

import { isAppUrl, isExternalUrl } from "../config";
import { language, type MessageKey, setLanguage, text } from "../messages";
import { type Preferences, writePreferences, zoomRange } from "../preferences";
import { showContextMenu } from "./context-menu";
import { Downloads } from "./downloads";
import { pageUrl } from "./pages";

// The page background of the brand theme, light and dark. scripts/build.mjs
// reads it from the theme, so the window's own surfaces match the web app.
declare const __CHROME_COLORS__: { light: string; dark: string };

// The strip across the top that holds the window buttons and moves the window.
const titleBand = 36;
const windowButtonSize = 12;
const loadTimeout = 20_000;
const defaultSize = { width: 1220, height: 820 };
const minimumSize = { width: 900, height: 600 };

// What the window shows: the web app once it has loaded, the client's own
// panel until then and whenever the app cannot be shown.
type Status = "loading" | "ready" | "failed" | "crashed";
// Where the menus lead: a new side conversation, and settings.
type AppPath = "/new" | "/settings";
type PendingWork = "drafts" | "upload";

export function openExternal(url: string) {
	if (!isExternalUrl(url)) return;
	shell
		.openExternal(url)
		.catch((error: unknown) =>
			console.warn("[Heveta] Could not open a link", error),
		);
}

function chromeColor() {
	return nativeTheme.shouldUseDarkColors
		? __CHROME_COLORS__.dark
		: __CHROME_COLORS__.light;
}

// The saved frame, kept on a display that still exists; centered otherwise.
function initialFrame(saved?: Rectangle) {
	const area = (
		saved ? screen.getDisplayMatching(saved) : screen.getPrimaryDisplay()
	).workArea;
	const minWidth = Math.min(minimumSize.width, area.width);
	const minHeight = Math.min(minimumSize.height, area.height);
	const width = Math.max(
		minWidth,
		Math.min(saved?.width ?? defaultSize.width, area.width),
	);
	const height = Math.max(
		minHeight,
		Math.min(saved?.height ?? defaultSize.height, area.height),
	);
	const within = (value: number | undefined, start: number, room: number) =>
		Math.round(
			Math.max(start, Math.min(value ?? start + room / 2, start + room)),
		);
	return {
		x: within(saved?.x, area.x, area.width - width),
		y: within(saved?.y, area.y, area.height - height),
		width,
		height,
		minWidth,
		minHeight,
	};
}

// One window: a page of the client's own (the title band, and a panel for
// loading and failures) with the web app in a view below the band. The web
// app keeps its drafts, uploads and connections for as long as the client
// runs: closing the window hides it.
export class ShellWindow {
	readonly window: BrowserWindow;
	private readonly view: WebContentsView;
	private readonly downloads: Downloads;
	private status: Status = "loading";
	// The main-frame load under way, until its document is ready or it failed.
	private load?: { url: string; failed: boolean; timer: NodeJS.Timeout };
	private lastUrl: string;
	private bridgeReady = false;
	private queuedPath?: AppPath;
	private pendingWork = new Set<PendingWork>();
	private saveTimer?: NodeJS.Timeout;
	private quitting = false;
	private askingAboutHang = false;
	private reloadingHungPage = false;

	constructor(
		private readonly appUrl: URL,
		preferences: Preferences,
		sessions: { local: Session; web: Session },
		private readonly events: {
			changed(): void;
			languageChanged(): void;
		},
	) {
		this.lastUrl = appUrl.href;
		nativeTheme.themeSource = preferences.theme;
		if (preferences.language) setLanguage(preferences.language);

		this.window = new BrowserWindow({
			...initialFrame(preferences.bounds),
			title: app.name,
			show: false,
			titleBarStyle: "hidden",
			trafficLightPosition: {
				x: (titleBand - windowButtonSize) / 2 + 2,
				y: (titleBand - windowButtonSize) / 2,
			},
			backgroundColor: chromeColor(),
			webPreferences: {
				session: sessions.local,
				preload: join(__dirname, "preload/shell.js"),
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				devTools: !app.isPackaged,
			},
		});
		if (preferences.maximized) this.window.maximize();

		this.view = new WebContentsView({
			webPreferences: {
				session: sessions.web,
				preload: join(__dirname, "preload/app.js"),
				additionalArguments: [`--heveta-origin=${appUrl.origin}`],
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				navigateOnDragDrop: false,
				spellcheck: true,
				devTools: !app.isPackaged,
				zoomFactor: 1.2 ** preferences.zoomLevel,
			},
		});
		this.view.setBackgroundColor(chromeColor());
		this.view.setVisible(false);
		this.window.contentView.addChildView(this.view);
		this.layout();

		this.downloads = new Downloads(
			this.window,
			this.contents,
			appUrl,
			sessions.web,
		);
		this.restrictPermissions(sessions.web);
		this.watchPage();
		this.watchWindow();

		// Each page speaks on its own channels (preload/shell.ts, preload/app.ts).
		const shellIpc = this.window.webContents.ipc;
		shellIpc.on("shell:ready", this.onShellReady);
		shellIpc.on("shell:retry", this.onShellRetry);
		const appIpc = this.contents.ipc;
		appIpc.on("desktop:ready", this.onBridgeReady);
		appIpc.on("desktop:appearance", this.onAppearance);
		appIpc.on("desktop:pending-work", this.onPendingWork);
		nativeTheme.on("updated", this.onThemeUpdated);
		powerMonitor.on("resume", this.onResume);

		void this.window.loadURL(pageUrl("shell"));
		this.loadApp(appUrl.href);
		this.focus();
	}

	// The web app's page.
	get contents() {
		return this.view.webContents;
	}
	get isVisible() {
		return !this.window.isDestroyed() && this.window.isVisible();
	}
	get isShowingApp() {
		return this.isVisible && this.status === "ready";
	}
	get canGoBack() {
		return this.isShowingApp && this.contents.navigationHistory.canGoBack();
	}
	get canGoForward() {
		return this.isShowingApp && this.contents.navigationHistory.canGoForward();
	}

	focus() {
		if (this.window.isDestroyed()) return;
		if (this.window.isMinimized()) this.window.restore();
		this.window.show();
		this.window.focus();
		this.focusPage();
	}

	// Menu items go through the web app's router, which keeps its state; a
	// load would start the app over.
	navigate(path: AppPath) {
		this.focus();
		this.queuedPath = path;
		this.sendQueuedPath();
		if (this.status === "failed" || this.status === "crashed") this.retry();
	}

	reload() {
		if (!this.confirmLeave("reload")) return;
		if (this.status === "ready") this.contents.reload();
		else this.retry();
	}
	goBack() {
		if (this.canGoBack) this.contents.navigationHistory.goBack();
	}
	goForward() {
		if (this.canGoForward) this.contents.navigationHistory.goForward();
	}

	// Steps the zoom level, or returns it to the actual size.
	zoom(step?: number) {
		if (!this.isShowingApp) return;
		this.contents.setZoomLevel(
			step === undefined
				? 0
				: Math.max(
						zoomRange.min,
						Math.min(zoomRange.max, this.contents.getZoomLevel() + step),
					),
		);
		this.saveSoon();
	}

	showDownloads() {
		this.downloads.showFolder();
	}
	toggleDeveloperTools() {
		if (this.contents.isDevToolsOpened()) this.contents.closeDevTools();
		else this.contents.openDevTools({ mode: "detach" });
	}

	// Whether work that only lives in the page may be dropped.
	confirmLeave(action: "quit" | "reload") {
		if (!this.pendingWork.size && !this.downloads.hasActive) return true;
		this.focus();
		const choice = dialog.showMessageBoxSync(this.window, {
			type: "warning",
			message: text("leaveTitle"),
			detail: text("leaveDetail"),
			buttons: [
				text("keepWorking"),
				text(action === "quit" ? "quitAnyway" : "reloadAnyway"),
			],
			defaultId: 0,
			cancelId: 0,
		});
		return choice === 1;
	}

	// From here on closing the window closes it.
	prepareToQuit() {
		this.quitting = true;
		this.save();
	}

	private focusPage() {
		(this.status === "ready" ? this.contents : this.window.webContents).focus();
	}

	private layout = () => {
		if (this.window.isDestroyed()) return;
		const { width, height } = this.window.getContentBounds();
		// Full screen has no window buttons, so the band gives its room back.
		const top = this.window.isFullScreen() ? 0 : titleBand;
		this.view.setBounds({ x: 0, y: top, width, height: height - top });
	};

	private restrictPermissions(session: Session) {
		const allowed = new Set(["clipboard-sanitized-write", "fullscreen"]);
		session.setPermissionCheckHandler(
			(contents, permission, origin) =>
				contents === this.contents &&
				isAppUrl(origin, this.appUrl) &&
				allowed.has(permission),
		);
		session.setPermissionRequestHandler(
			(contents, permission, callback, details) =>
				callback(
					contents === this.contents &&
						details.isMainFrame &&
						isAppUrl(details.requestingUrl, this.appUrl) &&
						allowed.has(permission),
				),
		);
	}

	private watchPage() {
		const contents = this.contents;
		contents.setWindowOpenHandler(({ url }) => {
			openExternal(url);
			return { action: "deny" };
		});
		contents.on("will-navigate", (event) => {
			if (!isAppUrl(event.url, this.appUrl)) {
				event.preventDefault();
				openExternal(event.url);
			} else if (!this.confirmLeave("reload")) event.preventDefault();
		});
		contents.on("will-redirect", (event) => {
			if (!event.isMainFrame) return;
			if (isAppUrl(event.url, this.appUrl)) {
				if (this.load) this.load.url = event.url;
			} else {
				event.preventDefault();
				this.fail();
			}
		});
		contents.on("did-start-navigation", (event) => {
			if (
				!event.isMainFrame ||
				event.isSameDocument ||
				!isAppUrl(event.url, this.appUrl)
			)
				return;
			clearTimeout(this.load?.timer);
			const load = {
				url: event.url,
				failed: false,
				timer: setTimeout(() => {
					if (this.load === load) this.fail();
				}, loadTimeout),
			};
			this.load = load;
			this.events.changed();
		});
		contents.on("did-navigate", (_event, url, httpStatus) => {
			// A new document: the previous one's bridge and work are gone.
			this.bridgeReady = false;
			this.pendingWork.clear();
			if (httpStatus >= 400) this.fail();
			else if (isAppUrl(url, this.appUrl)) this.lastUrl = url;
			this.events.changed();
		});
		contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
			if (isMainFrame && isAppUrl(url, this.appUrl)) this.lastUrl = url;
			this.events.changed();
		});
		contents.on("did-fail-load", (_event, code, _description, _url, isMain) => {
			// ERR_ABORTED (-3) is a load replaced by another, not a failure.
			if (!isMain || code === -3) return;
			console.warn("[Heveta] The page failed to load", { code });
			this.fail();
		});
		contents.on("dom-ready", () => {
			if (!this.load || this.load.failed) return;
			clearTimeout(this.load.timer);
			this.load = undefined;
			this.setStatus("ready");
		});
		contents.on("render-process-gone", (_event, details) => {
			console.warn("[Heveta] The page's process ended", details.reason);
			clearTimeout(this.load?.timer);
			this.load = undefined;
			this.bridgeReady = false;
			this.pendingWork.clear();
			if (this.reloadingHungPage) {
				this.reloadingHungPage = false;
				this.retry();
			} else this.setStatus("crashed");
		});
		contents.on("unresponsive", () => void this.askAboutHang());
		contents.on("page-title-updated", (_event, title) => {
			if (!this.window.isDestroyed()) this.window.setTitle(title);
		});
		contents.on("context-menu", (_event, params) =>
			showContextMenu(this.window, contents, params, openExternal),
		);
		contents.on("zoom-changed", (_event, direction) =>
			this.zoom(direction === "in" ? 0.5 : -0.5),
		);
	}

	private watchWindow() {
		const window = this.window;
		// The window is named after the web app's page, not the client's own.
		window.on("page-title-updated", (event) => event.preventDefault());
		window.on("resize", this.layout);
		window.on("enter-full-screen", this.layout);
		window.on("leave-full-screen", this.layout);
		window.on("resize", this.saveSoon);
		window.on("move", this.saveSoon);
		window.on("focus", () => {
			this.focusPage();
			this.events.changed();
		});
		window.on("show", () => this.events.changed());
		window.on("hide", () => this.events.changed());
		window.on("close", (event) => {
			this.save();
			if (this.quitting) return;
			event.preventDefault();
			// A full-screen window leaves its space before it hides, or the
			// space stays behind, empty.
			if (window.isFullScreen()) {
				window.once("leave-full-screen", () => window.hide());
				window.setFullScreen(false);
			} else window.hide();
		});
		window.on("closed", () => {
			clearTimeout(this.load?.timer);
			clearTimeout(this.saveTimer);
			nativeTheme.removeListener("updated", this.onThemeUpdated);
			powerMonitor.removeListener("resume", this.onResume);
		});
	}

	private loadApp(url: string) {
		// A failure is reported by did-fail-load; the promise only repeats it.
		this.contents.loadURL(url).catch(() => {});
	}

	private fail() {
		if (this.load) {
			clearTimeout(this.load.timer);
			this.load.failed = true;
		}
		this.setStatus("failed");
	}

	private retry() {
		const url = this.load?.url ?? this.lastUrl;
		this.setStatus("loading");
		this.loadApp(url);
	}

	private setStatus(status: Status) {
		if (this.status === status || this.window.isDestroyed()) return;
		this.status = status;
		this.view.setVisible(status === "ready");
		this.sendShellState();
		this.sendQueuedPath();
		if (this.window.isFocused()) this.focusPage();
		this.events.changed();
	}

	// A path chosen before the web app could take it goes once it can.
	private sendQueuedPath() {
		if (!this.queuedPath || this.status !== "ready" || !this.bridgeReady)
			return;
		this.contents.send("desktop:navigate", this.queuedPath);
		this.queuedPath = undefined;
	}

	private sendShellState() {
		const panel: Record<Exclude<Status, "ready">, [MessageKey, MessageKey?]> = {
			loading: ["loading"],
			failed: ["loadFailed", "loadFailedDetail"],
			crashed: ["crashed", "crashedDetail"],
		};
		const [title, detail] = this.status === "ready" ? [] : panel[this.status];
		this.window.webContents.send("shell:state", {
			language: language(),
			bandHeight: titleBand,
			status: this.status,
			title: title && text(title),
			detail: detail && text(detail),
			retry: text("retry"),
		});
	}

	private fromShell(event: IpcMainEvent) {
		return event.senderFrame === this.window.webContents.mainFrame;
	}
	private onShellReady = (event: IpcMainEvent) => {
		if (this.fromShell(event)) this.sendShellState();
	};
	private onShellRetry = (event: IpcMainEvent) => {
		if (
			this.fromShell(event) &&
			(this.status === "failed" || this.status === "crashed")
		)
			this.retry();
	};

	// The desktop channels belong to the web app's top document alone.
	private fromApp(event: IpcMainEvent) {
		return (
			event.senderFrame === this.contents.mainFrame &&
			isAppUrl(event.senderFrame.url, this.appUrl)
		);
	}
	private onBridgeReady = (event: IpcMainEvent, ready: unknown) => {
		if (!this.fromApp(event) || typeof ready !== "boolean") return;
		this.bridgeReady = ready;
		this.sendQueuedPath();
	};
	private onAppearance = (
		event: IpcMainEvent,
		theme: unknown,
		locale: unknown,
	) => {
		if (!this.fromApp(event)) return;
		if (theme !== "system" && theme !== "light" && theme !== "dark") return;
		if (locale !== "en" && locale !== "zh-CN") return;
		nativeTheme.themeSource = theme;
		if (setLanguage(locale)) {
			this.sendShellState();
			this.events.languageChanged();
		}
		this.saveSoon();
	};
	private onPendingWork = (
		event: IpcMainEvent,
		source: unknown,
		pending: unknown,
	) => {
		if (!this.fromApp(event) || typeof pending !== "boolean") return;
		if (source !== "drafts" && source !== "upload") return;
		if (pending) this.pendingWork.add(source);
		else this.pendingWork.delete(source);
	};

	private onThemeUpdated = () => {
		if (this.window.isDestroyed()) return;
		this.window.setBackgroundColor(chromeColor());
		this.view.setBackgroundColor(chromeColor());
	};
	// A load that failed while the Mac slept or was offline is tried again.
	private onResume = () => {
		if (this.status === "failed" && this.isVisible) this.retry();
	};

	private async askAboutHang() {
		if (this.askingAboutHang || !this.isVisible) return;
		this.askingAboutHang = true;
		try {
			const { response } = await dialog.showMessageBox(this.window, {
				type: "warning",
				message: text("unresponsive"),
				detail: text("unresponsiveDetail"),
				buttons: [text("wait"), text("reloadAnyway")],
				defaultId: 0,
				cancelId: 0,
			});
			// A hung page cannot be reloaded; its process is ended, and the
			// page is loaded again once it has gone.
			if (response === 1 && !this.window.isDestroyed()) {
				this.reloadingHungPage = true;
				this.contents.forcefullyCrashRenderer();
			}
		} finally {
			this.askingAboutHang = false;
		}
	}

	private saveSoon = () => {
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => this.save(), 400);
	};
	private save() {
		clearTimeout(this.saveTimer);
		if (this.window.isDestroyed()) return;
		writePreferences({
			bounds: this.window.getNormalBounds(),
			maximized: this.window.isMaximized(),
			zoomLevel: this.contents.getZoomLevel(),
			theme: nativeTheme.themeSource,
			language: language(),
		});
	}
}
