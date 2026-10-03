import type { ConnectRouter } from "@connectrpc/connect";

import { RunService } from "@/gen/heveta/v1/run_pb";
import { getAuthInfo } from "@/rpc/context";
import { getDB } from "@/rpc/database";

import { runLookup, runSnapshotResource } from "./rpc-codec";
import { cancelRun } from "./service";
import { getRunSnapshot } from "./store";

export function registerRuns(router: ConnectRouter) {
	router.service(RunService, {
		async getRun(req, ctx) {
			const snapshot = await getRunSnapshot(
				getDB(ctx),
				getAuthInfo(ctx).userId,
				req.runId,
			);
			return { snapshot: runSnapshotResource(snapshot) };
		},
		async cancelRun(req, ctx) {
			const snapshot = await cancelRun(
				getDB(ctx),
				getAuthInfo(ctx).userId,
				runLookup(req),
			);
			return { snapshot: runSnapshotResource(snapshot) };
		},
	});
}
