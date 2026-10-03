import { bigint, index, integer, snakeCase, text } from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

import { createdAt, timestamptz, updatedAt } from "./columns";
import { users } from "./users";

// Where a file is in its life: its object is being stored ("uploading"), it
// is stored, or nothing may use it any more and cleanup removes its object
// and row ("deleting"). Whether a message or an email references it is
// message_files' and email_files'.
export type FileStatus = "uploading" | "stored" | "deleting";

export const files = snakeCase.table(
	"files",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => uuidv7()),
		storageKey: text().notNull(),
		mimeType: text().notNull(),
		fileName: text().notNull(),
		size: bigint({ mode: "bigint" }).notNull(),
		// An image's size as shown (EXIF rotation applied), read from its start
		// when stored, so it is laid out before it loads; null for other files
		// and images whose size could not be read.
		width: integer(),
		height: integer(),
		userId: text()
			.notNull()
			.references(() => users.id),
		status: text().$type<FileStatus>().notNull().default("uploading"),
		// Where an attachment is put on the user's computer (docs/sandbox.md),
		// chosen when its message is sent: a folder of that message's own.
		workspacePath: text(),
		// When the attachment was put there, which happens once: a resumed run
		// or a later attempt of the turn leaves it as the agent may have changed
		// it.
		placedAt: timestamptz(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
	},
	(table) => [
		index("files_user_id_idx").on(table.userId, table.id),
		// Cleanup looks for old unreferenced files (files/lifecycle.ts).
		index("files_created_at_idx").on(table.createdAt),
	],
);

export type File = typeof files.$inferSelect;
export type NewFile = typeof files.$inferInsert;
