import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { app, type Rectangle } from "electron";

import type { Language } from "./messages";

export type ThemeSource = "system" | "light" | "dark";

// What the client remembers between launches. The appearance and language are
// the web app's settings, kept here so the window opens in them before the
// page has loaded.
export interface Preferences {
	bounds?: Rectangle;
	maximized: boolean;
	zoomLevel: number;
	theme: ThemeSource;
	language?: Language;
}

export const zoomRange = { min: -2, max: 3 };

const file = () => join(app.getPath("userData"), "preferences.json");

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBounds(value: unknown): Rectangle | undefined {
	if (!isRecord(value)) return undefined;
	const { x, y, width, height } = value;
	if (
		![x, y, width, height].every(Number.isSafeInteger) ||
		(width as number) <= 0 ||
		(height as number) <= 0
	)
		return undefined;
	return value as unknown as Rectangle;
}

export function readPreferences(): Preferences {
	let saved: Record<string, unknown> = {};
	try {
		const value: unknown = JSON.parse(readFileSync(file(), "utf8"));
		if (isRecord(value)) saved = value;
	} catch {
		// A first launch, or a file something else damaged: the defaults.
	}
	const { zoomLevel, theme, language } = saved;
	return {
		bounds: readBounds(saved.bounds),
		maximized: saved.maximized === true,
		zoomLevel:
			typeof zoomLevel === "number" && Number.isFinite(zoomLevel)
				? Math.max(zoomRange.min, Math.min(zoomRange.max, zoomLevel))
				: 0,
		theme: theme === "light" || theme === "dark" ? theme : "system",
		language: language === "en" || language === "zh-CN" ? language : undefined,
	};
}

export function writePreferences(preferences: Preferences) {
	try {
		// Written whole and renamed into place, so a crash leaves the old file.
		writeFileSync(`${file()}.tmp`, JSON.stringify(preferences), {
			mode: 0o600,
		});
		renameSync(`${file()}.tmp`, file());
	} catch (error) {
		console.warn("[Heveta] Could not save preferences", error);
	}
}
