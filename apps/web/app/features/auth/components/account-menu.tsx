import { Avatar } from "@astryxdesign/core/Avatar";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { useSideNavCollapse } from "@astryxdesign/core/SideNav";
import { useToast } from "@astryxdesign/core/Toast";
import { LogOut, Settings } from "lucide-react";
import { useState } from "react";

import { useProfile } from "~/features/auth/profile";
import { signOut } from "~/features/auth/session";
import { useT } from "~/i18n/use-t";

export function AccountMenu({
	onNavigate,
	onOpenSettings,
}: {
	onNavigate?: () => void;
	onOpenSettings: () => void;
}) {
	const t = useT();
	const user = useProfile();
	const toast = useToast();
	const [pending, setPending] = useState(false);
	// In the collapsed rail the account shrinks to its avatar, like the nav icons.
	const { isCollapsed } = useSideNavCollapse();
	async function signout() {
		if (pending) return;
		setPending(true);
		// Signing out leaves for the sign-in page (SignedInLayout).
		try {
			await signOut();
			onNavigate?.();
		} catch {
			toast({ type: "error", body: t("auth.signOutFailed") });
		} finally {
			setPending(false);
		}
	}
	return (
		<DropdownMenu
			presentation="popover"
			placement="above"
			alignment="start"
			hasChevron={!isCollapsed}
			button={{
				label: user?.username || t("auth.account"),
				tooltip: isCollapsed ? user?.username : user?.email,
				isIconOnly: isCollapsed,
				width: isCollapsed ? undefined : "100%",
				// Expanded, a full-width row with its avatar, name, and chevron
				// start-aligned like the nav rows: the theme's "account" variant
				// (packages/brand/src/theme/heveta.ts), a ghost button laid out as a grid.
				variant: isCollapsed ? "ghost" : "account",
				// A taller row than the nav items, as in ChatGPT and Claude: `lg`
				// gives a 20px icon slot, which the `xsm` avatar fills exactly.
				size: "lg",
				isLoading: pending,
				// The button names and tooltips the account; the avatar's own
				// tooltip would add a second overlay and a tab stop.
				icon: (
					<Avatar
						src={user?.avatarUrl || undefined}
						name={user?.username}
						size="xsm"
						tooltip={false}
					/>
				),
			}}
			items={[
				{
					label: t("auth.settings"),
					icon: Settings,
					isDisabled: pending,
					onClick: onOpenSettings,
				},
				{
					label: t("auth.signOut"),
					icon: LogOut,
					isDisabled: pending,
					onClick: () => {
						void signout();
					},
				},
			]}
		/>
	);
}
