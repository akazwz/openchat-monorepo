import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Icon } from "@astryxdesign/core/Icon";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { FolderOpen, Monitor, SquareTerminal } from "lucide-react";
import { useNavigate } from "react-router";

import { useT } from "~/i18n/use-t";

export type ComputerView = "screen" | "terminal" | "files";
const paths: Record<ComputerView, string> = {
	screen: "/computer",
	terminal: "/computer/terminal",
	files: "/computer/files",
};

// The agent's computer is one place with three views of it: its screen, a
// terminal on it, and its files. Each has its own address, so a view can be
// linked to and the back button moves between them.
export function ComputerTabs({ view }: { view: ComputerView }) {
	const t = useT();
	const navigate = useNavigate();
	// A phone's header also holds the drawer toggle and the view's controls:
	// the tabs are their icons there, named for assistive technology.
	const { isMobile } = useAppShellMobile();
	return (
		<TabList
			value={view}
			size="sm"
			onChange={(next) => void navigate(paths[next as ComputerView])}
		>
			<Tab
				value="screen"
				label={t("computer.screen")}
				isLabelHidden={isMobile}
				icon={<Icon icon={Monitor} size="sm" />}
			/>
			<Tab
				value="terminal"
				label={t("computer.terminal")}
				isLabelHidden={isMobile}
				icon={<Icon icon={SquareTerminal} size="sm" />}
			/>
			<Tab
				value="files"
				label={t("computer.files")}
				isLabelHidden={isMobile}
				icon={<Icon icon={FolderOpen} size="sm" />}
			/>
		</TabList>
	);
}
