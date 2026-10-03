import { sql } from "drizzle-orm";
import { index, snakeCase, text, uniqueIndex } from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

import { createdAt, storedJson, timestamptz } from "./columns";
import { users } from "./users";

// A received email, or one the agent sent: "sending" once it holds its
// place in the sending limit and is handed to Email Service, "sent" once
// Email Service took it. One left "sending" may or may not have gone out.
export type EmailStatus = "received" | "sending" | "sent";

export interface EmailAddressValue {
	address: string;
	// Empty when there is none.
	name: string;
}

// The agent's mail (docs/email.md). Its attachments are the user's files
// (email_files).
export const emails = snakeCase.table(
	"emails",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => uuidv7()),
		userId: text()
			.notNull()
			.references(() => users.id),
		status: text().$type<EmailStatus>().notNull(),
		fromAddress: text().notNull(),
		fromName: text().notNull().default(""),
		to: storedJson<EmailAddressValue[]>().notNull(),
		cc: storedJson<EmailAddressValue[]>().notNull(),
		bcc: storedJson<EmailAddressValue[]>().notNull(),
		replyTo: storedJson<EmailAddressValue[]>().notNull(),
		subject: text().notNull(),
		// The text/plain body, or the HTML one as text.
		text: text().notNull(),
		// Received: its Message-ID header. Sent: the ID Email Service gave it.
		messageId: text(),
		// The Message-ID it answers, and the thread's References header.
		inReplyTo: text(),
		references: text(),
		// Received: the DMARC result Cloudflare's mail server found for its From
		// domain ("pass", "fail", "none", ...), null when it gave none. Only
		// "pass" means the From address is not forged.
		dmarc: text(),
		// Received: when it was first read, by its person or the agent; null
		// while unread.
		readAt: timestamptz(),
		// The tool call that sent it.
		runId: text(),
		callId: text(),
		createdAt: createdAt(),
	},
	(t) => [
		index("emails_user_folder_idx").on(t.userId, t.status, t.id),
		// A message delivered again (a retry after a failure) is kept once.
		uniqueIndex("emails_received_message_unique")
			.on(t.userId, t.messageId)
			.where(sql`${t.status} = 'received'`),
		// A send is taken once per tool call; an interrupted one is found again.
		uniqueIndex("emails_call_unique").on(t.runId, t.callId),
		// All agents' sends of the last day, counted against their share of
		// the sending quota (mail/outbound.ts).
		index("emails_sent_created_idx")
			.on(t.createdAt)
			.where(sql`${t.status} in ('sending', 'sent')`),
	],
);

export type EmailRecord = typeof emails.$inferSelect;
