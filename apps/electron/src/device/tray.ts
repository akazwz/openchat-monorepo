import { join } from "node:path";

import { app, Menu, nativeImage, Tray } from "electron";

import { text } from "../messages";
import type { DeviceHost } from "./host";

// The menu bar item of a Mac that is connected to the account: whether it
// can be reached now, how many people are looking at its screen, and the
// switch for both. A Mac that is not connected has none.
export class DeviceTray {
	private tray?: Tray;

	constructor(
		private readonly host: DeviceHost,
		private readonly actions: { showWindow(): void; openSettings(): void },
	) {}

	update() {
		const { host } = this;
		if (!host.isBound) {
			this.tray?.destroy();
			this.tray = undefined;
			return;
		}
		this.tray ??= this.create();
		const status = text(
			host.isOnline
				? "deviceOnline"
				: host.isEnabled
					? "deviceConnecting"
					: "deviceOff",
		);
		const notes = [
			host.viewers && text("deviceViewers", { count: host.viewers }),
			host.errorText,
		].filter((note): note is string => Boolean(note));
		this.tray.setToolTip(status);
		// A count beside the icon while the screen is being viewed.
		this.tray.setTitle(host.viewers ? String(host.viewers) : "");
		this.tray.setContextMenu(
			Menu.buildFromTemplate([
				{ label: status, enabled: false },
				...notes.map((label) => ({ label, enabled: false })),
				{ type: "separator" },
				{
					label: text("deviceAccess"),
					type: "checkbox",
					checked: host.isEnabled,
					click: () => {
						host.setEnabled(!host.isEnabled).catch((error: unknown) => {
							console.warn("[Heveta] Device access could not change", error);
							this.update();
						});
					},
				},
				{ type: "separator" },
				{ label: text("showWindow"), click: this.actions.showWindow },
				{ label: text("settings"), click: this.actions.openSettings },
				{ type: "separator" },
				{ label: text("quit"), click: () => app.quit() },
			]),
		);
	}

	destroy() {
		this.tray?.destroy();
		this.tray = undefined;
	}

	private create() {
		// A template image: macOS draws it in the menu bar's own color.
		const icon = nativeImage.createFromPath(
			join(__dirname, "../resources/trayTemplate.png"),
		);
		icon.setTemplateImage(true);
		return new Tray(icon);
	}
}
