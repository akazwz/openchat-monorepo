import type { JsonObject } from "@/lib/json";

export const deviceProtocolVersion = 1;
export const deviceMessageBytes = 512 * 1024;
export const deviceJobLifetimeMs = 31 * 60 * 1000;

export interface DeviceStatus {
	online: boolean;
	screenAllowed: boolean;
	inputAllowed: boolean;
}

export interface DeviceCommand {
	id: string;
	method: string;
	arguments: JsonObject;
}

export type DeviceResult =
	| { ok: true; value: JsonObject }
	| { ok: false; error: string; unknown?: boolean };

export interface DeviceJob {
	command: DeviceCommand;
	hash: string;
	createdAt: number;
	// Cancellation is persisted before being sent to the native process.
	cancelled: boolean;
	result?: DeviceResult;
}

export interface RemoteDesktopSession {
	id: string;
	userId: string;
	browserSessionId: string;
	control: boolean;
	expiresAt: number;
	iceServers: DeviceIceServer[];
}

// Why a device cannot be watched or controlled now.
export type RemoteDesktopRefusal =
	| "offline"
	| "screen"
	| "input"
	| "controlled";

export interface DeviceIceServer {
	urls: string[];
	username?: string;
	credential?: string;
}

export function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validCommandId(id: unknown): id is string {
	return typeof id === "string" && /^[a-zA-Z0-9:_-]{1,200}$/.test(id);
}
