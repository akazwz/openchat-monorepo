import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { useNavigate, useParams } from "react-router";

import { useDeleteThread } from "~/features/threads/thread-commands";
import { displayTitle } from "~/features/threads/title";
import type { Thread } from "~/features/threads/types";
import { useT } from "~/i18n/use-t";

interface DeleteThreadDialogProps {
	thread: Thread | null;
	isOpen: boolean;
	onClose: () => void;
}

// Confirmed, the conversation is gone at once, as in ChatGPT and Claude: it
// leaves the side nav while its deletion is in flight (thread-commands.ts),
// and its page if open. A refused deletion lists it again.
export function DeleteThreadDialog({
	thread,
	isOpen,
	onClose,
}: DeleteThreadDialogProps) {
	const t = useT();
	const navigate = useNavigate();
	const { threadId: activeThreadId } = useParams();
	const { mutate: deleteThread } = useDeleteThread();
	return (
		<AlertDialog
			isOpen={isOpen && thread !== null}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={t("threads.deleteThreadTitle")}
			// Name the conversation, so the confirmation cannot hit the wrong one.
			description={t("threads.deleteThreadDescription", {
				title: thread ? displayTitle(t, thread) : "",
			})}
			actionLabel={t("threads.deleteThreadAction")}
			cancelLabel={t("threads.cancel")}
			onAction={() => {
				if (!thread) return;
				onClose();
				if (activeThreadId === thread.id) void navigate("/");
				deleteThread(thread.id);
			}}
		/>
	);
}
