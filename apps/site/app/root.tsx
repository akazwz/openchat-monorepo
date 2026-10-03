import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import messages from "@astryxdesign/core/locales/zh-CN.json";
import { Theme } from "@astryxdesign/core/theme";
import { hevetaTheme } from "@heveta/brand/theme";
import {
	Links,
	Meta,
	Outlet,
	Scripts,
	ScrollRestoration,
	useLocation,
} from "react-router";

import { localeOf } from "~/copy";

import "./app.css";

export const links = () => [
	{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
];

export function Layout({ children }: { children: React.ReactNode }) {
	// Each page's language is its path's (copy.ts): the page itself, and
	// Astryx's own labels in it.
	const locale = localeOf(useLocation().pathname);
	return (
		<html lang={locale}>
			<head>
				<meta charSet="utf-8" />
				<meta name="viewport" content="width=device-width, initial-scale=1" />
				<Meta />
				<Links />
			</head>
			<body>
				{/* The site follows the system's light or dark mode: it has no
				    setting of its own, and the app's lives on its own origin. */}
				<InternationalizationProvider
					locale={locale}
					messages={{ "zh-CN": messages }}
				>
					<Theme theme={hevetaTheme} mode="system">
						{children}
					</Theme>
				</InternationalizationProvider>
				<ScrollRestoration />
				<Scripts />
			</body>
		</html>
	);
}

export default function App() {
	return <Outlet />;
}
