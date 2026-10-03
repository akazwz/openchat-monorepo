import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";

import {
	type Binding,
	type Command,
	failure,
	isId,
	isRecord,
	type Result,
} from "../protocol";
import {
	editText,
	readText,
	resolvePath,
	stringArgument,
	writeText,
} from "./files";
import { Journal } from "./journal";
import { runShell } from "./shell";
import { receiveFile, sendFile, sendScreenshot } from "./transfer";

// The process that does what the agent asks of this Mac: commands and files.
// It runs apart from the window and the main process, as the Mac's user, and
// keeps a journal so that no command runs twice (journal.ts). The screen and
// the pointer belong to the main process, which it asks (`native`).
export interface ExecutorOptions {
	binding: Binding;
	journal: string;
}

const concurrentLimit = 8;
const nativeTimeout = 20_000;
const unknownOutcome: Result = {
	ok: false,
	unknown: true,
	error: "Whether this ran is not known; it will not be run again by itself",
};

const port = process.parentPort;
let binding: Binding;
let journal: Journal;
let ready = false;
let stopping = false;

interface Job {
	hash: string;
	abort: AbortController;
	done: Promise<void>;
}
const jobs = new Map<string, Job>();
const nativeCalls = new Map<
	string,
	{ resolve(value: Record<string, unknown>): void; reject(error: Error): void }
>();

// The same text for the same value, whatever order its keys came in.
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (isRecord(value))
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
}

const report = (id: string, result: Result) =>
	port.postMessage({ type: "result", id, result });

// Has the main process do what only it can: capture the screen, send input.
function native(command: Command, signal: AbortSignal) {
	signal.throwIfAborted();
	return new Promise<Record<string, unknown>>((resolve, reject) => {
		const requestId = randomUUID();
		const settle = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", cancel);
			nativeCalls.delete(requestId);
		};
		const cancel = () => {
			settle();
			reject(new Error("The operation was cancelled"));
		};
		const timer = setTimeout(cancel, nativeTimeout);
		signal.addEventListener("abort", cancel, { once: true });
		nativeCalls.set(requestId, {
			resolve(value) {
				settle();
				resolve(value);
			},
			reject(error) {
				settle();
				reject(error);
			},
		});
		port.postMessage({ type: "native", requestId, command });
	});
}

async function execute(command: Command, signal: AbortSignal) {
	const args = command.arguments;
	const path = () =>
		resolvePath(binding.workspace, stringArgument(args, "path"));
	switch (command.method) {
		case "shell":
			return runShell(binding.workspace, args, signal, (pid, active) =>
				port.postMessage({ type: "process", pid, active }),
			);
		case "read_file":
			return readText(path(), args);
		case "write_file":
			return writeText(path(), args, signal);
		case "edit_file":
			return editText(path(), args, signal);
		case "send_file":
		case "view_image":
			return sendFile(binding, command, path(), signal);
		case "receive_file":
			return receiveFile(
				binding,
				command,
				stringArgument(args, "fileId"),
				path(),
				signal,
			);
		case "screenshot": {
			const { image } = await native(command, signal);
			if (!(image instanceof Uint8Array))
				throw new Error("The screen could not be captured");
			// A copy that arrived in a message has a buffer of its own.
			return sendScreenshot(
				binding,
				command,
				image as Uint8Array<ArrayBuffer>,
				signal,
			);
		}
		case "computer":
		case "release_input":
			return native(command, signal);
		default:
			throw new Error(`Unknown method: ${command.method}`);
	}
}

async function run(command: Command, hash: string, signal: AbortSignal) {
	try {
		const saved = await journal.read(command.id);
		if (saved) {
			// Asked before. With another input the ID was reused; with no result,
			// the command began and its end was never recorded.
			report(
				command.id,
				saved.hash && saved.hash !== hash
					? failure(new Error("This command ID was used for another command"))
					: (saved.result ?? unknownOutcome),
			);
			return;
		}
		await journal.write(command.id, { hash, created: Date.now() });
		let result: Result;
		try {
			result = { ok: true, value: await execute(command, signal) };
		} catch (error) {
			result = failure(error);
		}
		await journal.write(command.id, { hash, result, created: Date.now() });
		report(command.id, result);
	} catch (error) {
		// The journal itself failed: what was done is not on record.
		report(command.id, { ...failure(error), unknown: true });
	}
}

function start(command: Command) {
	const hash = createHash("sha256")
		.update(canonical([command.method, command.arguments]))
		.digest("hex");
	const active = jobs.get(command.id);
	if (active) {
		if (active.hash !== hash)
			report(
				command.id,
				failure(new Error("This command ID was used for another command")),
			);
		return;
	}
	if (jobs.size >= concurrentLimit) {
		report(command.id, failure(new Error("This Mac is busy; try again")));
		return;
	}
	const abort = new AbortController();
	const done = run(command, hash, abort.signal).finally(() =>
		jobs.delete(command.id),
	);
	jobs.set(command.id, { hash, abort, done });
}

// The server asking what became of a command, or to stop it.
async function answer(id: string, cancel: boolean) {
	const active = jobs.get(id);
	if (active) {
		// Its result follows when it ends.
		if (cancel) active.abort.abort();
		return;
	}
	const saved = await journal.read(id);
	if (saved) {
		report(id, saved.result ?? unknownOutcome);
		return;
	}
	if (!cancel) {
		report(id, unknownOutcome);
		return;
	}
	// It never arrived here. Recorded, so that it does nothing if it still does.
	const cancelled: Result = { ok: false, error: "The operation was cancelled" };
	await journal.write(id, { result: cancelled, created: Date.now() });
	report(id, cancelled);
}

async function initialize(options: ExecutorOptions) {
	binding = options.binding;
	journal = new Journal(options.journal);
	await journal.open();
	await mkdir(binding.workspace, { recursive: true, mode: 0o700 });
	ready = true;
}

async function stop() {
	stopping = true;
	for (const job of jobs.values()) job.abort.abort();
	await Promise.allSettled([...jobs.values()].map((job) => job.done));
	process.exit(0);
}

port.on("message", ({ data }: { data: unknown }) => {
	if (!isRecord(data) || stopping) return;
	if (data.type === "stop") {
		void stop();
		return;
	}
	if (data.type === "init") {
		if (ready) return;
		initialize(data.options as ExecutorOptions).then(
			() => port.postMessage({ type: "ready" }),
			(error: unknown) =>
				port.postMessage({ type: "fatal", error: failure(error).error }),
		);
		return;
	}
	if (data.type === "native-result" && typeof data.requestId === "string") {
		const call = nativeCalls.get(data.requestId);
		if (typeof data.error === "string") call?.reject(new Error(data.error));
		else if (isRecord(data.value)) call?.resolve(data.value);
		return;
	}
	if (!ready) return;
	if (
		data.type === "execute" &&
		isId(data.id) &&
		typeof data.method === "string" &&
		isRecord(data.arguments)
	)
		start({ id: data.id, method: data.method, arguments: data.arguments });
	else if (
		(data.type === "collect" || data.type === "cancel") &&
		isId(data.id)
	) {
		const id = data.id;
		answer(id, data.type === "cancel").catch((error: unknown) =>
			report(id, { ...failure(error), unknown: true }),
		);
	}
});
