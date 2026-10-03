import { type ChildProcess, spawn } from "node:child_process";

import { resolvePath, stringArgument, wholeCharacters } from "./files";

const outputLimit = 48_000;
const timeoutRange = { min: 1, max: 1800 };
const killDelay = 500;

// Every command is the leader of a process group of its own, so what it
// started ends with it.
function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
	if (!child.pid) return;
	try {
		process.kill(-child.pid, signal);
	} catch (error) {
		// ESRCH: the group has already gone.
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

// Runs one command in a zsh login shell, as the Mac's user. `track` hears
// about the process group while it lives, so that whoever supervises this
// process can end the group should this process die.
export function runShell(
	workspace: string,
	args: Record<string, unknown>,
	signal: AbortSignal,
	track: (pid: number, active: boolean) => void,
) {
	const command = stringArgument(args, "command");
	const cwd = resolvePath(workspace, stringArgument(args, "cwd"));
	const timeout = args.timeout_seconds;
	if (
		typeof timeout !== "number" ||
		!(timeout >= timeoutRange.min && timeout <= timeoutRange.max)
	)
		throw new Error(
			`timeout_seconds must be ${timeoutRange.min}–${timeoutRange.max}`,
		);
	signal.throwIfAborted();

	return new Promise<Record<string, unknown>>((resolve, reject) => {
		const child = spawn("/bin/zsh", ["-lc", command], {
			cwd,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, TERM: "dumb" },
		});
		if (child.pid) track(child.pid, true);

		const chunks: Buffer[] = [];
		let size = 0;
		let truncated = false;
		const collect = (chunk: Buffer) => {
			const room = outputLimit - size;
			if (chunk.length > room) truncated = true;
			if (room <= 0) return;
			chunks.push(chunk.subarray(0, room));
			size += Math.min(chunk.length, room);
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);

		let timedOut = false;
		let killTimer: NodeJS.Timeout | undefined;
		// Asks the group to stop, then makes it.
		const stop = () => {
			signalGroup(child, "SIGTERM");
			killTimer ??= setTimeout(() => signalGroup(child, "SIGKILL"), killDelay);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			stop();
		}, timeout * 1000);
		signal.addEventListener("abort", stop, { once: true });
		// The shell has exited: anything it left running in its group goes too.
		child.once("exit", stop);
		const settle = () => {
			clearTimeout(timer);
			clearTimeout(killTimer);
			signal.removeEventListener("abort", stop);
		};
		// The shell could not start, for one because cwd does not exist.
		child.once("error", (error) => {
			settle();
			reject(error);
		});
		child.once("close", (code) => {
			settle();
			signalGroup(child, "SIGKILL");
			if (child.pid) track(child.pid, false);
			const output = wholeCharacters(Buffer.concat(chunks)).toString("utf8");
			const notes = [
				truncated && "[Output truncated]",
				timedOut
					? "[Command timed out]"
					: signal.aborted && "[Command cancelled]",
			].filter(Boolean);
			resolve({
				output: [output, ...notes].join("\n"),
				exitCode: code ?? -1,
				isError: code !== 0 || timedOut || signal.aborted,
			});
		});
	});
}
