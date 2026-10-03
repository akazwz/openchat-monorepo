import { AppError, ErrorCode } from "@/lib/errors";

import { decodeParts, encodeParts, type StoredMessagePart } from "./storage";
import type { MessagePart } from "./types";

export const listedOutputChars = 2_000;
// At most 48 KiB of UTF-8; leave room for row metadata below the DO row limit.
const chunkChars = 16_000;
export function* contentChunks(text: string): Generator<string> {
	for (let start = 0; start < text.length;) {
		let end = Math.min(start + chunkChars, text.length);
		const last = text.charCodeAt(end - 1);
		if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
		yield text.slice(start, end);
		start = end;
	}
}

export interface PartDescriptor {
	id: string;
	ordinal: number;
	meta: StoredMessagePart;
	generation: string;
	chunks: number;
	chars: number;
	modelChars: number;
	stepIndex: number | null;
}

// Metadata can be read without fetching a large body. Tool arguments retain
// their exact source text; only tool outputs use JSON encoding.
export function splitPart(part: MessagePart) {
	const [meta] = encodeParts([part]);
	let body = "";
	switch (meta.content.case) {
		case "text":
			body = meta.content.value;
			meta.content = { case: "text", value: "" };
			break;
		case "reasoning":
			body = meta.content.value.text;
			meta.content = { case: "reasoning", value: { text: "" } };
			break;
		case "toolCall":
			body = meta.content.value.arguments;
			meta.content = {
				case: "toolCall",
				value: { ...meta.content.value, arguments: "" },
			};
			break;
		case "toolResult":
			body = JSON.stringify(meta.content.value.output);
			meta.content = {
				case: "toolResult",
				value: { ...meta.content.value, output: null },
			};
			break;
	}
	return { meta, body };
}

export function joinPart(
	descriptor: PartDescriptor,
	body: string,
	omitted = false,
): MessagePart {
	const [part] = decodeParts([structuredClone(descriptor.meta)]);
	switch (part.content.case) {
		case "text":
			part.content.value = body;
			break;
		case "reasoning":
			part.content.value.text = body;
			break;
		case "toolCall":
			part.content.value.arguments = body;
			break;
		case "toolResult":
			part.content.value.output = omitted ? null : JSON.parse(body);
			if (omitted) part.content.value.outputOmitted = true;
			break;
	}
	if (!omitted && body.length !== descriptor.chars)
		throw new AppError("Message content is incomplete", ErrorCode.Unavailable);
	return part;
}

export const omitPartBody = (part: PartDescriptor, omitLongOutputs: boolean) =>
	omitLongOutputs &&
	part.meta.content.case === "toolResult" &&
	part.chars > listedOutputChars;

export async function contentDigest(text: string) {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return Array.from(new Uint8Array(bytes), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export const encodedTextChars = (text: string) =>
	JSON.stringify(text).length - 2;
export function partModelChars(part: MessagePart) {
	const content = part.content;
	if (content.case === "text") return encodedTextChars(content.value);
	if (content.case === "toolCall")
		return encodedTextChars(content.value.arguments);
	if (content.case === "toolResult")
		return encodedTextChars(
			typeof content.value.output === "string"
				? content.value.output
				: JSON.stringify(content.value.output),
		);
	return 0;
}
