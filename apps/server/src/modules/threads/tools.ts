import type { Database } from "@/db/client";
import type { ActiveTextSource } from "@/modules/runs/delivery";
import type { LocalTool } from "@/runtime/tools";

import { readConversation, searchConversations } from "./history";

const text = (value: unknown) => (typeof value === "string" ? value : "");
const integer = (value: unknown) =>
	typeof value === "number" && Number.isInteger(value) ? value : 0;
// Minutes are enough for the model to place a message in time (UTC).
const when = (at: Date) =>
	`${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
const speaker = (role: "user" | "assistant") =>
	role === "user" ? "User" : "Assistant";

// The user's conversations, which the agent searches and reads for details
// that are not in its memory or have slid out of its context window. In code a
// conversation is a thread; the model and the person call it a conversation.
export function conversationTools(
	db: Database,
	userId: string,
	currentThreadId: string,
	activeText?: ActiveTextSource,
): LocalTool[] {
	return [
		{
			name: "conversation_search",
			description:
				"Search this user's conversations, including the current one, for messages containing keywords. Use it when the user refers to something discussed before, or you need details that are not in your memory or no longer in your context window. Use short keywords separated by spaces; any keyword may match. Returns matching conversations with snippets; read one with conversation_read.",
			parameters: {
				type: "object",
				properties: {
					query: {
						type: "string",
						description: "Keywords separated by spaces.",
					},
				},
				required: ["query"],
				additionalProperties: false,
			},
			readOnly: true,
			concurrent: true,
			execute: async (args) => {
				const hits = await searchConversations(
					db,
					userId,
					text(args.query),
					activeText,
				);
				if (!hits.length) return { output: "No conversations found." };
				return {
					output: hits
						.map((hit) =>
							[
								`[${hit.id}] ${hit.title}${hit.id === currentThreadId ? " (this conversation)" : ""} (last active ${when(hit.updatedAt)})`,
								...hit.snippets.map(
									(snippet) =>
										`- ${speaker(snippet.role)}, ${when(snippet.createdAt)}: ${snippet.text}`,
								),
							].join("\n"),
						)
						.join("\n\n"),
				};
			},
		},
		{
			name: "conversation_read",
			description:
				"Read the messages of one of this user's conversations, by the id conversation_search returned, from message number `start` (0 is the first). Long conversations come in parts, and a long message is cut; the result says where to read on.",
			parameters: {
				type: "object",
				properties: {
					conversation_id: {
						type: "string",
						description: "The conversation's id.",
					},
					start: {
						type: "integer",
						description:
							"The message number to start from; 0 for the beginning.",
					},
					offset: {
						type: "integer",
						description:
							"Where to go on in message `start` when it was cut, as the result says; 0 otherwise.",
					},
				},
				required: ["conversation_id", "start", "offset"],
				additionalProperties: false,
			},
			readOnly: true,
			concurrent: true,
			execute: async (args) => {
				const start = integer(args.start);
				const transcript = await readConversation(
					db,
					userId,
					text(args.conversation_id),
					start,
					integer(args.offset),
					activeText,
				);
				const shown = transcript.messages;
				return {
					output: [
						`Conversation: ${transcript.title}${transcript.id === currentThreadId ? " (this conversation)" : ""}`,
						shown.length
							? `Messages ${shown[0].index}–${shown.at(-1)?.index} of ${transcript.total}.`
							: `No messages from ${start} on; it has ${transcript.total}.`,
						...shown.map((message) =>
							[
								`\n#${message.index} ${speaker(message.role)}, ${when(message.createdAt)}${message.start > 0 ? `, from character ${message.start}` : ""}:`,
								message.text,
								...(message.end < message.length
									? [
											`(Cut at character ${message.end} of ${message.length}. Call conversation_read with start=${message.index} and offset=${message.end} to read on in it.)`,
										]
									: []),
							].join("\n"),
						),
						...(transcript.next === undefined
							? []
							: [
									`\n(Call conversation_read with start=${transcript.next} and offset=0 to read on.)`,
								]),
					].join("\n"),
				};
			},
		},
	];
}
