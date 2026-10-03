import { defineMessages } from "~/i18n/catalog";

// What the whole app shares: loading, failures, and the color modes.
export default defineMessages("common", {
	en: {
		loading: "{brand} is loading",
		notFoundTitle: "Page not found",
		notFoundDescription: "This link may no longer work.",
		errorTitle: "Something went wrong",
		errorDescription: "Reloading the page usually fixes it.",
		home: "Go home",
		reload: "Reload",
		retry: "Try again",
		colorModeSystem: "System",
		colorModeLight: "Light",
		colorModeDark: "Dark",
	},
	"zh-CN": {
		loading: "{brand} 正在加载",
		notFoundTitle: "页面不存在",
		notFoundDescription: "这个链接可能已经失效。",
		errorTitle: "出了点问题",
		errorDescription: "刷新页面通常就能恢复。",
		home: "回到首页",
		reload: "刷新",
		retry: "重新加载",
		colorModeSystem: "跟随系统",
		colorModeLight: "浅色",
		colorModeDark: "深色",
	},
});
