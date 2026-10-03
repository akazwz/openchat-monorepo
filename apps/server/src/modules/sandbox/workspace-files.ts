import { posix } from "node:path/posix";

import { createDatabase } from "@/db/client";
import { errorDetails } from "@/lib/error-details";
import { AppError, ErrorCode } from "@/lib/errors";
import { errorResponse, failureResponse } from "@/lib/http-errors";
import { declaredBody } from "@/lib/request-body";
import { actingUserHeader, authenticate } from "@/modules/auth/session";
import { maxFileBytes } from "@/modules/files/types";
import { fileNameOnComputer } from "@/modules/files/workspace-paths";

import {
	type SandboxMachine,
	saveWorkspace,
	WorkspaceLostError,
	workspaceDir,
} from "./computer";
import { userComputer } from "./machine";

// The people's view of their computer's files (docs/sandbox.md): the
// workspace, which is what outlives a restart. The terminal reaches the rest.
export function workspacePath(requested: string) {
	const path = posix.resolve(workspaceDir, requested || ".");
	if (path !== workspaceDir && !path.startsWith(`${workspaceDir}/`))
		throw new AppError(
			`Only files in ${workspaceDir} can be opened here`,
			ErrorCode.InvalidArgument,
		);
	return path;
}

// A path that is gone (deleted in the terminal or by the agent, or with a
// restored or cleared workspace) is not found, which the page answers by
// going back to the workspace. The sandbox's own error loses its code on the
// way here, so the path is asked about first.
async function existing(machine: SandboxMachine, path: string) {
	if (!(await machine.exists(path)).exists)
		throw new AppError(`${path} does not exist`, ErrorCode.NotFound);
}

// One folder, folders first, then files, each by name. Hidden files are left
// out, as a file manager does.
export async function listWorkspaceFiles(userId: string, requested: string) {
	const path = workspacePath(requested);
	const { computer, machine } = userComputer(userId);
	await computer.ready();
	await existing(machine, path);
	const listed = await machine.listFiles(path);
	const files = listed.files
		.filter((file) => file.type === "file" || file.type === "directory")
		.map((file) => ({
			name: file.name,
			path: file.absolutePath,
			isDirectory: file.type === "directory",
			size: file.size,
			modifiedAt: file.modifiedAt,
		}))
		.sort(
			(left, right) =>
				Number(right.isDirectory) - Number(left.isDirectory) ||
				left.name.localeCompare(right.name),
		);
	return { path, files };
}

// GET /computer-file?path=…: a file of the user's workspace, streamed from
// the computer as a download. The page fetches it with its session, as an
// RPC, and hands the file to the browser.
export async function downloadComputerFile(request: Request) {
	const url = new URL(request.url);
	const database = createDatabase();
	try {
		const { userId } = await authenticate(
			database.db,
			request.headers,
			request.headers.get(actingUserHeader),
		);
		const path = workspacePath(url.searchParams.get("path") ?? "");
		const { computer, machine } = userComputer(userId);
		await computer.ready();
		await existing(machine, path);
		const file = await machine.readFile(path, { encoding: "none" });
		return new Response(file.content, {
			headers: {
				"Content-Type": file.mimeType || "application/octet-stream",
				"Content-Length": String(file.size),
				"Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(posix.basename(path))}`,
				"Cache-Control": "no-store",
				"X-Content-Type-Options": "nosniff",
			},
		});
	} catch (error) {
		return failureResponse(error, "ComputerFile");
	} finally {
		await database.close();
	}
}

// POST /computer-file?path=<folder>&name=…, with the session like an RPC:
// the body is a file, streamed into that folder of the user's workspace,
// which is then saved. A name already taken there is numbered
// ("report (2).pdf"), so nothing is overwritten. It is written under a
// hidden name first and takes its own once whole, so an upload cut off
// midway (the panel closed, the network gone) leaves nothing behind.
export async function uploadComputerFile(request: Request) {
	const database = createDatabase();
	try {
		const { userId } = await authenticate(
			database.db,
			request.headers,
			request.headers.get(actingUserHeader),
		);
		const url = new URL(request.url);
		const upload = declaredBody(request);
		if (!upload)
			return errorResponse("invalid_argument", "The file's length is required");
		if (upload.length > maxFileBytes)
			return errorResponse(
				"invalid_argument",
				`Files must be at most ${maxFileBytes / 1024 / 1024} MB`,
			);
		const folder = workspacePath(url.searchParams.get("path") ?? "");
		const name = url.searchParams.get("name") ?? "";
		const { computer, machine } = userComputer(userId);
		const generation = await computer.ready();
		await machine.mkdir(folder, { recursive: true });
		const partial = `${folder}/.${crypto.randomUUID()}.upload`;
		try {
			await machine.writeFile(
				partial,
				upload.body.pipeThrough(new FixedLengthStream(upload.length)),
			);
			let path = `${folder}/${fileNameOnComputer(name)}`;
			for (let number = 2; (await machine.exists(path)).exists; number++)
				path = `${folder}/${fileNameOnComputer(name, ` (${number})`)}`;
			const moved = await machine.exec('mv -n -- "$FROM" "$TO"', {
				env: { FROM: partial, TO: path },
			});
			if (!moved.success)
				throw new Error(moved.stderr || "Could not name the uploaded file");
			await saved(computer, generation);
			return Response.json({ path });
		} catch (error) {
			await machine
				.exec('rm -f -- "$FROM"', { env: { FROM: partial } })
				.catch(() => {});
			throw error;
		}
	} catch (error) {
		return failureResponse(error, "ComputerFile");
	} finally {
		await database.close();
	}
}

// The workspace saved with the file in it. A computer that restarted since
// the file was written lost it, which fails the upload; a save that failed
// otherwise leaves the file there, saved with the next save (settings show
// that changes wait), so the upload stands.
async function saved(
	computer: Parameters<typeof saveWorkspace>[0],
	generation: number,
) {
	try {
		await saveWorkspace(computer, generation);
	} catch (error) {
		if (error instanceof WorkspaceLostError) throw error;
		console.warn("[Sandbox] Workspace not saved after upload", {
			...errorDetails(error),
		});
	}
}
