// The server's rules for what a message carries, so the composer can say so
// before sending or uploading instead of after; the server enforces them
// (apps/server/src/config.ts `limits`, modules/files/types.ts).
export const maxMessageChars = 12_000;
export const maxAttachments = 10;
export const maxFileBytes = 100 * 1024 * 1024;
export const modelFileBytes = 20 * 1024 * 1024;

// Images shown in place (and read by the model).
export const imageTypes = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
];
export const pdfType = "application/pdf";
export const isImage = (mimeType: string) => imageTypes.includes(mimeType);
// Files that can be sent to a model to read (a model that reads neither
// opens them on its computer, as it does any other file). They count
// against the model's file budget whichever model a message goes to.
export const isModelFileType = (mimeType: string) =>
	isImage(mimeType) || mimeType === pdfType;

// "1.2 MB"
export function fileSize(bytes: number | bigint) {
	const units = ["B", "KB", "MB", "GB"];
	let value = Number(bytes);
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${unit ? value.toFixed(value < 10 ? 1 : 0) : value} ${units[unit]}`;
}
