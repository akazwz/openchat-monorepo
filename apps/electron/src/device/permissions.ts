import { desktopCapturer, shell, systemPreferences } from "electron";

// The two macOS permissions desktop access needs: Screen Recording to see the
// screen, Accessibility to move the pointer and type. Commands and files need
// neither.
export interface Permissions {
	screen: boolean;
	input: boolean;
}

const settingsPane = (anchor: string) =>
	`x-apple.systempreferences:com.apple.preference.security?${anchor}`;

export function readPermissions(): Permissions {
	return {
		screen: systemPreferences.getMediaAccessStatus("screen") === "granted",
		input: systemPreferences.isTrustedAccessibilityClient(false),
	};
}

export async function requestScreenPermission() {
	if (readPermissions().screen) return;
	// macOS reports "denied" for the screen before it has ever asked, so the
	// status cannot tell whether to ask. Listing the screens is what makes it
	// ask, and what adds this app to the list in System Settings; no picture
	// of the screen is taken.
	await desktopCapturer
		.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } })
		.catch(() => {});
	if (!readPermissions().screen)
		await shell.openExternal(settingsPane("Privacy_ScreenCapture"));
}

export async function requestInputPermission() {
	// `true` has macOS show its own prompt, which leads to System Settings.
	if (!systemPreferences.isTrustedAccessibilityClient(true))
		await shell.openExternal(settingsPane("Privacy_Accessibility"));
}
