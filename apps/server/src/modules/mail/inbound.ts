import { and, eq } from "drizzle-orm";
import { convert } from "html-to-text";
import PostalMime, { type Address, type Email } from "postal-mime";

import { mailConfig } from "@/config";
import { createDatabase, type Database } from "@/db/client";
import { emailFiles } from "@/db/schema/email-files";
import { type EmailAddressValue, emails } from "@/db/schema/emails";
import { errorDetails } from "@/lib/error-details";
import { streamOf } from "@/lib/streams";
import { announce, userEvents } from "@/modules/events/publish";
import { discardUnreferenced } from "@/modules/files/lifecycle";
import { storeFile } from "@/modules/files/service";
import { declaredType } from "@/modules/files/types";
import { fileNameOnComputer } from "@/modules/files/workspace-paths";

import { dmarcResult } from "./authentication";
import { clip, headerText, maxLineChars, threadReferences } from "./headers";
import { findMailbox, mailboxName } from "./mailbox";

const { received } = mailConfig;

// PostgreSQL text cannot hold NUL, which a message may carry anywhere: it
// becomes the replacement character, as in tool output (runtime/tools.ts).
const storable = (text: string) => text.replaceAll("\0", "�");

// An address is at most 254 characters (RFC 5321's path limit); a longer
// one is none. A display name gets as much room as any person's needs.
const maxAddressChars = 254;
const maxNameChars = 256;

// Groups ("Team: a@x, b@y;") are their members; the first of them, when a
// header lists more than are kept.
const addressList = (list: Address[] | undefined): EmailAddressValue[] =>
	(list ?? [])
		.flatMap((item) => item.group ?? [item])
		.map((mailbox) => ({
			address: headerText(mailbox.address, Number.POSITIVE_INFINITY),
			name: headerText(mailbox.name, maxNameChars),
		}))
		.filter(({ address }) => address && address.length <= maxAddressChars)
		.slice(0, received.maxAddresses);

// A message ID as it is kept, or null for none.
const messageIdOf = (value: string | undefined) =>
	headerText(value ?? "", maxLineChars) || null;

// An HTML-only body as text: links keep their addresses (sign-up and
// sign-in links are in them); images are dropped, remote ones being
// trackers; headings keep their case. Only its start is converted: a body
// of megabytes takes the conversion's time and memory, and a failure here
// would have the sender deliver it again and again.
const htmlText = (html: string) =>
	convert(html, {
		wordwrap: false,
		selectors: [
			{ selector: "img", format: "skip" },
			...["h1", "h2", "h3", "h4", "h5", "h6"].map((selector) => ({
				selector,
				options: { uppercase: false },
			})),
			{ selector: "table", options: { uppercaseHeaderCells: false } },
		],
	});

// The email's text: its text/plain body, else its HTML one as text, up to
// the length kept.
const bodyText = (email: Email) =>
	clip(
		storable(
			email.text ??
				(email.html
					? htmlText(email.html.slice(0, received.maxHtmlChars))
					: ""),
		).trim(),
		received.maxTextChars,
	);

// Keeps a received email in the user's mailbox (docs/email.md). A message
// delivered again (a retry after this failed, or two deliveries at once) is
// kept once, by its Message-ID.
export async function storeReceived(
	db: Database,
	userId: string,
	email: Email,
	envelopeFrom: string,
) {
	const messageId = messageIdOf(email.messageId);
	if (messageId) {
		const [kept] = await db
			.select({ id: emails.id })
			.from(emails)
			.where(
				and(
					eq(emails.userId, userId),
					eq(emails.status, "received"),
					eq(emails.messageId, messageId),
				),
			);
		if (kept) return;
	}
	// Stored before the email is, so the email never lacks one; unreferenced,
	// they would be removed a day later (files/lifecycle.ts).
	const attachments = [];
	for (const attachment of email.attachments) {
		const content =
			typeof attachment.content === "string"
				? new TextEncoder().encode(attachment.content)
				: new Uint8Array(attachment.content);
		if (!content.byteLength) continue;
		attachments.push(
			await storeFile(db, userId, {
				content: streamOf(content),
				size: content.byteLength,
				fileName: fileNameOnComputer(attachment.filename ?? ""),
				mimeType: declaredType(attachment.mimeType),
			}),
		);
	}
	const [from] = addressList(email.from ? [email.from] : []);
	const fromAddress =
		from?.address ?? headerText(envelopeFrom, maxAddressChars);
	const fileIds = attachments.map((file) => file.id);
	const kept = await db.transaction(async (tx) => {
		const [row] = await tx
			.insert(emails)
			.values({
				userId,
				status: "received",
				fromAddress,
				fromName: from?.name ?? "",
				to: addressList(email.to),
				cc: addressList(email.cc),
				bcc: [],
				replyTo: addressList(email.replyTo),
				subject: headerText(email.subject ?? "", maxLineChars),
				text: bodyText(email),
				messageId,
				inReplyTo: messageIdOf(email.inReplyTo),
				dmarc: dmarcResult(email.headers, fromAddress),
				references:
					threadReferences(
						(email.references ?? "")
							.split(/\s+/)
							.map((id) => headerText(id, maxLineChars)),
					) || null,
			})
			.onConflictDoNothing()
			.returning({ id: emails.id });
		if (!row) return false;
		if (fileIds.length)
			await tx
				.insert(emailFiles)
				.values(fileIds.map((fileId) => ({ emailId: row.id, fileId })));
		return true;
	});
	// The same message, kept by a delivery at the same time.
	if (!kept) {
		await discardUnreferenced(db, userId, fileIds);
		return;
	}
	await announce(userId, [userEvents.mail()]);
}

// The Worker's email() handler: mail to an agent's address is kept in its
// mailbox; anything else, or a message that cannot be read, is refused (the
// sender gets a bounce). Mail arriving starts nothing. A failure to keep it
// throws, which Email Routing answers with a temporary failure, so the
// sender tries again.
export async function receiveEmail(message: ForwardableEmailMessage) {
	const name = mailboxName(message.to);
	if (!name) {
		message.setReject("No such mailbox");
		return;
	}
	const database = createDatabase();
	try {
		const mailbox = await findMailbox(database.db, name);
		if (!mailbox) {
			message.setReject("No such mailbox");
			return;
		}
		let email: Email;
		try {
			email = await PostalMime.parse(message.raw, {
				attachmentEncoding: "arraybuffer",
			});
		} catch (error) {
			console.warn("[Mail] Unreadable message", errorDetails(error));
			message.setReject("The message could not be read");
			return;
		}
		if (email.attachments.length > received.maxAttachments) {
			message.setReject(
				`Too many attachments: up to ${received.maxAttachments} are accepted`,
			);
			return;
		}
		await storeReceived(database.db, mailbox.userId, email, message.from);
	} finally {
		await database.close();
	}
}
