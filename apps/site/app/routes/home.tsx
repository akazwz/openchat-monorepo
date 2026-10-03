import { AppShell } from "@astryxdesign/core/AppShell";
import { AspectRatio } from "@astryxdesign/core/AspectRatio";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TopNav, TopNavHeading } from "@astryxdesign/core/TopNav";
import { BrandMark, brandName } from "@heveta/brand";
import {
	AppWindow,
	ArrowRight,
	Brain,
	FileText,
	MonitorSmartphone,
	Search,
	SquareTerminal,
} from "lucide-react";
import { useLocation } from "react-router";

import { copy, localeOf, localePaths } from "~/copy";

import type { Route } from "./+types/home";

// The app, where every call to action leads.
const appUrl = "https://app.heveta.com";
const signInUrl = `${appUrl}/signin`;

const siteUrl = "https://heveta.com";

// Each capability's icon, in the order of its copy (copy.ts).
const capabilityIcons = [
	SquareTerminal,
	AppWindow,
	FileText,
	Search,
	Brain,
	MonitorSmartphone,
];

export function meta({ location }: Route.MetaArgs) {
	const locale = localeOf(location.pathname);
	const text = copy[locale];
	return [
		{ title: text.pageTitle },
		{ name: "description", content: text.description },
		{ property: "og:title", content: brandName },
		{ property: "og:description", content: text.description },
		{ property: "og:type", content: "website" },
		{ property: "og:url", content: `${siteUrl}${localePaths[locale]}` },
		// Each language's page names the other, for search engines.
		...Object.entries(localePaths).map(([hreflang, path]) => ({
			tagName: "link",
			rel: "alternate",
			hrefLang: hreflang,
			href: `${siteUrl}${path}`,
		})),
		{
			tagName: "link",
			rel: "alternate",
			hrefLang: "x-default",
			href: `${siteUrl}/`,
		},
	];
}

function StartButton({ label }: { label: string }) {
	return (
		<Button
			label={label}
			variant="primary"
			size="lg"
			href={appUrl}
			endContent={<Icon icon={ArrowRight} size="sm" />}
		/>
	);
}

export default function Home() {
	const locale = localeOf(useLocation().pathname);
	const text = copy[locale];
	const other = locale === "en" ? "zh-CN" : "en";
	return (
		<AppShell
			height="auto"
			variant="surface"
			topNav={
				<TopNav
					label={brandName}
					heading={
						<TopNavHeading
							heading={brandName}
							logo={<BrandMark size={24} />}
							headingHref={localePaths[locale]}
						/>
					}
					endContent={
						<HStack gap={2}>
							<Button
								label={text.otherLanguage}
								variant="ghost"
								href={localePaths[other]}
							/>
							<Button label={text.signIn} variant="ghost" href={signInUrl} />
							<Button label={text.start} variant="primary" href={appUrl} />
						</HStack>
					}
				/>
			}
		>
			{/* One centered column, capped so lines stay readable on wide screens. */}
			<VStack hAlign="center" paddingInline={4} paddingBlock={10}>
				<VStack gap={10} width="100%" maxWidth={1100}>
					<VStack gap={6} hAlign="center">
						<VStack gap={3} hAlign="center">
							<Heading
								level={1}
								type="display-2"
								justify="center"
								textWrap="balance"
							>
								{text.heading}
							</Heading>
							<Text
								type="large"
								color="secondary"
								justify="center"
								textWrap="balance"
							>
								{text.description}
							</Text>
						</VStack>
						<HStack gap={3}>
							<StartButton label={text.start} />
							<Button
								label={text.signIn}
								variant="secondary"
								size="lg"
								href={signInUrl}
							/>
						</HStack>
					</VStack>
					{/* The card's grey frames the screenshot, whose edges would
					    otherwise run into a page of the same background. The app as
					    it looks in the page's language and the visitor's mode: `fit`
					    stretches the picture over the box, and the reset scales its
					    image to that width; every screenshot has the box's ratio. */}
					<Card variant="muted" padding={2}>
						<AspectRatio ratio={1400 / 900} fit="cover">
							<picture>
								<source
									srcSet={`/screenshots/${locale}-dark.webp`}
									media="(prefers-color-scheme: dark)"
								/>
								<img
									src={`/screenshots/${locale}-light.webp`}
									alt={text.screenshotAlt}
									width={1400}
									height={900}
								/>
							</picture>
						</AspectRatio>
					</Card>
					<VStack gap={6}>
						<Heading level={2} justify="center">
							{text.capabilitiesHeading}
						</Heading>
						<Grid columns={{ minWidth: 280, repeat: "fit" }} gap={4}>
							{text.capabilities.map((item, index) => (
								<Card key={item.title} variant="muted">
									<VStack gap={3}>
										<Icon
											icon={capabilityIcons[index]}
											size="lg"
											color="secondary"
										/>
										<VStack gap={1}>
											<Heading level={3}>{item.title}</Heading>
											<Text color="secondary">{item.text}</Text>
										</VStack>
									</VStack>
								</Card>
							))}
						</Grid>
					</VStack>
					<VStack gap={4} hAlign="center" paddingBlock={8}>
						<Heading level={2} justify="center">
							{text.closingHeading}
						</Heading>
						<Text color="secondary" justify="center">
							{text.closingText}
						</Text>
						<StartButton label={text.start} />
					</VStack>
					<Text type="supporting" justify="center">
						© 2026 {brandName}
					</Text>
				</VStack>
			</VStack>
		</AppShell>
	);
}
