import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { type Binding, type Command, isRecord } from "../protocol";
import { temporaryPath } from "./files";

// The server's limit for a file (apps/server/src/modules/files).
const fileLimit = 100 * 1024 * 1024;

const imageTypes: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};
const otherTypes: Record<string, string> = {
	".pdf": "application/pdf",
	".txt": "text/plain",
	".json": "application/json",
	".csv": "text/csv",
};

// Files travel over HTTPS, not the device connection: each request names the
// command it belongs to, and the server checks that the command is this
// device's and still running.
function fileUrl(
	binding: Binding,
	command: Command,
	query: Record<string, string>,
) {
	const url = new URL("/device/file", binding.origin);
	url.search = new URLSearchParams({ job: command.id, ...query }).toString();
	return url;
}

const authorization = (binding: Binding) => ({
	authorization: `Bearer ${binding.credential}`,
});

async function upload(
	binding: Binding,
	command: Command,
	file: { name: string; type: string; size: number; body: BodyInit },
	signal: AbortSignal,
) {
	const response = await fetch(fileUrl(binding, command, { name: file.name }), {
		method: "POST",
		headers: {
			...authorization(binding),
			"content-type": file.type,
			"content-length": String(file.size),
		},
		body: file.body,
		// Node needs this to send a stream as a request body.
		duplex: "half",
		signal,
		redirect: "error",
	} as RequestInit);
	if (!response.ok)
		throw new Error(`The file could not be sent (${response.status})`);
	const stored: unknown = await response.json();
	if (!isRecord(stored) || typeof stored.id !== "string")
		throw new Error("The server's answer about the file was not understood");
	return { output: `Sent ${file.name}`, file: stored };
}

// A file on this Mac, to the conversation (send_file) or to the model alone
// (view_image).
export async function sendFile(
	binding: Binding,
	command: Command,
	path: string,
	signal: AbortSignal,
) {
	const info = await stat(path);
	if (!info.isFile()) throw new Error("The path is not a file");
	if (info.size > fileLimit) throw new Error("The file is larger than 100 MB");
	const extension = extname(path).toLowerCase();
	const imageType = imageTypes[extension];
	if (command.method === "view_image" && !imageType)
		throw new Error("The file is not a PNG, JPEG, WebP or GIF image");
	return upload(
		binding,
		command,
		{
			name: basename(path),
			type: imageType ?? otherTypes[extension] ?? "application/octet-stream",
			size: info.size,
			body: Readable.toWeb(createReadStream(path)) as ReadableStream,
		},
		signal,
	);
}

export function sendScreenshot(
	binding: Binding,
	command: Command,
	image: Uint8Array<ArrayBuffer>,
	signal: AbortSignal,
) {
	return upload(
		binding,
		command,
		{
			name: "screenshot.png",
			type: "image/png",
			size: image.byteLength,
			body: image,
		},
		signal,
	);
}

// A file from the conversation or the agent's mailbox, onto this Mac.
export async function receiveFile(
	binding: Binding,
	command: Command,
	fileId: string,
	path: string,
	signal: AbortSignal,
) {
	const response = await fetch(fileUrl(binding, command, { file: fileId }), {
		headers: authorization(binding),
		signal,
		redirect: "error",
	});
	if (!response.ok || !response.body)
		throw new Error(`The file could not be fetched (${response.status})`);
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = temporaryPath(path);
	let size = 0;
	try {
		await pipeline(
			Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
			new Transform({
				transform(chunk: Buffer, _encoding, callback) {
					size += chunk.length;
					callback(
						size > fileLimit
							? new Error("The file is larger than 100 MB")
							: null,
						chunk,
					);
				},
			}),
			createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
			{ signal },
		);
		signal.throwIfAborted();
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
	return { output: `Received ${path}` };
}
