import { defineMessages } from "~/i18n/catalog";

// A file attached to or sent in a message (file-card.tsx).
export default defineMessages("files", {
	en: {
		file: "File",
		download: "Download {name}",
		downloadFailed: "{name} failed to download. Try again later.",
	},
	"zh-CN": {
		file: "文件",
		download: "下载 {name}",
		downloadFailed: "{name} 下载失败，请稍后重试。",
	},
});
