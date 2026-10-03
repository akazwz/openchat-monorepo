// The languages people read the app in; English is the default.
export type Locale = "en" | "zh-CN";

// Text written for people, in each language.
export type Localized = Record<Locale, string>;

// The language a request's page speaks (it says so in Accept-Language; a
// browser's own header does too): the first one the app speaks, else English.
export function requestLocale(headers: Headers): Locale {
	for (const range of (headers.get("accept-language") ?? "").split(",")) {
		const language = range.trim().split(";")[0].toLowerCase().split("-")[0];
		if (language === "zh") return "zh-CN";
		if (language === "en") return "en";
	}
	return "en";
}
