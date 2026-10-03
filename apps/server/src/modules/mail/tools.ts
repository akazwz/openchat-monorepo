import { posix } from "node:path/posix";

import { mailConfig } from "@/config";
import type { Database } from "@/db/client";
import type { EmailAddressValue, EmailRecord } from "@/db/schema/emails";
import { AppError, ErrorCode } from "@/lib/errors";
import { openFile } from "@/modules/files/service";
import { fileNameOnComputer } from "@/modules/files/workspace-paths";
import { savedOutcome, workspaceDir } from "@/modules/sandbox/computer";
import { outputChars } from "@/modules/sandbox/output";
import { readyComputer, type RunComputer } from "@/modules/sandbox/tools";
import type { ToolCall, ToolOutcome, ToolSet, ToolSpec } from "@/runtime/tools";

import { mailAddress, mailboxOf } from "./mailbox";
import {
	encodedBytes,
	type OutgoingAttachment,
	sendEmail,
	sendOutcome,
} from "./outbound";
import {
	getEmail,
	listEmails,
	markEmailRead,
	recipientsSince,
} from "./service";

const pageSize = 20;
const snippetChars = 160;
const maxSendMegabytes = mailConfig.maxSendBytes / 1024 / 1024;

// Where an email's attachments go on the computer, in a folder of its own.
const attachmentsDir = (emailId: string, root = workspaceDir) =>
	`${root}/mail/${emailId}`;

const text = (value: unknown) => (typeof value === "string" ? value : "");
const texts = (value: unknown) =>
	Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
const when = (date: Date) =>
	`${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
const person = ({ address, name }: EmailAddressValue) =>
	name ? `${name} <${address}>` : address;
// People listed in a header, and an email's attachments: the first few of a
// long list.
const shownPeople = 10;
const shownAttachments = 20;
const people = (list: EmailAddressValue[]) =>
	list.slice(0, shownPeople).map(person).join(", ") +
	(list.length > shownPeople ? `, and ${list.length - shownPeople} more` : "");
// A received email's sender. Only its address's domain can be verified,
// when Cloudflare's mail server found DMARC passed: the email came from that
// domain's mail. Any other may be forged, by anyone. The name is whatever the
// sender wrote (it can read "the user's boss" or another address), so it
// comes after the verdict, as the sender's claim.
function receivedFrom(
	email: Pick<EmailRecord, "fromAddress" | "fromName" | "dmarc">,
) {
	const domain = email.fromAddress.slice(
		email.fromAddress.lastIndexOf("@") + 1,
	);
	const verdict =
		email.dmarc === "pass"
			? `verified: sent from ${domain}`
			: "not verified, may be forged";
	const name = email.fromName
		? `; the name it gives, unverified: "${email.fromName}"`
		: "";
	return `${email.fromAddress} (${verdict})${name}`;
}
const size = (bytes: bigint | number) => {
	const value = Number(bytes);
	return value < 1024
		? `${value} B`
		: value < 1024 * 1024
			? `${Math.round(value / 1024)} KB`
			: `${(value / 1024 / 1024).toFixed(1)} MB`;
};

const specs: ToolSpec[] = [
	{
		name: "email_list",
		description: `List the emails in your inbox or the ones you sent, newest first, ${pageSize} at a time: each with its id, time, sender or recipients, subject, attachment count, whether it is unread, and the start of its text. Reading an email marks it read.`,
		parameters: {
			type: "object",
			properties: {
				folder: { type: "string", enum: ["inbox", "sent"] },
				query: {
					type: "string",
					description:
						"Words that must all appear in the subject, sender, recipients, or text; empty for every email.",
				},
				before: {
					type: "string",
					description:
						"Empty for the newest; an email's id to list the ones older than it.",
				},
			},
			required: ["folder", "query", "before"],
			additionalProperties: false,
		},
		readOnly: true,
		concurrent: true,
		surface: "service",
	},
	{
		name: "email_read",
		description: `Read an email by its id: its sender, recipients, time, subject, attachments, and text. Long text comes in windows of ${outputChars} characters; the result says where to continue.`,
		parameters: {
			type: "object",
			properties: {
				id: { type: "string", description: "The email's id." },
				start: {
					type: "integer",
					description:
						"Character of the text to start from; 0 for the beginning.",
				},
			},
			required: ["id", "start"],
			additionalProperties: false,
		},
		readOnly: true,
		concurrent: true,
		surface: "service",
	},
	{
		name: "email_save_attachments",
		description: `Put an email's attachments on your computer, in ${workspaceDir}/mail/<the email's id>/, to open or process them there; the result lists their paths.`,
		parameters: {
			type: "object",
			properties: {
				id: { type: "string", description: "The email's id." },
			},
			required: ["id"],
			additionalProperties: false,
		},
		readOnly: false,
		concurrent: false,
		surface: "computer",
	},
	{
		name: "email_send",
		description: `Send an email from your own address, as plain text: a new one, or a reply to an email you received (reply_to), which goes in its thread. Attach files from your computer by path: an email can be up to ${maxSendMegabytes} MB as sent, in which attachments take a third more than their size. You can send to ${mailConfig.sendLimit} recipients in any 24 hours, counting to, cc, and bcc.`,
		parameters: {
			type: "object",
			properties: {
				to: {
					type: "array",
					items: { type: "string" },
					description:
						"Email addresses. For a reply, empty sends it where the received email asks replies to go (its Reply-To, else its sender).",
				},
				cc: {
					type: "array",
					items: { type: "string" },
					description: "Email addresses; empty for none.",
				},
				bcc: {
					type: "array",
					items: { type: "string" },
					description: "Email addresses; empty for none.",
				},
				subject: {
					type: "string",
					description:
						"The subject; for a reply, empty keeps the received email's.",
				},
				text: { type: "string", description: "The email's text." },
				reply_to: {
					type: "string",
					description:
						"The id of the received email this answers, which puts the reply in its thread; empty for a new email.",
				},
				attachments: {
					type: "array",
					items: { type: "string" },
					description: `Paths of files on your computer; relative paths are under ${workspaceDir}.`,
				},
			},
			required: [
				"to",
				"cc",
				"bcc",
				"subject",
				"text",
				"reply_to",
				"attachments",
			],
			additionalProperties: false,
		},
		readOnly: false,
		concurrent: false,
		surface: "service",
	},
];

// The mailbox's address and the time its instructions go with each request
// (runs/driver.ts), after the transcript like memory: the model needs to know
// its address to give it out.
export async function mailInstructions(db: Database, userId: string) {
	const mailbox = await mailboxOf(db, userId);
	return `# Email\nYour email address: ${mailAddress(mailbox)}`;
}

// The agent's mailbox (docs/email.md): reading it and sending from it run in
// this Worker; attachments go to and come from the run's computer.
export interface NativeMailFiles {
	workspace(): Promise<string>;
	receive(
		fileId: string,
		path: string,
		callId: string,
		signal: AbortSignal,
	): Promise<void>;
	read(
		path: string,
		callId: string,
		signal: AbortSignal,
	): Promise<{
		content: ReadableStream<Uint8Array>;
		size: number;
		mimeType: string;
	}>;
}

export function mailToolSet(
	db: Database,
	userId: string,
	runId: string,
	computer: RunComputer | undefined,
	native?: NativeMailFiles,
): ToolSet {
	async function list(args: Record<string, unknown>): Promise<ToolOutcome> {
		const folder = args.folder === "sent" ? "sent" : "inbox";
		const before = text(args.before).trim();
		const query = text(args.query).trim();
		const [mailbox, rows] = await Promise.all([
			mailboxOf(db, userId),
			listEmails(db, userId, folder, {
				limit: pageSize + 1,
				before: before || undefined,
				query,
			}),
		]);
		if (!rows.length)
			return {
				output: before
					? "No older emails."
					: query
						? "No emails match."
						: folder === "inbox"
							? `Your inbox (${mailAddress(mailbox)}) is empty.`
							: "You have not sent any email.",
			};
		const shown = rows.slice(0, pageSize);
		const lines = shown.map((row) => {
			const who =
				folder === "inbox"
					? `From: ${receivedFrom(row)}`
					: `To: ${people([...row.to, ...row.cc, ...row.bcc])}`;
			const unread =
				row.status === "received" && !row.readAt ? " · unread" : "";
			const attachments = row.attachmentCount
				? ` · ${row.attachmentCount} attachment${row.attachmentCount === 1 ? "" : "s"}`
				: "";
			const unconfirmed =
				row.status === "sending" ? " · sending not confirmed" : "";
			const start = row.snippet.replace(/\s+/g, " ").trim();
			return `[${row.id}] ${when(row.createdAt)} · ${who} · Subject: ${row.subject || "(none)"}${attachments}${unread}${unconfirmed}${start ? `\n  ${start.slice(0, snippetChars)}${start.length > snippetChars ? "…" : ""}` : ""}`;
		});
		const heading = `${folder === "inbox" ? "Inbox" : "Sent mail"} of ${mailAddress(mailbox)}${query ? `, matching "${query}"` : ""}, newest first:`;
		const more =
			rows.length > pageSize
				? `\nOlder emails follow: list them with before="${shown[shown.length - 1].id}".`
				: "";
		return { output: `${heading}\n${lines.join("\n")}${more}` };
	}

	async function read(args: Record<string, unknown>): Promise<ToolOutcome> {
		const { email, attachments } = await getEmail(db, userId, text(args.id));
		if (email.status === "received" && !email.readAt)
			await markEmailRead(db, userId, email.id);
		const status =
			email.status === "received"
				? `Received: ${when(email.createdAt)}`
				: email.status === "sent"
					? `Sent: ${when(email.createdAt)}`
					: `Sending not confirmed (${when(email.createdAt)}): it may or may not have gone out.`;
		const header = [
			`Email [${email.id}]`,
			`From: ${email.status === "received" ? receivedFrom(email) : person({ address: email.fromAddress, name: email.fromName })}`,
			email.replyTo.length ? `Reply-To: ${people(email.replyTo)}` : "",
			`To: ${people(email.to) || "(none)"}`,
			email.cc.length ? `Cc: ${people(email.cc)}` : "",
			email.bcc.length ? `Bcc: ${people(email.bcc)}` : "",
			status,
			`Subject: ${email.subject || "(none)"}`,
			attachments.length
				? `Attachments (put them on your computer with email_save_attachments): ${attachments
						.slice(0, shownAttachments)
						.map(
							(file) =>
								`${file.fileName} (${file.mimeType}, ${size(file.size)})`,
						)
						.join(
							"; ",
						)}${attachments.length > shownAttachments ? `; and ${attachments.length - shownAttachments} more` : ""}`
				: "",
		].filter(Boolean);
		const length = email.text.length;
		const start = Math.min(
			Math.max(Math.trunc(Number(args.start) || 0), 0),
			length,
		);
		let end = Math.min(start + outputChars, length);
		// Not between the two halves of a character outside the BMP.
		const last = email.text.charCodeAt(end - 1);
		if (end < length && last >= 0xd800 && last <= 0xdbff) end--;
		const body = !length
			? "(no text)"
			: start === 0 && end === length
				? email.text
				: `(Characters ${start + 1}–${end} of ${length}.)\n${email.text.slice(start, end)}${end < length ? `\n(The text continues: read on with start=${end}.)` : ""}`;
		return { output: `${header.join("\n")}\n\n${body}` };
	}

	async function saveAttachments(
		call: ToolCall,
		signal: AbortSignal,
	): Promise<ToolOutcome | undefined> {
		const { email, attachments } = await getEmail(
			db,
			userId,
			text(call.arguments.id),
		);
		if (!attachments.length)
			return { output: "This email has no attachments." };
		const dir = attachmentsDir(
			email.id,
			native ? await native.workspace() : workspaceDir,
		);
		// Each by its own name, numbered when another has it ("report (2).pdf").
		const taken = new Set<string>();
		const paths = attachments.map((file) => {
			let path = "";
			for (let number = 1; !path || taken.has(path); number++)
				path = `${dir}/${fileNameOnComputer(file.fileName, number === 1 ? "" : ` (${number})`)}`;
			taken.add(path);
			return path;
		});
		if (native) {
			for (const [index, file] of attachments.entries())
				await native.receive(file.id, paths[index], call.callId, signal);
			return { output: `Put on your computer:\n${paths.join("\n")}` };
		}
		if (!computer) throw new Error("Execution computer missing");
		const { computer: handle, machine } = await computer.attached();
		const generation = await readyComputer(handle);
		let outcome: ToolOutcome;
		try {
			await machine.mkdir(dir, { recursive: true });
			for (const [index, file] of attachments.entries())
				await machine.writeFile(
					paths[index],
					await openFile(db, userId, file.id),
				);
			outcome = { output: `Put on your computer:\n${paths.join("\n")}` };
		} catch (error) {
			outcome = {
				output: `Failed: ${error instanceof Error ? error.message : String(error)}`,
				isError: true,
			};
		}
		// Whatever was written is kept, like any change on the computer.
		return savedOutcome(handle, generation, outcome);
	}

	// Files from the computer, read here whole: an email carries at most a
	// few megabytes.
	async function attachmentsFrom(
		paths: string[],
		callId: string,
		signal: AbortSignal,
	): Promise<OutgoingAttachment[]> {
		if (!paths.length) return [];
		if (paths.length > mailConfig.maxAttachments)
			throw new AppError(
				`An email can carry up to ${mailConfig.maxAttachments} attachments.`,
				ErrorCode.InvalidArgument,
			);
		const attached = computer && (await computer.attached());
		if (attached) await readyComputer(attached.computer);
		const root = native ? await native.workspace() : workspaceDir;
		const attachments: OutgoingAttachment[] = [];
		let total = 0;
		for (const given of paths) {
			const path = posix.resolve(root, given);
			let read: {
				content: ReadableStream<Uint8Array>;
				size: number;
				mimeType: string;
			};
			try {
				read = native
					? await native.read(path, callId, signal)
					: await attached!.machine.readFile(path, { encoding: "none" });
			} catch (error) {
				throw new AppError(
					`${path} could not be read: ${error instanceof Error ? error.message : String(error)}`,
					ErrorCode.InvalidArgument,
				);
			}
			total += encodedBytes(read.size);
			if (total > mailConfig.maxSendBytes) {
				await read.content.cancel();
				throw new AppError(
					`The attachments are more than ${maxSendMegabytes} MB in all as sent (their sending encoding makes them a third larger).`,
					ErrorCode.InvalidArgument,
				);
			}
			attachments.push({
				fileName: fileNameOnComputer(posix.basename(path)),
				mimeType: read.mimeType,
				content: new Uint8Array(await new Response(read.content).arrayBuffer()),
			});
		}
		return attachments;
	}

	// Once sent: to whom, and what is left of the limit.
	async function sent(email: EmailRecord): Promise<ToolOutcome> {
		const { used } = await recipientsSince(
			db,
			userId,
			new Date(Date.now() - mailConfig.sendWindowMs),
		);
		const left = Math.max(mailConfig.sendLimit - used, 0);
		return {
			output: `Sent [${email.id}] from ${email.fromAddress} to ${people([...email.to, ...email.cc, ...email.bcc])}. You can send to ${left} more recipient${left === 1 ? "" : "s"} in the next 24 hours.`,
		};
	}

	// Handed to Email Service without an answer: it may have gone out. It
	// holds its place in the limit and shows in sent mail as not confirmed.
	const unconfirmed: ToolOutcome = {
		output:
			"Whether this email went out is unknown: its sending was not confirmed. It is listed in your sent mail as not confirmed. Do not send it again unless the user asks you to.",
		isError: true,
	};

	async function send(
		call: ToolCall,
		signal: AbortSignal,
	): Promise<ToolOutcome> {
		const args = call.arguments;
		const email = await sendEmail(
			db,
			userId,
			{ runId, callId: call.callId },
			{
				to: texts(args.to),
				cc: texts(args.cc),
				bcc: texts(args.bcc),
				subject: text(args.subject),
				text: text(args.text),
				replyTo: text(args.reply_to).trim() || undefined,
				attachments: await attachmentsFrom(
					texts(args.attachments),
					call.callId,
					signal,
				),
			},
		);
		return email ? sent(email) : unconfirmed;
	}

	return {
		specs: native
			? specs.map((spec) => ({
					...spec,
					description: spec.description.replaceAll(
						workspaceDir,
						"the selected Mac’s workspace",
					),
				}))
			: specs,
		executor: {
			async execute(call, signal) {
				switch (call.name) {
					case "email_list":
						return list(call.arguments);
					case "email_read":
						return read(call.arguments);
					case "email_save_attachments":
						return saveAttachments(call, signal);
					case "email_send":
						return send(call, signal);
					default:
						throw new Error(`No mail handler for "${call.name}"`);
				}
			},
			// A send cut off midway is found by its call; any other call that
			// may have taken effect stays unknown.
			async resume(call) {
				if (call.name !== "email_send") return undefined;
				const email = await sendOutcome(db, { runId, callId: call.callId });
				return email ? sent(email) : unconfirmed;
			},
		},
	};
}
