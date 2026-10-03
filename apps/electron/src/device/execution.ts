import { join } from "node:path";

import { utilityProcess, type UtilityProcess } from "electron";

import type { ExecutorOptions } from "./executor/main";
import {
	type Command,
	failure,
	type HostMessage,
	isId,
	isRecord,
	type Result,
} from "./protocol";

const startTimeout = 15_000;
const stopTimeout = 3000;

interface ExecutionEvents {
	// A command's result, for the server.
	result(message: Extract<HostMessage, { type: "result" }>): void;
	// The screen and the pointer, which only the main process reaches.
	native(command: Command): Promise<Record<string, unknown>>;
	// The process ended without being asked to.
	crashed(): void;
}

// Runs the command process (executor/main.ts) and stands between it and the
// rest of the client. Should that process die, the commands it had started
// are ended with it.
export class Execution {
	private process?: UtilityProcess;
	private stopping = false;
	// The process groups of the commands running now.
	private groups = new Set<number>();

	constructor(private readonly events: ExecutionEvents) {}

	start(options: ExecutorOptions) {
		const child = utilityProcess.fork(join(__dirname, "executor.js"), [], {
			serviceName: "Heveta Commands",
			stdio: "ignore",
		});
		this.process = child;
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("The command process did not start")),
				startTimeout,
			);
			child.once("spawn", () => child.postMessage({ type: "init", options }));
			child.on("message", (message: unknown) => {
				if (!isRecord(message)) return;
				if (message.type === "ready") {
					clearTimeout(timer);
					resolve();
				} else if (message.type === "fatal") {
					clearTimeout(timer);
					reject(
						new Error(`The command process could not start: ${message.error}`),
					);
				} else this.receive(child, message);
			});
			child.once("exit", () => {
				clearTimeout(timer);
				reject(new Error("The command process stopped"));
				this.killGroups();
				if (this.process !== child) return;
				this.process = undefined;
				if (!this.stopping) this.events.crashed();
			});
		});
	}

	// A message from the server about a command: execute, collect or cancel.
	send(message: unknown) {
		if (!this.stopping) this.process?.postMessage(message);
	}

	// Cancels what is running and ends the process.
	async stop() {
		this.stopping = true;
		const child = this.process;
		if (child) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					child.kill();
					resolve();
				}, stopTimeout);
				child.once("exit", () => {
					clearTimeout(timer);
					resolve();
				});
				child.postMessage({ type: "stop" });
			});
		}
		this.killGroups();
	}

	private receive(child: UtilityProcess, message: Record<string, unknown>) {
		if (
			message.type === "result" &&
			isId(message.id) &&
			isRecord(message.result)
		)
			this.events.result({
				type: "result",
				id: message.id,
				result: message.result as Result,
			});
		else if (
			message.type === "process" &&
			Number.isSafeInteger(message.pid) &&
			(message.pid as number) > 1
		) {
			if (message.active) this.groups.add(message.pid as number);
			else this.groups.delete(message.pid as number);
		} else if (
			message.type === "native" &&
			typeof message.requestId === "string" &&
			isRecord(message.command)
		) {
			const reply = (answer: { value: unknown } | { error: string }) => {
				if (!this.stopping && this.process === child)
					child.postMessage({
						type: "native-result",
						requestId: message.requestId,
						...answer,
					});
			};
			this.events.native(message.command as unknown as Command).then(
				(value) => reply({ value }),
				(error: unknown) => reply({ error: failure(error).error }),
			);
		}
	}

	private killGroups() {
		for (const pid of this.groups) {
			try {
				process.kill(-pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
		this.groups.clear();
	}
}
