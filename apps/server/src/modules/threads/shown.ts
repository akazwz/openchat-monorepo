import { eq, or, sql } from "drizzle-orm";

import { messages } from "@/db/schema/messages";
import { runs } from "@/db/schema/runs";

// What a conversation shows of each turn: its input, and the output of its
// latest attempt (earlier attempts' outputs stay stored, unshown).
export const shownMessage = or(
	eq(messages.role, "user"),
	sql`${messages.runId} = (select ${runs.id} from ${runs} where ${runs.turnId} = ${messages.turnId} order by ${runs.attempt} desc limit 1)`,
);
