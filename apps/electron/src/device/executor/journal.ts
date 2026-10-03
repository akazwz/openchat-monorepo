import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import type { Result } from "../protocol";
import { writeAtomically } from "./files";

// A command's record: written before the command does anything, and again
// with its result. `hash` is of what the command was asked to do.
export interface JournalEntry {
	hash?: string;
	result?: Result;
	created: number;
}

// The server forgets a command's result after seven days (connection.ts);
// nothing asks about it after that.
const retention = 7 * 24 * 60 * 60 * 1000;

// What this Mac has been asked to do, on disk: the server may ask about a
// command again after a lost connection, a restart of the client, or its own,
// and must hear what happened rather than have the command run twice.
export class Journal {
	constructor(private readonly directory: string) {}

	async open() {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const expired = Date.now() - retention;
		for (const name of await readdir(this.directory)) {
			const path = join(this.directory, name);
			if ((await stat(path)).mtimeMs < expired) await rm(path, { force: true });
		}
	}

	async read(id: string): Promise<JournalEntry | undefined> {
		try {
			return JSON.parse(await readFile(this.path(id), "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}

	write(id: string, entry: JournalEntry) {
		return writeAtomically(this.path(id), JSON.stringify(entry));
	}

	// IDs hold characters a file name should not.
	private path(id: string) {
		return join(
			this.directory,
			`${createHash("sha256").update(id).digest("hex")}.json`,
		);
	}
}
