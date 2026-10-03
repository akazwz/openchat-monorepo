import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, LayoutHeader, StackItem } from "@astryxdesign/core/Layout";
import { MobileNavToggle } from "@astryxdesign/core/MobileNav";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";

import { useT } from "~/i18n/use-t";

// Every app page has one full-width header; page controls stay at its end.
export function AppPageHeader({
	title,
	detail,
	back,
	end,
}: {
	title?: string;
	detail?: ReactNode;
	back?: { href: string; label: string };
	end?: ReactNode;
}) {
	const t = useT();
	const heading =
		title === undefined ? (
			<Skeleton width={120} height={20} />
		) : (
			<Heading level={4} accessibilityLevel={1} maxLines={1}>
				{title}
			</Heading>
		);
	return (
		<LayoutHeader padding={3} hasDivider>
			<HStack gap={2} vAlign="center">
				<MobileNavToggle label={t("threads.openNav")} />
				{back && (
					<IconButton
						label={back.label}
						icon={<Icon icon={ArrowLeft} size="sm" />}
						variant="ghost"
						href={back.href}
					/>
				)}
				{detail ? (
					<>
						{heading}
						<StackItem size="fill">{detail}</StackItem>
					</>
				) : (
					<StackItem size="fill">{heading}</StackItem>
				)}
				{end && (
					<HStack gap={2} vAlign="center">
						{end}
					</HStack>
				)}
			</HStack>
		</LayoutHeader>
	);
}
