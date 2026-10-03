import type { ResponseInputItem } from "openai/resources/responses/responses";

import type { Database } from "@/db/client";
import type { ThreadContextWindow } from "@/db/schema/threads";
import {
	encodedTextChars,
	type PartDescriptor,
} from "@/modules/threads/content";
import { archivedPartBody } from "@/modules/threads/content-store";
import type { Message, MessagePart } from "@/modules/threads/types";
import {
	windowedHistory,
	type EarlierTurns,
} from "@/runtime/adapters/thread-history";
import type { ModelInput } from "@/runtime/responses/types";
import { contextChars } from "@/runtime/window";

export interface HistoryBody extends PartDescriptor {
	messageId: string;
}
type WindowOptions = Parameters<typeof windowedHistory>[3];
const outputText = (item: ResponseInputItem.FunctionCallOutput) =>
	typeof item.output === "string"
		? item.output
		: item.output.find((part) => part.type === "input_text")?.text;

// First apply the existing window policy to a small projection with measured
// body lengths. Only bodies that survive sliding/clearing are then fetched.
export async function loadHistoryWindow(
	db: Database,
	history: Message[],
	bodies: Map<MessagePart, HistoryBody>,
	earlier: EarlierTurns,
	state: ThreadContextWindow,
	options: WindowOptions,
) {
	const texts = new WeakMap<object, HistoryBody[]>();
	const textExtras = new WeakMap<object, number>();
	const calls = new Map<string, HistoryBody>();
	const results = new Map<string, HistoryBody>();
	const projected = windowedHistory(history, earlier, state, {
		...options,
		onItem: (item, parts) => {
			const descriptors = parts.flatMap((part) =>
				bodies.has(part) ? [bodies.get(part)!] : [],
			);
			if ("type" in item && item.type === "function_call") {
				if (descriptors[0]) calls.set(item.call_id, descriptors[0]);
			} else if ("type" in item && item.type === "function_call_output") {
				if (descriptors[0]) results.set(item.call_id ?? "", descriptors[0]);
			} else if (
				"role" in item &&
				item.role === "assistant" &&
				typeof item.content === "string"
			) {
				texts.set(item, descriptors);
				textExtras.set(
					item,
					descriptors.reduce((total, part) => total + part.modelChars, 0) -
						encodedTextChars(item.content),
				);
			}
		},
		measure: (items: ModelInput) =>
			contextChars(items) +
			items.reduce((extra, item) => {
				if ("type" in item && item.type === "function_call") {
					const descriptor = calls.get(item.call_id);
					return (
						extra +
						(descriptor
							? descriptor.modelChars - encodedTextChars(item.arguments)
							: 0)
					);
				}
				if (
					"type" in item &&
					item.type === "function_call_output" &&
					outputText(item) === "x"
				)
					return extra + (results.get(item.call_id ?? "")?.modelChars ?? 1) - 1;
				return extra + (textExtras.get(item) ?? 0);
			}, 0),
	});
	const loaded = new Map<string, Promise<string>>();
	const read = (body: HistoryBody) => {
		const key = `${body.messageId}:${body.id}`;
		let value = loaded.get(key);
		if (!value) {
			value = archivedPartBody(db, body.messageId, body);
			loaded.set(key, value);
		}
		return value;
	};
	const items: ModelInput = [];
	for (const item of projected.items) {
		if ("type" in item && item.type === "function_call") {
			const body = calls.get(item.call_id);
			items.push(body ? { ...item, arguments: await read(body) } : item);
		} else if (
			"type" in item &&
			item.type === "function_call_output" &&
			outputText(item) === "x"
		) {
			const body = results.get(item.call_id ?? "");
			if (!body) {
				items.push(item);
				continue;
			}
			const value: unknown = JSON.parse(await read(body));
			const output = typeof value === "string" ? value : JSON.stringify(value);
			items.push({
				...item,
				output:
					typeof item.output === "string"
						? output
						: item.output.map((part, index) =>
								index === 0 && part.type === "input_text"
									? { ...part, text: output }
									: part,
							),
			});
		} else if (
			"role" in item &&
			item.role === "assistant" &&
			typeof item.content === "string" &&
			texts.has(item)
		) {
			const content: string[] = [];
			for (const body of texts.get(item)!) content.push(await read(body));
			items.push({ ...item, content: content.join("") });
		} else items.push(item);
	}
	return { ...projected, items };
}
