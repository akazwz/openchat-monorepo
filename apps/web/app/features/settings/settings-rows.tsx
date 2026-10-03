import { useAppShellMobile } from "@astryxdesign/core/AppShell";
import { Card } from "@astryxdesign/core/Card";
import { Divider } from "@astryxdesign/core/Divider";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import type { LucideIcon } from "lucide-react";
import { Children, type ReactNode } from "react";

// The Astryx settings templates' group: a muted card of divided rows.
export function SettingsCard({
	title,
	children,
}: {
	title?: string;
	children: ReactNode;
}) {
	const rows = Children.toArray(children);
	return (
		<VStack gap={1.5}>
			{title && (
				<Text type="supporting" weight="semibold" color="secondary">
					{title}
				</Text>
			)}
			<Card padding={0} width="100%" variant="muted">
				<VStack as="ul" role="list" gap={0}>
					{rows.map((row, index) => (
						<VStack key={index} as="li" gap={0}>
							{index > 0 && <Divider variant="subtle" />}
							{row}
						</VStack>
					))}
				</VStack>
			</Card>
		</VStack>
	);
}

// Desktop: the label takes the row's width and wraps; the value or control
// keeps its own at the end. Mobile: the value has its own row, so identifiers
// and avatar actions never squeeze the label.
// `detail` is content that cannot sit beside it (a picker of cards); it goes
// inside the row's own inset, so it lines up with the title.
export function SettingsRow({
	title,
	icon,
	description,
	control,
	detail,
}: {
	title: string;
	icon: LucideIcon;
	description?: string;
	control?: ReactNode;
	detail?: ReactNode;
}) {
	const { isMobile } = useAppShellMobile();
	const Row = isMobile ? VStack : HStack;
	return (
		<VStack padding={4} gap={3}>
			<Row gap={3} align={isMobile ? "stretch" : "center"}>
				<StackItem size="fill">
					<VStack gap={0.5}>
						<HStack gap={2} vAlign="center">
							<Icon icon={icon} size="sm" color="secondary" />
							<Text type="label">{title}</Text>
						</HStack>
						{description && (
							<Text type="supporting" color="secondary">
								{description}
							</Text>
						)}
					</VStack>
				</StackItem>
				{control && (
					<HStack justify={isMobile ? "start" : "end"}>{control}</HStack>
				)}
			</Row>
			{detail}
		</VStack>
	);
}
