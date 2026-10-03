import { actingHeaders } from "~/features/auth/interceptor";
import { confirmSession } from "~/features/auth/session";

// How long the downloaded file's address outlives the click that saves it:
// the browser reads it after the click returns, and Safari (iOS above all)
// fails a download whose address is already revoked.
const savedAddressMs = 60_000;

// Downloads a file into the page and saves it from there. Navigating to it
// would replace the app with the server's error page when the file is gone
// or the download fails, and drop unsent drafts with it.
export async function saveFile(url: string, fileName: string) {
	const response = await fetch(url, { headers: actingHeaders() });
	if (response.status === 401) void confirmSession();
	if (!response.ok) throw new Error(`Download failed: ${response.status}`);
	const saved = URL.createObjectURL(await response.blob());
	const link = document.createElement("a");
	link.href = saved;
	link.download = fileName;
	link.click();
	setTimeout(() => URL.revokeObjectURL(saved), savedAddressMs);
}
