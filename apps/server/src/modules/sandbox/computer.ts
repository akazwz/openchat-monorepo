import { errorDetails } from "@/lib/error-details";
import type { ToolOutcome } from "@/runtime/tools";

import { WorkspaceLostError } from "./workspace";

export interface ExecOptions {
	cwd?: string;
	env?: Record<string, string>;
}

export interface ExecResult {
	success: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
	command: string;
	duration: number;
	timestamp: string;
}

// The computer operations tools use; tests supply a fake.
export interface SandboxMachine {
	exec(command: string, options?: ExecOptions): Promise<ExecResult>;
	// A command that can be stopped: an AbortSignal cannot reach the sandbox
	// over RPC, so a stop kills the process by its ID instead. It can outlast
	// the call that started it and be found again by its ID.
	startProcess(
		command: string,
		options: { processId: string; cwd: string; env: Record<string, string> },
	): Promise<{ waitForExit(): Promise<unknown> }>;
	getProcess(id: string): Promise<{
		status: string;
		waitForExit(): Promise<unknown>;
	} | null>;
	killProcess(id: string): Promise<void>;
	// Text, always read as UTF-8: the sandbox's default guesses from the
	// file's name, and returns base64 for one it takes for binary (a .ts file
	// is an MPEG stream to it). Or with `encoding: "none"` the raw bytes as a
	// stream.
	readFile(
		path: string,
		options: { encoding: "utf-8" },
	): Promise<{ content: string }>;
	readFile(
		path: string,
		options: { encoding: "none" },
	): Promise<{
		content: ReadableStream<Uint8Array>;
		size: number;
		mimeType: string;
	}>;
	exists(path: string): Promise<{ exists: boolean }>;
	// With `recursive`, creates missing parents and accepts one that exists.
	mkdir(path: string, options: { recursive: true }): Promise<unknown>;
	// Text, or raw bytes from a stream.
	writeFile(
		path: string,
		content: string | ReadableStream<Uint8Array>,
	): Promise<unknown>;
	// An HTTP request to a port inside the container, through the sandbox;
	// nothing is exposed outside it.
	containerFetch(
		url: string,
		init: { method: string; headers: Record<string, string>; body?: string },
		port: number,
	): Promise<Response>;
}

export { WorkspaceLostError, workspaceDir } from "./workspace";

// A computer sleeps after this long without calls; its workspace is saved
// after every change, and before it sleeps.
export const idleTimeoutMs = 30 * 60 * 1000;

// What Worker code asks of a user's computer's workspace: the Computer Durable
// Object's own methods (computer-object.ts), run there one at a time; tests
// pass a fake.
export interface ComputerHandle {
	// The run this handle is used for, named in the logs of its calls.
	readonly runId?: string;
	// Before any use; `runId` holds the computer for that run until released.
	// The container's generation, which save() takes.
	ready(runId?: string): Promise<number>;
	save(generation: number): Promise<"saved" | "lost">;
	release(runId: string): Promise<void>;
}

// Which run and tool call a call to the computer serves.
export interface CallContext {
	runId?: string;
	callId?: string;
}

// Logs a call to the computer made from this Worker (docs/sandbox.md): which
// method, how long it took, how it ended, and for which run and tool call,
// so what a slow or cancelled request waited on can be told apart. A call
// that returns a stream is timed until the stream begins.
export async function traced<T>(
	method: string,
	context: CallContext,
	work: () => Promise<T>,
): Promise<T> {
	const started = Date.now();
	let outcome = "error";
	try {
		const result = await work();
		outcome = "ok";
		return result;
	} finally {
		console.log("[Sandbox] Call", {
			method,
			outcome,
			ms: Date.now() - started,
			...context,
		});
	}
}

// The machine, each of its calls logged for this run and tool call (traced),
// the waits on the processes it starts included.
export function tracedMachine(
	machine: SandboxMachine,
	context: CallContext,
): SandboxMachine {
	const call = <T>(method: string, work: () => Promise<T>) =>
		traced(method, context, work);
	const waited = (process: { waitForExit(): Promise<unknown> }) => () =>
		call("waitForExit", () => process.waitForExit());
	return {
		exec: (command, options) =>
			call("exec", () => machine.exec(command, options)),
		startProcess: async (command, options) => {
			const process = await call("startProcess", () =>
				machine.startProcess(command, options),
			);
			return { waitForExit: waited(process) };
		},
		getProcess: async (id) => {
			const process = await call("getProcess", () => machine.getProcess(id));
			return (
				process && { status: process.status, waitForExit: waited(process) }
			);
		},
		killProcess: (id) => call("killProcess", () => machine.killProcess(id)),
		readFile: ((path: string, options: { encoding: "utf-8" | "none" }) =>
			call("readFile", () =>
				machine.readFile(path, options as { encoding: "none" }),
			)) as SandboxMachine["readFile"],
		exists: (path) => call("exists", () => machine.exists(path)),
		mkdir: (path, options) => call("mkdir", () => machine.mkdir(path, options)),
		writeFile: (path, content) =>
			call("writeFile", () => machine.writeFile(path, content)),
		containerFetch: (url, init, port) =>
			call("containerFetch", () => machine.containerFetch(url, init, port)),
	};
}

// After a call that may have changed files, with the generation the ready()
// before it gave. A container that restarted since then lost the call's
// changes, and holds an empty workspace, which is never saved over the
// user's.
// `callId` names the tool call it follows, in the call's log.
export async function saveWorkspace(
	computer: ComputerHandle,
	generation: number,
	callId?: string,
) {
	const saved = await traced("save", { runId: computer.runId, callId }, () =>
		computer.save(generation),
	);
	if (saved === "lost") throw new WorkspaceLostError();
}

// A call's outcome once the workspace is saved after it, telling the model
// when its changes could not be: lost with a container that restarted, or
// still on the computer, waiting for the next save. A call whose outcome is
// unknown may have changed files too; it stays unknown.
export async function savedOutcome(
	computer: ComputerHandle,
	generation: number,
	outcome: ToolOutcome | undefined,
	callId?: string,
): Promise<ToolOutcome | undefined> {
	try {
		await saveWorkspace(computer, generation, callId);
		return outcome;
	} catch (error) {
		console.warn("[Sandbox] Computer save failed", errorDetails(error));
		if (!outcome) return outcome;
		return {
			...outcome,
			output:
				error instanceof WorkspaceLostError
					? `${outcome.output}\n\n${error.message}`
					: `${outcome.output}\n\nThe computer filesystem could not be saved after this call (${error instanceof Error ? error.message : String(error)}). Its changes are on the computer now, and are saved with the next save that succeeds; the computer stays on until then.`,
			isError: true,
		};
	}
}
