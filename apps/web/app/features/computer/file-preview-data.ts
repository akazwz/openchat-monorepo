import { actingHeaders } from "~/features/auth/interceptor";
import { confirmSession } from "~/features/auth/session";
import { currentSession, isCurrentSession } from "~/features/auth/store";

const textLimit = 1024 * 1024;
const imageLimit = 20 * 1024 * 1024;
const images: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	bmp: "image/bmp",
};
const textExtensions = new Set([
	"txt",
	"md",
	"markdown",
	"log",
	"csv",
	"tsv",
	"json",
	"jsonl",
	"yaml",
	"yml",
	"toml",
	"ini",
	"conf",
	"xml",
	"html",
	"htm",
	"svg",
	"css",
	"scss",
	"js",
	"jsx",
	"mjs",
	"cjs",
	"ts",
	"tsx",
	"py",
	"sh",
	"bash",
	"zsh",
	"sql",
	"go",
	"rs",
	"java",
	"c",
	"h",
	"cpp",
	"hpp",
	"rb",
	"php",
	"vue",
	"svelte",
	"r",
	"ipynb",
]);
const textNames = new Set(["readme", "license", "makefile", "dockerfile"]);

export type PreviewFile = {
	name: string;
	path: string;
	size: bigint | number;
	isDirectory: boolean;
};

// Unsupported formats and oversized files keep their download action only.
export function previewKind(file: PreviewFile) {
	if (file.isDirectory) return undefined;
	const name = file.name.toLowerCase();
	const extension = name.includes(".")
		? name.slice(name.lastIndexOf(".") + 1)
		: "";
	if (images[extension] && Number(file.size) <= imageLimit) return "image";
	if (
		(textExtensions.has(extension) || textNames.has(name)) &&
		Number(file.size) <= textLimit
	)
		return "text";
	return undefined;
}

// The download endpoint streams original bytes. Do not trust its guessed MIME
// type for text (.ts is sometimes guessed as video), or buffer unbounded files.
export async function readFilePreview(file: PreviewFile, signal: AbortSignal) {
	const kind = previewKind(file);
	if (!kind) throw new Error("Unsupported preview");
	const owner = currentSession();
	const response = await fetch(
		`/computer-file?${new URLSearchParams({ path: file.path })}`,
		{ headers: actingHeaders(), signal },
	);
	if (!isCurrentSession(owner)) {
		await response.body?.cancel();
		throw new Error("Session changed");
	}
	if (response.status === 401) void confirmSession();
	if (!response.ok || !response.body) {
		await response.body?.cancel();
		throw new Error("Preview failed");
	}
	const limit = kind === "image" ? imageLimit : textLimit;
	if (Number(response.headers.get("Content-Length")) > limit) {
		await response.body.cancel();
		throw new Error("Preview too large");
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.length;
			if (length > limit) {
				await reader.cancel();
				throw new Error("Preview too large");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	signal.throwIfAborted();
	if (!isCurrentSession(owner)) throw new Error("Session changed");
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	if (kind === "text") {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (text.includes("\0")) throw new Error("Binary file");
		return { kind, text } as const;
	}
	const extension = file.name
		.slice(file.name.lastIndexOf(".") + 1)
		.toLowerCase();
	return {
		kind,
		blob: new Blob([bytes], { type: images[extension] }),
	} as const;
}
