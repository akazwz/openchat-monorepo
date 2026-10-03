const productName = "Heveta Electron";
const productionUrl = "https://app.heveta.com";

// The web app this client hosts. Local development points it at Vite with
// HEVETA_APP_URL; anything but HTTPS or loopback HTTP is refused.
export function readAppUrl() {
	const url = new URL(process.env.HEVETA_APP_URL || productionUrl);
	const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (
		url.username ||
		url.password ||
		(url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
	)
		throw new Error("HEVETA_APP_URL must use HTTPS, or HTTP on localhost.");
	return url;
}

// The name the system knows this run by, which also names its profile and
// its Keychain item. A development build, and a run against another server,
// are each an app of their own: neither touches the installed client's
// sign-in or its device binding.
export function appNameFor(appUrl: URL, isPackaged: boolean) {
	const server =
		appUrl.origin === new URL(productionUrl).origin ? "" : ` (${appUrl.host})`;
	return `${productName}${server}${isPackaged ? "" : " Dev"}`;
}

function parse(value: string) {
	try {
		return new URL(value);
	} catch {
		return undefined;
	}
}

export function isAppUrl(value: string, appUrl: URL) {
	const url = parse(value);
	return Boolean(
		url && !url.username && !url.password && url.origin === appUrl.origin,
	);
}

// What may be handed to the system: web pages and mail links, nothing local.
export function isExternalUrl(value: string) {
	const url = parse(value);
	return Boolean(url && ["https:", "http:", "mailto:"].includes(url.protocol));
}

// A download the app started: from its origin, or a blob it made there.
export function isAppDownload(value: string, appUrl: URL) {
	return isAppUrl(
		value.startsWith("blob:") ? value.slice("blob:".length) : value,
		appUrl,
	);
}
