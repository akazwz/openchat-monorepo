import { z } from "zod";

import type { MessageKey } from "~/i18n/messages";

// Each field's error is a message key; FormInput shows it in the current
// language.
export const emailField = z
	.string()
	.trim()
	.toLowerCase()
	.pipe(z.email({ error: "auth.emailInvalid" satisfies MessageKey }));
// Same rule as the server's: 2–40 letters, numbers, underscores or hyphens.
export const usernameField = z
	.string()
	.trim()
	.regex(/^[\p{L}\p{N}_-]{2,40}$/u, {
		error: "auth.usernameInvalid" satisfies MessageKey,
	});
export const codeField = z
	.string()
	.trim()
	.regex(/^\d{6}$/, { error: "auth.codeFormatInvalid" satisfies MessageKey });
