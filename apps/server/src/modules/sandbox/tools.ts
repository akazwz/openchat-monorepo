import { posix } from "node:path/posix";

import type { Database } from "@/db/client";
import { errorDetails } from "@/lib/error-details";
import { AppError, ErrorCode } from "@/lib/errors";
import { peek } from "@/lib/streams";
import { storeFile } from "@/modules/files/service";
import {
	type FileReference,
	fileReference,
	isImageMimeType,
	maxFileBytes,
	signatureBytes,
	sniffMimeType,
} from "@/modules/files/types";
import type { ToolCall, ToolOutcome, ToolSet, ToolSpec } from "@/runtime/tools";

import {
	browserExecutor,
	browserSpecs,
	connectBrowser,
	isBrowserTool,
} from "./browser";
import {
	type ComputerHandle,
	type SandboxMachine,
	savedOutcome,
	saveWorkspace,
	idleTimeoutMs,
	traced,
	tracedMachine,
	workspaceDir,
} from "./computer";
import { userComputer } from "./machine";
import { clip, outputChars } from "./output";
import { placeUploads } from "./uploads";

const maxTimeoutSeconds = 30 * 60;

const workspaceNote = `The complete computer filesystem is saved after every change and restored after a restart, including files, installed system packages and browser data. Computer data expires after 30 days without use; send important results with send_file to keep them in the conversation. Running processes end when the computer stops after ${idleTimeoutMs / 60_000} idle minutes. Work in ${workspaceDir}: "pip install" and "npm install -g" go to ${workspaceDir}/.local, and a Python venv can live there. Other conversations of this user share the same computer.`;

const imageFormats = "PNG, JPEG, WebP, or GIF";
const maxFileMegabytes = maxFileBytes / 1024 / 1024;

const specs: ToolSpec[] = [
	{
		name: "shell",
		description: `Run a shell command (bash) on your own Linux computer, which has Python, Node.js, git, and common tools, and can reach the internet. It has a screen the user can watch, with one browser on it that stays open between your commands, keeping its tabs, pages, and logins; the user sees it and may use it too. Work in web pages with the browser tools. For scripted work over many pages, drive that same browser from Playwright in Node.js (installed; Python's is not): run "heveta-browser" (it starts the browser if it is not running), then in a script const { chromium } = require("playwright-core"); const browser = await chromium.connectOverCDP("http://127.0.0.1:9222"), working in browser.contexts()[0] and its open page or a new tab of it. Never launch another browser or close this one; end your script with browser.close(), which for a browser connected this way only disconnects from it. ${workspaceNote} Its output and its error output are each cut in the middle past ${outputChars / 2} bytes; write large output to a file and read it with read_file.`,
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "The command to run." },
				workdir: {
					type: "string",
					description: `Directory to run in; ${workspaceDir} unless the task needs another.`,
				},
				timeout_seconds: {
					type: "integer",
					description: `How long it may run before it is stopped, up to ${maxTimeoutSeconds}; 120 fits most commands.`,
				},
			},
			required: ["command", "workdir", "timeout_seconds"],
			additionalProperties: false,
		},
		readOnly: false,
		concurrent: false,
		surface: "computer",
	},
	{
		name: "read_file",
		description: `Read a text file on your computer. Relative paths are under ${workspaceDir}. Long files come in windows of ${outputChars} characters from the given line; the result says where to continue.`,
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "The file's path." },
				start_line: {
					type: "integer",
					description: "Line to start from; 1 for the beginning.",
				},
			},
			required: ["path", "start_line"],
			additionalProperties: false,
		},
		readOnly: true,
		concurrent: true,
		surface: "computer",
	},
	{
		name: "write_file",
		description: `Create or overwrite a text file on your computer, creating its directories. Relative paths are under ${workspaceDir}. ${workspaceNote}`,
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "The file's path." },
				content: { type: "string", description: "The whole new content." },
			},
			required: ["path", "content"],
			additionalProperties: false,
		},
		readOnly: false,
		concurrent: false,
		surface: "computer",
	},
	{
		name: "edit_file",
		description: `Change one place in a text file on your computer: old_text, which must appear exactly once, becomes new_text. Relative paths are under ${workspaceDir}.`,
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "The file's path." },
				old_text: {
					type: "string",
					description: "The exact text to replace, unique in the file.",
				},
				new_text: { type: "string", description: "The replacement." },
			},
			required: ["path", "old_text", "new_text"],
			additionalProperties: false,
		},
		readOnly: false,
		concurrent: false,
		surface: "computer",
	},
	{
		name: "send_file",
		description: `Send a file from your computer to the user: it appears in your reply where you call this, as the image itself or as a file they can download, and stays there even if the file later changes. Use it for whatever you made or found for them: screenshots, charts, documents, spreadsheets, archives. You see an image you send as this call's result: check that it shows what you meant before you describe it. Up to ${maxFileMegabytes} MB. The file shows in your reply by itself: don't also link to it or write its path. The user cannot open paths or links on your computer (such as sandbox: links), so never write one for them.`,
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: `The file's path; relative paths are under ${workspaceDir}.`,
				},
			},
			required: ["path"],
			additionalProperties: false,
		},
		readOnly: true,
		concurrent: true,
		surface: "delivery",
	},
	{
		name: "view_image",
		description: `Look at an image on your computer that the user does not need to see, such as a screenshot taken along the way. You get the image as this call's result. ${imageFormats}, up to ${maxFileMegabytes} MB; convert other formats first. This does not show it to the user; use send_file for that (you see the images you send, too).`,
		parameters: {
			type: "object",
			properties: {
				path: {
					type: "string",
					description: `The image's path; relative paths are under ${workspaceDir}.`,
				},
			},
			required: ["path"],
			additionalProperties: false,
		},
		readOnly: true,
		concurrent: true,
		surface: "computer",
	},
];

// Stores a copy of a file from the computer in the app's file storage.
export type StoreFile = (file: {
	content: ReadableStream<Uint8Array>;
	size: number;
	fileName: string;
	mimeType: string;
}) => Promise<FileReference>;

const resolvePath = (path: string) => posix.resolve(workspaceDir, path);

// A command runs as a process of the computer, under `timeout` (which ends
// it with its children at its time limit), writing its output, its exit code,
// and when it started and ended to files named after the call. So a command
// outlives an execution of its run that is interrupted (its actor restarted):
// the next finds it by the call and collects it; a stop kills it. The files
// live in /tmp, which a restart of the computer clears along with the
// process. Each of the command's output and errors is cut there to half of
// `outputChars` bytes, keeping its start and end as clip() does: a command can
// print far more than the Worker could hold, and together they fit the result
// without cutting it again (which could cut away the note of what was left
// out).
const callsDir = "/tmp/heveta-calls";
const shellProcess = `mkdir -p "$CALL_DIR" && date +%s >"$CALL_DIR/start"
timeout --kill-after=10s "$CALL_TIMEOUT" bash -c "$CALL_COMMAND" >"$CALL_DIR/out" 2>"$CALL_DIR/err" </dev/null &
echo $! >"$CALL_DIR/pid"
wait $!
code=$?
date +%s >"$CALL_DIR/end"
half=$((CALL_STREAM_BYTES / 2))
for file in "$CALL_DIR/out" "$CALL_DIR/err"; do
  size=$(stat -c %s "$file")
  if [ "$size" -gt "$CALL_STREAM_BYTES" ]; then
    { head -c "$half" "$file"; printf '\\n… %s bytes omitted …\\n' $((size - 2 * half)); tail -c "$half" "$file"; } >"$file.cut" && mv "$file.cut" "$file"
  fi
done
echo $code >"$CALL_DIR/exit.next" && mv "$CALL_DIR/exit.next" "$CALL_DIR/exit"`;
// `timeout` exits with 124 when it ended the command, 137 when that took a
// KILL.
const timedOutCodes = new Set([124, 137]);

const shellCall = (call: ToolCall) => {
	const name = call.callId.replace(/[^\w-]/g, "_");
	return {
		id: `shell-${name}`,
		dir: `${callsDir}/${name}`,
		seconds: Math.min(
			Math.max(Number(call.arguments.timeout_seconds) || 0, 1),
			maxTimeoutSeconds,
		),
	};
};

// How a wait for a command ended: it ended ("done"), the run was stopped, or
// whether it still runs cannot be told ("unknown": its process is gone
// without an exit code, or cannot be asked about).
type Waited = "done" | "stopped" | "unknown";

// The stream that reports a command's end can break while the command runs
// on; it is subscribed to again for as long as the command runs, this long
// after each break, so a stream that keeps breaking does not spin.
const resubscribeDelayMs = 1000;

async function runShell(
	machine: SandboxMachine,
	call: ToolCall,
	signal: AbortSignal,
): Promise<ToolOutcome | undefined> {
	const shell = shellCall(call);
	let process: { waitForExit(): Promise<unknown> };
	try {
		process = await machine.startProcess(shellProcess, {
			processId: shell.id,
			cwd: resolvePath(String(call.arguments.workdir || workspaceDir)),
			// The command reaches the shell as a variable, never as command text.
			env: {
				CALL_DIR: shell.dir,
				CALL_TIMEOUT: `${shell.seconds}s`,
				CALL_STREAM_BYTES: String(outputChars / 2),
				CALL_COMMAND: String(call.arguments.command),
			},
		});
	} catch (error) {
		// The computer may have started it before its answer was lost: then it
		// is found like a command an interrupted execution started.
		if (signal.aborted) throw error;
		const started = await resumeShell(machine, call, signal);
		if (started) return started;
		throw error;
	}
	return awaitShell(machine, shell, process, signal);
}

const shellEnded = async (
	machine: SandboxMachine,
	shell: ReturnType<typeof shellCall>,
) => (await machine.exists(`${shell.dir}/exit`)).exists;

const shellRunning = (process: { status: string } | null) =>
	process?.status === "running" || process?.status === "starting";

// A command an interrupted execution started: collected if it has ended,
// waited for if it still runs; undefined when neither (the computer
// restarted).
async function resumeShell(
	machine: SandboxMachine,
	call: ToolCall,
	signal: AbortSignal,
): Promise<ToolOutcome | undefined> {
	const shell = shellCall(call);
	if (await shellEnded(machine, shell)) return collectShell(machine, shell);
	const process = await machine.getProcess(shell.id);
	if (process && shellRunning(process))
		return awaitShell(machine, shell, process, signal);
	return (await shellEnded(machine, shell))
		? collectShell(machine, shell)
		: undefined;
}

// Waits for `until` or a stop, whichever is first.
async function waitFor(
	until: Promise<unknown>,
	signal: AbortSignal,
): Promise<"done" | "stopped"> {
	let onAbort: (() => void) | undefined;
	return Promise.race([
		until.then(() => "done" as const),
		new Promise<"stopped">((resolve) => {
			onAbort = () => resolve("stopped");
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}),
	]).finally(() => {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	});
}

// After the stream reporting a command's end broke: whether it ended, or the
// process to wait on again.
async function shellState(
	machine: SandboxMachine,
	shell: ReturnType<typeof shellCall>,
): Promise<"done" | "unknown" | { waitForExit(): Promise<unknown> }> {
	try {
		if (await shellEnded(machine, shell)) return "done";
		const process = await machine.getProcess(shell.id);
		if (process && shellRunning(process)) return process;
		return (await shellEnded(machine, shell)) ? "done" : "unknown";
	} catch (error) {
		console.warn("[Sandbox] Command not found", errorDetails(error));
		return "unknown";
	}
}

// Undefined when the command's outcome cannot be had: it is reported as
// unknown, never as failed, since it may have run (or still run) to its end.
async function awaitShell(
	machine: SandboxMachine,
	shell: ReturnType<typeof shellCall>,
	process: { waitForExit(): Promise<unknown> },
	signal: AbortSignal,
): Promise<ToolOutcome | undefined> {
	let waited: Waited | undefined;
	let current = process;
	while (!waited) {
		try {
			waited = await waitFor(current.waitForExit(), signal);
		} catch (error) {
			// The stream that reports its end broke; the command may run on.
			console.warn("[Sandbox] Command's end not streamed", errorDetails(error));
			const state = await shellState(machine, shell);
			if (typeof state === "string") waited = state;
			else {
				current = state;
				if (
					(await waitFor(
						new Promise((done) => setTimeout(done, resubscribeDelayMs)),
						signal,
					)) === "stopped"
				)
					waited = "stopped";
			}
		}
	}
	if (waited === "stopped") {
		// `timeout` passes the signal on to the command and its children.
		await machine.exec(
			'kill -TERM "$(cat "$CALL_DIR/pid")" 2>/dev/null; rm -rf "$CALL_DIR"',
			{ env: { CALL_DIR: shell.dir } },
		);
		await machine.killProcess(shell.id);
		throw signal.reason;
	}
	if (waited === "unknown") return undefined;
	return collectShell(machine, shell);
}

// A finished command's files, read and removed in one call to the computer:
// its exit code, start, and end, a line each, then its output and its error
// output, each on a line in base64, which no output can break.
const collectProcess = `{ cat "$CALL_DIR/exit" "$CALL_DIR/start" "$CALL_DIR/end" &&
  base64 -w0 "$CALL_DIR/out" && echo && base64 -w0 "$CALL_DIR/err" && echo; } &&
rm -rf "$CALL_DIR"`;

const decodeOutput = (base64: string) =>
	new TextDecoder().decode(
		Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)),
	);

// Undefined when the command's files cannot be had: its outcome is unknown,
// never failed, since it ran.
async function collectShell(
	machine: SandboxMachine,
	shell: ReturnType<typeof shellCall>,
): Promise<ToolOutcome | undefined> {
	let lines: string[];
	try {
		const collected = await machine.exec(collectProcess, {
			env: { CALL_DIR: shell.dir },
		});
		if (!collected.success)
			throw new Error(collected.stderr || "Could not read the command's files");
		lines = collected.stdout.split("\n");
	} catch (error) {
		console.warn("[Sandbox] Command not collected", errorDetails(error));
		return undefined;
	}
	const [exit, start, end, out, err] = lines;
	const code = Number(exit.trim());
	// Measured in the computer: it may be collected long after it ended.
	const ran = Number(end.trim()) - Number(start.trim());
	const stdout = decodeOutput(out);
	const stderr = decodeOutput(err);
	const timedOut = timedOutCodes.has(code) && ran >= shell.seconds;
	const parts = [
		timedOut
			? `Stopped after ${shell.seconds} seconds (its timeout).`
			: `Exit code: ${code}`,
	];
	if (stdout) parts.push(stdout);
	if (stderr) parts.push(`[stderr]\n${stderr}`);
	// Already cut in the computer (shellProcess).
	return { output: parts.join("\n"), isError: timedOut || code !== 0 };
}

// A file as the text tools see it, found out in the computer without
// bringing the file here: missing, binary (it has a NUL byte, as git and grep
// judge), or text of this many bytes and lines. In a subshell: the SDK runs
// a command in the shell it keeps for the session, where `exit` ended that
// shell (the call failed with "shell exited") and variables stayed behind.
type TextFile =
	| { kind: "missing" | "binary" }
	| { kind: "text"; bytes: number; lines: number };
const inspectText = `(
test -f "$FILE" || { echo missing; exit 0; }
bytes=$(stat -c %s "$FILE")
if [ "$bytes" -gt 0 ] && ! grep -qI '' "$FILE"; then echo binary; exit 0; fi
echo "text $bytes $(awk 'END { print NR }' "$FILE")"
)`;

async function textFile(
	machine: SandboxMachine,
	path: string,
): Promise<TextFile> {
	const result = await machine.exec(inspectText, { env: { FILE: path } });
	const [kind, bytes, lines] = result.stdout.trim().split(" ");
	if (!result.success || !kind)
		throw new Error(result.stderr || `Could not read ${path}`);
	if (kind !== "text")
		return { kind: kind === "binary" ? "binary" : "missing" };
	return { kind, bytes: Number(bytes), lines: Number(lines) };
}

// Why a text tool cannot use a file that is not text.
const notText = (path: string, kind: "missing" | "binary"): ToolOutcome => ({
	output:
		kind === "missing"
			? `${path} is not a file.`
			: `${path} is not a text file. Look into it with shell (file, head -c, xxd, a script), view it with view_image if it is an image, or send it with send_file.`,
	isError: true,
});

// A window of lines of a text file. Only the window leaves the computer: a
// log of many megabytes stays there. It is cut in the computer to what the
// window's characters can take in UTF-8, then here to whole lines.
async function readText(
	machine: SandboxMachine,
	args: Record<string, unknown>,
): Promise<ToolOutcome> {
	const path = resolvePath(String(args.path));
	const file = await textFile(machine, path);
	if (file.kind !== "text") return notText(path, file.kind);
	const start = Math.max(Math.trunc(Number(args.start_line) || 1), 1);
	if (start > file.lines) return { output: `${path} has ${file.lines} lines.` };
	const windowBytes = outputChars * 4;
	const read = await machine.exec(
		`awk -v start="$START" 'NR >= start' "$FILE" | head -c "$BYTES"`,
		{
			env: { FILE: path, START: String(start), BYTES: String(windowBytes) },
		},
	);
	if (!read.success) throw new Error(read.stderr || `Could not read ${path}`);
	const lines = read.stdout.split("\n");
	// The last piece is a whole line only if the text ended there; cut short,
	// it is part of one.
	const whole =
		new TextEncoder().encode(read.stdout).length < windowBytes
			? lines.length - (read.stdout.endsWith("\n") ? 1 : 0)
			: lines.length - 1;
	let count = 0;
	let size = 0;
	while (count < whole && size + lines[count].length + 1 <= outputChars)
		size += lines[count++].length + 1;
	// A single line longer than a window still shows, cut.
	if (count === 0) count = 1;
	const end = start + count - 1;
	const header = `${path}, lines ${start}–${end} of ${file.lines}${end < file.lines ? `; continue from line ${end + 1}` : ""}:`;
	return { output: `${header}\n${clip(lines.slice(0, count).join("\n"))}` };
}

async function writeText(
	machine: SandboxMachine,
	path: string,
	content: string,
) {
	await machine.mkdir(posix.dirname(path), { recursive: true });
	await machine.writeFile(path, content);
}

// A file edit_file changes whole, here: past this size (a data file, a
// bundle), it is left to shell, which changes it in place.
const editableBytes = 10 * 1024 * 1024;

async function editText(
	machine: SandboxMachine,
	args: Record<string, unknown>,
): Promise<ToolOutcome> {
	const path = resolvePath(String(args.path));
	const file = await textFile(machine, path);
	if (file.kind !== "text") return notText(path, file.kind);
	if (file.bytes > editableBytes)
		return {
			output: `${path} is ${file.bytes} bytes, too large for edit_file (up to ${editableBytes / 1024 / 1024} MB); change it with shell (sed, a script).`,
			isError: true,
		};
	const before = (await machine.readFile(path, { encoding: "utf-8" })).content;
	const old = String(args.old_text);
	const count = old ? before.split(old).length - 1 : 0;
	if (count !== 1)
		return {
			output: `old_text appears ${count} times in ${path}; it must appear exactly once. Include more surrounding text to make it unique.`,
			isError: true,
		};
	await machine.writeFile(
		path,
		before.replace(old, () => String(args.new_text)),
	);
	return { output: `Edited ${path}.` };
}

// Copies a file off the computer, streamed without buffering it. The copy is
// what the user gets and the model reads: it never changes, whatever later
// happens to the file, so a reply keeps its file and the model's context
// stays the same.
async function copyFile(
	machine: SandboxMachine,
	store: StoreFile,
	args: Record<string, unknown>,
	accepts: "images" | "any",
): Promise<{ path: string; file: FileReference } | ToolOutcome> {
	const path = resolvePath(String(args.path));
	const read = await machine.readFile(path, { encoding: "none" });
	if (read.size < 1 || read.size > maxFileBytes) {
		await read.content.cancel();
		return {
			output: `${path} is ${read.size} bytes; a file must be between 1 byte and ${maxFileMegabytes} MB.`,
			isError: true,
		};
	}
	// The file's start decides its type (as storing it does), so a file that
	// is no image is turned away before it is copied.
	const { head, stream } = await peek(read.content, signatureBytes);
	if (accepts === "images" && !isImageMimeType(sniffMimeType(head) ?? "")) {
		await stream.cancel();
		return {
			output: `${path} is not a ${imageFormats} image; convert it first.`,
			isError: true,
		};
	}
	const file = await store({
		content: stream,
		size: read.size,
		fileName: posix.basename(path),
		mimeType: read.mimeType,
	});
	return { path, file };
}

const message = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

// Before a call that uses the computer: its workspace restored, and the
// container's generation, which the call's save takes. `callId` names the
// tool call, in the log.
export async function readyComputer(computer: ComputerHandle, callId?: string) {
	try {
		return await traced("ready", { runId: computer.runId, callId }, () =>
			computer.ready(),
		);
	} catch (error) {
		console.warn("[Sandbox] Workspace restore failed", errorDetails(error));
		throw new AppError(
			"Your computer could not start or restore its workspace, so nothing was run. Try again shortly.",
			ErrorCode.Unavailable,
		);
	}
}

// Runs calls on the user's computer (docs/sandbox.md): the workspace is
// restored before a call and saved after any call that may have changed it.
// A command still running when an execution is interrupted is collected by
// `resume`.
export function sandboxExecutor(
	computer: ComputerHandle,
	computerMachine: SandboxMachine,
	store: StoreFile,
): ToolSet["executor"] {
	const ready = (call: ToolCall) => readyComputer(computer, call.callId);
	// Each call's own calls to the computer are logged with it.
	const machineFor = (call: ToolCall) =>
		tracedMachine(computerMachine, {
			runId: computer.runId,
			callId: call.callId,
		});
	// A failure ends the call as a result, except a stop. A stopped command
	// may have changed files before it was killed; they are kept like any
	// other change.
	const failed = async (
		call: ToolCall,
		error: unknown,
		signal: AbortSignal,
		generation: number,
	): Promise<ToolOutcome> => {
		if (signal.aborted) {
			if (call.name === "shell")
				await saveWorkspace(computer, generation, call.callId).catch(
					(saveError: unknown) => {
						console.warn(
							"[Sandbox] Workspace save failed",
							errorDetails(saveError),
						);
					},
				);
			throw error;
		}
		return { output: `Failed: ${message(error)}`, isError: true };
	};
	// A file operation that failed changed nothing; a command may have changed
	// files whether or not it succeeded.
	// A command whose outcome is unknown may have changed files too; it stays
	// unknown.
	const saved = async (
		call: ToolCall,
		outcome: ToolOutcome | undefined,
		generation: number,
	): Promise<ToolOutcome | undefined> => {
		if (call.name !== "shell" && outcome?.isError) return outcome;
		return savedOutcome(computer, generation, outcome, call.callId);
	};
	return {
		async execute(call, signal) {
			const generation = await ready(call);
			const machine = machineFor(call);
			let outcome: ToolOutcome | undefined;
			try {
				switch (call.name) {
					case "shell":
						outcome = await runShell(machine, call, signal);
						break;
					case "read_file":
						return await readText(machine, call.arguments);
					// Sending and viewing change nothing on the computer.
					case "send_file": {
						const copied = await copyFile(
							machine,
							store,
							call.arguments,
							"any",
						);
						if (!("file" in copied)) return copied;
						// The images the user sees, the model sees too.
						return {
							output: `Sent to the user: ${copied.path}`,
							shown: [copied.file],
							...(isImageMimeType(copied.file.mimeType)
								? { images: [copied.file] }
								: {}),
						};
					}
					case "view_image": {
						const copied = await copyFile(
							machine,
							store,
							call.arguments,
							"images",
						);
						if (!("file" in copied)) return copied;
						return { output: copied.path, images: [copied.file] };
					}
					case "write_file": {
						const path = resolvePath(String(call.arguments.path));
						await writeText(machine, path, String(call.arguments.content));
						outcome = { output: `Wrote ${path}.` };
						break;
					}
					case "edit_file":
						outcome = await editText(machine, call.arguments);
						break;
					default:
						throw new Error(`No sandbox handler for "${call.name}"`);
				}
			} catch (error) {
				outcome = await failed(call, error, signal, generation);
			}
			return saved(call, outcome, generation);
		},
		async resume(call, signal) {
			// Only a command can outlast its attempt; any other call's outcome is
			// unknown.
			if (call.name !== "shell") return undefined;
			// A computer that cannot be reached cannot say whether the command
			// ran: its outcome is unknown, never "nothing was run".
			const generation = await ready(call).catch(() => undefined);
			if (generation === undefined) return undefined;
			let outcome: ToolOutcome | undefined;
			try {
				outcome = await resumeShell(machineFor(call), call, signal);
			} catch (error) {
				outcome = await failed(call, error, signal, generation);
			}
			return outcome && saved(call, outcome, generation);
		},
	};
}

// Tools whose result is an image for the model to look at; a model that
// cannot read images is not offered them.
const showsImages = new Set(["view_image", "browser_take_screenshot"]);

// The computer a run uses (docs/sandbox.md), shared by the tools that need
// it: its own, and the mail tools, which put attachments on it and send files
// from it. Nothing reaches it until one of them is called, or its
// conversation has attachments not yet on the computer: those are put there
// as soon as the run starts, while the model reads the message, and the first
// call waits for them. From its first use it is held for the run until the
// run ends, so settings do not pull the workspace away under it.
export interface RunComputer {
	// The computer, once the conversation's attachments are on it.
	attached(): Promise<{ computer: ComputerHandle; machine: SandboxMachine }>;
	// Lets go of it as the run ends. It never throws.
	release(): Promise<void>;
}

export function runComputer(
	db: Database,
	userId: string,
	options: {
		runId: string;
		// The run's conversation, whose attachments it puts on the computer.
		threadId: string;
	},
): RunComputer {
	let connected:
		| { computer: ComputerHandle; machine: SandboxMachine }
		| undefined;
	const connect = () => {
		if (!connected) {
			const user = userComputer(userId);
			connected = {
				machine: user.machine,
				computer: {
					runId: options.runId,
					ready: () => user.computer.ready(options.runId),
					save: (generation) => user.computer.save(generation),
					release: (runId) => user.computer.release(runId),
				},
			};
		}
		return connected;
	};
	const place = () => {
		// Any failure, even reaching the computer, surfaces at the next call,
		// which waits for this; the run itself goes on.
		const placing = placeUploads(db, userId, connect, options.threadId);
		placing.catch(() => {});
		return placing;
	};
	let placing: Promise<void> | undefined = place();
	return {
		async attached() {
			const machine = connect();
			if (placing) {
				try {
					await placing;
				} catch (error) {
					console.warn("[Sandbox] Attachments not placed", errorDetails(error));
					placing = place();
					throw new AppError(
						"The files the user attached could not be put on your computer, so nothing was run. Try again shortly.",
						ErrorCode.Unavailable,
					);
				}
			}
			return machine;
		},
		async release() {
			await connected?.computer
				.release(options.runId)
				.catch((error) =>
					console.warn("[Sandbox] Computer not released", errorDetails(error)),
				);
		},
	};
}

// The computer's own tools: shell, files, and the browser on its screen. As
// the tools that use the computer most, they let go of it when the run ends.
export function sandboxToolSet(
	db: Database,
	userId: string,
	computer: RunComputer,
	options: { readsImages: boolean },
): ToolSet {
	const store: StoreFile = async (file) =>
		fileReference(await storeFile(db, userId, file));
	let executors:
		| { executor: ToolSet["executor"]; browser: ToolSet["executor"] }
		| undefined;
	const attached = async () => {
		const { computer: handle, machine } = await computer.attached();
		executors ??= {
			executor: sandboxExecutor(handle, machine, store),
			browser: browserExecutor(handle, store, connectBrowser(handle, machine)),
		};
		return executors;
	};
	return {
		specs: [...specs, ...browserSpecs].filter(
			(spec) => options.readsImages || !showsImages.has(spec.name),
		),
		executor: {
			async execute(call, signal) {
				const { executor, browser } = await attached();
				return (isBrowserTool(call.name) ? browser : executor).execute(
					call,
					signal,
				);
			},
			async resume(call, signal) {
				// As a computer that cannot be reached: the outcome is unknown.
				const executors = await attached().catch(() => undefined);
				if (!executors) return undefined;
				const { executor, browser } = executors;
				return (isBrowserTool(call.name) ? browser : executor).resume?.(
					call,
					signal,
				);
			},
			// The browser's session is this execution's; the computer is held
			// until the run ends, not while it waits to be resumed.
			async close(runEnded) {
				await executors?.browser.close?.(runEnded);
				if (runEnded) await computer.release();
			},
		},
	};
}
