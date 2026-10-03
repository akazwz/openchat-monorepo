import { ErrorReason } from "@/gen/heveta/v1/error_pb";
import { AppError, ErrorCode } from "@/lib/errors";

import type { ComputerHandle, SandboxMachine } from "./computer";
import { userMachine } from "./machine";
import { type ManageResult, type Snapshots, workspaceDir } from "./workspace";

// The user's computer as settings manage it: its Durable Object's stub
// (computer-object.ts); tests pass a fake.
export interface ManagedComputer extends ComputerHandle {
	exec: SandboxMachine["exec"];
	snapshots(): Promise<Snapshots>;
	restart(discardUnsaved: boolean): Promise<ManageResult>;
	restoreSnapshot(
		snapshotId: string,
		discardUnsaved: boolean,
	): Promise<ManageResult>;
	clearWorkspace(discardUnsaved: boolean): Promise<ManageResult>;
}

// Managing the user's computer from settings (docs/sandbox.md). Its Durable
// Object refuses to stop, restore, or clear it under a reply that is using
// it, which would pull its files away mid-work, and when the workspace's
// latest changes cannot be saved first, unless the person chose to discard
// them.
function managed(result: ManageResult) {
	if (result === "busy")
		throw new AppError(
			"A reply is using the computer; stop it or wait until it finishes",
			ErrorCode.FailedPrecondition,
			ErrorReason.COMPUTER_BUSY,
		);
	if (result === "unsaved")
		throw new AppError(
			"The workspace's latest changes could not be saved",
			ErrorCode.FailedPrecondition,
			ErrorReason.WORKSPACE_UNSAVED,
		);
	if (result === "not found")
		throw new AppError("Snapshot not found", ErrorCode.NotFound);
}

export async function workspaceUsage(
	userId: string,
	computer: ManagedComputer = userMachine(userId),
) {
	await computer.ready();
	const measured = await computer.exec(`du -sb ${workspaceDir}`);
	const bytes = Number(measured.stdout.split("\t")[0]);
	if (!measured.success || !Number.isFinite(bytes))
		throw new AppError(
			measured.stderr || "Could not measure the workspace",
			ErrorCode.Unavailable,
		);
	return bytes;
}

export async function restartComputer(
	userId: string,
	discardUnsaved: boolean,
	computer: ManagedComputer = userMachine(userId),
) {
	managed(await computer.restart(discardUnsaved));
}

export function listSnapshots(
	userId: string,
	computer: ManagedComputer = userMachine(userId),
) {
	return computer.snapshots();
}

export async function restoreSnapshot(
	userId: string,
	snapshotId: string,
	discardUnsaved: boolean,
	computer: ManagedComputer = userMachine(userId),
) {
	managed(await computer.restoreSnapshot(snapshotId, discardUnsaved));
}

export async function clearWorkspace(
	userId: string,
	discardUnsaved: boolean,
	computer: ManagedComputer = userMachine(userId),
) {
	managed(await computer.clearWorkspace(discardUnsaved));
}
