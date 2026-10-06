import type { Database } from "@/db/client";
import { nativeRun } from "@/modules/devices/tools";
import { mailToolSet } from "@/modules/mail/tools";
import { memoryTools } from "@/modules/memories/tools";
import { runComputer, sandboxToolSet } from "@/modules/sandbox/tools";
import { scheduleTools } from "@/modules/schedules/tools";
import { conversationTools } from "@/modules/threads/tools";
import { webTools } from "@/modules/web/tools";
import { composeToolSets, localToolSet, type ToolSet } from "@/runtime/tools";

import type { ActiveTextSource } from "./delivery";

// The tools a run's model can call, bound to the run's user and conversation:
// web, memory, and conversation tools run in this Worker; shell and file tools
// run on the computer the run was given (docs/sandbox.md), the cloud computer
// or a registered native device; the mail tools (docs/email.md) run here and
// put attachments on that computer or send files from it.
export const runTools = (
	db: Database,
	run: {
		id: string;
		userId: string;
		threadId: string;
		deviceId?: string | null;
	},
	options: { readsImages: boolean; activeText?: ActiveTextSource },
): ToolSet => {
	const native = run.deviceId
		? nativeRun(db, { ...run, deviceId: run.deviceId })
		: undefined;
	const computer = native
		? undefined
		: runComputer(db, run.userId, {
				runId: run.id,
				threadId: run.threadId,
			});
	return composeToolSets([
		localToolSet([
			...webTools(),
			...memoryTools(db, run.userId),
			...scheduleTools(db, run.userId),
			...conversationTools(db, run.userId, run.threadId, options.activeText),
		]),
		native
			? {
					...native.toolSet,
					specs: native.toolSet.specs.filter(
						(spec) =>
							options.readsImages ||
							!["view_image", "screenshot", "computer"].includes(spec.name),
					),
				}
			: sandboxToolSet(db, run.userId, computer!, options),
		mailToolSet(db, run.userId, run.id, computer, native?.mailFiles),
	]);
};
