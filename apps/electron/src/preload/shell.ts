import { contextBridge, ipcRenderer } from "electron";

import type { ShellApi, ShellState } from "../pages/shell-api";

// For the window's own page alone.
if (process.isMainFrame && location.protocol === "heveta-shell:") {
	const api: ShellApi = {
		onState(callback) {
			ipcRenderer.on("shell:state", (_event, state: ShellState) =>
				callback(state),
			);
			ipcRenderer.send("shell:ready");
		},
		retry() {
			ipcRenderer.send("shell:retry");
		},
	};
	contextBridge.exposeInMainWorld("hevetaShell", api);
}
