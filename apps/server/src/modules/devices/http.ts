import { createDatabase } from "@/db/client";
import { AppError, ErrorCode } from "@/lib/errors";
import { failureResponse } from "@/lib/http-errors";
import { declaredBody } from "@/lib/request-body";
import { upgradeRequest } from "@/lib/websocket";
import { admitWebSocket } from "@/modules/auth/session";
import { getFile, openFile, storeFile } from "@/modules/files/service";

import { deviceHeaders } from "./connection";
import { deviceCredential, ownedDevice } from "./credentials";
import type { DeviceJob } from "./protocol";
import { deviceConnection } from "./service";

export async function openDeviceConnection(request: Request, viewer: boolean) {
	try {
		if (!viewer) {
			if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
				return new Response("Expected WebSocket", { status: 426 });
			const device = await deviceCredential(request);
			return deviceConnection(device.id).fetch(
				upgradeRequest(request, {
					[deviceHeaders.id]: device.id,
					[deviceHeaders.user]: device.userId,
					[deviceHeaders.role]: "host",
					[deviceHeaders.credential]: device.tokenHash,
				}),
			);
		}
		const admission = await admitWebSocket(request);
		if (admission instanceof Response) return admission;
		const database = createDatabase();
		try {
			const device = await ownedDevice(
				database.db,
				admission.userId,
				new URL(request.url).searchParams.get("device") ?? "",
			);
			return deviceConnection(device.id).fetch(
				upgradeRequest(request, {
					[deviceHeaders.id]: device.id,
					[deviceHeaders.user]: device.userId,
					[deviceHeaders.role]: "viewer",
					[deviceHeaders.session]: admission.sessionId,
				}),
			);
		} finally {
			await database.close();
		}
	} catch (error) {
		return failureResponse(error, "Device connection");
	}
}

// Large payloads use authenticated HTTPS streams, bound to an already
// dispatched job, rather than inflating WebSocket messages.
export async function deviceFile(request: Request) {
	const database = createDatabase();
	try {
		const device = await deviceCredential(request);
		const query = new URL(request.url).searchParams;
		const job = JSON.parse(
			await deviceConnection(device.id).job(query.get("job") ?? ""),
		) as DeviceJob | null;
		if (!job || job.result || job.cancelled)
			throw new AppError(
				"Device job is not active",
				ErrorCode.FailedPrecondition,
			);
		if (request.method === "GET") {
			if (
				job.command.method !== "receive_file" ||
				job.command.arguments.fileId !== query.get("file")
			)
				throw new AppError(
					"File is not part of this job",
					ErrorCode.PermissionDenied,
				);
			const file = await getFile(
				database.db,
				device.userId,
				query.get("file") ?? "",
			);
			return new Response(await openFile(database.db, device.userId, file.id), {
				headers: {
					"content-type": file.mimeType,
					"content-length": file.size.toString(),
					"cache-control": "no-store",
				},
			});
		}
		if (
			!["send_file", "view_image", "computer", "screenshot"].includes(
				job.command.method,
			)
		)
			throw new AppError("This job cannot upload", ErrorCode.PermissionDenied);
		const body = declaredBody(request);
		if (!body)
			throw new AppError("File length is required", ErrorCode.InvalidArgument);
		const file = await storeFile(database.db, device.userId, {
			content: body.body,
			size: body.length,
			fileName: query.get("name") ?? "",
			mimeType:
				request.headers.get("content-type") ?? "application/octet-stream",
		});
		return Response.json({
			id: file.id,
			mimeType: file.mimeType,
			fileName: file.fileName,
			size: file.size.toString(),
			width: file.width,
			height: file.height,
		});
	} catch (error) {
		return failureResponse(error, "Device file");
	} finally {
		await database.close();
	}
}
