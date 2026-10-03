import type { ErrorReason } from "@/gen/heveta/v1/error_pb";

export const ErrorCode = {
	InvalidArgument: "invalid_argument",
	NotFound: "not_found",
	AlreadyExists: "already_exists",
	FailedPrecondition: "failed_precondition",
	Unauthenticated: "unauthenticated",
	PermissionDenied: "permission_denied",
	ResourceExhausted: "resource_exhausted",
	Unavailable: "unavailable",
	Internal: "internal",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export class AppError extends Error {
	constructor(
		message: string,
		readonly code: ErrorCode,
		// For the client to act on; the message is for logs.
		readonly reason?: ErrorReason,
	) {
		super(message);
		this.name = "AppError";
	}
}
