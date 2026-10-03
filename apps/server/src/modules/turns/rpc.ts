import {
	Code,
	ConnectError,
	type ConnectRouter,
	type HandlerContext,
} from "@connectrpc/connect";

import { TurnService } from "@/gen/heveta/v1/turn_pb";
import { runSnapshotResource } from "@/modules/runs/rpc-codec";
import { threadResource } from "@/modules/threads/rpc-codec";
import { cfCtxStore, getAuthInfo } from "@/rpc/context";
import { getDB } from "@/rpc/database";

import { retryTurnInput, startTurnInput } from "./rpc-codec";
import { submitTurn } from "./service";

// Work that follows the answer, kept alive by the Worker after it is sent.
const afterResponse = (ctx: HandlerContext) => (work: Promise<unknown>) => {
	const host = ctx.values.get(cfCtxStore);
	if (!host) throw new ConnectError("No execution context", Code.Internal);
	host.waitUntil(work);
};

export function registerTurns(router: ConnectRouter) {
	router.service(TurnService, {
		async startTurn(req, ctx) {
			const result = await submitTurn(getDB(ctx), startTurnInput(req), {
				userId: getAuthInfo(ctx).userId,
				signal: ctx.signal,
				afterResponse: afterResponse(ctx),
			});
			return {
				snapshot: runSnapshotResource(result.snapshot),
				thread: result.thread && threadResource(result.thread),
			};
		},
		async retryTurn(req, ctx) {
			const result = await submitTurn(getDB(ctx), retryTurnInput(req), {
				userId: getAuthInfo(ctx).userId,
				signal: ctx.signal,
				afterResponse: afterResponse(ctx),
			});
			return { snapshot: runSnapshotResource(result.snapshot) };
		},
	});
}
