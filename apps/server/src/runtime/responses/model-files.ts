import type {
	EasyInputMessage,
	ResponseFunctionCallOutputItemList,
	ResponseInputContent,
	ResponseInputItem,
} from "openai/resources/responses/responses";

import { AppError, ErrorCode } from "@/lib/errors";

import type { ModelInput } from "./types";

// History and checkpoints carry the files the model reads (images and PDFs)
// as references. Their bytes exist only in the request being sent, never in
// persisted or cloned context.
const referencePrefix = "heveta-file:";
export const modelFileReference = (fileId: string) =>
	`${referencePrefix}${fileId}`;
const modelFileReferenceId = (value: string | null | undefined) =>
	value?.startsWith(referencePrefix) ? value.slice(referencePrefix.length) : "";

const unavailableAttachmentText =
	"[A file attached to this earlier message is no longer available.]";
const unavailableShownImageText =
	"[The image shown here is no longer available.]";
const omittedShownImageText =
	"[The image shown here is left out: the conversation's images exceed the image budget.]";

// A tool result as the model reads it: its text, then the images the call
// showed the person. The run in progress and every later rebuild from the
// conversation produce it the same way, so the prompt prefix stays the same;
// the images are references to stored copies that never change.
export function toolResultOutput(
	output: string,
	imageIds: readonly string[],
	supportsImages: boolean,
): string | ResponseFunctionCallOutputItemList {
	if (!imageIds.length || !supportsImages) return output;
	return [
		{ type: "input_text", text: output },
		...imageIds.map((id) => ({
			type: "input_image" as const,
			image_url: modelFileReference(id),
			detail: "auto" as const,
		})),
	];
}

// Where the files a request sends come from: their sizes by ID, from one
// read of their records (a file that cannot be sent is its error instead),
// and each one's data as a data URL.
export interface ModelFileSource {
	sizes: (
		ids: string[],
		signal: AbortSignal,
	) => Promise<Map<string, number | AppError>>;
	read: (id: string, signal: AbortSignal) => Promise<string>;
}
export type FileSizes = ReadonlyMap<string, number | AppError>;

// The files of a transcript, for the loop: their recorded sizes, which the
// window clears old files by (window.ts clearModelFiles), and then the
// request with their data in place of their references.
export interface ModelFiles {
	sizes: (input: ModelInput, signal: AbortSignal) => Promise<FileSizes>;
	resolve: (
		input: ModelInput,
		sizes: FileSizes,
		signal: AbortSignal,
	) => Promise<ModelInput>;
}
// For a run whose transcripts refer to no files.
export const noModelFiles: ModelFiles = {
	sizes: async () => new Map(),
	resolve: async (input) => input,
};

type UserContent = Omit<EasyInputMessage, "role" | "content"> & {
	role: "user";
	content: ResponseInputContent[];
};
const isUserContent = (item: ResponseInputItem): item is UserContent =>
	"role" in item && item.role === "user" && Array.isArray(item.content);
type ToolOutputContent = Omit<
	ResponseInputItem.FunctionCallOutput,
	"output"
> & {
	output: ResponseFunctionCallOutputItemList;
};
const isToolOutputContent = (
	item: ResponseInputItem,
): item is ToolOutputContent =>
	"type" in item &&
	item.type === "function_call_output" &&
	Array.isArray(item.output);
export type ModelFilePart =
	| ResponseInputContent
	| ResponseFunctionCallOutputItemList[number];
// The file a part refers to (an image's URL or a PDF's data), or "".
export const modelFileId = (part: ModelFilePart) =>
	part.type === "input_image"
		? modelFileReferenceId(part.image_url)
		: part.type === "input_file"
			? modelFileReferenceId(part.file_data)
			: "";

// The parts of an input item that may refer to a file: a user message's
// content, or a tool result's.
export const modelFileParts = (item: ResponseInputItem): ModelFilePart[] =>
	isToolOutputContent(item)
		? item.output
		: "content" in item && Array.isArray(item.content)
			? (item.content as ModelFilePart[])
			: [];

// The item with parts that refer to a file replaced by text where `replace`
// gives some, or the item itself when it refers to no file.
export function replaceModelFiles(
	item: ResponseInputItem,
	replace: (
		part: ModelFilePart,
		fileId: string,
	) => { type: "input_text"; text: string } | undefined,
): ResponseInputItem {
	const note = (part: ModelFilePart) => {
		const fileId = modelFileId(part);
		return fileId ? replace(part, fileId) : undefined;
	};
	if (isToolOutputContent(item) && item.output.some(modelFileId))
		return {
			...item,
			output: item.output.map((part) => note(part) ?? part),
		};
	if (isUserContent(item) && item.content.some(modelFileId))
		return {
			...item,
			content: item.content.map((part) => note(part) ?? part),
		} satisfies UserContent;
	return item;
}

// Whether a request sends a file (an image or a PDF): the provider counts
// its tokens, which its characters do not show.
export const sendsModelFiles = (input: ModelInput) =>
	input.some((item) => modelFileParts(item).some((part) => modelFileId(part)));

// The request's files from `source`, within `fileBytes`. A copy of the
// request is made with references replaced by file data; the input is not
// modified. An earlier attachment that can no longer be read degrades to a
// text placeholder; the current input's must be readable. Images a tool
// showed degrade too, and also when they would exceed the budget, which the
// window's clearing keeps them within (window.ts clearModelFiles): what is
// left out then is the newest, so the prefix stays the same.
export function modelFiles(
	source: ModelFileSource,
	fileBytes: number,
): ModelFiles {
	// A file's data does not change: each is read once and kept while the
	// requests send it, not read again for every request of the loop. What
	// a request no longer sends (cleared, or slid out of the window) is let
	// go, so at most one request's files are held. A failed read is not
	// kept, so the next request tries again.
	const data = new Map<string, Promise<string>>();
	const read = (id: string, signal: AbortSignal) => {
		let reading = data.get(id);
		if (!reading) {
			reading = source.read(id, signal);
			data.set(id, reading);
			reading.catch(() => data.delete(id));
		}
		return reading;
	};
	return {
		sizes: async (input, signal) =>
			source.sizes(
				[
					...new Set(
						input.flatMap((item) =>
							modelFileParts(item).map(modelFileId).filter(Boolean),
						),
					),
				],
				signal,
			),
		resolve: async (input, sizes, signal) => {
			let current = -1;
			input.forEach((item, index) => {
				if ("role" in item && item.role === "user") current = index;
			});
			// Every reference in order, then the budget spent oldest first by the
			// files' recorded sizes: what fits is read, all at once, and at most
			// the budget is ever in memory.
			const references = input.flatMap((item) =>
				modelFileParts(item).flatMap((part) => {
					const fileId = modelFileId(part);
					return fileId ? [{ part, fileId }] : [];
				}),
			);
			let usedBytes = 0;
			const planned = new Map<ModelFilePart, string | Error>();
			for (const { part, fileId } of references) {
				const size = sizes.get(fileId);
				if (size === undefined || size instanceof Error)
					planned.set(
						part,
						size ?? new AppError("File not found", ErrorCode.NotFound),
					);
				else if (usedBytes + size > fileBytes)
					planned.set(
						part,
						new AppError(
							"The attached files exceed the model's file size budget",
							ErrorCode.ResourceExhausted,
						),
					);
				else {
					usedBytes += size;
					planned.set(part, fileId);
				}
			}
			const sent = new Set(
				[...planned.values()].filter((plan) => typeof plan === "string"),
			);
			for (const fileId of data.keys())
				if (!sent.has(fileId)) data.delete(fileId);
			const urls = new Map<string, string | Error>(
				await Promise.all(
					[...sent].map(
						async (fileId) =>
							[
								fileId,
								await read(fileId, signal).catch((error: unknown) =>
									error instanceof Error ? error : new Error(String(error)),
								),
							] as const,
					),
				),
			);
			signal.throwIfAborted();
			// The part with its data in place of the reference, or why it has none.
			const resolve = <P extends ModelFilePart>(part: P) => {
				const plan = planned.get(part);
				const url = typeof plan === "string" ? urls.get(plan) : plan;
				if (url === undefined || url instanceof Error)
					throw url ?? new Error("File not planned");
				return part.type === "input_image"
					? { ...part, image_url: url }
					: { ...part, file_data: url };
			};
			const result: ModelInput = [];
			for (const [index, item] of input.entries()) {
				if (isToolOutputContent(item) && item.output.some(modelFileId)) {
					const output: ResponseFunctionCallOutputItemList = [];
					for (const part of item.output) {
						const fileId = modelFileId(part);
						if (!fileId) {
							output.push(part);
							continue;
						}
						try {
							output.push(resolve(part));
						} catch (error) {
							if (
								!(error instanceof AppError) ||
								(error.code !== ErrorCode.NotFound &&
									error.code !== ErrorCode.FailedPrecondition &&
									error.code !== ErrorCode.ResourceExhausted)
							)
								throw error;
							output.push({
								type: "input_text",
								text:
									error.code === ErrorCode.ResourceExhausted
										? omittedShownImageText
										: unavailableShownImageText,
							});
						}
					}
					result.push({ ...item, output });
					continue;
				}
				if (!isUserContent(item) || !item.content.some(modelFileId)) {
					result.push(item);
					continue;
				}
				const content: ResponseInputContent[] = [];
				for (const part of item.content) {
					const fileId = modelFileId(part);
					if (!fileId) {
						content.push(part);
						continue;
					}
					try {
						content.push(resolve(part));
					} catch (error) {
						if (
							index !== current &&
							error instanceof AppError &&
							(error.code === ErrorCode.NotFound ||
								error.code === ErrorCode.FailedPrecondition)
						)
							content.push({
								type: "input_text",
								text: unavailableAttachmentText,
							});
						else throw error;
					}
				}
				result.push({ ...item, content } satisfies UserContent);
			}
			return result;
		},
	};
}
