import { contextBridge, ipcRenderer } from "electron";

// The web app's two interfaces to the client. A sandboxed preload cannot load
// other modules, so this file stands alone; it hands the page functions over
// fixed channels, never Electron objects, and only to the app's top document.
const origin = process.argv
	.find((argument) => argument.startsWith("--heveta-origin="))
	?.slice("--heveta-origin=".length);

if (process.isMainFrame && location.origin === origin) {
	const device = (method: string, value?: unknown) =>
		ipcRenderer.invoke("device:call", method, value);

	// This Mac as a device the agent can use (features/devices/native.ts in
	// the web app). The native macOS client offers the same interface.
	contextBridge.exposeInMainWorld("hevetaNative", {
		version: 1,
		info: () => device("info"),
		bind: (binding: unknown) => device("bind", binding),
		setEnabled: (enabled: boolean) => device("setEnabled", enabled),
		unbind: () => device("unbind"),
		syncUser: (userId: string) => device("syncUser", userId),
		screenPermission: () => device("screenPermission"),
		inputPermission: () => device("inputPermission"),
		onInfo(callback: (info: unknown) => void) {
			const listener = (_event: unknown, info: unknown) => callback(info);
			ipcRenderer.on("device:info", listener);
			return () => ipcRenderer.removeListener("device:info", listener);
		},
	});

	// The window around the web app (lib/desktop.ts in the web app).
	contextBridge.exposeInMainWorld("hevetaDesktop", {
		version: 1,
		onNavigate(callback: (path: string) => void) {
			const listener = (_event: unknown, path: string) => callback(path);
			ipcRenderer.on("desktop:navigate", listener);
			ipcRenderer.send("desktop:ready", true);
			return () => {
				ipcRenderer.removeListener("desktop:navigate", listener);
				ipcRenderer.send("desktop:ready", false);
			};
		},
		setAppearance(theme: string, language: string) {
			ipcRenderer.send("desktop:appearance", theme, language);
		},
		setPendingWork(source: string, pending: boolean) {
			ipcRenderer.send("desktop:pending-work", source, pending);
		},
	});
}
