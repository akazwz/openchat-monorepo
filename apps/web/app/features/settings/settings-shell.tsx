import { AppShell } from "@astryxdesign/core/AppShell";
import {
	SideNav,
	SideNavItem,
	SideNavSection,
} from "@astryxdesign/core/SideNav";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import {
	Outlet,
	PrefetchPageLinks,
	useLocation,
	useParams,
} from "react-router";

import { useT } from "~/i18n/use-t";

import {
	type SettingsOutletContext,
	settingsSections,
} from "./settings-sections";

// Settings replace the whole app, as in Linear or GitHub: the side nav holds
// a way back and the sections, not the conversation list. Phones have no side
// nav here; the pages list the sections and link back themselves.
export default function SettingsShell() {
	const t = useT();
	const { section } = useParams();
	const location = useLocation();
	// Kept for the whole visit: moving between sections must not lose it.
	const [returnTo] = useState(() => {
		const state = location.state as { returnTo?: unknown } | null;
		return typeof state?.returnTo === "string" &&
			state.returnTo.startsWith("/") &&
			!state.returnTo.startsWith("/settings")
			? state.returnTo
			: "/";
	});
	const context: SettingsOutletContext = { returnTo };
	return (
		<>
			{/* The way back, fetched ahead as the conversations fetch settings
			(thread-shell.tsx): opened from a link, this is the first page. */}
			<PrefetchPageLinks page={returnTo} />
			<AppShell
				mobileNav={false}
				sideNav={
					<SideNav
						aria-label={t("settings.navLabel")}
						topContent={
							<SideNavItem
								label={t("settings.back")}
								icon={ArrowLeft}
								href={returnTo}
							/>
						}
					>
						<SideNavSection title={t("settings.title")}>
							{settingsSections.map((item) => (
								<SideNavItem
									key={item.key}
									label={t(item.label)}
									icon={item.icon}
									href={`/settings/${item.key}`}
									isSelected={section === item.key}
								/>
							))}
						</SideNavSection>
					</SideNav>
				}
			>
				<Outlet context={context} />
			</AppShell>
		</>
	);
}
