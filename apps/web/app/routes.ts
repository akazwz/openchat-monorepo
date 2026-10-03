import {
	index,
	layout,
	type RouteConfig,
	route,
} from "@react-router/dev/routes";

export default [
	layout("routes/signed-in-layout.tsx", { id: "signed-in" }, [
		// Conversations, computer, and mail share one sidebar and main region.
		layout("routes/app-layout.tsx", { id: "routes/layout" }, [
			index("routes/thread.tsx", { id: "home" }),
			route("threads/:threadId", "routes/thread.tsx", { id: "thread" }),
			route("devices/:deviceId", "routes/remote-desktop.tsx", {
				id: "remote-desktop",
			}),
			route("computer", "routes/computer.tsx", { id: "computer" }),
			route("computer/terminal", "routes/terminal.tsx", { id: "terminal" }),
			route("computer/files", "routes/computer-files.tsx", {
				id: "computer-files",
			}),
			// The agent's mailbox: its folders, and an email (docs/email.md).
			route("mail", "routes/mail.tsx", { id: "mail" }),
			route("mail/sent", "routes/mail.tsx", { id: "mail-sent" }),
			route("mail/:emailId", "routes/mail.tsx", { id: "email" }),
		]),
		// Settings replace the whole app with their own section navigation.
		layout("routes/settings-layout.tsx", { id: "settings-layout" }, [
			route("settings", "routes/settings.tsx", { id: "settings-index" }),
			route("settings/:section", "routes/settings.tsx", { id: "settings" }),
		]),
	]),
	route("signin", "routes/signin.tsx"),
] satisfies RouteConfig;
