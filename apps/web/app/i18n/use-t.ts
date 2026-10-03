import { useTranslator } from "@astryxdesign/core/i18n";

import type { Message, MessageKey } from "./messages";

export type Translate = (
	key: MessageKey,
	values?: Record<string, unknown>,
) => string;

// The app's messages in the current language (i18n/messages.ts); a key that
// does not exist fails to compile.
export function useT(): Translate {
	return useTranslator() as Translate;
}

// A message a module produced (a key, or a key with its values).
export function translateMessage(t: Translate, message: Message) {
	return typeof message === "string"
		? t(message)
		: t(message.key, message.values);
}
