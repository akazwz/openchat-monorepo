import { index, primaryKey, snakeCase, text } from "drizzle-orm/pg-core";

import { files } from "./files";
import { messages } from "./messages";

// The files a message references: its attachments, files a reply showed, and
// images a tool returned. A referenced file cannot be deleted, and one no
// message or email references is removed (files/lifecycle.ts).
export const messageFiles = snakeCase.table(
	"message_files",
	{
		messageId: text()
			.notNull()
			.references(() => messages.id, { onDelete: "cascade" }),
		fileId: text()
			.notNull()
			.references(() => files.id),
	},
	(t) => [
		primaryKey({ columns: [t.messageId, t.fileId] }),
		index("message_files_file_idx").on(t.fileId),
	],
);
