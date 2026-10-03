import { and, eq, isNull } from "drizzle-orm";

import { createDatabase, type Database } from "@/db/client";
import { devices } from "@/db/schema/devices";
import { AppError, ErrorCode } from "@/lib/errors";
import { sha256 } from "@/lib/hash";

export async function ownedDevice(db: Database, userId: string, id: string) {
	const [device] = await db
		.select()
		.from(devices)
		.where(
			and(
				eq(devices.id, id),
				eq(devices.userId, userId),
				isNull(devices.revokedAt),
			),
		);
	if (!device) throw new AppError("Device not found", ErrorCode.NotFound);
	return device;
}

export async function deviceCredential(request: Request) {
	const authorization = request.headers.get("authorization") ?? "";
	if (!/^Bearer [a-f0-9-]{72}$/.test(authorization))
		throw new AppError("Invalid device credential", ErrorCode.Unauthenticated);
	const tokenHash = await sha256(authorization.slice(7));
	const database = createDatabase();
	try {
		const [device] = await database.db
			.select()
			.from(devices)
			.where(and(eq(devices.tokenHash, tokenHash), isNull(devices.revokedAt)));
		if (!device)
			throw new AppError("Device access revoked", ErrorCode.Unauthenticated);
		return device;
	} finally {
		await database.close();
	}
}

// Admission is checked again inside the DO's gate, against the credential
// generation the trusted Worker put in the handshake.
export async function liveDeviceCredential(
	id: string,
	tokenHash: string,
): Promise<string | undefined> {
	const database = createDatabase();
	try {
		const [device] = await database.db
			.select({ userId: devices.userId })
			.from(devices)
			.where(
				and(
					eq(devices.id, id),
					eq(devices.tokenHash, tokenHash),
					isNull(devices.revokedAt),
				),
			);
		return device?.userId;
	} finally {
		await database.close();
	}
}
