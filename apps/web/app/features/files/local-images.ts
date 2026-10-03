// Images this device just sent, by their file's ID: the local copy (an object
// URL of the chosen file) the transcript showed while the message was on its
// way. The server's copy of the message shows it too at first: an image whose
// address the page has loaded shows at once in a new element, while the
// server's address had never been loaded here, and the image went blank until
// it was. Each is kept only until the server's copy has loaded (MessageImage),
// or until the session ends (ThreadDrafts.clear).
const images = new Map<string, string>();

export function keepLocalImage(fileId: string, url: string) {
	images.set(fileId, url);
}
export const localImage = (fileId: string) => images.get(fileId);
export function releaseLocalImage(fileId: string) {
	const url = images.get(fileId);
	if (!url) return;
	URL.revokeObjectURL(url);
	images.delete(fileId);
}
export function releaseLocalImages() {
	for (const url of images.values()) URL.revokeObjectURL(url);
	images.clear();
}
