import { Code, ConnectError } from "@connectrpc/connect";

import { ErrorDetailSchema, ErrorReason } from "~/gen/heveta/v1/error_pb";
import type { MessageKey } from "~/i18n/messages";

// What a failed sign-in or account request tells the person. Apart from the
// form schemas (validation.ts): the profile uses it in every signed-in page,
// and importing it from there brought zod into their first load.
export function authErrorMessage(
	error: unknown,
	fallback: MessageKey,
): MessageKey {
	if (!(error instanceof ConnectError)) return fallback;
	switch (error.findDetails(ErrorDetailSchema)[0]?.reason) {
		case ErrorReason.SIGN_IN_CODE_NOT_SENT:
			return "auth.codeSendFailed";
		case ErrorReason.SIGN_IN_CODE_INVALID:
			return "auth.codeInvalidOrExpired";
		case ErrorReason.SIGN_IN_CODES_EXHAUSTED:
			return "auth.codesExhausted";
		case ErrorReason.SIGN_IN_CODES_PAUSED:
			return "auth.codesPaused";
		case ErrorReason.NOT_INVITED:
			return "auth.notInvited";
	}
	switch (error.code) {
		case Code.ResourceExhausted:
			return "auth.tooManyRequests";
		case Code.Unavailable:
			return "auth.serviceUnavailable";
		case Code.DeadlineExceeded:
			return "auth.requestTimedOut";
		case Code.Internal:
		case Code.Unknown:
		case Code.Unimplemented:
			return "auth.serviceFailure";
		default:
			return fallback;
	}
}
