import { app } from "electron";

export type Language = "en" | "zh-CN";

// Everything the client itself says: menus, dialogs, its own pages, the menu
// bar item. The web app's text is the web app's.
const messages = {
	en: {
		settings: "Settings…",
		file: "File",
		newChat: "New Chat",
		showDownloads: "Show Downloads",
		view: "View",
		reload: "Reload",
		back: "Back",
		forward: "Forward",
		actualSize: "Actual Size",
		zoomIn: "Zoom In",
		zoomOut: "Zoom Out",
		developerTools: "Developer Tools",
		showWindow: "Show Heveta",
		help: "Help",
		website: "Heveta Website",
		quit: "Quit Heveta",

		openLink: "Open Link in Browser",
		copyLink: "Copy Link",
		addToDictionary: "Add to Dictionary",

		loading: "Opening Heveta…",
		loadFailed: "Heveta couldn’t load",
		loadFailedDetail: "Check your connection and try again.",
		crashed: "This page stopped working",
		crashedDetail: "Reload to continue. Unsent changes may have been lost.",
		retry: "Try Again",

		leaveTitle: "You have unfinished work",
		leaveDetail:
			"Unsent drafts, uploads, or downloads will be lost. Closing the window keeps them; quitting or reloading does not.",
		keepWorking: "Keep Working",
		quitAnyway: "Quit",
		reloadAnyway: "Reload",
		unresponsive: "Heveta is not responding",
		unresponsiveDetail:
			"Wait for the page, or reload it. Reloading may lose unsent changes.",
		wait: "Keep Waiting",

		saveFile: "Save File",
		downloadFailed: "The download could not be completed",
		downloadFailedDetail: "Check your connection and download the file again.",

		deviceOnline: "This Mac is connected",
		deviceConnecting: "Connecting this Mac…",
		deviceOff: "Access to this Mac is off",
		deviceViewers: "Screen is being viewed: {count}",
		deviceAccess: "Allow Access to This Mac",

		errorCredentials:
			"The saved connection could not be read. Connect this Mac again.",
		errorRevoked:
			"This Mac was disconnected from your account. Connect it again.",
		errorReplaced:
			"Another Heveta app connected as this Mac. Turn access on again to use this one.",
		errorCommands: "Commands stopped unexpectedly. Turn access on again.",
		errorProtocol: "Update Heveta to connect this Mac.",
	},
	"zh-CN": {
		settings: "设置…",
		file: "文件",
		newChat: "新对话",
		showDownloads: "显示下载文件夹",
		view: "显示",
		reload: "重新加载",
		back: "后退",
		forward: "前进",
		actualSize: "实际大小",
		zoomIn: "放大",
		zoomOut: "缩小",
		developerTools: "开发者工具",
		showWindow: "显示 Heveta",
		help: "帮助",
		website: "Heveta 官网",
		quit: "退出 Heveta",

		openLink: "在浏览器中打开链接",
		copyLink: "复制链接",
		addToDictionary: "添加到词典",

		loading: "正在打开 Heveta…",
		loadFailed: "无法加载 Heveta",
		loadFailedDetail: "请检查网络连接，然后重试。",
		crashed: "页面已停止工作",
		crashedDetail: "重新加载即可继续。未发送的内容可能已经丢失。",
		retry: "重试",

		leaveTitle: "还有未完成的内容",
		leaveDetail:
			"未发送的草稿、上传或下载会丢失。关闭窗口会保留它们，退出或重新加载则不会。",
		keepWorking: "继续使用",
		quitAnyway: "退出",
		reloadAnyway: "重新加载",
		unresponsive: "Heveta 没有响应",
		unresponsiveDetail:
			"可以继续等待，或重新加载页面。重新加载可能丢失未发送的内容。",
		wait: "继续等待",

		saveFile: "保存文件",
		downloadFailed: "文件下载未完成",
		downloadFailedDetail: "请检查网络连接，然后重新下载。",

		deviceOnline: "这台 Mac 已连接",
		deviceConnecting: "正在连接这台 Mac…",
		deviceOff: "这台 Mac 的访问已关闭",
		deviceViewers: "正在被查看屏幕：{count}",
		deviceAccess: "允许访问这台 Mac",

		errorCredentials: "无法读取已保存的连接信息，请重新连接这台 Mac。",
		errorRevoked: "这台 Mac 已从你的账号断开，请重新连接。",
		errorReplaced:
			"另一个 Heveta 应用以这台 Mac 的身份连接了。要使用这一个，请重新开启访问。",
		errorCommands: "命令执行意外停止，请重新开启访问。",
		errorProtocol: "请更新 Heveta 后再连接这台 Mac。",
	},
} satisfies Record<Language, Record<string, string>>;

export type MessageKey = keyof (typeof messages)["en"];

let chosen: Language | undefined;

// The language the web app is set to, once it has said so; the system's
// before that.
export function language(): Language {
	return (
		chosen ??
		(app.getPreferredSystemLanguages()[0]?.startsWith("zh") ? "zh-CN" : "en")
	);
}

// Returns whether the language changed.
export function setLanguage(value: Language) {
	const previous = language();
	chosen = value;
	return previous !== value;
}

export function text(
	key: MessageKey,
	values?: Record<string, string | number>,
) {
	const message: string = messages[language()][key];
	if (!values) return message;
	return message.replace(/\{(\w+)\}/g, (_match, name: string) =>
		String(values[name] ?? ""),
	);
}
