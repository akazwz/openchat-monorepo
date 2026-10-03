import {
	index,
	integer,
	snakeCase,
	text,
	timestamp,
	unique,
} from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

import { createdAt, storedJson } from "./columns";
import { users } from "./users";

// Where the model's context window stands in this conversation (see
// runtime/window.ts). Messages are never deleted; this only says which part
// the model is shown, so every run rebuilds the same prefix and the provider's
// prompt cache keeps hitting between slides.
export interface ThreadContextWindow {
	// Turns before this one have slid out of the window.
	startTurnId?: string;
	// Results of tool calls before this one are cleared (the calls stay).
	firstKeptToolCallId?: string;
	// Files the model reads (images, PDFs) up to this one's first reference
	// are no longer sent; notes stand in for them (the text around them stays).
	lastClearedFileId?: string;
	// Input tokens per character, measured on this conversation's last model
	// request: tokenizers differ, so character counts are converted with the
	// conversation's own ratio rather than a stored count per message.
	tokensPerChar?: number;
}

export const threads = snakeCase.table(
	"threads",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => uuidv7()),
		userId: text()
			.notNull()
			.references(() => users.id),
		title: text().notNull().default(""),
		// Title changes; activity and run progress have their own ordering.
		revision: integer().notNull().default(1),
		// Where the title came from: the first message ("input"), the model
		// ("generated"), or a rename ("user"). Only an "input" title is replaced
		// by a generated one.
		titleSource: text()
			.$type<"input" | "generated" | "user">()
			.notNull()
			.default("user"),
		contextWindow: storedJson<ThreadContextWindow>().notNull().default({}),
		createdAt: createdAt(),
		// The conversation's last activity: its latest message (prepareRun sets
		// it). A rename or a generated title is not activity. Conversations are
		// listed by it, and a page's cursor carries it as a JavaScript Date, so
		// it is kept to the millisecond a Date holds: a microsecond more would
		// put a row on both sides of its own cursor.
		updatedAt: timestamp({ withTimezone: true, mode: "date", precision: 3 })
			.notNull()
			.defaultNow(),
	},
	(t) => [
		unique("threads_id_user_unique").on(t.id, t.userId),
		// The list: a user's conversations, the most recently active first
		// (read backwards; ascending, it matches ORDER BY … DESC exactly).
		index("threads_user_active_idx").on(t.userId, t.updatedAt, t.id),
	],
);
export type ThreadRecord = typeof threads.$inferSelect;
