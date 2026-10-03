import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Center } from "@astryxdesign/core/Center";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import {
	HStack,
	Layout,
	LayoutContent,
	LayoutHeader,
	VStack,
} from "@astryxdesign/core/Layout";
import { pageTitle } from "@heveta/brand";
import { ArrowLeft } from "lucide-react";
import {
	Navigate,
	useLocation,
	useOutletContext,
	useParams,
} from "react-router";

import { useT } from "~/i18n/use-t";

import {
	type SettingsOutletContext,
	SettingsSectionList,
	settingsSections,
} from "./settings-sections";

function MobileHeader({ title, back }: { title: string; back: string }) {
	const t = useT();
	return (
		<LayoutHeader padding={3}>
			<HStack gap={2} vAlign="center">
				<IconButton
					label={t("settings.back")}
					icon={<Icon icon={ArrowLeft} size="sm" />}
					variant="ghost"
					href={back}
				/>
				<Heading level={4} accessibilityLevel={1}>
					{title}
				</Heading>
			</HStack>
		</LayoutHeader>
	);
}

// One settings section. Wide screens pick sections in the settings side nav;
// phones list them at /settings and drill in.
export default function SettingsPage() {
	const t = useT();
	const { section: key } = useParams();
	const { returnTo } = useOutletContext<SettingsOutletContext>();
	const { isMobile } = useAppShellMobile();
	const location = useLocation();
	const section = settingsSections.find((item) => item.key === key);
	if (key && !section) return <Navigate to="/settings" replace />;
	if (!section && !isMobile)
		return (
			<Navigate
				to={`/settings/${settingsSections[0].key}`}
				// Keeps where "返回" leads (returnTo) for a reload there.
				state={location.state}
				replace
			/>
		);
	if (!section)
		return (
			<>
				<title>{pageTitle(t("settings.title"))}</title>
				<Layout
					height="fill"
					header={<MobileHeader title={t("settings.title")} back={returnTo} />}
					content={
						<LayoutContent padding={2}>
							<SettingsSectionList />
						</LayoutContent>
					}
				/>
			</>
		);
	const { Content } = section;
	const sectionLabel = t(section.label);
	return (
		<>
			<title>
				{pageTitle(t("settings.sectionPageTitle", { section: sectionLabel }))}
			</title>
			{/* One readable column, centered like the conversation page; the
			scroll area still spans the full width. */}
			<Layout
				height="fill"
				contentWidth={720}
				header={
					isMobile ? (
						<MobileHeader title={sectionLabel} back="/settings" />
					) : undefined
				}
				content={
					<LayoutContent padding={isMobile ? 4 : 8}>
						<VStack gap={6}>
							{!isMobile && (
								<Heading level={2} accessibilityLevel={1}>
									{sectionLabel}
								</Heading>
							)}
							<Content />
						</VStack>
					</LayoutContent>
				}
			/>
		</>
	);
}

// A section that fails to render replaces only itself: the unsent drafts and
// running replies held above settings stay (thread-controller.tsx).
export function ErrorBoundary() {
	const t = useT();
	const { isMobile } = useAppShellMobile();
	const errorTitle = t("common.errorTitle");
	return (
		<>
			<title>
				{pageTitle(t("settings.sectionPageTitle", { section: errorTitle }))}
			</title>
			<Layout
				height="fill"
				header={
					isMobile ? (
						<MobileHeader title={t("settings.title")} back="/settings" />
					) : undefined
				}
				content={
					<Center axis="both" padding={6} height="100%">
						<EmptyState
							title={errorTitle}
							headingLevel={1}
							description={t("settings.sectionErrorDescription")}
						/>
					</Center>
				}
			/>
		</>
	);
}
