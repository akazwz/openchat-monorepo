import { createDatabase, type Database } from "@/db/client";
import { avatarContent, purgeAvatarGarbage } from "@/modules/auth/avatar";
import { purgeExpiredAuthRecords } from "@/modules/auth/service";
import { deviceFile, openDeviceConnection } from "@/modules/devices/http";
import { openEventChannel } from "@/modules/events/channel";
import { fileContent } from "@/modules/files/content";
import { cleanupFiles } from "@/modules/files/lifecycle";
import { uploadFile } from "@/modules/files/upload";
import { receiveEmail } from "@/modules/mail/inbound";
import { purgeWithdrawnRequests } from "@/modules/runs/store";
import { openConnection } from "@/modules/sandbox/connections";
import {
	downloadComputerFile,
	uploadComputerFile,
} from "@/modules/sandbox/workspace-files";
import { handler } from "@/rpc/router";

export { UserHub } from "@/modules/events/hub";
export { RunActor } from "@/modules/runs/actor";
// The user's native computer; snapshot handles live in its DO storage.
export { Computer } from "@/modules/sandbox/computer-object";
export { DeviceConnection } from "@/modules/devices/connection";

// What each of the Worker's cron triggers (cloudflare.config.ts) runs: garbage
// collection only. Runs need no sweep; each is armed before it is accepted
// (runs/delivery.ts).
const scheduledTasks: Record<string, (db: Database) => Promise<void>> = {
	"17 * * * *": async (db) => {
		await purgeExpiredAuthRecords(db);
		const removed = await cleanupFiles(db);
		if (removed) console.info("Unused files removed", { count: removed });
		await purgeWithdrawnRequests(db);
		await purgeAvatarGarbage(db);
	},
};

export default {
	// Mail to the agents' addresses (docs/email.md).
	async email(message) {
		await receiveEmail(message);
	},
	async scheduled(controller) {
		const task = scheduledTasks[controller.cron];
		if (!task) throw new Error(`No task for cron "${controller.cron}"`);
		const database = createDatabase();
		try {
			await task(database.db);
		} finally {
			await database.close();
		}
	},
	async fetch(request, env, ctx): Promise<Response> {
		// The web app is served from this Worker, so RPCs are same-origin.
		const pathname = new URL(request.url).pathname;
		if (pathname === "/device/connect" && request.method === "GET")
			return openDeviceConnection(request, false);
		if (pathname === "/device/remote" && request.method === "GET")
			return openDeviceConnection(request, true);
		if (pathname === "/device/file" && ["GET", "POST"].includes(request.method))
			return deviceFile(request);
		if (pathname === "/events" && request.method === "GET")
			return openEventChannel(request);
		if (pathname === "/screen" && request.method === "GET")
			return openConnection(request, "screen");
		if (pathname === "/upload" && request.method === "POST")
			return uploadFile(request);
		if (pathname === "/terminal" && request.method === "GET")
			return openConnection(request, "terminal");
		if (pathname === "/computer-file" && request.method === "GET")
			return downloadComputerFile(request);
		if (pathname === "/computer-file" && request.method === "POST")
			return uploadComputerFile(request);
		if (request.method === "GET" || request.method === "HEAD") {
			if (pathname.startsWith("/files/")) {
				return fileContent(request);
			}
			if (pathname.startsWith("/avatars/")) return avatarContent(request);
			if (!handler.hasRoute(pathname)) return env.ASSETS.fetch(request);
		}
		return handler.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
