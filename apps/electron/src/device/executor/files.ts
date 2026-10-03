import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const readLimit = 48_000;
const editLimit = 16 * 1024 * 1024;

type Arguments = Record<string, unknown>;

export function stringArgument(args: Arguments, name: string) {
	const value = args[name];
	if (typeof value !== "string") throw new Error(`${name} must be a string`);
	return value;
}

// A path as the agent gives it: absolute, under the home folder ("~"), or
// relative to the workspace.
export function resolvePath(workspace: string, path: string) {
	if (path.includes("\0")) throw new Error("Invalid path");
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return isAbsolute(path) ? resolve(path) : resolve(workspace, path);
}

// Replaces a file in one step: readers see the old content or the new, never
// part of either. A new file is private to the user; an existing one keeps
// its permissions.
export async function writeAtomically(
	path: string,
	content: string | Uint8Array,
	signal?: AbortSignal,
) {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	let mode = 0o600;
	try {
		mode = (await stat(path)).mode & 0o777;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	const temporary = temporaryPath(path);
	try {
		const file = await open(temporary, "wx", mode);
		try {
			await file.writeFile(content);
			await file.sync();
		} finally {
			await file.close();
		}
		signal?.throwIfAborted();
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

export const temporaryPath = (path: string) => `${path}.heveta-${randomUUID()}`;

// `bytes` without a UTF-8 sequence cut off at its end, if there is one: a
// window that ends inside a character leaves that character for later.
export function wholeCharacters(bytes: Buffer) {
	for (let back = 1; back <= Math.min(3, bytes.length); back++) {
		const byte = bytes[bytes.length - back];
		if ((byte & 0xc0) === 0x80) continue;
		const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
		return length > back ? bytes.subarray(0, bytes.length - back) : bytes;
	}
	return bytes;
}

export async function readText(path: string, args: Arguments) {
	const { offset, limit } = args;
	if (
		!Number.isSafeInteger(offset) ||
		(offset as number) < 0 ||
		!Number.isSafeInteger(limit) ||
		(limit as number) < 1 ||
		(limit as number) > readLimit
	)
		throw new Error(`offset must be 0 or more and limit 1–${readLimit}`);
	const file = await open(path, "r");
	try {
		const info = await file.stat();
		if (!info.isFile()) throw new Error("The path is not a file");
		const buffer = Buffer.alloc(limit as number);
		const { bytesRead } = await file.read(
			buffer,
			0,
			buffer.length,
			offset as number,
		);
		let bytes: Buffer = buffer.subarray(0, bytesRead);
		if ((offset as number) + bytesRead < info.size)
			bytes = wholeCharacters(bytes);
		return {
			output: bytes.toString("utf8"),
			size: info.size,
			offset,
			bytesRead: bytes.length,
		};
	} finally {
		await file.close();
	}
}

export async function writeText(
	path: string,
	args: Arguments,
	signal: AbortSignal,
) {
	await writeAtomically(path, stringArgument(args, "content"), signal);
	return { output: `Wrote ${path}` };
}

export async function editText(
	path: string,
	args: Arguments,
	signal: AbortSignal,
) {
	const oldText = stringArgument(args, "old_text");
	const newText = stringArgument(args, "new_text");
	if (!oldText) throw new Error("old_text cannot be empty");
	const info = await stat(path);
	if (!info.isFile()) throw new Error("The path is not a file");
	if (info.size > editLimit) throw new Error("The file is too large to edit");
	const content = await readFile(path, "utf8");
	const at = content.indexOf(oldText);
	if (at < 0 || content.includes(oldText, at + 1))
		throw new Error("old_text must match exactly once");
	await writeAtomically(
		path,
		content.slice(0, at) + newText + content.slice(at + oldText.length),
		signal,
	);
	return { output: `Updated ${path}` };
}
