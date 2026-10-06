import { Center } from "@astryxdesign/core/Center";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Layout, LayoutContent, VStack } from "@astryxdesign/core/Layout";
import { pageTitle } from "@heveta/brand";

import { AppPageHeader } from "~/components/app-page-header";
import { MemorySection } from "~/features/settings/memory-section";
import { useT } from "~/i18n/use-t";

// What the agent remembers about its person: part of the agent, beside its
// computer and its mailbox, not a setting of the app.
export default function MemoryPage() {
	const t = useT();
	return (
		<>
			<title>{pageTitle(t("settings.sectionMemory"))}</title>
			<Layout
				height="fill"
				header={<AppPageHeader title={t("settings.sectionMemory")} />}
				content={
					<LayoutContent padding={4}>
						<Center axis="horizontal">
							<VStack width="100%" maxWidth={800}>
								<MemorySection />
							</VStack>
						</Center>
					</LayoutContent>
				}
			/>
		</>
	);
}

export function ErrorBoundary() {
	const t = useT();
	return (
		<Layout
			height="fill"
			header={<AppPageHeader title={t("common.errorTitle")} />}
			content={
				<Center axis="both" padding={6} height="100%">
					<EmptyState title={t("common.errorTitle")} headingLevel={1} />
				</Center>
			}
		/>
	);
}
