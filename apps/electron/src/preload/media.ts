import { contextBridge, ipcRenderer } from "electron";

import type { MediaApi, MediaCommand } from "../pages/media-api";

// For the client's screen-sharing page alone.
if (process.isMainFrame && location.protocol === "heveta-shell:") {
	const api: MediaApi = {
		onCommand(callback) {
			ipcRenderer.on("media:command", (_event, command: MediaCommand) =>
				callback(command),
			);
			ipcRenderer.send("media:ready");
		},
		send(event) {
			ipcRenderer.send("media:event", event);
		},
	};
	contextBridge.exposeInMainWorld("hevetaMedia", api);
}
