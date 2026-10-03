import { Selector } from "@astryxdesign/core/Selector";
import { Languages, SunMoon } from "lucide-react";

import { useColorMode } from "~/components/color-mode";
import type { AppLocale } from "~/i18n/catalog";
import { type LanguagePreference, useLanguage } from "~/i18n/language";
import { useT } from "~/i18n/use-t";

import { SettingsCard, SettingsRow } from "./settings-rows";
import { ThemeChoiceCards } from "./theme-choice-cards";

// Each language by its own name, as language menus show them.
const languageNames: Record<AppLocale, string> = {
	en: "English",
	"zh-CN": "简体中文",
};

export function GeneralSection() {
	const t = useT();
	const { mode, setMode } = useColorMode();
	const preference = useLanguage((state) => state.preference);
	const choose = useLanguage((state) => state.choose);
	return (
		<SettingsCard>
			<SettingsRow
				title={t("settings.appearance")}
				icon={SunMoon}
				description={t("settings.thisBrowserOnly")}
				detail={<ThemeChoiceCards value={mode} onChange={setMode} />}
			/>
			<SettingsRow
				title={t("settings.language")}
				icon={Languages}
				description={t("settings.thisBrowserOnly")}
				detail={
					<Selector
						label={t("settings.language")}
						isLabelHidden
						width={240}
						value={preference}
						onChange={(value) => choose(value as LanguagePreference)}
						options={[
							{ value: "system", label: t("settings.languageBrowser") },
							...Object.entries(languageNames).map(([value, label]) => ({
								value,
								label,
							})),
						]}
					/>
				}
			/>
		</SettingsCard>
	);
}
