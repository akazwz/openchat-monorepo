import type { Catalog } from "@astryxdesign/core/i18n";

// The languages the app speaks. English is the default and the fallback.
export const locales = ["en", "zh-CN"] as const;
export type AppLocale = (typeof locales)[number];

type Prefixed<P extends string, T> = {
	[K in keyof T & string as `${P}.${K}`]: string;
};

// A feature's messages, in every language: English first, and each other
// language with exactly its keys (a missing or extra one fails to compile).
// Keys are given without the feature's prefix and returned with it, so two
// features can never define the same key. Messages are ICU MessageFormat
// ("{count, plural, one {# file} other {# files}}"), as Astryx's own are.
export function defineMessages<
	const P extends string,
	const T extends Record<string, string>,
>(
	prefix: P,
	messages: { en: T } & Record<
		Exclude<AppLocale, "en">,
		Record<keyof T, string>
	>,
) {
	const prefixed = {} as Record<AppLocale, Prefixed<P, T>>;
	for (const locale of locales) {
		const entries = Object.entries(messages[locale]).map(([key, value]) => [
			`${prefix}.${key}`,
			value,
		]);
		prefixed[locale] = Object.fromEntries(entries) as Prefixed<P, T>;
	}
	return prefixed;
}

// Messages as Astryx's provider takes them.
export function toCatalog(messages: Record<string, string>): Catalog {
	return Object.fromEntries(
		Object.entries(messages).map(([key, defaultMessage]) => [
			key,
			{ defaultMessage },
		]),
	);
}
