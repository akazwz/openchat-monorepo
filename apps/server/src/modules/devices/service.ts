import { env, exports } from "cloudflare:workers";
import { and, eq, isNull } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";

import type { Database } from "@/db/client";
import { devices } from "@/db/schema/devices";
import { ErrorReason } from "@/gen/heveta/v1/error_pb";
import { AppError, ErrorCode } from "@/lib/errors";
import { sha256 } from "@/lib/hash";
import { objectLocation } from "@/lib/location";
import { announce, userEvents } from "@/modules/events/publish";

import { ownedDevice } from "./credentials";
import {
	object,
	type DeviceIceServer,
	type RemoteDesktopRefusal,
} from "./protocol";

const refusalReasons: Record<RemoteDesktopRefusal, ErrorReason> = {
	offline: ErrorReason.DEVICE_OFFLINE,
	screen: ErrorReason.DEVICE_SCREEN_NOT_ALLOWED,
	input: ErrorReason.DEVICE_INPUT_NOT_ALLOWED,
	controlled: ErrorReason.DEVICE_CONTROLLED,
};

export const deviceConnection = (id: string) =>
	exports.DeviceConnection.getByName(id, objectLocation);

export async function listDevices(db: Database, userId: string) {
	const records = await db
		.select()
		.from(devices)
		.where(and(eq(devices.userId, userId), isNull(devices.revokedAt)));
	return Promise.all(
		records.map(async (record) => ({
			...record,
			...(await deviceConnection(record.id).status()),
		})),
	);
}

export async function registerDevice(
	db: Database,
	userId: string,
	input: {
		clientId: string;
		name: string;
		osVersion: string;
		workspacePath: string;
	},
) {
	if (
		!/^[a-f0-9-]{36}$/i.test(input.clientId) ||
		!input.name.trim() ||
		input.name.length > 100 ||
		!input.osVersion ||
		input.osVersion.length > 100 ||
		!input.workspacePath.startsWith("/") ||
		input.workspacePath.length > 4096
	)
		throw new AppError("Invalid device information", ErrorCode.InvalidArgument);
	const credential = crypto.randomUUID() + crypto.randomUUID();
	const [record] = await db
		.insert(devices)
		.values({
			id: uuidv7(),
			userId,
			...input,
			name: input.name.trim(),
			tokenHash: await sha256(credential),
		})
		.onConflictDoUpdate({
			target: [devices.userId, devices.clientId],
			set: {
				name: input.name.trim(),
				osVersion: input.osVersion,
				workspacePath: input.workspacePath,
				tokenHash: await sha256(credential),
				revokedAt: null,
			},
		})
		.returning();
	await deviceConnection(record.id).revoke();
	await announce(userId, [userEvents.devices()]);
	return {
		device: {
			...record,
			online: false,
			screenAllowed: false,
			inputAllowed: false,
		},
		credential,
	};
}

export async function revokeDevice(db: Database, userId: string, id: string) {
	// Keep the record for existing run history and allow retries to deliver revocation.
	const [record] = await db
		.select()
		.from(devices)
		.where(and(eq(devices.id, id), eq(devices.userId, userId)));
	if (!record) throw new AppError("Device not found", ErrorCode.NotFound);
	await db
		.update(devices)
		.set({ revokedAt: new Date() })
		.where(eq(devices.id, id));
	await deviceConnection(id).revoke();
	await announce(userId, [userEvents.devices()]);
}

export async function closeDeviceViewers(
	db: Database,
	userId: string,
	sessionId: string,
) {
	const records = await db
		.select({ id: devices.id })
		.from(devices)
		.where(eq(devices.userId, userId));
	await Promise.all(
		records.map(({ id }) =>
			deviceConnection(id).closeBrowserSession(sessionId),
		),
	);
}

// Only short-lived TURN credentials reach the native host and browser. The
// Cloudflare key API token stays in Worker secrets.
async function iceServers(): Promise<DeviceIceServer[]> {
	if (!env.TURN_KEY_ID || !env.TURN_API_TOKEN)
		throw new AppError(
			"Remote desktop relay is not configured",
			ErrorCode.Unavailable,
		);
	const response = await fetch(
		`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
		{
			method: "POST",
			headers: {
				authorization: `Bearer ${env.TURN_API_TOKEN}`,
				"content-type": "application/json",
				"user-agent": "Heveta/1.0",
			},
			body: JSON.stringify({ ttl: 7200 }),
			signal: AbortSignal.timeout(10_000),
		},
	);
	if (!response.ok)
		throw new AppError(
			"Remote desktop relay is unavailable",
			ErrorCode.Unavailable,
		);
	const result: unknown = await response.json();
	if (!object(result) || !Array.isArray(result.iceServers))
		throw new Error("Invalid TURN response");
	return result.iceServers
		.map((server: unknown) => {
			if (
				!object(server) ||
				!Array.isArray(server.urls) ||
				!server.urls.every((url: unknown) => typeof url === "string")
			)
				throw new Error("Invalid ICE server");
			return {
				urls: (server.urls as string[]).filter(
					(url) => !/:53(?:\?|$)/.test(url),
				),
				...(typeof server.username === "string"
					? { username: server.username }
					: {}),
				...(typeof server.credential === "string"
					? { credential: server.credential }
					: {}),
			};
		})
		.filter((server) => server.urls.length);
}

export async function startRemoteDesktop(
	db: Database,
	userId: string,
	browserSessionId: string,
	deviceId: string,
	control: boolean,
) {
	await ownedDevice(db, userId, deviceId);
	const servers = await iceServers();
	const sessionId = uuidv7();
	const refusal = await deviceConnection(deviceId).createRemoteSession({
		id: sessionId,
		userId,
		browserSessionId,
		control,
		iceServers: servers,
		// A reservation without an admitted viewer must expire promptly.
		expiresAt: Date.now() + 30_000,
	});
	if (refusal)
		throw new AppError(
			`Remote desktop refused: ${refusal}`,
			ErrorCode.FailedPrecondition,
			refusalReasons[refusal],
		);
	return { sessionId, iceServers: servers };
}
