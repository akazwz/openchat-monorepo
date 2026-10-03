import { index, snakeCase, text } from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

import { createdAt, timestamptz, updatedAt } from "./columns";
import { users } from "./users";

// One row per signed-in session. Its token lives only in the browser's
// HttpOnly cookie; the database keeps its SHA-256 hash. A session in use is
// renewed as it goes (modules/auth/session.ts), so one used within its
// lifetime stays signed in.
export const sessions = snakeCase.table(
	"sessions",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => uuidv7()),
		userId: text()
			.notNull()
			.references(() => users.id),
		tokenHash: text().notNull().unique(),
		expiresAt: timestamptz().notNull(),
		// Retained until closing the session's event channels succeeds.
		revokedAt: timestamptz(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [
		index("sessions_user_id_idx").on(t.userId),
		index("sessions_expires_at_idx").on(t.expiresAt),
	],
);
