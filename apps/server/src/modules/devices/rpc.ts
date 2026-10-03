import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { ConnectRouter } from "@connectrpc/connect";

import type { DeviceRecord } from "@/db/schema/devices";
import { DeviceSchema, DeviceService } from "@/gen/heveta/v1/device_pb";
import { getAuthInfo } from "@/rpc/context";
import { getDB } from "@/rpc/database";

import type { DeviceStatus } from "./protocol";
import {
	listDevices,
	registerDevice,
	revokeDevice,
	startRemoteDesktop,
} from "./service";

const resource = (device: DeviceRecord & DeviceStatus) =>
	create(DeviceSchema, {
		id: device.id,
		name: device.name,
		platform: device.platform,
		osVersion: device.osVersion,
		workspacePath: device.workspacePath,
		online: device.online,
		screenAllowed: device.screenAllowed,
		inputAllowed: device.inputAllowed,
		createTime: timestampFromDate(device.createdAt),
	});
export function registerDevices(router: ConnectRouter) {
	router.service(DeviceService, {
		async registerDevice(req, ctx) {
			const result = await registerDevice(
				getDB(ctx),
				getAuthInfo(ctx).userId,
				req,
			);
			return { device: resource(result.device), credential: result.credential };
		},
		async listDevices(_req, ctx) {
			return {
				devices: (await listDevices(getDB(ctx), getAuthInfo(ctx).userId)).map(
					resource,
				),
			};
		},
		async revokeDevice(req, ctx) {
			await revokeDevice(getDB(ctx), getAuthInfo(ctx).userId, req.deviceId);
			return {};
		},
		async startRemoteDesktop(req, ctx) {
			const { userId, sessionId } = getAuthInfo(ctx);
			return startRemoteDesktop(
				getDB(ctx),
				userId,
				sessionId,
				req.deviceId,
				req.control,
			);
		},
	});
}
