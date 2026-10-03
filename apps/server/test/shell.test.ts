import { beforeEach, expect, test, vi } from "vitest";

import type {
	ComputerHandle,
	SandboxMachine,
} from "@/modules/sandbox/computer";
import { sandboxExecutor } from "@/modules/sandbox/tools";

const dir = "/tmp/heveta-calls/call-1";
const shell = {
	callId: "call-1",
	name: "shell",
	arguments: { command: "make deploy", timeout_seconds: 600 },
};

// A computer whose stream reporting a command's end breaks while the command
// runs on, as the SDK's does ("stream ended unexpectedly without exit event").
// Waiting on the process again gets a stream that reports its end.
function setup() {
	const files = new Map<string, string>();
	let end!: () => void;
	const ended = new Promise<void>((resolve) => {
		end = () => {
			files.set(`${dir}/start`, "0\n");
			files.set(`${dir}/end`, "1\n");
			files.set(`${dir}/out`, "deployed\nto 2 hosts");
			files.set(`${dir}/err`, "");
			files.set(`${dir}/exit`, "0\n");
			resolve();
		};
	});
	const state = { running: true, collects: true, end };
	const machine = {
		startProcess: async () => ({
			waitForExit: () =>
				Promise.reject(
					new Error("stream ended unexpectedly without exit event"),
				),
		}),
		getProcess: async () =>
			state.running ? { status: "running", waitForExit: () => ended } : null,
		exists: async (path: string) => ({ exists: files.has(path) }),
		// Collecting a command reads its files in one call: code and times,
		// then its output and errors in base64 (sandbox/tools.ts).
		exec: vi.fn(async (command: string) => {
			if (!command.includes("base64"))
				return { success: true, stdout: "", stderr: "" };
			if (!state.collects) throw new Error("Connection lost");
			const read = (name: string) => files.get(`${dir}/${name}`) ?? "";
			const encoded = (name: string) =>
				`${Buffer.from(read(name)).toString("base64")}\n`;
			return {
				success: true,
				stdout: `${read("exit")}${read("start")}${read("end")}${encoded("out")}${encoded("err")}`,
				stderr: "",
			};
		}),
		killProcess: vi.fn(async () => {}),
	};
	const computer = { ready: async () => {}, save: vi.fn(async () => {}) };
	const executor = sandboxExecutor(
		computer as unknown as ComputerHandle,
		machine as unknown as SandboxMachine,
		async () => {
			throw new Error("Nothing is stored");
		},
	);
	return { executor, machine, files, state };
}

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

test("a command whose end stopped streaming is waited for again and collected; one gone without an exit code is unknown, never failed", async () => {
	const { executor, machine, files, state } = setup();
	const signal = new AbortController().signal;
	const deployed = executor.execute(shell, signal);
	await new Promise((resolve) => setTimeout(resolve));
	state.end();
	expect((await deployed)?.output).toBe("Exit code: 0\ndeployed\nto 2 hosts");
	expect(machine.killProcess).not.toHaveBeenCalled();
	// A command that ended but whose files could not be read ran: its
	// outcome is unknown, never failed.
	state.collects = false;
	expect(await executor.execute(shell, signal)).toBeUndefined();
	state.collects = true;
	// Gone without an exit code (the computer restarted): whether it ran is
	// unknown, which the model is told instead of a failure.
	files.clear();
	state.running = false;
	expect(await executor.execute(shell, signal)).toBeUndefined();
});
