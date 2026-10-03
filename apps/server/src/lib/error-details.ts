import type { APIError } from "openai";
import { DatabaseError } from "pg";

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

// Log selected diagnostic fields, never whole request/response objects.
function diagnosticText(value: unknown) {
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	return String(value)
		.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/\b(?:sk-|sk_)[\w-]+/g, "[redacted]")
		.replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, "[redacted]")
		.replace(
			/((?:api[_-]?key|authorization|password|secret|token)\s*[=:]\s*)\S+/gi,
			"$1[redacted]",
		)
		.replace(/https?:\/\/[^\s"'<>]+/gi, (value) => {
			try {
				const url = new URL(value);
				return `${url.origin}${url.pathname}${url.search ? "?[redacted]" : ""}`;
			} catch {
				return "[url]";
			}
		})
		.replace(/[\r\n\t]+/g, " ")
		.slice(0, 1000);
}

export function providerErrorDetails(payload: unknown) {
	const body = record(payload);
	// OpenAI's { error }, or Cloudflare's list of errors (as `errors`, or as
	// `error` from AI binding catalog models).
	const error =
		(Array.isArray(body.error) ? body.error[0] : body.error) ??
		(Array.isArray(body.errors) ? body.errors[0] : undefined) ??
		payload;
	const details = record(error);
	return {
		code: diagnosticText(details.code),
		type: diagnosticText(details.type),
		param: diagnosticText(details.param),
		message: diagnosticText(
			typeof error === "string" ? error : details.message,
		),
	};
}

export class GatewayError extends Error {
	constructor(
		message: string,
		readonly details: Record<string, unknown>,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "GatewayError";
	}
}

export function errorDetails(error: unknown) {
	const chain: Record<string, unknown>[] = [];
	const seen = new Set<unknown>();
	// Database errors embed SQL, bound values and sometimes authentication data.
	let database = false;
	let current = error;
	while (
		current &&
		typeof current === "object" &&
		!seen.has(current) &&
		chain.length < 5
	) {
		seen.add(current);
		if (current instanceof DatabaseError) database = true;
		const item = record(current);
		if (item.name === "DrizzleQueryError") database = true;
		chain.push(item);
		current = item.cause;
	}
	return {
		...(error instanceof GatewayError ? error.details : {}),
		errors: chain.map((item) => ({
			name: diagnosticText(item.name) ?? "Error",
			message: database ? undefined : diagnosticText(item.message),
			code: diagnosticText(item.code),
			status: typeof item.status === "number" ? item.status : undefined,
			type: diagnosticText(item.type),
			param: diagnosticText(item.param),
		})),
		frames:
			error instanceof Error
				? error.stack
						?.split("\n")
						.filter((line) => /^\s+at /.test(line))
						.slice(0, 6)
				: undefined,
	};
}

function headerDetails(headers: Headers) {
	return {
		contentType: diagnosticText(headers.get("content-type")),
		gatewayLogId: diagnosticText(headers.get("cf-aig-log-id")),
		requestId: diagnosticText(headers.get("x-request-id")),
		rayId: diagnosticText(headers.get("cf-ray")),
	};
}

export function responseDetails(response: Response) {
	return { status: response.status, ...headerDetails(response.headers) };
}

// The OpenAI SDK's error for a rejected request or a stream error event.
export function apiErrorDetails(error: APIError) {
	return {
		status: error.status,
		...(error.headers ? headerDetails(error.headers) : {}),
		provider: providerErrorDetails(error.error),
	};
}
