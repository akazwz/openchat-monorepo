import { app, Menu, type MenuItemConstructorOptions } from "electron";

import { text } from "../messages";
import { openExternal, type ShellWindow } from "./window";

const zoomStep = 0.5;

// The application menu and the Dock menu, in the web app's language. Built
// again when the language changes; `refreshMenu` keeps the items that depend
// on the page enabled or not.
export function installMenu(shell: ShellWindow) {
	const template: MenuItemConstructorOptions[] = [
		{
			label: app.name,
			submenu: [
				{ role: "about" },
				{ type: "separator" },
				{
					label: text("settings"),
					accelerator: "Command+,",
					click: () => shell.navigate("/settings"),
				},
				{ type: "separator" },
				{ role: "services" },
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ role: "unhide" },
				{ type: "separator" },
				{ role: "quit" },
			],
		},
		{
			label: text("file"),
			submenu: [
				{
					label: text("newChat"),
					accelerator: "Command+N",
					click: () => shell.navigate("/"),
				},
				{
					label: text("showDownloads"),
					accelerator: "Command+Shift+J",
					click: () => shell.showDownloads(),
				},
				{ type: "separator" },
				{ role: "close" },
			],
		},
		{ role: "editMenu" },
		{
			label: text("view"),
			submenu: [
				{
					id: "reload",
					label: text("reload"),
					accelerator: "Command+R",
					click: () => shell.reload(),
				},
				{ type: "separator" },
				{
					id: "back",
					label: text("back"),
					accelerator: "Command+[",
					click: () => shell.goBack(),
				},
				{
					id: "forward",
					label: text("forward"),
					accelerator: "Command+]",
					click: () => shell.goForward(),
				},
				{ type: "separator" },
				{
					id: "actualSize",
					label: text("actualSize"),
					accelerator: "Command+0",
					click: () => shell.zoom(),
				},
				{
					id: "zoomIn",
					label: text("zoomIn"),
					accelerator: "Command+Plus",
					click: () => shell.zoom(zoomStep),
				},
				{
					id: "zoomOut",
					label: text("zoomOut"),
					accelerator: "Command+-",
					click: () => shell.zoom(-zoomStep),
				},
				{ type: "separator" },
				{ role: "togglefullscreen" },
				...(app.isPackaged
					? []
					: [
							{
								label: text("developerTools"),
								accelerator: "Alt+Command+I",
								click: () => shell.toggleDeveloperTools(),
							},
						]),
			],
		},
		{
			role: "windowMenu",
			submenu: [
				{ role: "minimize" },
				{ role: "zoom" },
				{ type: "separator" },
				{ label: text("showWindow"), click: () => shell.focus() },
				{ role: "front" },
			],
		},
		{
			label: text("help"),
			submenu: [
				{
					label: text("website"),
					click: () => openExternal("https://heveta.com"),
				},
			],
		},
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
	app.dock?.setMenu(
		Menu.buildFromTemplate([
			{ label: text("showWindow"), click: () => shell.focus() },
			{ label: text("newChat"), click: () => shell.navigate("/") },
		]),
	);
	refreshMenu(shell);
}

export function refreshMenu(shell: ShellWindow) {
	const menu = Menu.getApplicationMenu();
	const enabled: Record<string, boolean> = {
		reload: shell.isVisible,
		back: shell.canGoBack,
		forward: shell.canGoForward,
		actualSize: shell.isShowingApp,
		zoomIn: shell.isShowingApp,
		zoomOut: shell.isShowingApp,
	};
	for (const [id, value] of Object.entries(enabled)) {
		const item = menu?.getMenuItemById(id);
		if (item) item.enabled = value;
	}
}
