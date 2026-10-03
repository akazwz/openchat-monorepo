import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
	document.addEventListener("visibilitychange", onChange);
	return () => document.removeEventListener("visibilitychange", onChange);
}

// Whether the page is on screen: false while its tab is in the background,
// its window is minimized, or a phone shows another app.
export function usePageVisible() {
	return useSyncExternalStore(
		subscribe,
		() => document.visibilityState === "visible",
		() => true,
	);
}
