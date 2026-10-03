import type { RunRecord } from "@/db/schema/runs";

import { RunStatus, StopReason } from "./types";

// A run's end, from how its loop stopped.
export function runOutcome(
	reason: StopReason,
	error = "",
): Pick<RunRecord, "status" | "error"> {
	switch (reason) {
		case StopReason.MODEL_COMPLETE:
			return { status: RunStatus.COMPLETED, error: "" };
		case StopReason.CANCELLED:
			return { status: RunStatus.CANCELLED, error: "" };
		default:
			return { status: RunStatus.FAILED, error };
	}
}
