import { Avatar } from "@astryxdesign/core/Avatar";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { useMutation } from "@tanstack/react-query";
import { CircleUserRound, Mail, UserRound } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";

import { useProfile } from "~/features/auth/profile";
import {
	currentSession,
	isCurrentSession,
	useAuthStore,
} from "~/features/auth/store";
import type { User } from "~/gen/heveta/v1/auth_pb";
import type { MessageKey } from "~/i18n/messages";
import { useT } from "~/i18n/use-t";
import { authClient } from "~/lib/rpc-client";

import { setAvatar, UnreadableImage } from "./avatar";
import { SettingsCard, SettingsRow } from "./settings-rows";

// The form and its libraries (react-hook-form, zod) load with the first
// rename, not with settings, which the conversations prefetch.
const UsernameDialog = lazy(() => import("./username-dialog"));

// The profile photo: shown, replaced from a picked image, or removed. It is
// private to the account (the server serves it to its own sessions only).
function AvatarRow() {
	const t = useT();
	const toast = useToast();
	const user = useProfile();
	const picker = useRef<HTMLInputElement>(null);
	const adopt = (updated: User | undefined, done: MessageKey) => {
		if (updated) useAuthStore.getState().updateUser(updated);
		toast({ body: t(done) });
	};
	const upload = useMutation({
		mutationFn: setAvatar,
		onSuccess: (updated, { owner }) => {
			if (isCurrentSession(owner)) adopt(updated, "settings.avatarUpdated");
		},
		onError: (error, { owner }) => {
			if (isCurrentSession(owner))
				toast({
					type: "error",
					body: t(
						error instanceof UnreadableImage
							? "settings.avatarUnreadable"
							: "settings.avatarFailed",
					),
				});
		},
	});
	const remove = useMutation({
		mutationFn: async () => (await authClient.removeAvatar({})).user,
		onSuccess: (updated) => adopt(updated, "settings.avatarRemoved"),
		onError: () => toast({ type: "error", body: t("settings.avatarFailed") }),
	});
	const busy = upload.isPending || remove.isPending;
	const hasAvatar = Boolean(user?.avatarUrl);
	return (
		<SettingsRow
			title={t("settings.avatar")}
			icon={CircleUserRound}
			control={
				<HStack gap={3} vAlign="center">
					<input
						ref={picker}
						type="file"
						hidden
						accept="image/*"
						onChange={(event) => {
							const file = event.target.files?.[0];
							event.target.value = "";
							if (file) upload.mutate({ file, owner: currentSession() });
						}}
					/>
					<Avatar
						src={user?.avatarUrl || undefined}
						name={user?.username}
						size="md"
						tooltip={false}
					/>
					{hasAvatar && (
						<Button
							label={t("settings.avatarRemove")}
							size="sm"
							variant="ghost"
							isDisabled={busy}
							isLoading={remove.isPending}
							onClick={() => remove.mutate()}
						/>
					)}
					<Button
						label={t(
							hasAvatar ? "settings.avatarChange" : "settings.avatarUpload",
						)}
						size="sm"
						isDisabled={busy}
						isLoading={upload.isPending}
						onClick={() => picker.current?.click()}
					/>
				</HStack>
			}
		/>
	);
}

// Signing in is by email code only, so the account is a photo, a name, and
// an address.
export function AccountSection() {
	const t = useT();
	const user = useProfile();
	const [renameOpen, setRenameOpen] = useState(false);
	// A fresh form every time the dialog opens.
	const [renameKey, setRenameKey] = useState(0);
	return (
		<>
			<SettingsCard>
				<AvatarRow />
				<SettingsRow
					title={t("settings.username")}
					icon={UserRound}
					control={
						<HStack gap={3} vAlign="center">
							<Text color="secondary" maxLines={1}>
								{user?.username || "—"}
							</Text>
							<Button
								label={t("settings.edit")}
								size="sm"
								onClick={() => {
									setRenameKey((key) => key + 1);
									setRenameOpen(true);
								}}
							/>
						</HStack>
					}
				/>
				<SettingsRow
					title={t("settings.email")}
					icon={Mail}
					control={
						<Text color="secondary" maxLines={1}>
							{user?.email || "—"}
						</Text>
					}
				/>
			</SettingsCard>
			{/* From the first rename on (a fresh form each time it opens). */}
			{renameKey > 0 && (
				<Suspense>
					<UsernameDialog
						key={renameKey}
						isOpen={renameOpen}
						onOpenChange={setRenameOpen}
					/>
				</Suspense>
			)}
		</>
	);
}
