import { errorDetails } from "./error-details";
import { AppError, type ErrorCode } from "./errors";

// Connect's HTTP status for each code, so the app handles a plain route's
// error (an upload, a download) like any RPC's.
const statuses: Record<ErrorCode, number> = {
	invalid_argument: 400,
	not_found: 404,
	already_exists: 409,
	failed_precondition: 400,
	unauthenticated: 401,
	permission_denied: 403,
	resource_exhausted: 429,
	unavailable: 503,
	internal: 500,
};

export const errorResponse = (code: ErrorCode, message: string) =>
	Response.json({ code, message }, { status: statuses[code] });

// An AppError answers with its code and message; anything else is logged
// and answers as an internal error.
export function failureResponse(error: unknown, route: string) {
	if (error instanceof AppError)
		return errorResponse(error.code, error.message);
	console.error(`[${route}] Failed`, errorDetails(error));
	return errorResponse("internal", "Internal server error");
}
