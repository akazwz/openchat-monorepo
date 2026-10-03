import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { ConnectRouter } from "@connectrpc/connect";

import {
	ComputerFileSchema,
	ComputerService,
	WorkspaceSnapshotSchema,
} from "@/gen/heveta/v1/computer_pb";
import { getAuthInfo } from "@/rpc/context";

import {
	clearWorkspace,
	listSnapshots,
	restartComputer,
	restoreSnapshot,
	workspaceUsage,
} from "./manage";
import { listWorkspaceFiles } from "./workspace-files";

export function registerComputer(router: ConnectRouter) {
	router.service(ComputerService, {
		async listComputerFiles(req, ctx) {
			const { userId } = getAuthInfo(ctx);
			const listed = await listWorkspaceFiles(userId, req.path);
			return {
				path: listed.path,
				files: listed.files.map((file) =>
					create(ComputerFileSchema, {
						name: file.name,
						path: file.path,
						isDirectory: file.isDirectory,
						size: BigInt(file.size),
						modifyTime: timestampFromDate(new Date(file.modifiedAt)),
					}),
				),
			};
		},
		async getWorkspaceUsage(_req, ctx) {
			const { userId } = getAuthInfo(ctx);
			return { bytes: BigInt(await workspaceUsage(userId)) };
		},
		async restartComputer(req, ctx) {
			const { userId } = getAuthInfo(ctx);
			await restartComputer(userId, req.discardUnsaved);
			return {};
		},
		async listWorkspaceSnapshots(_req, ctx) {
			const { userId } = getAuthInfo(ctx);
			const listed = await listSnapshots(userId);
			return {
				snapshots: listed.snapshots.map((snapshot) =>
					create(WorkspaceSnapshotSchema, {
						id: snapshot.id,
						createTime: timestampFromDate(new Date(snapshot.createdAt)),
						expireTime: timestampFromDate(
							new Date(snapshot.filesystem.expiresAt),
						),
					}),
				),
				currentSnapshotId: listed.currentId ?? "",
				unsavedSince:
					listed.unsavedSince === undefined
						? undefined
						: timestampFromDate(new Date(listed.unsavedSince)),
			};
		},
		async restoreWorkspaceSnapshot(req, ctx) {
			const { userId } = getAuthInfo(ctx);
			await restoreSnapshot(userId, req.snapshotId, req.discardUnsaved);
			return {};
		},
		async clearWorkspace(req, ctx) {
			const { userId } = getAuthInfo(ctx);
			await clearWorkspace(userId, req.discardUnsaved);
			return {};
		},
	});
}
