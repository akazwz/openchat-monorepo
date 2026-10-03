import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import {
	HStack,
	Layout,
	LayoutContent,
	LayoutFooter,
	VStack,
} from "@astryxdesign/core/Layout";
import { zodResolver } from "@hookform/resolvers/zod";
import { useId } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { FormInput } from "~/components/form-input";
import { useProfile, useSetUsername } from "~/features/auth/profile";
import { usernameField } from "~/features/auth/validation";
import { useT } from "~/i18n/use-t";

const schema = z.object({ username: usernameField });

export default function UsernameDialog({
	isOpen,
	onOpenChange,
}: {
	isOpen: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const t = useT();
	const current = useProfile()?.username ?? "";
	const { mutate: setUsername } = useSetUsername();
	const formId = useId();
	const { control, handleSubmit } = useForm<z.infer<typeof schema>>({
		resolver: zodResolver(schema),
		defaultValues: { username: current },
	});
	// Saved, it closes and the name shows at once (auth/profile.ts); a refusal
	// is reported and the old name shows again.
	const close = (open: boolean) => {
		if (!open) onOpenChange(false);
	};
	return (
		<Dialog isOpen={isOpen} onOpenChange={close} purpose="form" width={420}>
			<Layout
				height="auto"
				header={
					<DialogHeader
						title={t("settings.usernameDialogTitle")}
						onOpenChange={close}
					/>
				}
				content={
					<LayoutContent>
						<VStack
							as="form"
							id={formId}
							gap={4}
							onSubmit={handleSubmit(({ username }) => {
								onOpenChange(false);
								if (username !== current) setUsername(username);
							})}
						>
							<FormInput
								control={control}
								name="username"
								label={t("settings.username")}
								autoComplete="nickname"
								maxLength={40}
								autoFocus
							/>
						</VStack>
					</LayoutContent>
				}
				footer={
					<LayoutFooter>
						<HStack gap={2} hAlign="end">
							<Button
								label={t("settings.cancel")}
								variant="secondary"
								onClick={() => onOpenChange(false)}
							/>
							<Button
								type="submit"
								form={formId}
								label={t("settings.save")}
								variant="primary"
							/>
						</HStack>
					</LayoutFooter>
				}
			/>
		</Dialog>
	);
}
