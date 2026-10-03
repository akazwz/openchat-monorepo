import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { ConnectRouter } from "@connectrpc/connect";

import { MemorySchema, MemoryService } from "@/gen/heveta/v1/memory_pb";
import { AppError, ErrorCode } from "@/lib/errors";
import { getAuthInfo } from "@/rpc/context";
import { getDB } from "@/rpc/database";

import type { Memory } from "./service";
import * as memoryService from "./service";

const memoryResource = (memory: Memory) =>
	create(MemorySchema, {
		id: memory.id,
		content: memory.content,
		createTime: timestampFromDate(memory.createdAt),
		updateTime: timestampFromDate(memory.updatedAt),
	});

export function registerMemories(router: ConnectRouter) {
	router.service(MemoryService, {
		async listMemories(_req, ctx) {
			const memories = await memoryService.listMemories(
				getDB(ctx),
				getAuthInfo(ctx).userId,
			);
			return { memories: memories.map(memoryResource) };
		},
		// Idempotent for people: a memory the agent already removed is gone.
		async deleteMemory(req, ctx) {
			try {
				await memoryService.deleteMemory(
					getDB(ctx),
					getAuthInfo(ctx).userId,
					req.memoryId,
				);
			} catch (error) {
				if (!(error instanceof AppError && error.code === ErrorCode.NotFound))
					throw error;
			}
			return {};
		},
		async deleteAllMemories(_req, ctx) {
			await memoryService.deleteAllMemories(
				getDB(ctx),
				getAuthInfo(ctx).userId,
			);
			return {};
		},
	});
}
