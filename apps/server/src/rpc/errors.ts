import { Code, ConnectError, type Interceptor } from "@connectrpc/connect";
import { DatabaseError } from "pg";

import { ErrorDetailSchema } from "@/gen/heveta/v1/error_pb";
import { AppError, type ErrorCode } from "@/lib/errors";

const rpcCodes: Record<ErrorCode, Code> = {
	invalid_argument: Code.InvalidArgument,
	not_found: Code.NotFound,
	already_exists: Code.AlreadyExists,
	failed_precondition: Code.FailedPrecondition,
	unauthenticated: Code.Unauthenticated,
	permission_denied: Code.PermissionDenied,
	resource_exhausted: Code.ResourceExhausted,
	unavailable: Code.Unavailable,
	internal: Code.Internal,
};

const connectionCodes = new Set([
	"ECONNREFUSED",
	"ECONNRESET",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ENOTFOUND",
	"ETIMEDOUT",
	"08000",
	"08001",
	"08003",
	"08004",
	"08006",
	"08007",
	"08P01",
	"28P01",
	"28000",
	"53300",
	"57P01",
	"57P02",
	"57P03",
]);

// How node-postgres and the Workers socket say a connection failed; server
// errors carry a SQLSTATE code instead (above).
const connectionMessages = new Set([
	"connection attempt failed",
	"Connection terminated unexpectedly",
	"Connection terminated due to connection timeout",
	"timeout expired",
	"Client has encountered a connection error and is not queryable",
]);

// Drizzle's error.message contains SQL and all bound parameters. Never log or
// return the raw error: authentication queries include token hashes and codes.
function failure(error: unknown, method: string): never {
	if (error instanceof AppError)
		error = new ConnectError(
			error.message,
			rpcCodes[error.code],
			undefined,
			error.reason
				? [{ desc: ErrorDetailSchema, value: { reason: error.reason } }]
				: undefined,
		);
	if (error instanceof ConnectError) {
		console.warn("[RPC] Request failed", { method, code: Code[error.code] });
		throw error;
	}
	const seen = new Set<Error>();
	const names: string[] = [];
	const codes: string[] = [];
	let database = false;
	let connection = false;
	let current = error;
	while (current instanceof Error && !seen.has(current)) {
		seen.add(current);
		if (/^[\w.]+$/.test(current.name)) names.push(current.name);
		if (
			current.name === "DrizzleQueryError" ||
			current instanceof DatabaseError
		)
			database = true;
		if (connectionMessages.has(current.message)) connection = true;
		if (
			"code" in current &&
			typeof current.code === "string" &&
			/^[A-Z0-9_]+$/.test(current.code)
		) {
			codes.push(current.code);
			if (connectionCodes.has(current.code)) connection = true;
		}
		current = current.cause;
	}
	console.error("[RPC] Request failed", {
		method,
		errors: names,
		codes,
		reason:
			database && connection
				? "database_connection_failed"
				: database
					? "database_query_failed"
					: "unexpected_error",
		...(database && connection
			? {
					hint: "Local development: run pnpm db:setup; check the Hyperdrive localConnectionString and any connection override.",
				}
			: {}),
		frames:
			error instanceof Error
				? error.stack
						?.split("\n")
						.filter((line) => /^\s+at /.test(line))
						.slice(0, 8)
				: undefined,
	});
	throw new ConnectError(
		database && connection
			? "Database is unavailable"
			: "Internal server error",
		database && connection ? Code.Unavailable : Code.Internal,
	);
}

export const logInterceptor: Interceptor = (next) => async (req) => {
	const method = `${req.service.typeName}/${req.method.name}`;
	console.log("[RPC] Request", { method });
	// Every method is unary (docs/sync.md): a failure is thrown by `next`.
	try {
		return await next(req);
	} catch (error) {
		failure(error, method);
	}
};
