import type {
	ResponseInputContent,
	ResponseInputItem,
} from "openai/resources/responses/responses";

import type { ThreadContextWindow } from "@/db/schema/threads";
import { AppError, ErrorCode } from "@/lib/errors";
import {
	type FileReference,
	isImageMimeType,
	type FileKind,
	fileKinds,
	modelReadsFile,
} from "@/modules/files/types";
import type { Message, MessagePart } from "@/modules/threads/types";

import { modelFileReference, toolResultOutput } from "../responses/model-files";
import type { ModelInput } from "../responses/types";
import {
	clearModelFiles,
	clearModelFilesBefore,
	clearToolResultsBefore,
	type Omitted,
	type ReadOnlyTool,
	slideWindow,
	userText,
	type WindowPolicy,
} from "../window";

// This is the product-to-provider adapter. Stored chat output is a projection;
// an active execution checkpoint instead retains the complete native transcript.
export type HistoryItemProjection = (
	item: ResponseInputItem,
	parts: MessagePart[],
) => void;

function assistantHistory(
	parts: MessagePart[],
	supportsImages: boolean,
	onItem?: HistoryItemProjection,
): ModelInput {
	const result: ModelInput = [];
	let textParts: MessagePart[] = [];
	const flush = () => {
		// The model's reply as text, with its phase (commentary or final
		// answer). Not as the provider's own output message: its ID is that
		// provider's (DeepSeek's are UUIDs, OpenAI wants "msg_…"), and a
		// conversation can change models between turns; with nothing stored
		// at the provider (store: false), the ID references nothing anyway.
		const text = [...textParts]
			.sort(
				(left, right) =>
					(left.assistantText?.contentIndex ?? 0) -
					(right.assistantText?.contentIndex ?? 0),
			)
			.map((part) => (part.content.case === "text" ? part.content.value : ""))
			.join("");
		if (text) {
			const phase = textParts
				.map((part) => part.assistantText?.phase)
				.find((value) => value !== undefined);
			const item: ResponseInputItem = {
				type: "message",
				role: "assistant",
				content: text,
				...(phase === undefined ? {} : { phase }),
			};
			result.push(item);
			onItem?.(
				item,
				[...textParts].sort(
					(a, b) =>
						(a.assistantText?.contentIndex ?? 0) -
						(b.assistantText?.contentIndex ?? 0),
				),
			);
		}
		textParts = [];
	};
	// Earlier tool use stays in context as native call/output pairs. Every call
	// needs an output: one without a recorded result (the run stopped first)
	// gets a stand-in, and a result without its call is dropped.
	const calls = new Set<string>();
	const results = new Set<string>();
	for (const part of parts)
		if (part.content.case === "toolCall") calls.add(part.content.value.id);
		else if (part.content.case === "toolResult")
			results.add(part.content.value.toolCallId);
	for (const part of parts) {
		if (part.content.case === "toolCall") {
			flush();
			const call = part.content.value;
			const item: ResponseInputItem = {
				type: "function_call",
				call_id: call.id,
				name: call.name,
				arguments: call.arguments,
			};
			result.push(item);
			onItem?.(item, [part]);
			if (!results.has(call.id))
				result.push({
					type: "function_call_output",
					call_id: call.id,
					output: "No result was recorded for this call.",
				});
			continue;
		}
		if (part.content.case === "toolResult") {
			flush();
			const output = part.content.value;
			if (calls.has(output.toolCallId)) {
				const item: ResponseInputItem = {
					type: "function_call_output",
					call_id: output.toolCallId,
					output: toolResultOutput(
						typeof output.output === "string"
							? output.output
							: JSON.stringify(output.output),
						(output.images ?? []).map((image) => image.id),
						supportsImages,
					),
				};
				result.push(item);
				onItem?.(item, [part]);
			}
			continue;
		}
		if (part.content.case !== "text") {
			flush();
			continue;
		}
		if (
			textParts[0]?.assistantText?.messageId !== part.assistantText?.messageId
		)
			flush();
		textParts.push(part);
	}
	flush();
	return result;
}

const unsupportedImageText =
	"[An image was attached to this earlier message; the current model cannot read images.]";

// "34 KB": a file's size as the model reads it.
function sizeText(size: bigint) {
	const units = ["bytes", "KB", "MB", "GB"];
	let value = Number(size);
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${unit ? value.toFixed(value < 10 ? 1 : 0) : value} ${units[unit]}`;
}
// What the model is told of an attachment besides its content: its name and
// size, and where it was copied on the computer (the agent, or a restored or
// cleared workspace, may have changed it since).
export type AttachmentPath = (file: FileReference) => string | undefined;
const attachmentNote = (file: FileReference, path?: AttachmentPath) => {
	const workspacePath = path ? path(file) : file.workspacePath;
	return `[Attached: ${file.fileName} (${sizeText(file.size)})${workspacePath ? `, copied to your computer at ${workspacePath}` : ""}]`;
};

// An attachment as the model reads it. Images and PDFs the model reads are
// file references the request layer reads; every other file only the note
// names, and the model opens it on its computer (a PDF it cannot read too).
function attachmentContent(
	file: FileReference,
	reads: readonly FileKind[],
	path?: AttachmentPath,
): ResponseInputContent[] {
	const note: ResponseInputContent[] = [
		{ type: "input_text", text: attachmentNote(file, path) },
	];
	if (isImageMimeType(file.mimeType) && !reads.includes("image"))
		return [{ type: "input_text", text: unsupportedImageText }, ...note];
	if (!modelReadsFile(file.mimeType, reads)) return note;
	return [
		isImageMimeType(file.mimeType)
			? {
					type: "input_image",
					image_url: modelFileReference(file.id),
					detail: "auto",
				}
			: {
					type: "input_file",
					file_data: modelFileReference(file.id),
					filename: file.fileName,
				},
		...note,
	];
}

export function modelHistory(
	history: Message[],
	reads: readonly FileKind[] = fileKinds,
	onItem?: HistoryItemProjection,
	attachmentPath?: AttachmentPath,
): ModelInput {
	return history.flatMap<ResponseInputItem>((message) => {
		if (message.role === "assistant")
			return assistantHistory(message.parts, reads.includes("image"), onItem);
		return [
			{
				role: "user",
				content: message.parts.flatMap<ResponseInputContent>((part) => {
					if (part.content.case === "text")
						return [{ type: "input_text", text: part.content.value }];
					if (part.content.case === "file")
						return attachmentContent(part.content.value, reads, attachmentPath);
					return [];
				}),
			},
		];
	});
}

// The recorded sizes of the files a conversation's messages send the model
// (its attachments, the images its tools returned), by ID.
const fileSizes = (history: Message[]) =>
	new Map(
		history.flatMap((message) =>
			message.parts.flatMap((part) =>
				(part.content.case === "file"
					? [part.content.value]
					: part.content.case === "toolResult"
						? (part.content.value.images ?? [])
						: []
				).map((file) => [file.id, Number(file.size)] as const),
			),
		),
	);

// A user message as the window notice quotes it once its turn slides out:
// the same text its request item holds, so every path to the notice (a run's
// window, the turns before a new run) quotes it alike.
const userQuote = (
	message: Message,
	reads: readonly FileKind[],
	path?: AttachmentPath,
) => userText(modelHistory([message], reads, undefined, path)[0]);

interface HistoryWindow {
	items: ModelInput;
	omitted: Omitted;
	// Set when building this run's window moved it; the thread keeps it so
	// later runs rebuild the same prefix.
	moved?: Pick<
		ThreadContextWindow,
		"startTurnId" | "firstKeptToolCallId" | "lastClearedFileId"
	>;
}

// The turns before a conversation's window: how many, and the input
// messages of the newest of them, as many as the notice can quote.
export interface EarlierTurns {
	turns: number;
	inputs: Message[];
}
export const noEarlierTurns: EarlierTurns = { turns: 0, inputs: [] };

// The model's view of a conversation at the start of a run: the turns inside
// the window, with the tool results and files an earlier slide or clearing
// cleared, cleared and slid again if the new input takes it past the trigger.
// `history` runs from the window's start to the new input; `earlier` is what
// slid out before it. Files are cleared oldest first by their recorded sizes
// against their own budget, as tool results are; nothing is read from
// storage here.
export function windowedHistory(
	history: Message[],
	// The turns before the window, each by its input message (EarlierTurns).
	earlier: EarlierTurns,
	state: ThreadContextWindow,
	options: {
		onItem?: HistoryItemProjection;
		measure?: (items: ModelInput) => number;
		policy: WindowPolicy;
		fixedChars: number;
		tokensPerChar: number;
		reads: readonly FileKind[];
		readOnly: ReadOnlyTool;
		attachmentPath?: AttachmentPath;
	},
): HistoryWindow {
	const omitted: Omitted = {
		turns: earlier.turns,
		contextSegments: 0,
		userTexts: earlier.inputs.map((message) =>
			userQuote(message, options.reads, options.attachmentPath),
		),
	};
	const exchanges: Message[][] = [];
	for (const message of history) {
		if (message.role === "user" || !exchanges.length) exchanges.push([]);
		exchanges[exchanges.length - 1].push(message);
	}
	const current = exchanges.at(-1) ?? [];
	const attachesImages = current.some((message) =>
		message.parts.some(
			(part) =>
				part.content.case === "file" &&
				isImageMimeType(part.content.value.mimeType),
		),
	);
	if (attachesImages && !options.reads.includes("image"))
		throw new AppError(
			"The selected model does not read images",
			ErrorCode.InvalidArgument,
		);
	const turnIds: string[] = [];
	let items: ModelInput = [];
	for (const exchange of exchanges) {
		const exchangeItems = modelHistory(
			exchange,
			options.reads,
			options.onItem,
			options.attachmentPath,
		);
		items = [...items, ...exchangeItems];
		turnIds.push(...exchangeItems.map(() => exchange[0].turnId));
	}
	items = clearToolResultsBefore(
		items,
		state.firstKeptToolCallId,
		options.readOnly,
	);
	items = clearModelFilesBefore(items, state.lastClearedFileId);
	// A new input whose own files exceed the budget is refused when its
	// request is built (model-files.ts), before anything is sent.
	const files = clearModelFiles(items, fileSizes(history), options.policy);
	if (files) items = files.items;
	const slide = slideWindow(items, omitted, {
		policy: options.policy,
		fixedChars: options.fixedChars,
		tokensPerChar: options.tokensPerChar,
		readOnly: options.readOnly,
		measure: options.measure,
	});
	if (!slide && !files) return { items, omitted };
	return {
		items: slide?.items ?? items,
		omitted: slide?.omitted ?? omitted,
		moved: {
			startTurnId: turnIds[slide?.keptFrom ?? 0] ?? current[0]?.turnId,
			firstKeptToolCallId:
				slide?.firstKeptToolCallId ?? state.firstKeptToolCallId,
			lastClearedFileId: files?.lastClearedFileId ?? state.lastClearedFileId,
		},
	};
}
