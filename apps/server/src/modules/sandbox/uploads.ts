import { posix } from "node:path/posix";

import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import type { Database } from "@/db/client";
import { files } from "@/db/schema/files";
import { messageFiles } from "@/db/schema/message-files";
import { messages } from "@/db/schema/messages";
import { openFile } from "@/modules/files/service";

import {
	type ComputerHandle,
	type SandboxMachine,
	saveWorkspace,
	workspaceDir,
} from "./computer";

// Where the user's attachments go on their computer (docs/sandbox.md): each
// message's in a folder of its own, uploads/<message id>/.
export const uploadsDir = `${workspaceDir}/uploads`;

// Puts a conversation's attachments on the user's computer at the paths
// chosen when they were sent, streamed from storage, then saves the
// workspace. All that are not there yet, not only the latest message's: one
// whose placing failed, or whose run never reached the computer, goes on
// before the next call that could look for it. Each is put there once: one
// already placed (by an earlier attempt of the turn, or by this run before it
// was resumed) is left as the agent may have changed it. That is recorded
// only once the workspace holding them is saved: an attachment written to a
// computer that restarts before the save is put there again.
// The computer is reached (`connect`) only when there is something to put
// on it.
export async function placeUploads(
	db: Database,
	userId: string,
	connect: () => { computer: ComputerHandle; machine: SandboxMachine },
	threadId: string,
) {
	const pending = await db
		.selectDistinct({ id: files.id, workspacePath: files.workspacePath })
		.from(files)
		.innerJoin(messageFiles, eq(messageFiles.fileId, files.id))
		.innerJoin(messages, eq(messages.id, messageFiles.messageId))
		.where(
			and(
				eq(files.userId, userId),
				eq(files.status, "stored"),
				eq(messages.threadId, threadId),
				eq(messages.userId, userId),
				isNotNull(files.workspacePath),
				isNull(files.placedAt),
			),
		);
	if (!pending.length) return;
	const { computer, machine } = connect();
	const generation = await computer.ready();
	for (const file of pending) {
		const path = file.workspacePath as string;
		await machine.mkdir(posix.dirname(path), { recursive: true });
		await machine.writeFile(path, await openFile(db, userId, file.id));
	}
	await saveWorkspace(computer, generation);
	await db
		.update(files)
		.set({ placedAt: new Date() })
		.where(
			inArray(
				files.id,
				pending.map((file) => file.id),
			),
		);
}
