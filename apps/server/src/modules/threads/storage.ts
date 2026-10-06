import type { MessageRecord } from "@/db/schema/messages";
import type { FileReference } from "@/modules/files/types";

import type { Message, MessagePart, ToolResult } from "./types";

// JSON has no bigint: a file's size is stored as a string.
type StoredFile = Omit<FileReference, "size"> & { size: string };
type StoredContent =
	| Exclude<MessagePart["content"], { case: "file" | "toolResult" }>
	| { case: "file"; value: StoredFile }
	| {
			case: "toolResult";
			value: Omit<ToolResult, "images"> & { images?: StoredFile[] };
	  };
export type StoredMessagePart = Omit<MessagePart, "content"> & {
	content: StoredContent;
};

const encodeFile = (file: FileReference): StoredFile => ({
	...file,
	size: file.size.toString(),
});
const decodeFile = (file: StoredFile): FileReference => ({
	...file,
	size: BigInt(file.size),
});

export function encodeParts(parts: MessagePart[]): StoredMessagePart[] {
	return parts.map((part): StoredMessagePart => {
		const content = part.content;
		if (content.case === "file")
			return {
				...part,
				content: { case: "file", value: encodeFile(content.value) },
			};
		if (content.case === "toolResult") {
			const { images, ...result } = content.value;
			return {
				...part,
				content: {
					case: "toolResult",
					value: images
						? { ...result, images: images.map(encodeFile) }
						: result,
				},
			};
		}
		return { ...part, content };
	});
}
export function decodeParts(parts: StoredMessagePart[]): MessagePart[] {
	return parts.map((part): MessagePart => {
		const content = part.content;
		if (content.case === "file")
			return {
				...part,
				content: { case: "file", value: decodeFile(content.value) },
			};
		if (content.case === "toolResult") {
			const { images, ...result } = content.value;
			return {
				...part,
				content: {
					case: "toolResult",
					value: images
						? { ...result, images: images.map(decodeFile) }
						: result,
				},
			};
		}
		return { ...part, content };
	});
}
export function messageFromRow(row: MessageRecord): Message {
	return {
		id: row.id,
		threadId: row.threadId,
		turnId: row.turnId,
		runId: row.runId,
		role: row.role,
		parts: decodeParts(row.parts),
		...(row.scheduled ? { scheduled: true } : {}),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}
