import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";

import type { EmailAddressValue, EmailRecord } from "@/db/schema/emails";
import type { File } from "@/db/schema/files";
import {
	EmailAddressSchema,
	EmailFolder,
	EmailSchema,
} from "@/gen/heveta/v1/mail_pb";
import { fileResource } from "@/modules/files/rpc-codec";
import { fileReference } from "@/modules/files/types";

import type { EmailSummary } from "./service";

const addressResource = ({ address, name }: EmailAddressValue) =>
	create(EmailAddressSchema, { address, name });

const common = (email: Omit<EmailRecord, "text">) => ({
	id: email.id,
	folder: email.status === "received" ? EmailFolder.INBOX : EmailFolder.SENT,
	from: addressResource({ address: email.fromAddress, name: email.fromName }),
	to: email.to.map(addressResource),
	cc: email.cc.map(addressResource),
	bcc: email.bcc.map(addressResource),
	replyTo: email.replyTo.map(addressResource),
	subject: email.subject,
	time: timestampFromDate(email.createdAt),
	unconfirmed: email.status === "sending",
	unread: email.status === "received" && !email.readAt,
	senderVerified: email.dmarc === "pass",
});

// An email in a list: the start of its text, not the text.
export const emailSummaryResource = (email: EmailSummary) =>
	create(EmailSchema, {
		...common(email),
		attachmentCount: email.attachmentCount,
		snippet: email.snippet.replace(/\s+/g, " ").trim(),
	});

export const emailResource = (email: EmailRecord, attachments: File[]) =>
	create(EmailSchema, {
		...common(email),
		attachmentCount: attachments.length,
		text: email.text,
		attachments: attachments.map((file) => fileResource(fileReference(file))),
	});
