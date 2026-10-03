// The site's languages: English at /, Chinese at /zh/.
export type SiteLocale = "en" | "zh-CN";
export const localePaths: Record<SiteLocale, string> = {
	en: "/",
	"zh-CN": "/zh/",
};

export const localeOf = (pathname: string): SiteLocale =>
	pathname === "/zh" || pathname.startsWith("/zh/") ? "zh-CN" : "en";

// Each language's copy, with the same shape (a missing entry fails to
// compile). What it can do is what the app does (apps/server/src/modules);
// nothing it cannot.
const en = {
	pageTitle: "Heveta · An AI assistant with its own computer",
	heading: "An AI assistant with its own computer",
	description:
		"Heveta is an AI assistant with a Linux computer of its own in the cloud: it runs commands, works with files, and browses the web, then sends you what it made.",
	start: "Get started",
	signIn: "Sign in",
	otherLanguage: "中文",
	screenshotAlt:
		"A conversation in Heveta: the chat on the left, its computer’s screen on the right",
	capabilitiesHeading: "What it can do",
	capabilities: [
		{
			title: "A computer of its own",
			text: "A full Linux environment with Python, Node.js, and common tools. It runs commands, installs software, and writes and runs code; the files in its workspace stay.",
		},
		{
			title: "A browser you can watch",
			text: "It opens pages, clicks, and fills in forms in the browser on its screen. Watch it work, or take over yourself.",
		},
		{
			title: "Files in, results out",
			text: "Send it images, PDFs, spreadsheets, or any file; it works on them on its computer, and the charts and documents it makes appear right in its reply.",
		},
		{
			title: "Research",
			text: "It searches the web, reads the pages, and turns what it finds into an answer.",
		},
		{
			title: "Remembers what you tell it",
			text: "Preferences and facts you ask it to remember carry over to new conversations; see and delete them in settings.",
		},
		{
			title: "Pick up on any device",
			text: "Close the page and the reply still finishes; your phone and your computer show the same conversation.",
		},
	],
	closingHeading: "Start using Heveta",
	closingText:
		"Sign in with your email; your first sign-in creates your account.",
};

const zh: typeof en = {
	pageTitle: "Heveta · 有自己电脑的 AI 助手",
	heading: "有自己电脑的 AI 助手",
	description:
		"Heveta 是一个 AI 助手。它在云端有一台自己的 Linux 电脑：能运行命令、处理文件、打开网页，做好的东西直接发给你。",
	start: "开始使用",
	signIn: "登录",
	otherLanguage: "English",
	screenshotAlt: "Heveta 的对话页面：左边是对话，右边是它的电脑屏幕",
	capabilitiesHeading: "它能做什么",
	capabilities: [
		{
			title: "一台自己的电脑",
			text: "完整的 Linux 环境，预装 Python、Node.js 和常用工具。它运行命令、安装软件、写代码并运行，工作区里的文件一直都在。",
		},
		{
			title: "看得见的浏览器",
			text: "它在电脑屏幕上的浏览器里打开网页、点击、填写。你可以在旁边看着，也可以接过来自己操作。",
		},
		{
			title: "文件进，成品出",
			text: "发给它图片、PDF、表格或任何文件，它放到电脑上处理；做好的图表和文档直接出现在回复里。",
		},
		{
			title: "查资料",
			text: "搜索网页、读取原文，把找到的内容整理成回答。",
		},
		{
			title: "记得你说过的",
			text: "让它记住的偏好和信息，下次对话依然有效；在设置里随时查看和删除。",
		},
		{
			title: "换台设备接着看",
			text: "关掉页面，回复照样在后台完成；手机和电脑上打开的是同一份对话。",
		},
	],
	closingHeading: "开始使用 Heveta",
	closingText: "用邮箱登录，第一次登录就会创建账号。",
};

export const copy: Record<SiteLocale, typeof en> = { en, "zh-CN": zh };
