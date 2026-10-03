import { posix } from "node:path/posix";

import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { type File, files } from "@/db/schema/files";

// Linux file names are at most 255 bytes.
const maxNameBytes = 255;
const encoder = new TextEncoder();

// A name the user gave, as a single file name on the computer: no directory
// separators or control characters, and short enough in bytes.
export function fileNameOnComputer(name: string, suffix = "") {
	const base = [...name]
		.map((char) =>
			char < " " || char === "\x7f" || char === "/" || char === "\\"
				? "_"
				: char,
		)
		.join("")
		.trim();
	const safe = base === "" || base === "." || base === ".." ? "file" : base;
	const extension = posix.extname(safe);
	let stem = safe.slice(0, safe.length - extension.length);
	const tail = `${suffix}${extension}`;
	while (stem && encoder.encode(stem + tail).length > maxNameBytes)
		stem = [...stem].slice(0, -1).join("");
	return stem + tail;
}

// Chooses where each attachment goes on the user's computer: its own name in
// `dir`, a folder of its own message's (sandbox/uploads.ts), numbered when
// another file of the message has that name ("report (2).xlsx"). No other
// message's file is ever in that folder, so the path is free by
// construction. Call in the transaction that claims them. Paths are recorded
// on the files, so every later request tells the model the same path; a file
// sent again keeps the one it has.
export async function assignWorkspacePaths(
	db: Database,
	claimed: File[],
	dir: string,
): Promise<File[]> {
	const taken = new Set<string>();
	const placed: File[] = [];
	for (const file of claimed) {
		if (file.workspacePath) {
			placed.push(file);
			continue;
		}
		let path = "";
		for (let number = 1; !path || taken.has(path); number++)
			path = `${dir}/${fileNameOnComputer(file.fileName, number === 1 ? "" : ` (${number})`)}`;
		taken.add(path);
		const [updated] = await db
			.update(files)
			.set({ workspacePath: path })
			.where(eq(files.id, file.id))
			.returning();
		placed.push(updated);
	}
	return placed;
}
