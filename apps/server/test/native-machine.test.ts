import { expect, test, vi } from "vitest";

import { type Filesystem, filesystemTtlMs } from "@/modules/sandbox/filesystem";
import { NativeMachine } from "@/modules/sandbox/native-machine";

vi.mock("@cloudflare/sandbox", () => ({
	Files: class {
		stat = vi.fn(async () => ({ type: "directory" }));
	},
	SandboxFileError: { is: () => false },
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function fixture() {
	let running = false;
	let image = "";
	let current: { id: string; filesystem: Filesystem } | undefined;
	const monitors: ReturnType<typeof deferred<void>>[] = [];
	const container = {
		get running() {
			return running;
		},
		images: { computer: "test-image" },
		start: vi.fn((options: ContainerStartupOptions) => {
			running = true;
			image = options.image ?? "";
		}),
		destroy: vi.fn(async () => {
			running = false;
		}),
		snapshotContainer: vi.fn(async () => ({
			id: crypto.randomUUID(),
			size: 200,
		})),
		setInactivityTimeout: vi.fn(async () => {}),
		inspect: vi.fn(async () => ({
			image,
			labels: { "heveta-runtime": "native-v1" },
		})),
		monitor: vi.fn(() => {
			const monitor = deferred<void>();
			monitors.push(monitor);
			return monitor.promise;
		}),
		exec: vi.fn(async (_argv: string[], _options?: ContainerExecOptions) => ({
			output: async () => ({
				exitCode: 0,
				stdout: new TextEncoder().encode("ok").buffer,
				stderr: new ArrayBuffer(0),
			}),
		})),
	};
	const host = {
		activity: vi.fn(async () => {}),
		started: vi.fn(),
		stopped: vi.fn(async () => {}),
		currentSnapshot: vi.fn(async () => current),
		resumedSnapshot: vi.fn(async (_id: string, expiresAt: number) => {
			if (current) current.filesystem.expiresAt = expiresAt;
		}),
	};
	const machine = new NativeMachine(container as unknown as Container, host);
	return {
		machine,
		container,
		host,
		monitors,
		setCurrent: (filesystem: Filesystem) => {
			current = { id: "current", filesystem };
		},
		stop: () => {
			running = false;
		},
	};
}

test("concurrent cold calls wait for the same setup and receive isolated command environments", async () => {
	const { machine, container } = fixture();
	const setup = deferred<void>();
	container.setInactivityTimeout.mockReturnValueOnce(setup.promise);
	const first = machine.exec("echo one", { env: { CALL_COMMAND: "one" } });
	const second = machine.exec("echo two");
	await vi.waitFor(() => expect(container.start).toHaveBeenCalledTimes(1));
	expect(container.exec).not.toHaveBeenCalled();
	setup.resolve();
	await Promise.all([first, second]);
	const commands = container.exec.mock.calls.filter(
		([argv]) => argv[0] === "bash",
	);
	expect(commands[0]?.[1]?.env).toMatchObject({
		CALL_COMMAND: "one",
		PYTHONUSERBASE: "/workspace/.local",
	});
	expect(commands[1]?.[1]?.env).not.toHaveProperty("CALL_COMMAND");
	expect(machine.pending).toBe(0);
});

test("an execution failure does not replay a command that may have changed files", async () => {
	const { machine, container } = fixture();
	await machine.ensureRunning();
	container.exec.mockClear();
	container.exec.mockRejectedValueOnce(new Error("transport lost"));
	await expect(machine.exec("change-files")).rejects.toThrow("transport lost");
	expect(container.exec).toHaveBeenCalledTimes(1);
	expect(machine.pending).toBe(0);
});

test("a late stop from the previous instance cannot invalidate its replacement", async () => {
	const { machine, host, monitors, stop } = fixture();
	await machine.ensureRunning();
	stop();
	await machine.ensureRunning();
	monitors[0]!.resolve();
	await Promise.resolve();
	expect(host.stopped).not.toHaveBeenCalled();
	monitors[1]!.resolve();
	await vi.waitFor(() => expect(host.stopped).toHaveBeenCalledTimes(1));
});

test("recovering a process on a stopped computer does not start a new instance", async () => {
	const { machine, container } = fixture();
	expect(await machine.getProcess("old-command")).toBeNull();
	await expect(machine.waitForExit("old-command")).rejects.toThrow(
		"The computer stopped",
	);
	expect(container.start).not.toHaveBeenCalled();
});

function filesystem(image = "test-image"): Filesystem {
	return {
		snapshot: { id: "root-checkpoint", size: 200 },
		image,
		expiresAt: Date.now() + 86_400_000,
	};
}

test("a cold boot restores the filesystem and records a renewed 30-day lifetime without R2", async () => {
	const { machine, container, host, setCurrent } = fixture();
	setCurrent(filesystem());
	await machine.restoreSnapshot({ id: "current" });
	expect(container.start).toHaveBeenCalledWith(
		expect.objectContaining({
			containerSnapshot: { id: "root-checkpoint", size: 200 },
		}),
	);
	expect(host.resumedSnapshot).toHaveBeenCalledWith(
		"current",
		expect.any(Number),
	);
	expect(host.resumedSnapshot.mock.calls[0]![1]).toBeGreaterThan(
		Date.now() + 29 * 86_400_000,
	);
	const cleanup = container.exec.mock.calls[0]![0].join(" ");
	expect(cleanup).toContain("rm -f /tmp/heveta-workspace-restored");
	expect(cleanup).toContain("/tmp/.X99-lock");
	expect(cleanup).toContain("/root/.config/heveta-browser/SingletonLock");
});

test("a deployed image change preserves the snapshot's own image and installed environment", async () => {
	const { machine, container, setCurrent } = fixture();
	setCurrent(filesystem("previous-image"));
	await machine.restoreSnapshot({ id: "current" });
	expect(container.start).toHaveBeenCalledWith(
		expect.objectContaining({
			containerSnapshot: { id: "root-checkpoint", size: 200 },
		}),
	);
	expect((await machine.createSnapshot()).image).toBe("previous-image");
});

test.each(["boot", "metadata"])(
	"a %s failure preserves the snapshot and never starts a user command on an empty computer",
	async (phase) => {
		const { machine, container, host, setCurrent } = fixture();
		setCurrent(filesystem());
		if (phase === "boot")
			container.exec.mockRejectedValueOnce(new Error("unavailable"));
		else host.resumedSnapshot.mockRejectedValueOnce(new Error("unavailable"));
		await expect(machine.exec("user-command")).rejects.toThrow("unavailable");
		expect(container.start).toHaveBeenCalledTimes(1);
		expect(container.destroy).toHaveBeenCalledOnce();
		expect(
			container.exec.mock.calls.some(
				([argv]) => argv.at(-1) === "user-command",
			),
		).toBe(false);
		await machine.exec("user-command");
		expect(container.start).toHaveBeenCalledTimes(2);
		expect(
			container.exec.mock.calls.filter(
				([argv]) => argv.at(-1) === "user-command",
			),
		).toHaveLength(1);
	},
);

test("each save returns a new immutable full filesystem snapshot", async () => {
	const { machine, container } = fixture();
	const first = await machine.createSnapshot();
	const second = await machine.createSnapshot();
	expect(second.snapshot.id).not.toBe(first.snapshot.id);
	expect(container.snapshotContainer).toHaveBeenCalledTimes(2);
	expect(first.expiresAt).toBeGreaterThan(Date.now() + filesystemTtlMs - 1000);
});

test("a failed filesystem capture publishes no replacement snapshot", async () => {
	const { machine, container, setCurrent } = fixture();
	setCurrent(filesystem());
	container.snapshotContainer.mockRejectedValueOnce(
		new Error("snapshot failed"),
	);
	await expect(machine.createSnapshot()).rejects.toThrow("snapshot failed");
	expect(container.snapshotContainer).toHaveBeenCalledOnce();
});
