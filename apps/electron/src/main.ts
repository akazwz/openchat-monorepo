import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { app, nativeImage, session } from "electron";

import { appNameFor, isAppUrl, readAppUrl } from "./config";
import { DeviceHost } from "./device/host";
import { DeviceTray } from "./device/tray";
import { readPreferences } from "./preferences";
import { installMenu, refreshMenu } from "./shell/menu";
import { registerPageScheme, servePages } from "./shell/pages";
import { ShellWindow } from "./shell/window";

const appUrl = readAppUrl();
app.setName(appNameFor(appUrl, app.isPackaged));
// Both paths are set before Chromium starts. The profile is the client's
// own: the browser's and the native macOS client's sign-ins are separate.
const profile = join(app.getPath("appData"), app.name);
mkdirSync(join(profile, "Chromium"), { recursive: true, mode: 0o700 });
app.setPath("userData", profile);
app.setPath("sessionData", join(profile, "Chromium"));
registerPageScheme();

let shell: ShellWindow | undefined;
// Quitting waits for what must be put away first, then goes through.
let quitting: "no" | "preparing" | "ready" = "no";

function start() {
	// The client's own pages, kept apart from the web app's persistent session.
	const local = session.fromPartition("heveta-local");
	const web = session.fromPartition("persist:heveta-web");
	servePages(local);

	// A packaged app has its icon in the bundle.
	if (!app.isPackaged)
		app.dock?.setIcon(
			nativeImage.createFromPath(join(__dirname, "../resources/icon.png")),
		);
	app.setAboutPanelOptions({
		applicationName: app.name,
		applicationVersion: app.getVersion(),
	});

	const device = new DeviceHost(appUrl, local, () => deviceChanged());
	const window = new ShellWindow(
		appUrl,
		readPreferences(),
		{ local, web },
		{
			// The window reports while it is still being made.
			changed() {
				if (shell) refreshMenu(shell);
			},
			languageChanged() {
				if (shell) installMenu(shell);
				deviceChanged();
			},
		},
	);
	shell = window;
	const tray = new DeviceTray(device, {
		showWindow: () => window.focus(),
		openSettings: () => window.navigate("/settings"),
	});
	// The device's state, to the two places that show it.
	function deviceChanged() {
		tray.update();
		const page = window.contents;
		if (!page.isDestroyed() && isAppUrl(page.getURL(), appUrl))
			page.send("device:info", device.info());
	}

	// The web app's device interface (preload/app.ts): its top document only.
	window.contents.ipc.handle("device:call", (event, method, value) => {
		if (
			event.senderFrame !== window.contents.mainFrame ||
			!isAppUrl(event.senderFrame.url, appUrl)
		)
			throw new Error("Untrusted device request");
		return device.call(method, value);
	});
	// Coming back from System Settings is when a permission may have changed.
	window.window.on("focus", () => device.refreshPermissions());
	installMenu(window);
	tray.update();

	app.on("before-quit", (event) => {
		if (quitting === "ready") return;
		event.preventDefault();
		if (quitting === "preparing" || !window.confirmLeave("quit")) return;
		quitting = "preparing";
		window.prepareToQuit();
		web.flushStorageData();
		void Promise.allSettled([device.shutdown(), web.cookies.flushStore()]).then(
			() => {
				tray.destroy();
				quitting = "ready";
				app.quit();
			},
		);
	});
}

if (process.platform !== "darwin") {
	console.error("Heveta Electron runs on macOS only.");
	app.quit();
} else if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on("second-instance", () => shell?.focus());
	app.on("activate", () => shell?.focus());
	// Closing the window hides it; the client stays in the Dock.
	app.on("window-all-closed", () => {});
	process.on("SIGTERM", () => app.quit());
	process.on("SIGINT", () => app.quit());
	void app.whenReady().then(start);
}
