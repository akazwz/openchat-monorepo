import { index, snakeCase, text } from "drizzle-orm/pg-core";

import { timestamptz } from "./columns";

// R2 deletions survive a failed request/Worker. Pending uploads expire after
// a day; pointing the profile at one removes its entry in the same commit.
export const avatarGarbage = snakeCase.table(
	"avatar_garbage",
	{
		key: text().primaryKey(),
		deleteAfter: timestamptz().notNull(),
	},
	(t) => [index("avatar_garbage_delete_after_idx").on(t.deleteAfter)],
);
