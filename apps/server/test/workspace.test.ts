import { afterEach, expect, test, vi } from "vitest";

import { type Filesystem, filesystemTtlMs } from "@/modules/sandbox/filesystem";
import { Workspace, type WorkspaceMachine } from "@/modules/sandbox/workspace";

const marker = "/tmp/heveta-workspace-restored";
afterEach(() => vi.useRealTimers());

function fixture() {
	const values = new Map<string, unknown>();
	let running = false;
	let resumedId: string | undefined;
	const files = new Map<string, string>();
	const roots = new Map<string, Map<string, string>>();
	const faults = { restore: false, save: false };
	const storage = {
		get: async <T>(key: string) =>
			structuredClone(values.get(key)) as T | undefined,
		put: async <T>(key: string, value: T) => {
			values.set(key, structuredClone(value));
		},
		delete: async (key: string) => values.delete(key),
	};
	const machine: WorkspaceMachine = {
		exec: async (command, options) => {
			if (!running) {
				const current = await workspace.currentSnapshot();
				if (current && faults.restore) throw new Error("snapshot unavailable");
				files.clear();
				if (current) {
					for (const [path, content] of roots.get(
						current.filesystem.snapshot.id,
					) ?? [])
						if (path !== marker) files.set(path, content);
					await workspace.resumedSnapshot(
						current.id,
						Date.now() + filesystemTtlMs,
					);
				}
				resumedId = current?.id;
				running = true;
				workspace.started();
			}
			let success = true;
			if (command === `test -f ${marker}`) success = files.has(marker);
			if (command.startsWith('printf %s "$SNAPSHOT"'))
				files.set(marker, options?.env?.SNAPSHOT ?? "new");
			return {
				success,
				exitCode: success ? 0 : 1,
				stdout: "",
				stderr: "",
				command,
				duration: 0,
				timestamp: "",
			};
		},
		mkdir: async () => {},
		createSnapshot: async () => {
			if (faults.save) throw new Error("save unavailable");
			const id = crypto.randomUUID();
			roots.set(id, new Map(files));
			return fs(id);
		},
		restoreSnapshotFilesystem: async ({ id }) => {
			if (resumedId !== id) throw new Error("wrong snapshot restored");
		},
		destroy: async () => {
			running = false;
			files.clear();
			await workspace.stopped();
		},
	};
	const workspace = new Workspace(machine, storage, {
		running: () => running,
		stop: () => machine.destroy(),
		activeRuns: async () => [],
		changed: vi.fn(),
	});
	return { workspace, machine, files, roots, values, faults };
}

function fs(id: string, expiresAt = Date.now() + filesystemTtlMs): Filesystem {
	return { snapshot: { id, size: 100 }, image: "image", expiresAt };
}

test("restarting restores files, installed software and browser state from the whole filesystem", async () => {
	const { workspace, files } = fixture();
	const { generation } = await workspace.ready();
	files.set("/workspace/report.txt", "report");
	files.set("/usr/local/bin/my-tool", "installed");
	files.set("/root/.config/heveta-browser/profile", "browser");
	expect(await workspace.save(generation)).toBe("saved");
	expect(await workspace.restart(false)).toBe("done");
	expect(files.has("/workspace/report.txt")).toBe(false);
	await workspace.ready();
	expect(files.get("/workspace/report.txt")).toBe("report");
	expect(files.get("/usr/local/bin/my-tool")).toBe("installed");
	expect(files.get("/root/.config/heveta-browser/profile")).toBe("browser");
});

test("restoring before expiry renews the lifetime, while 30 inactive days starts an empty computer", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	const start = Date.now();
	const { workspace, machine, files } = fixture();
	const { generation } = await workspace.ready();
	files.set("/workspace/kept.txt", "kept");
	await workspace.save(generation);
	const id = (await workspace.snapshots()).currentId;
	await machine.destroy();
	const restoredAt = start + filesystemTtlMs - 1;
	vi.setSystemTime(restoredAt);
	await workspace.ready();
	expect(files.get("/workspace/kept.txt")).toBe("kept");
	expect((await workspace.snapshots()).snapshots[0]?.filesystem.expiresAt).toBe(
		restoredAt + filesystemTtlMs,
	);
	await machine.destroy();
	vi.setSystemTime(restoredAt + filesystemTtlMs);
	expect((await workspace.snapshots()).snapshots).toEqual([]);
	expect(await workspace.restore(id!, false)).toBe("not found");
	await workspace.ready();
	expect(files.has("/workspace/kept.txt")).toBe(false);
	expect((await workspace.snapshots()).currentId).toBeUndefined();
});

test("an expired selected state never silently falls back to another historical state", async () => {
	const { workspace, values, roots, files } = fixture();
	values.set("workspace-snapshots", [
		{ id: "newer", dir: "/workspace", createdAt: 2, filesystem: fs("newer") },
		{
			id: "chosen",
			dir: "/workspace",
			createdAt: 1,
			filesystem: fs("chosen", Date.now() - 1),
		},
	]);
	values.set("workspace-current", "chosen");
	roots.set("newer", new Map([["/workspace/unrelated", "newer"]]));
	await workspace.ready();
	expect(files.has("/workspace/unrelated")).toBe(false);
	expect((await workspace.snapshots()).currentId).toBeUndefined();
});

test("a valid snapshot failing to restore remains available and can be retried", async () => {
	const { workspace, machine, files, faults } = fixture();
	const { generation } = await workspace.ready();
	files.set("/workspace/kept", "kept");
	await workspace.save(generation);
	const before = await workspace.snapshots();
	await machine.destroy();
	faults.restore = true;
	await expect(workspace.ready()).rejects.toThrow("snapshot unavailable");
	expect((await workspace.snapshots()).currentId).toBe(before.currentId);
	faults.restore = false;
	await workspace.ready();
	expect(files.get("/workspace/kept")).toBe("kept");
});

test("a save failure preserves the last checkpoint and refuses to sleep until saved", async () => {
	const { workspace, files, faults } = fixture();
	const { generation } = await workspace.ready();
	files.set("/workspace/kept", "saved");
	await workspace.save(generation);
	const before = (await workspace.snapshots()).currentId;
	files.set("/workspace/kept", "unsaved");
	faults.save = true;
	await expect(workspace.save(generation)).rejects.toThrow("save unavailable");
	expect(await workspace.sleep()).toBe("stays on");
	expect(files.get("/workspace/kept")).toBe("unsaved");
	expect((await workspace.snapshots()).currentId).toBe(before);
	expect((await workspace.snapshots()).unsavedSince).toBeTypeOf("number");
	faults.save = false;
	await workspace.save(generation);
	expect((await workspace.snapshots()).unsavedSince).toBeUndefined();
});

test("legacy snapshots block use until migrated, preserving IDs and rejecting incomplete current metadata", async () => {
	const { workspace, values, roots, files } = fixture();
	const legacy = [
		{ id: "current", dir: "/workspace", createdAt: 2, pinned: true },
		{ id: "r2-only", dir: "/workspace", createdAt: 1 },
	];
	values.set("workspace-snapshots", legacy);
	values.set("workspace-current", "current");
	await expect(workspace.ready()).rejects.toThrow("must be migrated");
	expect(files.size).toBe(0);
	expect((await workspace.migrateSnapshots()).ids).toEqual([
		"current",
		"r2-only",
	]);
	await expect(
		workspace.migrateSnapshots({ current: null, "r2-only": null }),
	).rejects.toThrow("Missing native filesystem");
	expect(values.get("workspace-snapshots")).toEqual(legacy);
	roots.set("root", new Map([["/workspace/kept", "migrated"]]));
	await workspace.migrateSnapshots({ current: fs("root"), "r2-only": null });
	expect((await workspace.migrateSnapshots()).ids).toEqual([]);
	await workspace.migrateSnapshots({});
	expect((await workspace.snapshots()).snapshots).toMatchObject([
		{ id: "current", createdAt: 2, pinned: true },
	]);
	await workspace.ready();
	expect(files.get("/workspace/kept")).toBe("migrated");
});
