import type { Thread } from "~/features/threads/types";
import type { Translate } from "~/i18n/use-t";

// The title a new thread gets from its first message, mirroring the
// server's rule (threads/service.ts): the first 40 characters of the
// trimmed text, or empty when there is none (an image-only message). The
// display helper below turns an empty title into a localized "Untitled".
export function threadTitle(text: string) {
	return Array.from(text.trim()).slice(0, 40).join("");
}
// How a conversation is named wherever it is shown; one with no title yet
// (still being titled, or started with no text) shows as "Untitled".
export const displayTitle = (t: Translate, thread: Pick<Thread, "title">) =>
	thread.title || t("threads.untitled");
