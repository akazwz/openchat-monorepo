import { expect, test } from "vitest";

import { ErrorCode } from "@/lib/errors";
import { workspacePath } from "@/modules/sandbox/workspace-files";

test("paths people open resolve inside the workspace", () => {
	expect(workspacePath("")).toBe("/workspace");
	expect(workspacePath("notes/plan.md")).toBe("/workspace/notes/plan.md");
	expect(workspacePath("/workspace/a/../b.txt")).toBe("/workspace/b.txt");
});

test("no path leaves the workspace", () => {
	for (const path of [
		"../etc/passwd",
		"/etc/passwd",
		"/workspace/../root",
		"/workspace-other/file",
		"notes/../../x",
	])
		expect(() => workspacePath(path)).toThrow(
			expect.objectContaining({ code: ErrorCode.InvalidArgument }),
		);
});
