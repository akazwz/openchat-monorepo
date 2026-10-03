import { createContextValues } from "@connectrpc/connect";

import { rpcConfig } from "@/config";
import { registerAuth } from "@/modules/auth/rpc";
import { registerDevices } from "@/modules/devices/rpc";
import { registerFiles } from "@/modules/files/rpc";
import { registerMail } from "@/modules/mail/rpc";
import { registerMemories } from "@/modules/memories/rpc";
import { registerModels } from "@/modules/models/rpc";
import { registerRuns } from "@/modules/runs/rpc";
import { registerComputer } from "@/modules/sandbox/rpc";
import { registerThreads } from "@/modules/threads/rpc";
import { registerTurns } from "@/modules/turns/rpc";

import { authInterceptor } from "./auth";
import { cfCtxStore, clientAddressStore } from "./context";
import { createDatabaseInterceptor } from "./database";
import { logInterceptor } from "./errors";
import { createWorkerHandler } from "./fetch-handler";

export const handler = createWorkerHandler<Env>({
	readMaxBytes: rpcConfig.readMaxBytes,
	// A request another site starts cannot carry this header (it would need
	// a preflight this API never allows): no RPC can be forged.
	requireConnectProtocolHeader: true,
	contextValues(req, _env, ctx) {
		return createContextValues()
			.set(cfCtxStore, ctx)
			.set(clientAddressStore, req.headers.get("CF-Connecting-IP") ?? "");
	},
	interceptors: [logInterceptor, createDatabaseInterceptor(), authInterceptor],
	routes(router) {
		registerAuth(router);
		registerThreads(router);
		registerTurns(router);
		registerFiles(router);
		registerRuns(router);
		registerModels(router);
		registerMemories(router);
		registerComputer(router);
		registerMail(router);
		registerDevices(router);
	},
});
