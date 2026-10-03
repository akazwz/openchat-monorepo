import { sql } from "drizzle-orm";

import type { Database } from "@/db/client";

// An ILIKE pattern for text containing `term` literally: its own `%`, `_`
// and `\` match themselves (backslash is Postgres' default LIKE escape).
export const containing = (term: string) =>
	`%${term.replace(/[\\%_]/g, "\\$&")}%`;

// Holds a lock on `name` until the transaction ends. Names start with what
// they guard ("workspace", a user id), so different locks never share one.
export async function advisoryLock(db: Database, ...name: string[]) {
	await db.execute(
		sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(name)}, 0))`,
	);
}
