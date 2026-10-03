import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import {
	HStack,
	Layout,
	LayoutContent,
	LayoutFooter,
} from "@astryxdesign/core/Layout";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useId, useMemo } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { FormInput } from "~/components/form-input";
import { useRenameThread } from "~/features/threads/thread-commands";
import type { Thread } from "~/features/threads/types";
import { useT } from "~/i18n/use-t";

const maxTitleLength = 200;
interface FormData {
	title: string;
}

interface RenameThreadDialogProps {
	thread: Thread | null;
	isOpen: boolean;
	onClose: () => void;
}

// Saved, the dialog closes and the new title shows at once while the rename
// is in flight (thread-commands.ts); a refused rename shows the old one again.
// Loaded on demand (thread-shell.tsx).
export default function RenameThreadDialog({
	thread,
	isOpen,
	onClose,
}: RenameThreadDialogProps) {
	const { mutate: rename } = useRenameThread();
	return (
		<Dialog
			isOpen={isOpen && thread !== null}
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			purpose="form"
			width={480}
		>
			{thread && (
				<RenameThreadForm
					key={thread.id}
					thread={thread}
					isOpen={isOpen}
					onClose={onClose}
					onSubmit={(data) => {
						onClose();
						if (data.title !== thread.title)
							rename({ id: thread.id, title: data.title });
					}}
				/>
			)}
		</Dialog>
	);
}

// The Astryx `DialogFormDialog` template: header, fields, and a footer of actions.
function RenameThreadForm({
	thread,
	isOpen,
	onClose,
	onSubmit,
}: {
	thread: Thread;
	isOpen: boolean;
	onClose: () => void;
	onSubmit: (data: FormData) => void;
}) {
	const t = useT();
	const formId = useId();
	const formSchema = useMemo(
		() =>
			z.object({
				title: z
					.string()
					.trim()
					.min(1, t("threads.titleRequired"))
					.max(
						maxTitleLength,
						t("threads.titleTooLong", { max: maxTitleLength }),
					),
			}),
		[t],
	);
	const { control, handleSubmit, reset } = useForm<FormData>({
		defaultValues: { title: thread.title },
		resolver: zodResolver(formSchema),
	});
	useEffect(() => {
		if (isOpen) reset({ title: thread.title });
	}, [isOpen, thread.title, reset]);
	return (
		<Layout
			header={
				<DialogHeader
					title={t("threads.renameThreadTitle")}
					onOpenChange={() => onClose()}
				/>
			}
			content={
				<LayoutContent>
					<form id={formId} noValidate onSubmit={handleSubmit(onSubmit)}>
						<FormInput
							control={control}
							name="title"
							label={t("threads.threadNameLabel")}
							maxLength={maxTitleLength}
							autoFocus
						/>
					</form>
				</LayoutContent>
			}
			footer={
				<LayoutFooter>
					<HStack gap={2} hAlign="end">
						<Button
							label={t("threads.cancel")}
							variant="secondary"
							onClick={onClose}
						/>
						<Button
							label={t("threads.save")}
							variant="primary"
							type="submit"
							form={formId}
						/>
					</HStack>
				</LayoutFooter>
			}
		/>
	);
}
