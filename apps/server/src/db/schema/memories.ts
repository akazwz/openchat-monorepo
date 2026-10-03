import { index, snakeCase, text } from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

import { createdAt, updatedAt } from "./columns";
import { users } from "./users";

// Long-term memory about a user, kept across conversations as plain text. The
// agent reads and writes it only through its memory tools.
export const memories = snakeCase.table(
	"memories",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => uuidv7()),
		userId: text()
			.notNull()
			.references(() => users.id),
		content: text().notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(t) => [index("memories_user_updated_idx").on(t.userId, t.updatedAt)],
);
export type MemoryRecord = typeof memories.$inferSelect;
