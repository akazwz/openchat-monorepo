import { create } from "zustand";

import { type AppLocale, locales } from "./catalog";

// Which language the app speaks: the browser's (the default), or one chosen
// in settings, kept in this browser as the color mode is.
export type LanguagePreference = "system" | AppLocale;
const storageKey = "heveta-language";

// The first of the browser's languages the app speaks; English otherwise.
export function browserLocale(): AppLocale {
	for (const tag of globalThis.navigator?.languages ?? []) {
		const language = tag.toLowerCase().split("-")[0];
		if (language === "zh") return "zh-CN";
		if (language === "en") return "en";
	}
	return "en";
}

function readPreference(): LanguagePreference {
	try {
		const saved = localStorage.getItem(storageKey);
		if (saved === "system" || locales.includes(saved as AppLocale))
			return saved as LanguagePreference;
	} catch {}
	return "system";
}

interface LanguageState {
	preference: LanguagePreference;
	// What the app speaks now. The prebuilt shell is English, so the first
	// render is too; LanguageProvider applies the real one before paint.
	locale: AppLocale;
	load: () => void;
	choose: (preference: LanguagePreference) => void;
}

const resolve = (preference: LanguagePreference): AppLocale =>
	preference === "system" ? browserLocale() : preference;

export const useLanguage = create<LanguageState>()((set) => ({
	preference: "system",
	locale: "en",
	load: () => {
		const preference = readPreference();
		set({ preference, locale: resolve(preference) });
	},
	choose: (preference) => {
		try {
			localStorage.setItem(storageKey, preference);
		} catch {}
		set({ preference, locale: resolve(preference) });
	},
}));

// For requests: the server answers in it (a sign-in code's email, the
// models' descriptions).
export const currentLocale = () => useLanguage.getState().locale;
