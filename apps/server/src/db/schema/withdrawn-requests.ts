import { index, primaryKey, snakeCase, text } from "drizzle-orm/pg-core";

import { createdAt } from "./columns";
import { users } from "./users";

// Sends stopped before the server took them (runs/commands.ts). A client
// sends a request again while its outcome is unknown, and a copy may still be
// on its way after the stop; recording the withdrawal under the request's own
// lock means no copy is ever taken. Kept a day, far longer than any copy can
// take to arrive (index.ts cleans them up).
export const withdrawnRequests = snakeCase.table(
	"withdrawn_requests",
	{
		userId: text()
			.notNull()
			.references(() => users.id),
		requestId: text().notNull(),
		createdAt: createdAt(),
	},
	(t) => [
		primaryKey({ columns: [t.userId, t.requestId] }),
		index("withdrawn_requests_created_at_idx").on(t.createdAt),
	],
);
