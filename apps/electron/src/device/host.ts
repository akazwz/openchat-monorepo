import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

import type { Session } from "electron";

import { type MessageKey, text } from "../messages";
import { Execution } from "./execution";
import { DeviceLink, type LinkEnd } from "./link";
import {
	readPermissions,
	requestInputPermission,
	requestScreenPermission,
} from "./permissions";
import {
	type Binding,
	type BrokerMessage,
	type Command,
	type DeviceInfo,
	isId,
	isRecord,
} from "./protocol";
import { RemoteDesktop } from "./remote";
import { DeviceStorage } from "./storage";

// macOS tells nobody when a privacy permission changes; while this Mac can
// be reached, the two it needs are read again this often.
const permissionInterval = 3000;

const linkErrors: Record<LinkEnd, MessageKey> = {
	revoked: "errorRevoked",
	replaced: "errorReplaced",
	protocol: "errorProtocol",
};

// The Mac's name as its owner gave it ("Ada’s MacBook Pro").
function computerName() {
	try {
		const name = execFileSync("scutil", ["--get", "ComputerName"], {
			encoding: "utf8",
		}).trim();
		if (name) return name;
	} catch {
		// Not set: the network name will do.
	}
	return hostname().replace(/\.local$/, "");
}

// This Mac as a device of the account signed in in the web app: bound to it
// by a credential, and, while its owner allows, reachable by the agent
// (commands, files, the screen) and by its owner from another device (the
// screen). Access is off whenever the client starts; the binding stays.
//
// The web app drives it through `call` (the hevetaNative interface) and the
// menu bar item through `setEnabled`; `changed` tells both when to read it
// again.
export class DeviceHost {
	private readonly storage = new DeviceStorage();
	private readonly remote: RemoteDesktop;
	private readonly name = computerName();
	private readonly defaultWorkspace = join(homedir(), "Heveta");
	private binding?: Binding;
	// The account the web app is signed in to.
	private userId = "";
	private enabled = false;
	private online = false;
	private error?: MessageKey;
	private link?: DeviceLink;
	private execution?: Execution;
	private permissions = readPermissions();
	private permissionTimer?: NodeJS.Timeout;
	// Binding and turning access on or off happen one at a time.
	private queue: Promise<unknown> = Promise.resolve();
	private shutDown = false;

	constructor(
		private readonly appUrl: URL,
		localSession: Session,
		private readonly changed: () => void,
	) {
		try {
			this.binding = this.storage.read(appUrl.origin);
		} catch (error) {
			console.warn("[Heveta] The device binding could not be read", error);
			this.error = "errorCredentials";
		}
		this.remote = new RemoteDesktop(localSession, {
			allowed: () => this.online,
			send: (message) => this.link?.send(message),
			changed: () => this.changed(),
		});
	}

	// Whether this Mac is bound to the account signed in now.
	get isBound() {
		return !!this.binding && this.binding.userId === this.userId;
	}
	get isEnabled() {
		return this.enabled;
	}
	get isOnline() {
		return this.online;
	}
	get viewers() {
		return this.remote.viewers;
	}
	get errorText() {
		return this.error ? text(this.error) : null;
	}

	info(): DeviceInfo {
		return {
			clientId: this.storage.clientId,
			name: this.name,
			osVersion: `macOS ${process.getSystemVersion()}`,
			workspacePath: this.binding?.workspace ?? this.defaultWorkspace,
			deviceId: this.binding?.deviceId ?? "",
			userId: this.binding?.userId ?? "",
			enabled: this.enabled,
			online: this.online,
			screenAllowed: this.permissions.screen,
			inputAllowed: this.permissions.input,
			error: this.errorText,
		};
	}

	// One request from the web app.
	async call(method: unknown, value: unknown): Promise<DeviceInfo> {
		if (this.shutDown) throw new Error("Heveta is quitting");
		switch (method) {
			case "info":
				break;
			// The system's permission dialogs stay out of the queue: turning
			// access off must not wait for them.
			case "screenPermission":
				await requestScreenPermission();
				break;
			case "inputPermission":
				await requestInputPermission();
				break;
			case "syncUser":
				if (typeof value !== "string" || value.length > 200)
					throw new Error("Invalid account");
				await this.enqueue(() => this.syncUser(value));
				break;
			case "bind":
				await this.enqueue(() => this.bind(value));
				break;
			case "unbind":
				await this.enqueue(() => this.unbind());
				break;
			case "setEnabled":
				if (typeof value !== "boolean") throw new Error("Invalid setting");
				await this.setEnabled(value);
				break;
			default:
				throw new Error("Unknown device request");
		}
		this.refreshPermissions();
		return this.info();
	}

	setEnabled(enabled: boolean) {
		return this.enqueue(() => (enabled ? this.enable() : this.disable()));
	}

	// Reads the two permissions again and passes on what changed.
	refreshPermissions() {
		const permissions = readPermissions();
		const previous = this.permissions;
		if (
			permissions.screen === previous.screen &&
			permissions.input === previous.input
		)
			return;
		this.permissions = permissions;
		this.remote.permissionsChanged(permissions);
		this.sendStatus();
		this.changed();
	}

	async shutdown() {
		this.shutDown = true;
		await this.enqueue(() => this.disable());
	}

	private enqueue<T>(work: () => Promise<T>): Promise<T> {
		const result = this.queue.then(work);
		this.queue = result.catch(() => {});
		return result;
	}

	// The web app's account changed. A binding is another account's device
	// until that account is back.
	private async syncUser(userId: string) {
		this.userId = userId;
		if (!this.isBound) await this.disable();
		this.changed();
	}

	private async bind(value: unknown) {
		if (
			!isRecord(value) ||
			!isId(value.deviceId) ||
			!isId(value.userId) ||
			value.userId !== this.userId ||
			typeof value.credential !== "string" ||
			!/^[a-f0-9-]{72}$/.test(value.credential)
		)
			throw new Error("Invalid device binding");
		await this.disable();
		const binding: Binding = {
			origin: this.appUrl.origin,
			userId: value.userId,
			deviceId: value.deviceId,
			credential: value.credential,
			workspace: this.defaultWorkspace,
		};
		this.storage.write(binding);
		this.binding = binding;
		this.error = undefined;
		this.changed();
	}

	private async unbind() {
		await this.disable();
		this.forget();
		this.error = undefined;
		this.changed();
	}

	private forget() {
		this.storage.clear();
		this.binding = undefined;
	}

	private async enable() {
		if (this.enabled) return;
		const binding = this.binding;
		if (!binding || !this.isBound)
			throw new Error("This Mac is not connected to the account");
		this.enabled = true;
		this.error = undefined;
		this.changed();

		const execution = new Execution({
			result: (message) => this.link?.send(message),
			native: (command) => this.native(command),
			crashed: () => this.stopBecause("errorCommands"),
		});
		this.execution = execution;
		try {
			await execution.start({ binding, journal: this.journalPath(binding) });
		} catch (error) {
			await this.disable();
			throw error;
		}

		const link = new DeviceLink(this.appUrl, binding.credential, {
			online: () => {
				this.online = true;
				this.sendStatus();
				this.changed();
			},
			offline: () => {
				this.online = false;
				this.remote.stopAll();
				this.changed();
			},
			message: (message) => this.receive(message),
			ended: (reason) =>
				this.stopBecause(linkErrors[reason], reason === "revoked"),
		});
		this.link = link;
		link.start();
		this.permissionTimer = setInterval(
			() => this.refreshPermissions(),
			permissionInterval,
		);
	}

	private async disable() {
		this.enabled = false;
		this.online = false;
		clearInterval(this.permissionTimer);
		// Told that access is off, the server ends what it had under way here.
		this.link?.stop({ type: "disabled" });
		this.link = undefined;
		this.remote.stopAll();
		const execution = this.execution;
		this.execution = undefined;
		this.changed();
		await execution?.stop();
	}

	// Something other than its owner ended the access; `error` says what.
	private stopBecause(error: MessageKey, forget = false) {
		void this.enqueue(async () => {
			if (!this.enabled) return;
			await this.disable();
			if (forget) this.forget();
			this.error = error;
			this.changed();
		});
	}

	// Each binding has a journal of its own: the commands of one account, or
	// of one registration, are nothing to another.
	private journalPath(binding: Binding) {
		const scope = createHash("sha256")
			.update(
				JSON.stringify([binding.origin, binding.userId, binding.deviceId]),
			)
			.digest("hex");
		return join(this.storage.root, "journal", scope);
	}

	private sendStatus() {
		this.link?.send({
			type: "status",
			screenAllowed: this.permissions.screen,
			inputAllowed: this.permissions.input,
		});
	}

	private receive(message: BrokerMessage) {
		switch (message.type) {
			case "execute":
			case "collect":
			case "cancel":
				this.execution?.send(message);
				break;
			case "remote_start":
				void this.remote.start(message);
				break;
			case "remote_stop":
				this.remote.stop(message.sessionId);
				break;
			case "signal":
				this.remote.signal(message.sessionId, message.signal);
				break;
		}
	}

	// What the command process cannot do itself: the screen and the pointer.
	private async native(command: Command): Promise<Record<string, unknown>> {
		if (!this.online) throw new Error("Access to this Mac is off");
		switch (command.method) {
			case "screenshot":
				return this.remote.screenshot();
			case "computer":
				if (this.remote.isControlled)
					throw new Error(
						"A person is controlling this Mac; try again when they have finished",
					);
				this.remote.input.perform(command.arguments);
				return { output: "Input sent" };
			case "release_input":
				// A person's own held keys are theirs to let go of.
				if (!this.remote.isControlled) this.remote.input.release();
				return { output: "Input released" };
			default:
				throw new Error(`Unknown method: ${command.method}`);
		}
	}
}
