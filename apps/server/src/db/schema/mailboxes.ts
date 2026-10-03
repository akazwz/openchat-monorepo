import { snakeCase, text } from "drizzle-orm/pg-core";

import { createdAt } from "./columns";
import { users } from "./users";

// The agent's own mailbox (docs/email.md): its address is `name` at the
// agent mail domain, generated on first use and never changed.
export const mailboxes = snakeCase.table("mailboxes", {
	userId: text()
		.primaryKey()
		.references(() => users.id),
	// The address's local part, lowercase.
	name: text().notNull().unique(),
	createdAt: createdAt(),
});

export type Mailbox = typeof mailboxes.$inferSelect;
