import type { ShellApi, ShellState } from "./shell-api";

declare global {
	interface Window {
		hevetaShell: ShellApi;
	}
}

// The window's own page: the band that carries the window buttons, and, while
// the web app is not on screen, a panel saying why.
const panel = document.querySelector("main")!;
const title = document.querySelector("h1")!;
const detail = document.querySelector("p")!;
const retry = document.querySelector("button")!;
let state: ShellState | undefined;

window.hevetaShell.onState((next) => {
	state = next;
	document.documentElement.lang = next.language;
	document.documentElement.style.setProperty(
		"--band-height",
		`${next.bandHeight}px`,
	);
	panel.hidden = next.status === "ready";
	panel.dataset.status = next.status;
	title.textContent = next.title ?? "";
	detail.textContent = next.detail ?? "";
	detail.hidden = !next.detail;
	retry.textContent = next.retry;
	retry.hidden = next.status !== "failed" && next.status !== "crashed";
});

retry.addEventListener("click", () => window.hevetaShell.retry());
// A load that failed offline is tried again when the network returns.
window.addEventListener("online", () => {
	if (state?.status === "failed") window.hevetaShell.retry();
});
