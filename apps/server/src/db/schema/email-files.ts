import { index, primaryKey, snakeCase, text } from "drizzle-orm/pg-core";

import { emails } from "./emails";
import { files } from "./files";

// An email's attachments. Like message_files, a referenced file is kept, and
// one no email or message references is removed (files/lifecycle.ts).
export const emailFiles = snakeCase.table(
	"email_files",
	{
		emailId: text()
			.notNull()
			.references(() => emails.id, { onDelete: "cascade" }),
		fileId: text()
			.notNull()
			.references(() => files.id),
	},
	(t) => [
		primaryKey({ columns: [t.emailId, t.fileId] }),
		index("email_files_file_idx").on(t.fileId),
	],
);
