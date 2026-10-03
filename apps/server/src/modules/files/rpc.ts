import type { ConnectRouter } from "@connectrpc/connect";

import { FileService } from "@/gen/heveta/v1/file_pb";
import { getAuthInfo } from "@/rpc/context";
import { getDB } from "@/rpc/database";

import * as service from "./service";

export function registerFiles(router: ConnectRouter) {
	router.service(FileService, {
		async deleteFile(req, ctx) {
			await service.deleteFile(getDB(ctx), getAuthInfo(ctx).userId, req.fileId);
			return {};
		},
	});
}
