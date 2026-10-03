import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";

import {
	MessageRole,
	MessageSchema,
	ThreadSchema,
} from "@/gen/heveta/v1/thread_pb";
import type { Run } from "@/modules/runs/types";

import { type PartOptions, partToProto } from "./part-codec";
import type { Message, Thread } from "./types";

export const threadResource = (thread: Thread) =>
	create(ThreadSchema, {
		id: thread.id,
		title: thread.title,
		revision: thread.revision,
		activeTime: timestampFromDate(thread.activeAt),
		running: thread.running,
	});
// The run that produced an assistant output, as the output carries it.
export type OutputRun = Pick<Run, "status" | "attempt" | "cancelRequested"> & {
	revision: number;
};
export function messageToProto(
	message: Message,
	run?: OutputRun,
	options?: PartOptions,
) {
	return create(MessageSchema, {
		id: message.id,
		threadId: message.threadId,
		turnId: message.turnId,
		runId: message.runId ?? "",
		role: message.role === "user" ? MessageRole.USER : MessageRole.ASSISTANT,
		parts: message.parts.map((part) => partToProto(part, options)),
		createTime: timestampFromDate(message.createdAt),
		updateTime: timestampFromDate(message.updatedAt),
		...(run
			? {
					runStatus: run.status,
					runAttempt: run.attempt,
					runCancelRequested: run.cancelRequested,
					runRevision: run.revision,
				}
			: {}),
	});
}
