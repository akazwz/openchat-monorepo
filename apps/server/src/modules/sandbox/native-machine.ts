import { Files, SandboxFileError } from "@cloudflare/sandbox";

import { errorDetails } from "@/lib/error-details";
import { closeSocket } from "@/lib/websocket";

import type { ExecOptions, ExecResult } from "./computer";
import { type Filesystem, filesystemTtlMs } from "./filesystem";
import {
	processDir,
	processesDir,
	processState,
	runProcess,
	stopProcess,
	waitProcess,
} from "./native-processes";

// Native exec inherits only PATH from start(), so every command explicitly
// receives the computer's environment, including graphical and install paths.
export const computerEnv = {
	HOME: "/root",
	LANG: "C.UTF-8",
	TERM: "xterm-256color",
	DISPLAY: ":99",
	DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/heveta-session-bus",
	NPM_CONFIG_PREFIX: "/workspace/.local",
	PYTHONUSERBASE: "/workspace/.local",
	PIP_ROOT_USER_ACTION: "ignore",
	NODE_PATH: "/usr/local/lib/node_modules:/workspace/.local/lib/node_modules",
	PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/workspace/.local/bin",
};
// Our alarm saves before stopping; the native timeout is a fallback after an
// object restart. A live monitor prevents it from stopping before that save.
export const fallbackTimeoutMs = 6 * 60 * 60 * 1000;
interface NativeHost {
	activity(): Promise<void>;
	started(): void;
	stopped(): Promise<void>;
	currentSnapshot(): Promise<
		{ id: string; filesystem: Filesystem } | undefined
	>;
	// Commit the platform's renewed lifetime before accepting user commands.
	resumedSnapshot(id: string, expiresAt: number): Promise<void>;
}

// The platform operations used by Computer. It owns no Run state and performs
// no retries: a failed native call may already have changed the computer.
export class NativeMachine {
	readonly files: Files;
	pending = 0;
	#setup: Promise<void> | undefined;
	#epoch = 0;
	#image: string | undefined;
	#restoredSnapshotId: string | undefined;
	#attached = false;

	constructor(
		readonly container: Container,
		readonly host: NativeHost,
	) {
		this.files = new Files(container);
	}

	async ensureRunning() {
		if (!this.#setup && this.container.running && this.#attached) return;
		this.#setup ??= this.#start().finally(() => {
			this.#setup = undefined;
		});
		await this.#setup;
	}

	async #start() {
		const epoch = ++this.#epoch;
		const current = await this.host.currentSnapshot();
		// Never discard an unfamiliar running instance without an explicit
		// migration: there is no permanent directory archive to fall back to.
		if (
			this.container.running &&
			(await this.container.inspect())?.labels["heveta-runtime"] !== "native-v1"
		) {
			throw new Error("The running computer requires migration");
		}
		if (!this.container.running) {
			this.#restoredSnapshotId = undefined;
			const filesystem = current?.filesystem;
			if (filesystem) {
				try {
					this.#boot({ containerSnapshot: filesystem.snapshot });
					await this.#prepareBoot();
					await this.host.resumedSnapshot(
						current.id,
						Date.now() + filesystemTtlMs,
					);
					this.#restoredSnapshotId = current.id;
					this.#image = filesystem.image;
				} catch (error) {
					// A valid snapshot failing to restore is an outage, not expiry.
					// Keep its handle and run no command on an empty replacement.
					await this.container.destroy();
					this.#restoredSnapshotId = undefined;
					throw error;
				}
			} else {
				this.#boot({ image: this.container.images.computer });
				await this.#prepareBoot();
				this.#image = this.container.images.computer;
			}
		} else {
			// inspect() has no image for a snapshot boot. DO metadata keeps
			// that source image across DO restarts and ordinary deployments.
			this.#image =
				(await this.container.inspect())?.image || current?.filesystem.image;
			await this.container.setInactivityTimeout(fallbackTimeoutMs);
		}
		this.host.started();
		this.#attached = true;
		const stopped = async (error?: unknown) => {
			if (epoch !== this.#epoch) return;
			this.#setup = undefined;
			this.#attached = false;
			this.#restoredSnapshotId = undefined;
			if (error)
				console.warn("[Computer] Container stopped", errorDetails(error));
			await this.host.stopped();
		};
		void this.container
			.monitor()
			.then(() => stopped(), stopped)
			.catch((error) => {
				console.warn("[Computer] Stop cleanup failed", errorDetails(error));
			});
	}

	#boot(source: { image: string } | { containerSnapshot: ContainerSnapshot }) {
		this.container.start({
			...source,
			instance: "standard-1",
			enableInternet: true,
			env: computerEnv,
			labels: { "heveta-runtime": "native-v1" },
		});
	}

	async #prepareBoot() {
		await this.container.setInactivityTimeout(fallbackTimeoutMs);
		// Filesystem snapshots keep files, but no processes. Clear lifecycle
		// markers and desktop locks before starting their replacement processes.
		const process = await this.container.exec([
			"sh",
			"-c",
			"rm -f /tmp/heveta-workspace-restored /tmp/heveta-workspace-saved /tmp/heveta-workspace-saved.next /tmp/.X99-lock /tmp/.X11-unix/X99 /tmp/heveta-session-bus /tmp/tmux-0/heveta /root/.config/heveta-browser/SingletonLock /root/.config/heveta-browser/SingletonSocket /root/.config/heveta-browser/SingletonCookie /root/.config/heveta-browser/DevToolsActivePort",
		]);
		if ((await process.output()).exitCode !== 0)
			throw new Error("Cannot prepare the computer filesystem");
	}

	async #use<T>(work: () => Promise<T>) {
		this.pending++;
		try {
			await this.host.activity();
			await this.ensureRunning();
			return await work();
		} finally {
			this.pending--;
			await this.host.activity();
		}
	}

	async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
		return this.#use(async () => {
			const started = Date.now();
			const process = await this.container.exec(["bash", "-c", command], {
				cwd: options?.cwd ?? "/workspace",
				env: { ...computerEnv, ...options?.env },
			});
			const result = await process.output();
			return {
				success: result.exitCode === 0,
				exitCode: result.exitCode,
				stdout: new TextDecoder().decode(result.stdout),
				stderr: new TextDecoder().decode(result.stderr),
				command,
				duration: Date.now() - started,
				timestamp: new Date().toISOString(),
			};
		});
	}

	async startProcess(
		command: string,
		options: {
			processId: string;
			cwd: string;
			env: Record<string, string>;
		},
	) {
		const dir = processDir(options.processId);
		await this.#use(async () => {
			if ((await this.files.stat(options.cwd)).type !== "directory")
				throw new Error("The working directory is not a directory");
			const create = await this.container.exec([
				"bash",
				"-c",
				'mkdir -p -- "$1" && mkdir -- "$2"',
				"bash",
				processesDir,
				dir,
			]);
			if ((await create.output()).exitCode !== 0)
				throw new Error("The process ID is already in use");
			// Discarding both native output streams lets this process outlive the
			// request. Tool commands already keep bounded output in their own files.
			await this.container.exec(
				["sh", "-c", runProcess, "sh", dir, "bash", "-c", command],
				{
					cwd: options.cwd,
					env: { ...computerEnv, ...options.env },
					stdout: "ignore",
					stderr: "ignore",
				},
			);
		});
	}

	async getProcess(id: string) {
		if (!this.container.running) return null;
		const dir = processDir(id);
		return this.#use(async () => {
			const process = await this.container.exec([
				"sh",
				"-c",
				processState,
				"sh",
				dir,
			]);
			const output = await process.output();
			if (output.exitCode !== 0) throw new Error("Cannot read process state");
			const [state, value] = new TextDecoder()
				.decode(output.stdout)
				.trim()
				.split(" ");
			return state === "missing"
				? null
				: {
						status:
							state === "exited"
								? value === "0"
									? "completed"
									: "failed"
								: state,
					};
		});
	}

	async waitForExit(id: string) {
		if (!this.container.running) throw new Error("The computer stopped");
		const dir = processDir(id);
		return this.#use(async () => {
			const process = await this.container.exec([
				"sh",
				"-c",
				waitProcess,
				"sh",
				dir,
				processState,
			]);
			const output = await process.output();
			const status = new TextDecoder().decode(output.stdout).trim();
			if (!status.startsWith("exited "))
				throw new Error("The process was lost");
			return Number(status.slice(7));
		});
	}

	async killProcess(id: string) {
		if (!this.container.running) return;
		const dir = processDir(id);
		await this.#use(async () => {
			const process = await this.container.exec([
				"bash",
				"-c",
				stopProcess,
				"bash",
				dir,
			]);
			await process.output();
		});
	}

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
	readFile(path: string, options: { encoding: "utf-8" | "none" }) {
		return this.#use(async () => {
			if (options.encoding === "utf-8") {
				const response = await this.files.readFile(path);
				return { content: await response.text() };
			}
			const stat = await this.files.stat(path);
			const mime = await this.container.exec([
				"file",
				"-L",
				"--brief",
				"--mime-type",
				"--",
				path,
			]);
			const result = await mime.output();
			if (result.exitCode !== 0) throw new Error("Cannot identify file type");
			const response = await this.files.readFile(path);
			if (!response.body) throw new Error("File stream is missing");
			return {
				content: response.body,
				size: Number(stat.size),
				mimeType:
					new TextDecoder().decode(result.stdout).trim() ||
					"application/octet-stream",
			};
		});
	}

	async exists(path: string) {
		return this.#use(async () => {
			try {
				await this.files.stat(path);
				return { exists: true };
			} catch (error) {
				if (SandboxFileError.is(error) && error.code === "ENOENT")
					return { exists: false };
				throw error;
			}
		});
	}

	mkdir(path: string, options: { recursive: true }) {
		return this.#use(() => this.files.mkdir(path, options));
	}

	listFiles(path: string) {
		return this.#use(async () => {
			// Stat the directory in one native command, rather than one RPC per
			// entry. Skip hidden entries and symlinks as the existing file page does.
			const process = await this.container.exec([
				"python3",
				"-c",
				`
import datetime, json, os, stat, sys
files = []
with os.scandir(sys.argv[1]) as entries:
 for entry in entries:
  if entry.name.startswith('.'): continue
  info = entry.stat(follow_symlinks=False)
  kind = 'directory' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) else None
  if kind:
   files.append(dict(name=entry.name, absolutePath=entry.path, type=kind, size=info.st_size,
    modifiedAt=datetime.datetime.fromtimestamp(info.st_mtime, datetime.timezone.utc).isoformat()))
print(json.dumps(dict(files=files)))
`,
				path,
			]);
			const output = await process.output();
			if (output.exitCode !== 0)
				throw new Error(new TextDecoder().decode(output.stderr));
			return JSON.parse(new TextDecoder().decode(output.stdout)) as {
				files: {
					name: string;
					absolutePath: string;
					type: "file" | "directory";
					size: number;
					modifiedAt: string;
				}[];
			};
		});
	}

	writeFile(path: string, content: string | ReadableStream<Uint8Array>) {
		return this.#use(() => this.files.writeFile(path, content));
	}

	containerFetch(request: Request, port: number) {
		return this.#use(() => this.container.getTcpPort(port).fetch(request));
	}

	createSnapshot() {
		return this.#use(() => this.#snapshotFilesystem());
	}

	async #snapshotFilesystem(): Promise<Filesystem> {
		const epoch = this.#epoch;
		if (!this.#image) throw new Error("The running computer image is unknown");
		const snapshot = await this.container.snapshotContainer({});
		if (epoch !== this.#epoch || !this.container.running)
			throw new Error("The computer restarted while saving its filesystem");
		console.log("[Computer] Filesystem snapshot", {
			id: snapshot.id,
			size: snapshot.size,
		});
		return {
			snapshot,
			image: this.#image,
			expiresAt: Date.now() + filesystemTtlMs,
		};
	}

	restoreSnapshot(snapshot: { id: string }) {
		return this.#use(async () => {
			if (this.#restoredSnapshotId !== snapshot.id)
				throw new Error("The computer did not restore its current snapshot");
		});
	}

	async destroy() {
		++this.#epoch;
		await this.container.destroy();
		this.#setup = undefined;
		this.#restoredSnapshotId = undefined;
		this.#image = undefined;
		this.#attached = false;
		await this.host.stopped();
	}

	// A tmux session keeps the person's shell alive between viewing clients.
	// The WebSocket owns only its attached PTY client, which is aborted on close.
	async terminal(request: Request) {
		await this.host.activity();
		await this.ensureRunning();
		const url = new URL(request.url);
		const size = (key: string, fallback: number) => {
			const value = Number(url.searchParams.get(key));
			return Number.isInteger(value) && value > 0 && value <= 1000
				? value
				: fallback;
		};
		const abort = new AbortController();
		const process = await this.container.exec(
			[
				"tmux",
				"-L",
				"heveta",
				"new-session",
				"-A",
				"-s",
				"terminal",
				"-c",
				"/workspace",
				"bash",
			],
			{
				cwd: "/workspace",
				env: computerEnv,
				pty: { cols: size("cols", 80), rows: size("rows", 24) },
				signal: abort.signal,
			},
		);
		const [client, server] = Object.values(new WebSocketPair());
		server.binaryType = "arraybuffer";
		server.accept();
		const input = process.stdin!.getWriter();
		let ended = false;
		let exited = false;
		process.exitCode.then(
			() => {
				exited = true;
			},
			() => {
				exited = true;
			},
		);
		const close = (code: number, reason: string) => {
			if (ended) return;
			ended = true;
			if (!exited) abort.abort();
			closeSocket(server, code, reason);
			void this.host.activity();
		};
		server.addEventListener("close", () => close(1000, "Closed"));
		server.addEventListener("error", () => close(1011, "Terminal failed"));
		server.addEventListener("message", (event) => {
			if (typeof event.data === "string") {
				try {
					const { cols, rows } = JSON.parse(event.data);
					if (
						[cols, rows].every(
							(value) => Number.isInteger(value) && value > 0 && value <= 1000,
						)
					)
						process.resize(cols, rows);
				} catch {
					/* Ignore invalid resize messages. */
				}
			} else
				void input
					.write(new Uint8Array(event.data))
					.catch(() => close(1011, "Terminal input failed"));
		});
		void (async () => {
			try {
				server.send(JSON.stringify({ type: "ready" }));
				for await (const chunk of process.stdout!) server.send(chunk);
				close(1000, `Terminal closed with code ${await process.exitCode}`);
			} catch {
				close(1011, "Terminal output failed");
			}
		})();
		return new Response(null, { status: 101, webSocket: client });
	}
}
