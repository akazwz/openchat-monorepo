import { errorDetails } from "@/lib/error-details";

import type { ExecOptions, ExecResult } from "./computer";
import type { Filesystem } from "./filesystem";

export const workspaceDir = "/workspace";
// NativeMachine clears this /tmp marker on every fresh boot, including a
// filesystem restore. Their presence describes this live container only.
const restoredMarker = "/tmp/heveta-workspace-restored";
const markRestored = `printf %s "$SNAPSHOT" >${restoredMarker}`;
// Snapshots kept to roll back to: the current one, the newest two (the state
// before the last change), those a restore or a clear promised to keep, then
// the newest of each earlier hour, ten in all, so a burst of calls does not
// push out the hours before it. All expire after 30 days without a restore;
// dropping a handle does not delete the platform snapshot before its TTL.
const keptSnapshots = 10;
const hourMs = 60 * 60 * 1000;
const snapshotsKey = "workspace-snapshots";
// The snapshot the workspace is now, which a new container restores: the
// newest one, or the one a restore chose until the next save.
const currentKey = "workspace-current";
// When changes that could not be saved were first made (see Workspace.save).
const unsavedKey = "workspace-unsaved-since";
const leasesKey = "workspace-leases";

export interface Snapshot {
	id: string;
	dir: string;
	createdAt: number;
	filesystem: Filesystem;
	// The state before a restore or a clear, which the user was told stays
	// restorable.
	pinned?: boolean;
}

// What the workspace needs of the computer it is on: the Computer Durable
// Object itself (tests pass a fake).
export interface WorkspaceMachine {
	exec(command: string, options?: ExecOptions): Promise<ExecResult>;
	mkdir(path: string, options: { recursive: true }): Promise<unknown>;
	createSnapshot(): Promise<Filesystem>;
	restoreSnapshotFilesystem(snapshot: { id: string }): Promise<unknown>;
	destroy(): Promise<void>;
}
// The Durable Object's own storage.
export interface WorkspaceStorage {
	get<T>(key: string): Promise<T | undefined>;
	put<T>(key: string, value: T): Promise<void>;
	delete(key: string): Promise<boolean>;
}
// The rest the workspace needs of the Durable Object it lives in.
export interface WorkspaceHost {
	// Whether the container is running: a stopped one's disk is gone, and
	// asking it anything would start a new one.
	running(): boolean;
	// Stops the container, as sleeping does.
	stop(): Promise<void | false>;
	// Of these runs, those still active (queued or running).
	activeRuns(runIds: string[]): Promise<string[]>;
	// The workspace or its snapshots changed: a snapshot was saved, or one was
	// restored. The user's devices read them again.
	changed(): void;
}

export class WorkspaceLostError extends Error {
	constructor() {
		super(
			"The computer restarted during this call, so its changes were lost; the workspace is back to its last saved state.",
		);
	}
}

// The outcome of an operation from settings: "unsaved" when the workspace's
// latest changes could not be saved first, and the request did not say to
// discard them.
export type ManageResult = "done" | "busy" | "not found" | "unsaved";

export interface Snapshots {
	// Newest first.
	snapshots: Snapshot[];
	currentId?: string;
	// Since when changes have gone unsaved; undefined when none have.
	unsavedSince?: number;
}

// What an operation spent its time on and found, logged with it (see
// #serial): milliseconds of each phase (`startMs`: a container started for
// it; `restoreMs`, `snapshotMs`), and facts such as the snapshot taken.
type Phases = Record<string, number | string | boolean>;

// Times one phase of an operation into `phases`, whether it succeeds or not.
async function timed<T>(
	phases: Phases,
	name: string,
	work: () => Promise<T>,
): Promise<T> {
	const started = Date.now();
	try {
		return await work();
	} finally {
		phases[name] = Date.now() - started;
	}
}

// A user's computer, retained for 30 days without use (docs/sandbox.md). Its disk is
// wiped whenever the container stops, so it is restored from its newest
// snapshot before use and snapshotted after every call that may change it.
// It lives in the computer's Durable Object, the one place that knows the
// computer's order of events: every operation that restores, snapshots, or
// replaces the workspace runs one at a time, and the snapshots are this
// object's own. Native snapshots save the whole root filesystem; their
// handles and expiry times live in this object's storage, with no R2 archive.
export class Workspace {
	#queue: Promise<unknown> = Promise.resolve();
	// Operations waiting their turn: an operation queued while the computer
	// prepares to sleep means it is in use again (see sleep).
	#waiting = 0;
	// The container's generation: it changes when the container stops
	// (NativeMachine monitor/destroy), and when ready() finds a container without the
	// restored mark, a new one, whether or not its predecessor's stop was
	// reported (the SDK reports a stop only when it learns of it, which a
	// container that vanished may never give it). Work prepared by ready()
	// in one generation and saved in another was done on a container that is
	// gone, and a snapshot taken across a restart holds a new container's
	// empty disk, not the workspace.
	#generation = 0;
	// The generation whose container is known to be restored, so ready()
	// need not ask it again (one call to the container fewer for every call
	// of the agent). Kept in memory only, and forgotten whenever NativeMachine
	// starts or attaches to a container: after that, or after this object
	// restarts, the container is asked (its mark, which it keeps while it
	// runs). The SDK also runs onStart when it only attaches to a container
	// already running, which costs one question, not a restore.
	#restoredIn: number | undefined;

	constructor(
		private machine: WorkspaceMachine,
		private storage: WorkspaceStorage,
		private host: WorkspaceHost,
	) {}

	// Runs an operation after those before it, and logs it (docs/sandbox.md):
	// which, how it ended ("ok", its answer, or "error"), how long it took in
	// all and waiting its turn, and its phases.
	#serial<T>(method: string, work: (phases: Phases) => Promise<T>): Promise<T> {
		this.#waiting++;
		const queued = Date.now();
		const run = async () => {
			this.#waiting--;
			const started = Date.now();
			const phases: Phases = {};
			let outcome = "error";
			try {
				const result = await work(phases);
				outcome = typeof result === "string" ? result : "ok";
				return result;
			} finally {
				console.log("[Computer] Call", {
					method,
					outcome,
					totalMs: Date.now() - queued,
					queueMs: started - queued,
					...phases,
				});
			}
		};
		const next = this.#queue.then(run, run);
		this.#queue = next.catch(() => {});
		return next;
	}

	// Before any use; `runId` names a run that uses the computer until it
	// releases it. The container's generation, for save(), and whether it had
	// to be restored now (and so has just started).
	ready(runId?: string) {
		return this.#serial("ready", async (phases) => {
			if (runId) await this.#lease(runId, true);
			const restored = await this.#ready(phases);
			return { generation: this.#generation, restored };
		});
	}

	// After a call that may have changed files, with the generation its
	// ready() gave. "lost" when the container restarted since: the call's
	// changes went with it, and its empty workspace is never saved over the
	// user's. A save that fails throws, and the changes wait, unsaved, for
	// the next one: the computer does not sleep until they are saved, and
	// settings show since when they have waited.
	save(generation: number): Promise<"saved" | "lost"> {
		return this.#serial("save", async (phases) =>
			generation === this.#generation ? this.#save(phases) : "lost",
		);
	}

	release(runId: string) {
		return this.#serial("release", () => this.#lease(runId, false));
	}

	// When the computer has been idle long enough to sleep: saved once more,
	// for what changed without a call or a connection that ended (a program
	// the agent left running), then stopped. It stays on when that save
	// fails, which would lose the changes, or when anything asked for it
	// meanwhile. The save is not announced: devices showing its files would
	// read them again at once and wake it; they read them when next opened.
	sleep() {
		return this.#serial("sleep", async (phases) => {
			if (await this.#busy()) return "in use";
			try {
				await this.#save(phases, false);
			} catch (error) {
				console.warn("[Sandbox] Workspace not saved; staying on", {
					...errorDetails(error),
				});
				return "stays on";
			}
			if (this.#waiting > 0) return "in use";
			const stopped = await timed(phases, "stopMs", () => this.host.stop());
			return stopped === false ? "in use" : "stopped";
		});
	}

	async snapshots(): Promise<Snapshots> {
		const current = await this.#current();
		return {
			snapshots: byTime(await this.#snapshots()),
			currentId: current?.id,
			unsavedSince: await this.storage.get<number>(unsavedKey),
		};
	}

	// The container stops; the next use restores the current snapshot, with
	// the latest changes saved into it first.
	restart(discardUnsaved: boolean) {
		return this.#serial("restart", async (phases): Promise<ManageResult> => {
			if (await this.#busy()) return "busy";
			if (!(await this.#checkpoint(phases, discardUnsaved))) return "unsaved";
			await this.#stop(phases);
			return "done";
		});
	}

	// The chosen snapshot becomes the current one and the computer restarts:
	// a fresh container restores the current snapshot whole. Restoring into
	// the running one would mount it under the programs using the workspace
	// (a browser's server, a terminal), which keep the old files, and a local
	// restore merges into what is there. The state it replaces is saved first
	// and kept, to come back to.
	restore(snapshotId: string, discardUnsaved: boolean) {
		return this.#serial("restore", async (phases): Promise<ManageResult> => {
			if (await this.#busy()) return "busy";
			const snapshots = await this.#snapshots();
			if (!snapshots.some((snapshot) => snapshot.id === snapshotId))
				return "not found";
			// The save before keeps the chosen snapshot, whatever its age.
			if (!(await this.#checkpoint(phases, discardUnsaved, snapshotId)))
				return "unsaved";
			await this.#pinCurrent();
			await this.storage.put(currentKey, snapshotId);
			await this.#stop(phases);
			this.host.changed();
			return "done";
		});
	}

	// Empties the workspace. The state before is saved first and kept, to
	// come back to.
	clear(discardUnsaved: boolean) {
		return this.#serial("clear", async (phases): Promise<ManageResult> => {
			if (await this.#busy()) return "busy";
			if (!(await this.#checkpoint(phases, discardUnsaved))) return "unsaved";
			await this.#pinCurrent();
			await this.#ready(phases);
			const cleared = await this.machine.exec(
				`find ${workspaceDir} -mindepth 1 -delete`,
			);
			if (!cleared.success)
				throw new Error(cleared.stderr || "Could not clear the workspace");
			if ((await this.#save(phases)) === "lost") throw new WorkspaceLostError();
			return "done";
		});
	}

	// NativeMachine started a container, or attached to one: whether it is
	// restored is asked again.
	started() {
		this.#restoredIn = undefined;
	}

	// The container stopped: whatever it held unsaved is gone with it.
	async stopped() {
		this.#generation++;
		await this.storage.delete(unsavedKey);
	}

	async #stop(phases: Phases) {
		await timed(phases, "stopMs", () => this.machine.destroy());
		await this.storage.delete(unsavedKey);
	}

	// Saves the latest changes before an operation that would replace them.
	// False when that failed and they are not to be discarded; a container
	// that is stopped or was never restored holds nothing to save.
	async #checkpoint(phases: Phases, discardUnsaved: boolean, keep?: string) {
		try {
			await this.#save(phases, true, keep);
			return true;
		} catch (error) {
			console.warn("[Sandbox] Workspace not saved before replacing it", {
				discardUnsaved,
				...errorDetails(error),
			});
			return discardUnsaved;
		}
	}

	// The current snapshot, which the user was told stays restorable.
	async #pinCurrent() {
		const current = await this.#current();
		if (!current || current.pinned) return;
		await this.storage.put(
			snapshotsKey,
			(await this.#snapshots()).map((snapshot) =>
				snapshot.id === current.id ? { ...snapshot, pinned: true } : snapshot,
			),
		);
	}

	async #snapshots(includeExpired = false) {
		const snapshots = await this.#storedSnapshots();
		if (snapshots.some((snapshot) => !snapshot.filesystem))
			throw new Error("Computer snapshots must be migrated before use");
		return (snapshots as Snapshot[]).filter(
			(snapshot) =>
				includeExpired || snapshot.filesystem.expiresAt > Date.now(),
		);
	}

	#storedSnapshots() {
		return this.storage
			.get<(Omit<Snapshot, "filesystem"> & { filesystem?: Filesystem })[]>(
				snapshotsKey,
			)
			.then((snapshots) => snapshots ?? []);
	}

	async #current(includeExpired = false) {
		const snapshots = await this.#snapshots(includeExpired);
		const id = await this.storage.get<string>(currentKey);
		// Without one recorded, the first: the newest, or (as stored before
		// the current one was recorded) the one a restore moved first.
		// An explicitly selected snapshot expiring starts an empty computer;
		// never silently replace it with an unrelated historical state.
		return id === undefined
			? snapshots[0]
			: snapshots.find((snapshot) => snapshot.id === id);
	}

	// NativeMachine reads this before booting, so it can resume the matching
	// root filesystem before Workspace asks the container about its markers.
	currentSnapshot() {
		// A live container still holds its data even if an older snapshot
		// expired. Keep its source image available when attaching after a DO
		// restart; the next save captures that live filesystem afresh.
		return this.#current(this.host.running());
	}

	// Called inside ready(), so it must not re-enter the operation queue.
	async resumedSnapshot(id: string, expiresAt: number) {
		const snapshots = await this.#storedSnapshots();
		if (!snapshots.some((snapshot) => snapshot.id === id))
			throw new Error("The resumed snapshot is no longer retained");
		await this.storage.put(
			snapshotsKey,
			snapshots.map((snapshot) =>
				snapshot.id === id
					? { ...snapshot, filesystem: { ...snapshot.filesystem, expiresAt } }
					: snapshot,
			),
		);
	}

	// One-time internal RPC for the authenticated migration Worker. Missing
	// current filesystem metadata blocks use instead of discarding old files.
	// null drops a historical R2-only backup, which cannot be restored natively.
	migrateSnapshots(records?: Record<string, Filesystem | null>) {
		return this.#serial("migrateSnapshots", async () => {
			const snapshots = await this.#storedSnapshots();
			const missing = snapshots.filter((snapshot) => !snapshot.filesystem);
			const currentId =
				(await this.storage.get<string>(currentKey)) ?? snapshots[0]?.id;
			if (!records)
				return { ids: missing.map((snapshot) => snapshot.id), currentId };
			for (const snapshot of missing) {
				const filesystem = records[snapshot.id];
				if (
					filesystem === undefined ||
					(!filesystem && snapshot.id === currentId)
				)
					throw new Error(
						`Missing native filesystem for snapshot ${snapshot.id}`,
					);
				if (
					filesystem &&
					(!filesystem.snapshot?.id ||
						!filesystem.image ||
						!Number.isFinite(filesystem.expiresAt))
				)
					throw new Error("Invalid filesystem snapshot metadata");
			}
			await this.storage.put(
				snapshotsKey,
				snapshots.flatMap((snapshot) => {
					const filesystem = snapshot.filesystem ?? records[snapshot.id];
					return filesystem ? [{ ...snapshot, filesystem }] : [];
				}),
			);
			return { ids: [], currentId };
		});
	}

	// Restores the workspace unless this container's already is; true when it
	// did. A container that is running and has not started again since it was
	// restored is not asked.
	async #ready(phases: Phases) {
		if (this.host.running() && this.#restoredIn === this.#generation)
			return false;
		// Asking it starts a container that is not running.
		const restored = await timed(
			phases,
			this.host.running() ? "checkMs" : "startMs",
			() => this.#restored(),
		);
		if (restored) {
			this.#restoredIn = this.#generation;
			return false;
		}
		// No mark: a new container. Work prepared on an earlier one went with it.
		const generation = ++this.#generation;
		const current = await this.#current();
		await timed(phases, "restoreMs", async () => {
			if (current)
				await this.machine.restoreSnapshotFilesystem({
					id: current.id,
				});
			else await this.machine.mkdir(workspaceDir, { recursive: true });
			// Just restored, the workspace is its current snapshot.
			await this.#exec(markRestored, { SNAPSHOT: current?.id ?? "new" });
		});
		if (this.#generation !== generation) {
			// The container restarted meanwhile: the mark may be on a new one
			// that was not restored. The next use asks again.
			await this.machine.exec(`rm -f ${restoredMarker}`).catch(() => {});
			throw new Error(
				"The computer restarted while its workspace was restored",
			);
		}
		this.#restoredIn = generation;
		phases.restoredSnapshot = current?.id ?? "new";
		return true;
	}

	// `keep` is a snapshot kept whatever its age (see restore).
	async #save(
		phases: Phases,
		announce = true,
		keep?: string,
	): Promise<"saved" | "lost"> {
		const generation = this.#generation;
		if (!this.host.running()) return "lost";
		try {
			if (!(await timed(phases, "checkMs", () => this.#restored())))
				return "lost";
			// Always capture the root, including installs and browser state
			// outside /workspace; scanning just that directory cannot detect them.
			if (!(await this.#snapshot(phases, generation, announce, keep)))
				return "lost";
		} catch (error) {
			if ((await this.storage.get(unsavedKey)) === undefined)
				await this.storage.put(unsavedKey, Date.now());
			throw error;
		}
		if ((await this.storage.get(unsavedKey)) !== undefined) {
			await this.storage.delete(unsavedKey);
			if (announce) this.host.changed();
		}
		return "saved";
	}

	// A new snapshot of the workspace, which becomes the current one; false
	// when the container restarted while it was taken.
	async #snapshot(
		phases: Phases,
		generation: number,
		announce: boolean,
		keep?: string,
	) {
		const filesystem = await timed(phases, "snapshotMs", () =>
			this.machine.createSnapshot(),
		);
		const id = filesystem.snapshot.id;
		phases.snapshotId = id;
		if (this.#generation !== generation) return false;
		const snapshots = [
			{ id, dir: workspaceDir, createdAt: Date.now(), filesystem },
			...(await this.#snapshots()),
		];
		const kept = retained(snapshots, [id, ...(keep ? [keep] : [])]);
		await this.storage.put(snapshotsKey, kept);
		await this.storage.put(currentKey, id);
		if (announce) this.host.changed();
		return true;
	}

	// Runs a command of the workspace's own in the container; its output.
	async #exec(command: string, env?: Record<string, string>) {
		const result = await this.machine.exec(command, env && { env });
		if (!result.success)
			throw new Error(result.stderr || `Could not run: ${command}`);
		return result.stdout.trim();
	}

	async #restored() {
		const check = await this.machine.exec(`test -f ${restoredMarker}`);
		return check.exitCode === 0;
	}

	async #lease(runId: string, held: boolean) {
		const leases = new Set((await this.storage.get<string[]>(leasesKey)) ?? []);
		if (held === leases.has(runId)) return;
		if (held) leases.add(runId);
		else leases.delete(runId);
		await this.storage.put(leasesKey, [...leases]);
	}

	// Stopping, restoring, or clearing the computer under a reply that uses it
	// would pull its files away mid-work, so those wait until none does. A run
	// holds its lease from its first call on the computer until it ends; one
	// that ended without releasing it (its execution lost) holds nothing.
	async #busy() {
		const leases = (await this.storage.get<string[]>(leasesKey)) ?? [];
		if (!leases.length) return false;
		const active = await this.host.activeRuns(leases);
		await this.storage.put(leasesKey, active);
		return active.length > 0;
	}
}

// Newest first, by when each was taken: a restore changes which one is
// current, never the order.
const byTime = (snapshots: Snapshot[]) =>
	snapshots.toSorted((left, right) => right.createdAt - left.createdAt);

// Of the snapshots, those kept (see keptSnapshots), newest first; `always`
// are kept whatever their age: the current one, and one being restored.
function retained(snapshots: Snapshot[], always: string[]) {
	const kept: Snapshot[] = [];
	const hours = new Set<number>();
	for (const [index, snapshot] of byTime(snapshots).entries()) {
		if (kept.length === keptSnapshots) break;
		const hour = Math.floor(snapshot.createdAt / hourMs);
		if (
			index < 2 ||
			always.includes(snapshot.id) ||
			snapshot.pinned ||
			!hours.has(hour)
		) {
			hours.add(hour);
			kept.push(snapshot);
		}
	}
	return kept;
}
