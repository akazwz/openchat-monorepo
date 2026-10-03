// What this Mac and the server's device broker say to each other
// (apps/server/src/modules/devices, docs/macos.md), and the values the
// client's own processes pass along. Protocol version 1.
export const protocolVersion = 1;
export const messageLimit = 512 * 1024;

// This Mac's registration with an account. The workspace is part of it: the
// server keeps the same path for the files it has the device fetch.
export interface Binding {
	origin: string;
	userId: string;
	deviceId: string;
	credential: string;
	workspace: string;
}

// What the web app's "Devices" settings read (hevetaNative.info()).
export interface DeviceInfo {
	clientId: string;
	name: string;
	osVersion: string;
	workspacePath: string;
	deviceId: string;
	userId: string;
	enabled: boolean;
	online: boolean;
	screenAllowed: boolean;
	inputAllowed: boolean;
	error: string | null;
}

export interface Command {
	id: string;
	method: string;
	arguments: Record<string, unknown>;
}

// `unknown` marks an operation that may or may not have happened: the server
// never repeats those.
export type Result =
	| { ok: true; value: Record<string, unknown> }
	| { ok: false; error: string; unknown?: boolean };

export interface IceServer {
	urls: string[];
	username?: string;
	credential?: string;
}

export interface Signal {
	description?: { type: string; sdp?: string };
	candidate?: Record<string, unknown>;
}

// Why a screen-sharing session ended, for the person watching. The web app
// has the words for each (features/devices/messages.ts).
export type RemoteError =
	| "screen_permission"
	| "input_permission"
	| "controlled"
	| "busy"
	| "capture"
	| "connection"
	| "ended";

export type BrokerMessage =
	| { type: "hello"; version: number }
	| { type: "revoked" }
	| ({ type: "execute" } & Command)
	| { type: "collect" | "cancel"; id: string }
	| {
			type: "remote_start";
			sessionId: string;
			control: boolean;
			iceServers: IceServer[];
	  }
	| { type: "remote_stop"; sessionId: string }
	| { type: "signal"; sessionId: string; signal: Signal };

export type HostMessage =
	| { type: "status"; screenAllowed: boolean; inputAllowed: boolean }
	| { type: "disabled" }
	| { type: "result"; id: string; result: Result }
	| { type: "signal"; sessionId: string; signal: Signal }
	| {
			type: "remote_error";
			sessionId: string;
			code: RemoteError;
			error: string;
	  };

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Command and session IDs, as the server makes them.
export function isId(value: unknown): value is string {
	return typeof value === "string" && /^[a-zA-Z0-9:_-]{1,200}$/.test(value);
}

export function failure(error: unknown): Extract<Result, { ok: false }> {
	return {
		ok: false,
		error:
			error instanceof Error
				? error.message.slice(0, 2000)
				: "The operation failed",
	};
}

function isIceServer(value: unknown): value is IceServer {
	return (
		isRecord(value) &&
		Array.isArray(value.urls) &&
		value.urls.every((url) => typeof url === "string") &&
		(value.username === undefined || typeof value.username === "string") &&
		(value.credential === undefined || typeof value.credential === "string")
	);
}

// A message the client understands, or nothing: a newer server's additions
// are skipped, not errors.
export function readBrokerMessage(value: unknown): BrokerMessage | undefined {
	if (!isRecord(value)) return undefined;
	switch (value.type) {
		case "hello":
			return typeof value.version === "number"
				? { type: "hello", version: value.version }
				: undefined;
		case "revoked":
			return { type: "revoked" };
		case "execute":
			return isId(value.id) &&
				typeof value.method === "string" &&
				isRecord(value.arguments)
				? {
						type: "execute",
						id: value.id,
						method: value.method,
						arguments: value.arguments,
					}
				: undefined;
		case "collect":
		case "cancel":
			return isId(value.id) ? { type: value.type, id: value.id } : undefined;
		case "remote_start":
			return isId(value.sessionId) &&
				Array.isArray(value.iceServers) &&
				value.iceServers.every(isIceServer)
				? {
						type: "remote_start",
						sessionId: value.sessionId,
						control: value.control === true,
						iceServers: value.iceServers,
					}
				: undefined;
		case "remote_stop":
			return isId(value.sessionId)
				? { type: "remote_stop", sessionId: value.sessionId }
				: undefined;
		case "signal":
			return isId(value.sessionId) && isRecord(value.signal)
				? {
						type: "signal",
						sessionId: value.sessionId,
						signal: value.signal as Signal,
					}
				: undefined;
		default:
			return undefined;
	}
}
