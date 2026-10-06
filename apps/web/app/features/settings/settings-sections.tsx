import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import {
	ChevronRight,
	Laptop,
	type LucideIcon,
	Monitor,
	SlidersHorizontal,
	UserRound,
} from "lucide-react";
import type { ComponentType } from "react";

import { DevicesSection } from "~/features/devices/devices-section";
import type { MessageKey } from "~/i18n/messages";
import { useT } from "~/i18n/use-t";

import { AccountSection } from "./account-section";
import { ComputerSection } from "./computer-section";
import { GeneralSection } from "./general-section";

// New settings are a new entry here: each section has its own address.
export const settingsSections: {
	key: string;
	label: MessageKey;
	icon: LucideIcon;
	Content: ComponentType;
}[] = [
	{
		key: "general",
		label: "settings.sectionGeneral",
		icon: SlidersHorizontal,
		Content: GeneralSection,
	},
	{
		key: "computer",
		label: "settings.sectionComputer",
		icon: Monitor,
		Content: ComputerSection,
	},
	{
		key: "devices",
		label: "devices.title",
		icon: Laptop,
		Content: DevicesSection,
	},
	{
		key: "account",
		label: "settings.sectionAccount",
		icon: UserRound,
		Content: AccountSection,
	},
];

export interface SettingsOutletContext {
	// Where "back" leaves settings for: the page settings was opened from.
	returnTo: string;
}

// Phones: the sections as a list to drill into, like iOS Settings.
export function SettingsSectionList() {
	const t = useT();
	return (
		<List density="spacious">
			{settingsSections.map((section) => (
				<ListItem
					key={section.key}
					label={t(section.label)}
					href={`/settings/${section.key}`}
					startContent={<Icon icon={section.icon} />}
					endContent={<Icon icon={ChevronRight} size="sm" color="secondary" />}
				/>
			))}
		</List>
	);
}
