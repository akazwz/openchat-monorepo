import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";

import { emailBudget, mailConfig } from "@/config";
import type { Database } from "@/db/client";
import { emailFiles } from "@/db/schema/email-files";
import { type EmailRecord, emails } from "@/db/schema/emails";
import { mailboxes } from "@/db/schema/mailboxes";
import { errorDetails } from "@/lib/error-details";
import { AppError, ErrorCode } from "@/lib/errors";
import { advisoryLock } from "@/lib/sql";
import { streamOf } from "@/lib/streams";
import { announce, userEvents } from "@/modules/events/publish";
import { discardUnreferenced } from "@/modules/files/lifecycle";
import { storeFile } from "@/modules/files/service";
import { declaredType } from "@/modules/files/types";

import {
	byteLength,
	maxHeaderBytes,
	maxLineChars,
	threadReferences,
} from "./headers";
import { mailAddress, mailboxOf } from "./mailbox";
import { allRecipientsSince, recipientsSince } from "./service";

export interface OutgoingAttachment {
	fileName: string;
	mimeType: string;
	content: Uint8Array;
}

export interface OutgoingEmail {
	to: string[];
	cc: string[];
	bcc: string[];
	subject: string;
	text: string;
	// A received email this answers, by ID.
	replyTo?: string;
	attachments: OutgoingAttachment[];
}

// The tool call sending it: an interrupted one finds its email again.
export interface SendingCall {
	runId: string;
	callId: string;
}

// The headers that make it a reply in its thread: In-Reply-To names the
// answered message, and References the thread's IDs, then the answered one.
function threading(answered: EmailRecord) {
	if (!answered.messageId || byteLength(answered.messageId) > maxHeaderBytes)
		return undefined;
	return {
		inReplyTo: answered.messageId,
		references: threadReferences([
			...(answered.references ?? "").split(/\s+/),
			answered.messageId,
		]),
	};
}

// Email Service's size limit is on the message it sends, in which the text
// and each attachment are base64: 4 characters for every 3 bytes, in lines
// of 76 and a line break. Headers and part boundaries take a little more,
// which the room left under the limit covers.
export const encodedBytes = (bytes: number) => {
	const characters = Math.ceil(bytes / 3) * 4;
	return characters + 2 * Math.ceil(characters / 76);
};

// A reply's subject when the model left it empty: the answered one's, marked
// as a reply once.
const replySubject = (subject: string) =>
	/^re:/i.test(subject) ? subject : `Re: ${subject}`;

// Email Service takes the recipients it has, at least one of to, cc, and bcc.
function destinations(
	to: string[],
	cc: string[],
	bcc: string[],
): EmailDestinations {
	const hidden = bcc.length ? { bcc } : {};
	if (to.length) return { to, ...(cc.length ? { cc } : {}), ...hidden };
	if (cc.length) return { cc, ...hidden };
	return { bcc };
}

// Addresses as the model wrote them, trimmed and each once.
function recipients(list: string[]) {
	const seen = new Set<string>();
	return list
		.map((address) => address.trim())
		.filter((address) => {
			const key = address.toLowerCase();
			if (!address || seen.has(key)) return false;
			seen.add(key);
			return true;
		});
}

const unsent = (message: string) =>
	new AppError(message, ErrorCode.InvalidArgument);

// Email Service's errors that refuse a send before it goes out (its docs'
// list of codes): what it was given, from whom, to whom, or the account's
// limits. Its own failures (E_INTERNAL_SERVER_ERROR), a failed delivery
// (E_DELIVERY_FAILED), a code not known here, and any other failure leave
// it unknown: the email may have gone out.
const refusals = new Set([
	"E_VALIDATION_ERROR",
	"E_FIELD_MISSING",
	"E_TOO_MANY_RECIPIENTS",
	"E_TOO_MANY_ATTACHMENTS",
	"E_SENDER_NOT_VERIFIED",
	"E_RECIPIENT_NOT_ALLOWED",
	"E_RECIPIENT_SUPPRESSED",
	"E_SENDER_DOMAIN_NOT_AVAILABLE",
	"E_CONTENT_TOO_LARGE",
	"E_RATE_LIMIT_EXCEEDED",
	"E_DAILY_LIMIT_EXCEEDED",
	"E_HEADER_NOT_ALLOWED",
	"E_HEADER_USE_API_FIELD",
	"E_HEADER_VALUE_INVALID",
	"E_HEADER_VALUE_TOO_LONG",
	"E_HEADER_NAME_INVALID",
	"E_HEADERS_TOO_LARGE",
	"E_HEADERS_TOO_MANY",
]);
const refusalCode = (error: unknown) => {
	const code =
		error && typeof error === "object" && "code" in error
			? String(error.code)
			: "";
	return refusals.has(code) ? code : undefined;
};

// Sends an email from the user's agent (docs/email.md): the email takes its
// place in the sending limit and is recorded before Email Service gets it,
// so a send whose outcome is lost is still found (sendOutcome), and never
// sent twice for one call. The sent email when Email Service took it;
// undefined when whether it did cannot be known. Refusals throw, and leave
// nothing behind.
export async function sendEmail(
	db: Database,
	userId: string,
	call: SendingCall,
	email: OutgoingEmail,
): Promise<EmailRecord | undefined> {
	let answered: EmailRecord | undefined;
	if (email.replyTo) {
		[answered] = await db
			.select()
			.from(emails)
			.where(
				and(
					eq(emails.id, email.replyTo),
					eq(emails.userId, userId),
					eq(emails.status, "received"),
				),
			);
		if (!answered)
			throw new AppError(
				"reply_to must be the ID of an email you received.",
				ErrorCode.NotFound,
			);
	}
	const cc = recipients(email.cc);
	const bcc = recipients(email.bcc);
	// A reply with no recipients goes where a mail program's Reply sends it:
	// to the addresses the email asks replies to go to, or else its sender.
	const to = recipients(
		email.to.length || !answered
			? email.to
			: answered.replyTo.length
				? answered.replyTo.map((person) => person.address)
				: [answered.fromAddress],
	);
	const count = to.length + cc.length + bcc.length;
	if (!count) throw unsent("An email needs at least one recipient.");
	if (count > mailConfig.sendLimit)
		throw unsent(
			`An email can go to at most ${mailConfig.sendLimit} recipients (${count} given): you can send to ${mailConfig.sendLimit} in any 24 hours.`,
		);
	const text = email.text.trim();
	if (!text) throw unsent("An email needs text.");
	const subject =
		email.subject.trim() || (answered ? replySubject(answered.subject) : "");
	const thread = answered && threading(answered);
	if (!subject) throw unsent("An email needs a subject.");
	if (subject.length > maxLineChars)
		throw unsent(`A subject can be up to ${maxLineChars} characters.`);
	if (email.attachments.length > mailConfig.maxAttachments)
		throw unsent(
			`An email can carry up to ${mailConfig.maxAttachments} attachments.`,
		);
	const size =
		encodedBytes(byteLength(text)) +
		email.attachments.reduce(
			(sum, file) => sum + encodedBytes(file.content.byteLength),
			0,
		);
	if (size > mailConfig.maxSendBytes)
		throw unsent(
			`An email can be up to ${mailConfig.maxSendBytes / 1024 / 1024} MB as sent, attachments included (their sending encoding makes them a third larger); this one is ${(size / 1024 / 1024).toFixed(1)} MB.`,
		);
	const mailbox = await mailboxOf(db, userId);

	// Copies of the attachments, which the sent email keeps. Their types are
	// the computer's guesses from their names.
	const fileIds: string[] = [];
	for (const file of email.attachments)
		fileIds.push(
			(
				await storeFile(db, userId, {
					content: streamOf(file.content),
					size: file.content.byteLength,
					fileName: file.fileName,
					mimeType: declaredType(file.mimeType),
				})
			).id,
		);
	const address = (value: string) => ({ address: value, name: "" });
	let reserved: EmailRecord | undefined;
	try {
		reserved = await db.transaction(async (tx) => {
			// One send of the user's at a time takes its place in the limit.
			await tx
				.select({ userId: mailboxes.userId })
				.from(mailboxes)
				.where(eq(mailboxes.userId, userId))
				.for("update");
			const now = Date.now();
			const { used, oldest } = await recipientsSince(
				tx,
				userId,
				new Date(now - mailConfig.sendWindowMs),
			);
			if (used + count > mailConfig.sendLimit) {
				const left = Math.max(mailConfig.sendLimit - used, 0);
				const frees = new Date(
					(oldest?.getTime() ?? now) + mailConfig.sendWindowMs,
				);
				throw new AppError(
					`Not sent: you can send to ${mailConfig.sendLimit} recipients in any 24 hours, and ${left} ${left === 1 ? "is" : "are"} left now; this email has ${count}. Recipients of the earliest email of the last 24 hours free up at ${frees.toISOString().slice(0, 16).replace("T", " ")} UTC.`,
					ErrorCode.ResourceExhausted,
				);
			}
			// And the agents' share of the account's sending quota (config.ts
			// emailBudget), for all users' sends at once: past it, the quota
			// would run out for sign-in codes too.
			await advisoryLock(tx, "agent-mail-budget");
			const { used: allUsed } = await allRecipientsSince(
				tx,
				new Date(now - mailConfig.sendWindowMs),
			);
			if (allUsed + count > emailBudget.agentRecipientsPerDay)
				throw new AppError(
					"Not sent: the service's sending budget for all agents is used up for now. Tell the user; it frees up over the next 24 hours.",
					ErrorCode.ResourceExhausted,
				);
			const [row] = await tx
				.insert(emails)
				.values({
					userId,
					status: "sending",
					fromAddress: mailAddress(mailbox),
					fromName: mailConfig.senderName,
					to: to.map(address),
					cc: cc.map(address),
					bcc: bcc.map(address),
					replyTo: [],
					subject,
					text,
					inReplyTo: thread?.inReplyTo ?? null,
					references: thread?.references ?? null,
					runId: call.runId,
					callId: call.callId,
				})
				.onConflictDoNothing()
				.returning();
			if (row && fileIds.length)
				await tx
					.insert(emailFiles)
					.values(fileIds.map((fileId) => ({ emailId: row.id, fileId })));
			return row;
		});
	} catch (error) {
		await discardUnreferenced(db, userId, fileIds);
		throw error;
	}
	// This call already sent one (it ran again): that one is its outcome.
	if (!reserved) {
		await discardUnreferenced(db, userId, fileIds);
		return sendOutcome(db, call);
	}
	await announce(userId, [userEvents.mail()]);

	let sent: EmailSendResult;
	try {
		sent = await env.AGENT_MAIL.send({
			from: { email: reserved.fromAddress, name: reserved.fromName },
			...destinations(to, cc, bcc),
			subject,
			text,
			...(email.attachments.length
				? {
						attachments: email.attachments.map((file) => ({
							disposition: "attachment" as const,
							filename: file.fileName,
							type: file.mimeType,
							content: file.content,
						})),
					}
				: {}),
			...(thread
				? {
						headers: {
							"In-Reply-To": thread.inReplyTo,
							References: thread.references,
						},
					}
				: {}),
		});
	} catch (error) {
		const code = refusalCode(error);
		if (!code) {
			// It may have gone out: the email stays "sending", and holds its
			// place in the limit.
			console.warn("[Mail] Send outcome unknown", errorDetails(error));
			return undefined;
		}
		await db.delete(emails).where(eq(emails.id, reserved.id));
		await discardUnreferenced(db, userId, fileIds);
		await announce(userId, [userEvents.mail()]);
		throw new AppError(
			`Not sent: Email Service refused it (${code}: ${error instanceof Error ? error.message : String(error)}).`,
			ErrorCode.FailedPrecondition,
		);
	}
	const done = {
		...reserved,
		status: "sent" as const,
		messageId: sent.messageId,
	};
	try {
		await db
			.update(emails)
			.set({ status: "sent", messageId: sent.messageId })
			.where(eq(emails.id, reserved.id));
	} catch (error) {
		// It went out all the same; its record stays "sending" (not confirmed),
		// which errs on the side of the limit.
		console.warn("[Mail] Sent email not recorded as sent", errorDetails(error));
		return done;
	}
	await announce(userId, [userEvents.mail()]);
	return done;
}

// What became of a send a call started: the email if Email Service took it,
// undefined if that cannot be known. With no email recorded for the call,
// it never reached Email Service.
export async function sendOutcome(
	db: Database,
	call: SendingCall,
): Promise<EmailRecord | undefined> {
	const [email] = await db
		.select()
		.from(emails)
		.where(and(eq(emails.runId, call.runId), eq(emails.callId, call.callId)));
	if (!email)
		throw new AppError(
			"This email was not sent. Send it again if it is still needed.",
			ErrorCode.FailedPrecondition,
		);
	return email.status === "sent" ? email : undefined;
}
