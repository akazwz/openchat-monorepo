import type { MessagesByLocale } from "@astryxdesign/core/i18n";
import astryxZh from "@astryxdesign/core/locales/zh-CN.json";

import common from "~/components/messages";
import auth from "~/features/auth/messages";
import computer from "~/features/computer/messages";
import devices from "~/features/devices/messages";
import files from "~/features/files/messages";
import mail from "~/features/mail/messages";
import settings from "~/features/settings/messages";
import threads from "~/features/threads/messages";

import { type AppLocale, locales, toCatalog } from "./catalog";

// Every feature's messages (each feature's messages.ts).
const features = [
	devices,
	common,
	auth,
	threads,
	computer,
	files,
	mail,
	settings,
] as const;

type KeysOf<T> = T extends Record<"en", infer E> ? keyof E : never;
export type MessageKey = KeysOf<(typeof features)[number]>;

const english: Record<string, string> = Object.assign(
	{},
	...features.map((feature) => feature.en),
);

// Whether a string (one stored as data, e.g. a form field's error) is one of
// the app's message keys.
export function isMessageKey(value: string): value is MessageKey {
	return Object.hasOwn(english, value);
}

// A message a module produces for the interface to show (a failure's
// reason): its key, with the values it takes.
export type Message =
	| MessageKey
	| { key: MessageKey; values: Record<string, unknown> };

// Astryx ships its own components' English; its Chinese is a catalog of its
// own, and a few strings it does not have yet.
const astryx: Partial<MessagesByLocale> = { "zh-CN": astryxZh };
export const astryxOverrides = {
	"zh-CN": {
		"@astryx.chatToolCalls.status.pending": "等待调用",
		"@astryx.chatToolCalls.status.running": "调用中",
		"@astryx.chatToolCalls.status.complete": "调用完成",
		"@astryx.chatToolCalls.status.error": "调用失败",
		"@astryx.spinner.loading": "加载中",
	},
};

export const messages = Object.fromEntries(
	locales.map((locale: AppLocale) => [
		locale,
		{
			...astryx[locale],
			...toCatalog(
				Object.assign({}, ...features.map((feature) => feature[locale])),
			),
		},
	]),
) as MessagesByLocale;
