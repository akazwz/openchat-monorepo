import {
	and,
	asc,
	desc,
	eq,
	getColumns,
	gt,
	isNull,
	lt,
	or,
	sql,
} from "drizzle-orm";

import { mailConfig } from "@/config";
import type { Database } from "@/db/client";
import { emailFiles } from "@/db/schema/email-files";
import { type EmailRecord, emails } from "@/db/schema/emails";
import { type File, files } from "@/db/schema/files";
import { AppError, ErrorCode } from "@/lib/errors";
import { containing } from "@/lib/sql";
import { announce, userEvents } from "@/modules/events/publish";
import { discardUnreferenced } from "@/modules/files/lifecycle";

import { mailboxOf } from "./mailbox";

export type Folder = "inbox" | "sent";
// As literals, not bound values: a partial index on sent mail
// (emails_sent_created_idx) then serves every plan of these queries.
const inFolder = (folder: Folder) =>
	folder === "inbox"
		? sql`${emails.status} = 'received'`
		: sql`${emails.status} in ('sending', 'sent')`;

// An email in a list: everything but its text, of which the start.
export type EmailSummary = Omit<EmailRecord, "text"> & {
	snippet: string;
	attachmentCount: number;
};

const snippetChars = 300;
const { text: _text, ...summaryColumns } = getColumns(emails);

// A folder's emails, newest first, from before the email `before` when
// given. `query` keeps those whose subject, sender, recipients, or text
// contain each of its words.
export async function listEmails(
	db: Database,
	userId: string,
	folder: Folder,
	options: { limit: number; before?: string; query?: string },
): Promise<EmailSummary[]> {
	const words = [
		...new Set((options.query ?? "").trim().split(/\s+/).filter(Boolean)),
	].slice(0, 10);
	const matches = words.map((word) => {
		const pattern = containing(word);
		return or(
			sql`${emails.subject} ilike ${pattern}`,
			sql`${emails.fromAddress} ilike ${pattern}`,
			sql`${emails.fromName} ilike ${pattern}`,
			sql`${emails.to}::text ilike ${pattern}`,
			sql`${emails.text} ilike ${pattern}`,
		);
	});
	return db
		.select({
			...summaryColumns,
			snippet: sql<string>`left(${emails.text}, ${snippetChars})`,
			attachmentCount:
				sql<number>`(select count(*) from ${emailFiles} where ${emailFiles.emailId} = ${emails.id})`.mapWith(
					Number,
				),
		})
		.from(emails)
		.where(
			and(
				eq(emails.userId, userId),
				inFolder(folder),
				options.before ? lt(emails.id, options.before) : undefined,
				...matches,
			),
		)
		.orderBy(desc(emails.id))
		.limit(options.limit);
}

// An email of the user's and its attachments, in the order they came.
export async function getEmail(
	db: Database,
	userId: string,
	emailId: string,
): Promise<{ email: EmailRecord; attachments: File[] }> {
	const [email] = await db
		.select()
		.from(emails)
		.where(and(eq(emails.id, emailId), eq(emails.userId, userId)));
	if (!email) throw new AppError("Email not found.", ErrorCode.NotFound);
	const attachments = await db
		.select({ file: files })
		.from(emailFiles)
		.innerJoin(files, eq(files.id, emailFiles.fileId))
		.where(and(eq(emailFiles.emailId, emailId), eq(files.status, "stored")))
		.orderBy(asc(files.id));
	return { email, attachments: attachments.map((row) => row.file) };
}

// A received email is read once its person opens it or the agent reads it.
// One read already keeps its time; its devices learn it (the unread count).
export async function markEmailRead(
	db: Database,
	userId: string,
	emailId: string,
) {
	const [marked] = await db
		.update(emails)
		.set({ readAt: new Date() })
		.where(
			and(
				eq(emails.id, emailId),
				eq(emails.userId, userId),
				eq(emails.status, "received"),
				isNull(emails.readAt),
			),
		)
		.returning({ id: emails.id });
	if (marked) {
		await announce(userId, [userEvents.mail()]);
		return;
	}
	const [email] = await db
		.select({ id: emails.id })
		.from(emails)
		.where(and(eq(emails.id, emailId), eq(emails.userId, userId)));
	if (!email) throw new AppError("Email not found.", ErrorCode.NotFound);
}

// Only received mail: sent mail is the record of what the agent did in the
// user's name, and what its sending limit counts.
export async function deleteEmail(
	db: Database,
	userId: string,
	emailId: string,
) {
	const fileIds = await db.transaction(async (tx) => {
		const [email] = await tx
			.select({ status: emails.status })
			.from(emails)
			.where(and(eq(emails.id, emailId), eq(emails.userId, userId)))
			.for("update");
		if (!email) throw new AppError("Email not found.", ErrorCode.NotFound);
		if (email.status !== "received")
			throw new AppError(
				"Sent emails cannot be deleted.",
				ErrorCode.FailedPrecondition,
			);
		const attached = await tx
			.select({ fileId: emailFiles.fileId })
			.from(emailFiles)
			.where(eq(emailFiles.emailId, emailId));
		await tx.delete(emails).where(eq(emails.id, emailId));
		return attached.map((row) => row.fileId);
	});
	await discardUnreferenced(db, userId, fileIds);
	await announce(userId, [userEvents.mail()]);
}

// Recipients of the emails sent (or being sent) since `since`, by one user's
// agent or, without a user, by all agents; and when the oldest of them was
// sent, which is when the first of them leaves the window.
async function sentRecipients(
	db: Pick<Database, "select">,
	since: Date,
	userId?: string,
) {
	const [row] = await db
		.select({
			used: sql<number>`coalesce(sum(jsonb_array_length(${emails.to}) + jsonb_array_length(${emails.cc}) + jsonb_array_length(${emails.bcc})), 0)`.mapWith(
				Number,
			),
			oldest: sql<Date | null>`min(${emails.createdAt})`.mapWith(
				(value: string | Date | null) => (value ? new Date(value) : null),
			),
		})
		.from(emails)
		.where(
			and(
				userId ? eq(emails.userId, userId) : undefined,
				inFolder("sent"),
				gt(emails.createdAt, since),
			),
		);
	return { used: row?.used ?? 0, oldest: row?.oldest ?? null };
}

export const recipientsSince = (
	db: Pick<Database, "select">,
	userId: string,
	since: Date,
) => sentRecipients(db, since, userId);

export const allRecipientsSince = (db: Pick<Database, "select">, since: Date) =>
	sentRecipients(db, since);

// The mailbox, how many recipients the agent sent to in the last 24 hours,
// and how many received emails nobody has read.
export async function mailboxUsage(db: Database, userId: string) {
	const mailbox = await mailboxOf(db, userId);
	const [{ used }, [unread]] = await Promise.all([
		recipientsSince(db, userId, new Date(Date.now() - mailConfig.sendWindowMs)),
		db
			.select({ count: sql<number>`count(*)`.mapWith(Number) })
			.from(emails)
			.where(
				and(
					eq(emails.userId, userId),
					inFolder("inbox"),
					isNull(emails.readAt),
				),
			),
	]);
	return {
		mailbox,
		used,
		limit: mailConfig.sendLimit,
		unread: unread?.count ?? 0,
	};
}
