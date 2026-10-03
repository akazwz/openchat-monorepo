import {
	Code,
	ConnectError,
	createContextKey,
	type HandlerContext,
	type Interceptor,
} from "@connectrpc/connect";

import { createDatabase, type Database } from "@/db/client";
import { errorDetails } from "@/lib/error-details";
import { cfCtxStore } from "@/rpc/context";

const databaseStore = createContextKey<(() => Database) | undefined>(undefined);

export function getDB(ctx: Pick<HandlerContext, "values">): Database {
	const getDatabase = ctx.values.get(databaseStore);
	if (!getDatabase)
		throw new ConnectError("Database context is not set", Code.Internal);
	return getDatabase();
}

// One lazy connection pool per RPC. Every RPC is unary (changes are pushed on
// the event channel, docs/sync.md), so the pool closes with the response.
export function createDatabaseInterceptor(open = createDatabase): Interceptor {
	return (next) => async (req) => {
		let connection: ReturnType<typeof createDatabase> | undefined;
		let closed = false;
		const lifetime = Promise.withResolvers<void>();
		// Register before invoking a handler, so the host keeps the request alive
		// until the pool has closed, including after a client disconnects.
		req.contextValues.get(cfCtxStore)?.waitUntil(lifetime.promise);
		req.contextValues.set(databaseStore, () => {
			if (closed)
				throw new ConnectError("Database request has finished", Code.Internal);
			connection ??= open();
			return connection.db;
		});
		try {
			return await next(req);
		} finally {
			// The pool closes after the answer is sent, not before it: the
			// request is kept alive until it has (waitUntil, above).
			closed = true;
			void Promise.resolve(connection?.close())
				.catch((error: unknown) =>
					console.warn("[RPC] Database pool did not close", {
						...errorDetails(error),
					}),
				)
				.finally(() => lifetime.resolve());
		}
	};
}
