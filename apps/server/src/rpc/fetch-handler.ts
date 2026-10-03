import type {
	ConnectRouter,
	ConnectRouterOptions,
	ContextValues,
} from "@connectrpc/connect";
import { createConnectRouter } from "@connectrpc/connect";
import type { UniversalHandler } from "@connectrpc/connect/protocol";
import {
	universalServerRequestFromFetch,
	universalServerResponseToFetch,
} from "@connectrpc/connect/protocol";

interface WorkerHandlerOptions<Env> extends ConnectRouterOptions {
	routes: (router: ConnectRouter) => void;
	// Values the handlers read from the request (the caller's address).
	contextValues?: (
		req: Request,
		env: Env,
		ctx: ExecutionContext,
	) => ContextValues;
}

// Serves the Connect API from the Worker's fetch handler; the Worker routes
// everything else (hasRoute).

export function createWorkerHandler<Env>(options: WorkerHandlerOptions<Env>) {
	const router = createConnectRouter(options);
	options.routes(router);
	const paths = new Map<string, UniversalHandler>();
	for (const uHandler of router.handlers) {
		paths.set(uHandler.requestPath, uHandler);
	}
	return {
		hasRoute(pathname: string) {
			return paths.has(pathname);
		},
		async fetch(req: Request, env: Env, ctx: ExecutionContext) {
			const url = new URL(req.url);
			const handler = paths.get(url.pathname);
			if (handler === undefined)
				return new Response("Not found", { status: 404 });
			const uReq = {
				...universalServerRequestFromFetch(req, {}),
				contextValues: options.contextValues?.(req, env, ctx),
			};
			const uRes = await handler(uReq);
			return universalServerResponseToFetch(uRes);
		},
	};
}
