import { Theme, type ThemeMode } from "@astryxdesign/core/theme";
import { hevetaTheme } from "@heveta/brand/theme";
import { Monitor, Moon, Sun } from "lucide-react";
import {
	createContext,
	type ReactNode,
	useContext,
	useLayoutEffect,
	useState,
} from "react";

import type { MessageKey } from "~/i18n/messages";

const storageKey = "heveta-color-mode";

// Runs in the document head before the app loads, so a saved light or dark
// mode colors the page from the first paint; Theme syncs `data-theme` on
// <html> only once React has mounted.
export const colorModeScript = `try{var m=localStorage.getItem(${JSON.stringify(storageKey)});if(m==="light"||m==="dark")document.documentElement.dataset.theme=m}catch(e){}`;

function readMode(): ThemeMode {
	try {
		const saved = localStorage.getItem(storageKey);
		if (saved === "light" || saved === "dark" || saved === "system")
			return saved;
	} catch {}
	return "system";
}

const ColorModeContext = createContext<{
	mode: ThemeMode;
	setMode: (mode: ThemeMode) => void;
}>({ mode: "system", setMode: () => {} });

// The compiled brand theme (packages/brand/src/theme/heveta.ts); people choose
// only the color mode.
export function ColorModeProvider({ children }: { children: ReactNode }) {
	// The prebuilt HTML shell is rendered in "system" mode, and hydration does not
	// patch mismatched attributes, so the first render must match it. A layout
	// effect applies the saved mode in the same commit, before anything paints.
	const [mode, setMode] = useState<ThemeMode>("system");
	useLayoutEffect(() => setMode(readMode()), []);
	function updateMode(next: ThemeMode) {
		setMode(next);
		try {
			localStorage.setItem(storageKey, next);
		} catch {}
	}
	return (
		<ColorModeContext value={{ mode, setMode: updateMode }}>
			<Theme theme={hevetaTheme} mode={mode}>
				{children}
			</Theme>
		</ColorModeContext>
	);
}

export function useColorMode() {
	return useContext(ColorModeContext);
}

// Icons let people tell the three choices apart at a glance.
export const colorModeOptions: {
	value: ThemeMode;
	label: MessageKey;
	icon: typeof Monitor;
}[] = [
	{ value: "system", label: "common.colorModeSystem", icon: Monitor },
	{ value: "light", label: "common.colorModeLight", icon: Sun },
	{ value: "dark", label: "common.colorModeDark", icon: Moon },
];
