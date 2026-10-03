import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import { type ReactNode, useEffect, useLayoutEffect } from "react";

import { useLanguage } from "./language";
import { astryxOverrides, messages } from "./messages";

// The app's language (language.ts): Astryx's components and the app's own
// messages both follow it, and so does <html lang>. The prebuilt shell is
// English and hydration does not patch it, so the first render is English
// too; a layout effect applies the real language before anything paints.
export function LanguageProvider({ children }: { children: ReactNode }) {
	const locale = useLanguage((state) => state.locale);
	const load = useLanguage((state) => state.load);
	useLayoutEffect(load, [load]);
	useEffect(() => {
		document.documentElement.lang = locale;
	}, [locale]);
	// The browser's own language may change while the page is open.
	useEffect(() => {
		const follow = () => {
			if (useLanguage.getState().preference === "system") load();
		};
		globalThis.addEventListener("languagechange", follow);
		return () => globalThis.removeEventListener("languagechange", follow);
	}, [load]);
	return (
		<InternationalizationProvider
			locale={locale}
			messages={messages}
			overrides={astryxOverrides}
		>
			{children}
		</InternationalizationProvider>
	);
}
