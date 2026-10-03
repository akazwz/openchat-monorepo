import { exports } from "cloudflare:workers";

import type { SandboxMachine } from "./computer";

const namePrefix = "user-";
// Each user's computer is the Durable Object of this name.
const computerName = (userId: string) => `${namePrefix}${userId}`;
// The user a computer belongs to, from its Durable Object's name.
export const computerOwner = (name: string | undefined) =>
	name?.startsWith(namePrefix) ? name.slice(namePrefix.length) : undefined;

// Each user's native Computer Durable Object. Calls use Workers RPC directly;
// there is no SDK transport or implicit session configuration.
export const userMachine = (userId: string) =>
	exports.Computer.getByName(computerName(userId));

// The same stub, as its workspace (computer) and its machine.
export function userComputer(userId: string) {
	const machine = userMachine(userId);
	return {
		computer: machine,
		machine: {
			listFiles: (path: string) => machine.listFiles(path),
			...({
				exec: (command, options) => machine.exec(command, options),
				startProcess: async (command, options) => {
					await machine.startProcess(command, options);
					return { waitForExit: () => machine.waitForExit(options.processId) };
				},
				getProcess: async (id) => {
					const process = await machine.getProcess(id);
					return (
						process && {
							...process,
							waitForExit: () => machine.waitForExit(id),
						}
					);
				},
				killProcess: (id) => machine.killProcess(id),
				readFile: ((path: string, options: { encoding: "utf-8" | "none" }) =>
					options.encoding === "utf-8"
						? machine.readTextFile(path)
						: machine.readFile(path)) as SandboxMachine["readFile"],
				exists: (path) => machine.exists(path),
				mkdir: (path, options) => machine.mkdir(path, options),
				writeFile: (path, content) => machine.writeFile(path, content),
				containerFetch: (url, init, port) =>
					machine.containerFetch(url, init, port),
			} satisfies SandboxMachine),
		},
	};
}
