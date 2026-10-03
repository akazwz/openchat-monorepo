import { Button } from "@astryxdesign/core/Button";
import { Center } from "@astryxdesign/core/Center";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Layout } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import { pageTitle } from "@heveta/brand";
import { lazy, Suspense } from "react";

import { AppPageHeader } from "~/components/app-page-header";
import { useT } from "~/i18n/use-t";

import { ComputerFiles } from "./computer-files";
import { useWorkspaceFiles } from "./workspace-files";

// Heavy live clients load only with the view the person opens.
const ComputerScreen = lazy(() => import("./computer-screen"));
const ComputerTerminal = lazy(() => import("./computer-terminal"));

type ComputerView = "screen" | "terminal" | "files";
const titles = {
	screen: "computer.title",
	terminal: "computer.terminal",
	files: "computer.files",
} as const;

// Each route shows one view of the same computer. Navigating away unmounts
// the live client and releases its connection, without stopping its work.
export default function ComputerPage({ view }: { view: ComputerView }) {
	const t = useT();
	const files = useWorkspaceFiles();
	const title = t(titles[view]);
	return (
		<>
			<title>{pageTitle(title)}</title>
			<Suspense
				fallback={
					<Layout
						header={<AppPageHeader title={title} />}
						content={
							<Center axis="both" height="100%">
								<Spinner
									aria-label={t(
										view === "terminal"
											? "computer.loadingTerminal"
											: "computer.loadingScreen",
									)}
								/>
							</Center>
						}
					/>
				}
			>
				{view === "screen" && <ComputerScreen />}
				{view === "terminal" && <ComputerTerminal />}
				{view === "files" && <ComputerFiles files={files} />}
			</Suspense>
		</>
	);
}

// A view's render failure leaves navigation and session state available.
export function ErrorBoundary() {
	const t = useT();
	return (
		<>
			<title>{pageTitle(t("common.errorTitle"))}</title>
			<Layout
				header={<AppPageHeader title={t("common.errorTitle")} />}
				content={
					<Center axis="both" padding={6} height="100%">
						<EmptyState
							title={t("common.errorTitle")}
							headingLevel={1}
							description={t("computer.pageErrorDescription")}
							actions={
								<Button
									label={t("threads.newThread")}
									href="/"
									variant="primary"
								/>
							}
						/>
					</Center>
				}
			/>
		</>
	);
}
