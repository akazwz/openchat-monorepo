import { AspectRatio } from "@astryxdesign/core/AspectRatio";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, Section, StackItem, VStack } from "@astryxdesign/core/Layout";
import { SelectableCard } from "@astryxdesign/core/SelectableCard";
import { Text } from "@astryxdesign/core/Text";
import { Theme, type ThemeMode } from "@astryxdesign/core/theme";
import { hevetaTheme } from "@heveta/brand/theme";

import { colorModeOptions } from "~/components/color-mode";
import { useT } from "~/i18n/use-t";

// The miniature drawn inside each card, after Astryx's settings-dialog
// template: the app drawn small in one mode, its page with a card on it (the
// template's lines of "text" are left out: Skeleton pulses forever). A nested
// Theme re-declares the tokens for the mode it draws, so the light card stays
// light in a dark app. The page's color is the picture's edge: the settings
// card around it has the card color in either mode, so a picture edged in
// that color lost its edge in its own mode. The outer Section has no padding,
// so the inner one does not bleed to its edges.
function PreviewCanvas({ mode }: { mode: "light" | "dark" }) {
	return (
		<Theme theme={hevetaTheme} mode={mode}>
			<Section variant="section" padding={0} height="100%">
				<VStack padding={2} paddingBlockStart={5} height="100%">
					<StackItem size="fill">
						<Section variant="muted" padding={0} height="100%" />
					</StackItem>
				</VStack>
			</Section>
		</Theme>
	);
}

// One rounded frame that clips the canvas; "follow system" is half of each.
// A picture, not a control: inert keeps it out of hit-testing and the
// accessibility tree, so the card around it takes every click.
function Preview({ mode }: { mode: ThemeMode }) {
	return (
		<AspectRatio ratio={3 / 2} inert>
			<Card variant="preview" padding={0} height="100%">
				{mode === "system" ? (
					<HStack gap={0} height="100%">
						<StackItem size="fill">
							<PreviewCanvas mode="light" />
						</StackItem>
						<StackItem size="fill">
							<PreviewCanvas mode="dark" />
						</StackItem>
					</HStack>
				) : (
					<PreviewCanvas mode={mode} />
				)}
			</Card>
		</AspectRatio>
	);
}

// Appearance as pictures of each choice, as macOS, GitHub, and Claude show
// it. SelectableCard owns selection, hover, and focus; a card only selects,
// so re-picking the current mode does nothing.
export function ThemeChoiceCards({
	value,
	onChange,
}: {
	value: ThemeMode;
	onChange: (value: ThemeMode) => void;
}) {
	const t = useT();
	return (
		<Grid
			// Each card is a checkbox (SelectableCard), so the set is a group,
			// not a radio group.
			role="group"
			aria-label={t("settings.appearance")}
			// Three across where they fit; capped so the cards stay a control,
			// not a hero image, on wide screens.
			columns={{ minWidth: 96, max: 3 }}
			gap={2}
			maxWidth={480}
		>
			{colorModeOptions.map((option) => {
				const isSelected = option.value === value;
				return (
					<SelectableCard
						key={option.value}
						label={t(option.label)}
						isSelected={isSelected}
						padding={2}
						onChange={() => {
							if (!isSelected) onChange(option.value);
						}}
					>
						<VStack gap={1.5}>
							<Preview mode={option.value} />
							<HStack gap={1} align="center" justify="center">
								<Icon icon={option.icon} size="sm" color="secondary" />
								<Text
									type="supporting"
									weight={isSelected ? "semibold" : undefined}
								>
									{t(option.label)}
								</Text>
							</HStack>
						</VStack>
					</SelectableCard>
				);
			})}
		</Grid>
	);
}
