import { expect, test } from "vitest";

import { fileNameOnComputer } from "@/modules/files/workspace-paths";
import type { Message } from "@/modules/threads/types";
import { modelHistory } from "@/runtime/adapters/thread-history";

test("a native run projects attachments onto its selected workspace without changing cloud history", () => {
	const file = {
		id: "file-id",
		fileName: "报告.txt",
		size: 12n,
		mimeType: "text/plain",
		workspacePath: "/workspace/uploads/input/报告.txt",
	};
	const history: Message[] = [
		{
			id: "input",
			threadId: "thread",
			turnId: "turn",
			runId: null,
			role: "user",
			createdAt: new Date(),
			updatedAt: new Date(),
			parts: [{ id: "file", content: { case: "file", value: file } }],
		},
	];
	const native = modelHistory(
		history,
		[],
		undefined,
		(file) => `uploads/${file.id}/${fileNameOnComputer(file.fileName)}`,
	);
	expect(JSON.stringify(native)).toContain("uploads/file-id/报告.txt");
	expect(JSON.stringify(native)).not.toContain("/workspace");
	expect(JSON.stringify(modelHistory(history, []))).toContain(
		"/workspace/uploads/input/报告.txt",
	);
	expect(file.workspacePath).toBe("/workspace/uploads/input/报告.txt");
});
