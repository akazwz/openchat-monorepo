import { LayerProvider } from "@astryxdesign/core/Layer";
import { LinkProvider } from "@astryxdesign/core/Link";
import { type ComponentPropsWithRef, type ReactNode, use } from "react";
import { Link, matchRoutes, UNSAFE_DataRouterContext } from "react-router";

import { ColorModeProvider } from "~/components/color-mode";
import { LanguageProvider } from "~/i18n/language-provider";

// Astryx's links. Only a path the app routes navigates within the page; any
// other path on this origin is the server's (a file at /files/…), so it is a
// document request, as are other origins. React Router has no public way to
// read the routes; its own PrefetchPageLinks reads them from this context.
function RouterLink({ href = "", ...props }: ComponentPropsWithRef<"a">) {
	const router = use(UNSAFE_DataRouterContext)?.router;
	if (
		!href.startsWith("/") ||
		href.startsWith("//") ||
		!router ||
		!matchRoutes(router.routes, href, router.basename)
	) {
		// Its content is the link's children, among the props.
		// oxlint-disable-next-line jsx-a11y/anchor-has-content
		return <a href={href} {...props} />;
	}
	return <Link to={href} {...props} />;
}

export function AppProvider({ children }: { children: ReactNode }) {
	return (
		<LanguageProvider>
			<ColorModeProvider>
				<LinkProvider component={RouterLink}>
					<LayerProvider toast={{ position: "bottomEnd", maxVisible: 3 }}>
						{children}
					</LayerProvider>
				</LinkProvider>
			</ColorModeProvider>
		</LanguageProvider>
	);
}
