import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import { BrandMark, brandName, pageTitle } from "@heveta/brand";
import { QueryClientProvider } from "@tanstack/react-query";
import {
	isRouteErrorResponse,
	Links,
	Meta,
	Outlet,
	Scripts,
	ScrollRestoration,
	useRouteError,
} from "react-router";

import { colorModeScript } from "~/components/color-mode";
import { StandalonePage } from "~/components/standalone-page";
import { useT } from "~/i18n/use-t";
import { AppProvider } from "~/lib/app-provider";
import { useDesktop } from "~/lib/desktop";
import { queryClient } from "~/lib/query-client";

import "./app.css";

export const links = () => [
	{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
];

export function Layout({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				<meta charSet="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				{/* Register the layer order before styles load, including app.css
				    injected by Vite from script in development. */}
				<style>{"@layer reset, astryx-base, astryx-theme;"}</style>
				{/* Apply the saved light/dark mode before the first paint. */}
				<script
					// A constant script: nothing in it comes from users.
					dangerouslySetInnerHTML={{ __html: colorModeScript }}
				/>
				<Meta />
				<Links />
			</head>
			<body>
				<AppProvider>{children}</AppProvider>
				<ScrollRestoration />
				<Scripts />
			</body>
		</html>
	);
}

export default function App() {
	useDesktop();
	return (
		<QueryClientProvider client={queryClient}>
			<Outlet />
		</QueryClientProvider>
	);
}

// Only the mark and a spinner while the app loads.
export function HydrateFallback() {
	const t = useT();
	return (
		<StandalonePage>
			<title>{brandName}</title>
			<VStack gap={4} hAlign="center">
				<BrandMark size={40} />
				<Spinner aria-label={t("common.loading", { brand: brandName })} />
			</VStack>
		</StandalonePage>
	);
}

export function ErrorBoundary() {
	const error = useRouteError();
	const notFound = isRouteErrorResponse(error) && error.status === 404;
	const t = useT();
	const title = t(notFound ? "common.notFoundTitle" : "common.errorTitle");
	return (
		<StandalonePage>
			<title>{pageTitle(title)}</title>
			<EmptyState
				title={title}
				headingLevel={1}
				description={t(
					notFound ? "common.notFoundDescription" : "common.errorDescription",
				)}
				icon={<BrandMark size={40} />}
				actions={
					<HStack gap={2}>
						<Button label={t("common.home")} href="/" />
						{!notFound && (
							<Button
								label={t("common.reload")}
								variant="primary"
								onClick={() => window.location.reload()}
							/>
						)}
					</HStack>
				}
			/>
		</StandalonePage>
	);
}
