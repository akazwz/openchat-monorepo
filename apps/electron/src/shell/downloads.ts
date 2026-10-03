import { basename, join } from "node:path";

import {
	app,
	type BrowserWindow,
	dialog,
	type DownloadItem,
	type Session,
	shell,
	type WebContents,
} from "electron";

import { isAppDownload } from "../config";
import { text } from "../messages";

// Files the web app saves: a system save panel, progress on the Dock icon,
// and a bounce of the Downloads stack when one finishes.
export class Downloads {
	private active = new Set<DownloadItem>();

	constructor(
		private readonly window: BrowserWindow,
		contents: WebContents,
		appUrl: URL,
		session: Session,
	) {
		session.on("will-download", (event, item, source) => {
			if (source !== contents || !isAppDownload(item.getURL(), appUrl)) {
				event.preventDefault();
				return;
			}
			this.track(item);
		});
	}

	get hasActive() {
		return this.active.size > 0;
	}

	showFolder() {
		void shell.openPath(app.getPath("downloads")).then((error) => {
			if (error) console.warn("[Heveta] Could not open Downloads", error);
		});
	}

	private track(item: DownloadItem) {
		// The server names the file; only its last component is taken.
		const name = basename(item.getFilename());
		item.setSaveDialogOptions({
			title: text("saveFile"),
			defaultPath: join(
				app.getPath("downloads"),
				name && name !== "." && name !== ".." ? name : "download",
			),
			properties: ["createDirectory", "showOverwriteConfirmation"],
		});
		this.active.add(item);
		const progress = () => this.showProgress();
		item.on("updated", progress);
		item.once("done", (_event, state) => {
			item.removeListener("updated", progress);
			this.active.delete(item);
			this.showProgress();
			if (state === "completed") app.dock?.downloadFinished(item.getSavePath());
			else if (state === "interrupted" && !this.window.isDestroyed())
				void dialog.showMessageBox(this.window, {
					type: "warning",
					message: text("downloadFailed"),
					detail: text("downloadFailedDetail"),
				});
		});
		this.showProgress();
	}

	private showProgress() {
		if (this.window.isDestroyed()) return;
		if (!this.active.size) {
			this.window.setProgressBar(-1);
			return;
		}
		let total = 0;
		let received = 0;
		let sized = true;
		for (const item of this.active) {
			if (!item.getTotalBytes()) sized = false;
			total += item.getTotalBytes();
			received += item.getReceivedBytes();
		}
		// Above 1 is Electron's indeterminate bar, for a download of unknown size.
		this.window.setProgressBar(sized ? Math.min(1, received / total) : 2);
	}
}
