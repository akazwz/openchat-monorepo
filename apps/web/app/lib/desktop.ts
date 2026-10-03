import { useEffect } from "react";
import { useNavigate } from "react-router";

import { useColorMode } from "~/components/color-mode";
import { useLanguage } from "~/i18n/language";

interface DesktopBridge {
	version: number;
	onNavigate(callback: (path: "/" | "/settings") => void): () => void;
	setAppearance(
		theme: "system" | "light" | "dark",
		language: "en" | "zh-CN",
	): void;
	setPendingWork(source: "drafts" | "upload", pending: boolean): void;
}

declare global {
	interface Window {
		hevetaDesktop?: DesktopBridge;
	}
}

export function useDesktop() {
	const navigate = useNavigate();
	const { mode } = useColorMode();
	const language = useLanguage((state) => state.locale);
	useEffect(
		() =>
			window.hevetaDesktop?.onNavigate((path) => {
				void navigate(path);
			}),
		[navigate],
	);
	useEffect(() => {
		window.hevetaDesktop?.setAppearance(mode, language);
	}, [mode, language]);
}

// Send only the presence of work, never its text or files. Each owner clears
// its flag on sign-out/unmount; neither source can clear the other's flag.
export function useDesktopPendingWork(
	source: "drafts" | "upload",
	pending: boolean,
) {
	useEffect(() => {
		window.hevetaDesktop?.setPendingWork(source, pending);
		return () => window.hevetaDesktop?.setPendingWork(source, false);
	}, [source, pending]);
}
