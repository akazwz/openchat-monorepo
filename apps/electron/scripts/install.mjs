import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { verifyApplication } from "./signing.mjs";

const run = promisify(execFile);
const root = join(import.meta.dirname, "..");
const name = "Heveta Electron.app";
const source = join(
	root,
	".build/packages",
	`Heveta Electron-darwin-${process.arch}`,
	name,
);
const destination = join(homedir(), "Applications", name);
await access(source);
await mkdir(join(homedir(), "Applications"), { recursive: true });
// Copy completely before moving the installed app. The final replacement is
// a same-volume rename, so an interrupted copy leaves the previous app usable.
const staging = await mkdtemp(
	join(homedir(), "Applications", ".heveta-install-"),
);
const stagedApp = join(staging, name);
let previous;
try {
	await run("ditto", [source, stagedApp]);
	await verifyApplication(stagedApp);
	const { stdout: sourceId } = await run("plutil", [
		"-extract",
		"CFBundleIdentifier",
		"raw",
		"-o",
		"-",
		join(stagedApp, "Contents/Info.plist"),
	]);
	if (sourceId.trim() !== "com.heveta.electron")
		throw new Error("Unexpected application bundle.");
	let installed = false;
	try {
		await access(destination);
		installed = true;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	if (installed) {
		await access(destination);
		const { stdout: id } = await run("plutil", [
			"-extract",
			"CFBundleIdentifier",
			"raw",
			"-o",
			"-",
			join(destination, "Contents/Info.plist"),
		]);
		if (id.trim() !== "com.heveta.electron") {
			throw new Error(`Another application already exists at ${destination}.`);
		}
		const { stdout: processes } = await run("ps", ["-axo", "command="]);
		const executable = join(destination, "Contents/MacOS/Heveta Electron");
		if (
			processes
				.split("\n")
				.some(
					(command) =>
						command === executable || command.startsWith(`${executable} `),
				)
		) {
			throw new Error("Quit Heveta Electron before installing a new build.");
		}
		const backups = join(root, ".build/install");
		await mkdir(backups, { recursive: true });
		previous = join(
			backups,
			`Previous-${new Date().toISOString().replaceAll(":", "-")}.app`,
		);
		await rename(destination, previous);
	}
	try {
		await rename(stagedApp, destination);
	} catch (error) {
		if (previous) await rename(previous, destination);
		throw error;
	}
} finally {
	await rm(staging, { recursive: true, force: true });
}
console.log(`Installed: ${destination}`);
if (previous) console.log(`Previous build: ${previous}`);
