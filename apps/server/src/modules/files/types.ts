import { imageSize } from "image-size";

import type { File } from "@/db/schema/files";

export interface FileReference {
	id: string;
	mimeType: string;
	fileName: string;
	size: bigint;
	// An image's size as shown, when known.
	width?: number;
	height?: number;
	// Where an attachment was put on the user's computer (docs/sandbox.md).
	workspacePath?: string;
}
// A file as a message carries it. Browsers fetch it at its address
// (fileResource), models read it through the binding.
export function fileReference(file: File): FileReference {
	const { id, mimeType, fileName, size } = file;
	return {
		id,
		mimeType,
		fileName,
		size,
		...(file.width && file.height
			? { width: file.width, height: file.height }
			: {}),
		...(file.workspacePath ? { workspacePath: file.workspacePath } : {}),
	};
}

// The largest file stored: an upload, or a file the agent sends. A Worker
// accepts request bodies up to 100 MB.
export const maxFileBytes = 100 * 1024 * 1024;

const imageMimeTypes = [
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/gif",
] as const;
const pdfMimeType = "application/pdf";
export function isImageMimeType(value: string) {
	return (imageMimeTypes as readonly string[]).includes(value);
}
// The kinds of files a model can read itself (ModelOption.reads): images,
// and PDFs (their text and pages).
export type FileKind = "image" | "pdf";
export const fileKinds: readonly FileKind[] = ["image", "pdf"];
export const fileKindOf = (mimeType: string): FileKind | undefined =>
	isImageMimeType(mimeType)
		? "image"
		: mimeType === pdfMimeType
			? "pdf"
			: undefined;
// Files that can be sent to a model to read.
export const isModelFileType = (mimeType: string) =>
	fileKindOf(mimeType) !== undefined;
// Files a model that reads these kinds reads itself. Everything else it
// reaches on its computer, a PDF it cannot read among them.
export function modelReadsFile(mimeType: string, reads: readonly FileKind[]) {
	const kind = fileKindOf(mimeType);
	return kind !== undefined && reads.includes(kind);
}

// How files of these types start. Images render in place and the model reads
// images and PDFs, so a file declared as one must really be one: a renamed
// document is never stored, served, or sent to the model under their type.
const signatures: Record<string, [bytes: number[], offset: number][]> = {
	"image/jpeg": [[[0xff, 0xd8, 0xff], 0]],
	"image/png": [[[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0]],
	"image/gif": [[[0x47, 0x49, 0x46, 0x38], 0]],
	"image/webp": [
		[[0x52, 0x49, 0x46, 0x46], 0],
		[[0x57, 0x45, 0x42, 0x50], 8],
	],
	// "%PDF-"
	[pdfMimeType]: [[[0x25, 0x50, 0x44, 0x46, 0x2d], 0]],
};
// Enough of a file's start to check every signature.
export const signatureBytes = 12;

export const hasVerifiedType = (mimeType: string) => mimeType in signatures;
// A type declared by someone else (an email's sender, a file's name), taken
// only for types the content is not checked against: an image or a PDF is
// one only when its start says so, and a file that only claims to be one is
// stored as a plain file instead of being refused.
export const declaredType = (mimeType: string) =>
	hasVerifiedType(mimeType) ? "application/octet-stream" : mimeType;

// Enough of an image's start to hold its size: a JPEG's comes after its
// metadata (EXIF, colour profile), which is rarely this long.
export const dimensionBytes = 512 * 1024;
// An image's size as it is shown. Browsers apply a JPEG's EXIF orientation,
// and orientations 5–8 turn it a quarter, swapping its sides. Undefined when
// the start does not hold it.
export function imageDimensions(head: Uint8Array) {
	try {
		const { width, height, orientation } = imageSize(head);
		if (!width || !height) return undefined;
		return orientation && orientation >= 5
			? { width: height, height: width }
			: { width, height };
	} catch {
		return undefined;
	}
}
// A file's type when its start says so.
export const sniffMimeType = (head: Uint8Array) =>
	Object.keys(signatures).find((type) => hasSignature(type, head));
function hasSignature(mimeType: string, head: Uint8Array) {
	const expected = signatures[mimeType];
	return Boolean(
		expected?.every(([bytes, offset]) =>
			bytes.every((byte, index) => head[offset + index] === byte),
		),
	);
}
