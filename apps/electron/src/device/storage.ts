import { randomUUID } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { app, safeStorage } from "electron";

import { type Binding, isRecord } from "./protocol";

// What this installation keeps about being a device: an ID of its own, which
// the server uses to recognise the same Mac when it is connected again, and
// the binding, whose credential is encrypted with a key in the macOS Keychain.
export class DeviceStorage {
	readonly root = join(app.getPath("userData"), "device");
	readonly clientId: string;
	private readonly bindingFile = join(this.root, "binding");

	constructor() {
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		const idFile = join(this.root, "client-id");
		let id: string | undefined;
		try {
			id = readFileSync(idFile, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		if (!id) {
			id = randomUUID();
			writeFileSync(idFile, id, { mode: 0o600 });
		}
		this.clientId = id;
	}

	// The binding made with this server, if any. Throws when one is saved but
	// cannot be read: the caller says so instead of silently forgetting it.
	read(origin: string): Binding | undefined {
		let encrypted: Buffer;
		try {
			encrypted = readFileSync(this.bindingFile);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		const value: unknown = JSON.parse(safeStorage.decryptString(encrypted));
		if (!isRecord(value) || value.origin !== origin) return undefined;
		const { userId, deviceId, credential, workspace } = value;
		if (
			typeof userId !== "string" ||
			typeof deviceId !== "string" ||
			typeof credential !== "string" ||
			typeof workspace !== "string"
		)
			throw new Error("The saved device binding is incomplete");
		return { origin, userId, deviceId, credential, workspace };
	}

	write(binding: Binding) {
		writeFileSync(
			`${this.bindingFile}.tmp`,
			safeStorage.encryptString(JSON.stringify(binding)),
			{ mode: 0o600 },
		);
		renameSync(`${this.bindingFile}.tmp`, this.bindingFile);
	}

	clear() {
		rmSync(this.bindingFile, { force: true });
	}
}
