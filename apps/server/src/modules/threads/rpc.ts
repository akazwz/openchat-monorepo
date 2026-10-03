import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";

import { ThreadService } from "@/gen/heveta/v1/thread_pb";
import { getAuthInfo } from "@/rpc/context";
import { getDB } from "@/rpc/database";

import { partToProto } from "./part-codec";
import { messageToProto, threadResource } from "./rpc-codec";
import * as service from "./service";

export function registerThreads(router: ConnectRouter) {
	router.service(ThreadService, {
		async getThread(req, ctx) {
			return {
				thread: threadResource(
					await service.getThread(
						getDB(ctx),
						getAuthInfo(ctx).userId,
						req.threadId,
					),
				),
			};
		},
		async listThreads(req, ctx) {
			const page = await service.listThreads(
				getDB(ctx),
				getAuthInfo(ctx).userId,
				req,
			);
			return {
				threads: page.items.map(threadResource),
				nextPageToken: page.nextPageToken,
			};
		},
		async updateThread(req, ctx) {
			if (!req.thread?.id)
				throw new ConnectError("Thread ID is required", Code.InvalidArgument);
			const paths = req.updateMask?.paths ?? [];
			if (paths.length !== 1 || paths[0] !== "title")
				throw new ConnectError(
					"Update mask must be title",
					Code.InvalidArgument,
				);
			const row = await service.updateThread(
				getDB(ctx),
				getAuthInfo(ctx).userId,
				req.thread.id,
				{ title: req.thread.title },
			);
			return { thread: threadResource(row) };
		},
		async deleteThread(req, ctx) {
			await service.deleteThread(
				getDB(ctx),
				getAuthInfo(ctx).userId,
				req.threadId,
			);
			return {};
		},
		async listMessages(req, ctx) {
			const page = await service.listMessages(
				getDB(ctx),
				getAuthInfo(ctx).userId,
				req.threadId,
				req,
			);
			return {
				messages: page.items.map(({ run, ...message }) =>
					messageToProto(message, run, { omitLongOutputs: true }),
				),
				nextPageToken: page.nextPageToken,
			};
		},
		async getToolResult(req, ctx) {
			const { content } = partToProto(
				await service.getToolResult(
					getDB(ctx),
					getAuthInfo(ctx).userId,
					req.messageId,
					req.toolCallId,
				),
			);
			return {
				result: content.case === "toolResult" ? content.value : undefined,
			};
		},
	});
}
