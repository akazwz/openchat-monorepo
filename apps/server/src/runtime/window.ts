import type { ResponseInputItem } from "openai/resources/responses/responses";

import {
	type FileSizes,
	modelFileId,
	modelFileParts,
	replaceModelFiles,
} from "./responses/model-files";
import type { ModelInput } from "./responses/types";

// The sliding context window (docs/agent-design.md, section 3). Nothing is
// summarized: when the context reaches `trigger` of the working window, old
// tool results are cleared and the oldest content slides out, at once, down
// to `target`. The provider's prompt cache matches prefixes, so a slide breaks
// it once and the window then only grows at its end until the next slide.
export interface WindowPolicy {
	// The working context window, in tokens.
	tokens: number;
	trigger: number;
	target: number;
	// Tool results kept verbatim when the rest are cleared.
	recentToolResults: number;
	// What the user said in the slid-out part, quoted in the notice.
	omittedUserChars: number;
	// The files the model reads itself (images and PDFs) that one request may
	// carry, in bytes. Old ones are cleared at `trigger` of it down to
	// `target`, as tool results are, so the newest are the ones sent.
	fileBytes: number;
}

// What has slid out of the window, kept as data so the notice the model reads
// is rebuilt identically on every request (and so from the database, too).
export interface Omitted {
	// Whole exchanges, each starting with a user message.
	turns: number;
	// Earlier context segments of this Run; not RunStep operations.
	contextSegments: number;
	// What the user sent in the slid-out turns (userText), oldest first.
	userTexts: string[];
}
export const nothingOmitted: Omitted = {
	turns: 0,
	contextSegments: 0,
	userTexts: [],
};

// A cleared result says how to have it again. A call that changes nothing is
// made again; any other has already taken effect, and making it again would
// do it twice (send the email again, run the command again).
export const clearedToolResult =
	"[This result was cleared from the context window. Call the tool again with the same arguments if you need it.]";
export const clearedEffectResult =
	"[This result was cleared from the context window. The call already ran and took effect; do not repeat it just to see its output.]";
// A cleared file leaves the text around it (its attachment note, the result
// it came with).
export const clearedAttachment =
	"[The file attached here was cleared from the context window to make room for newer files.]";
export const clearedToolImage =
	"[The image shown here was cleared from the context window to make room for newer images.]";

// Whether a tool's calls change nothing (ToolSpec.readOnly): the note on a
// cleared result depends on it.
export type ReadOnlyTool = (toolName: string) => boolean;

// Characters as the model reads them. Image data is left out: images have
// their own byte limit and a fixed token cost, and a file reference is not
// what is sent. The same measure calibrates `tokensPerChar`, so it only has to
// be consistent, not exact.
export function contextChars(items: ModelInput) {
	return JSON.stringify(items, (key, value) =>
		key === "image_url" && typeof value === "string" ? "" : value,
	).length;
}

const estimateTokens = (chars: number, tokensPerChar: number) =>
	Math.ceil(chars * tokensPerChar);

const isUserMessage = (item: ResponseInputItem) =>
	"role" in item && item.role === "user";
const isToolResult = (
	item: ResponseInputItem,
): item is ResponseInputItem.FunctionCallOutput =>
	"type" in item && item.type === "function_call_output";

// What a user message sent, as the notice quotes it: their words and the
// notes on their attachments (what they are and where they are on the
// computer), its text parts.
export const userText = (item: ResponseInputItem) => {
	if (!("role" in item) || item.role !== "user") return "";
	if (typeof item.content === "string") return item.content;
	return item.content
		.flatMap((part) => (part.type === "input_text" ? [part.text] : []))
		.join("\n");
};

// The newest quotes that fit, in their original order.
function quoted(texts: string[], maxChars: number) {
	const kept: string[] = [];
	let used = 0;
	for (let index = texts.length - 1; index >= 0; index--) {
		const text = texts[index].trim();
		if (!text) continue;
		if (used + text.length > maxChars) break;
		kept.unshift(text);
		used += text.length;
	}
	return kept;
}

// The first thing in the window once anything has slid out, so the model
// knows there is more and how to find it.
export function windowNotice(
	omitted: Omitted,
	policy: WindowPolicy,
): ResponseInputItem[] {
	if (!omitted.turns && !omitted.contextSegments) return [];
	const quotes = quoted(omitted.userTexts, policy.omittedUserChars);
	const parts = [
		omitted.turns
			? `The first ${omitted.turns} turn${omitted.turns === 1 ? "" : "s"} of this conversation ${omitted.turns === 1 ? "is" : "are"} no longer in your context window.`
			: "",
		omitted.contextSegments
			? `The first ${omitted.contextSegments} context segment${omitted.contextSegments === 1 ? "" : "s"} of the current run ${omitted.contextSegments === 1 ? "is" : "are"} no longer in your context window.`
			: "",
		quotes.length
			? `What the user said in them, oldest first:\n${quotes.map((text) => `- ${text.replace(/\s+/g, " ")}`).join("\n")}`
			: "",
		"Find anything else from them with conversation_search, which covers this conversation too, and read it with conversation_read.",
	];
	return [{ role: "developer", content: parts.filter(Boolean).join("\n\n") }];
}

// A result's note once cleared, by what its call can do.
function clearedOutput(items: ModelInput, readOnly: ReadOnlyTool) {
	const tools = new Map(
		items.flatMap((item) =>
			"type" in item && item.type === "function_call"
				? [[item.call_id, item.name] as const]
				: [],
		),
	);
	return (callId: string | null | undefined) => {
		const tool = callId ? tools.get(callId) : undefined;
		return tool !== undefined && readOnly(tool)
			? clearedToolResult
			: clearedEffectResult;
	};
}

// Replaces every tool result but the newest `keep` with a note; the calls stay,
// so each cleared result can be had again. Returns the call whose result is
// the oldest one kept, which marks the boundary for later rebuilds.
export function clearToolResults(
	items: ModelInput,
	keep: number,
	readOnly: ReadOnlyTool,
) {
	const results = items.flatMap((item, index) =>
		isToolResult(item) ? [index] : [],
	);
	const [firstKept] = results.slice(-keep);
	const cleared = new Set(
		firstKept === undefined ? [] : results.filter((i) => i < firstKept),
	);
	const note = clearedOutput(items, readOnly);
	const keptItem = firstKept === undefined ? undefined : items[firstKept];
	return {
		items: items.map((item, index) =>
			cleared.has(index) && isToolResult(item)
				? { ...item, output: note(item.call_id) }
				: item,
		),
		firstKeptToolCallId:
			(keptItem && isToolResult(keptItem) && keptItem.call_id) || undefined,
	};
}

// Clears the results of tool calls that come before `firstKeptCallId`, as a
// previous slide decided.
export function clearToolResultsBefore(
	items: ModelInput,
	firstKeptCallId: string | undefined,
	readOnly: ReadOnlyTool,
) {
	if (!firstKeptCallId) return items;
	const boundary = items.findIndex(
		(item) => isToolResult(item) && item.call_id === firstKeptCallId,
	);
	if (boundary < 0) return items;
	const note = clearedOutput(items, readOnly);
	return items.map((item, index) =>
		index < boundary && isToolResult(item)
			? { ...item, output: note(item.call_id) }
			: item,
	);
}

// Every reference to a file in a transcript, in order: the item it is in and
// the file.
const fileReferences = (items: ModelInput) =>
	items.flatMap((item, index) =>
		modelFileParts(item)
			.map(modelFileId)
			.filter(Boolean)
			.map((fileId) => ({ index, fileId })),
	);

// Clears the files (images, PDFs) the transcript refers to up to and
// including the first reference to `lastClearedFileId`, as an earlier
// clearing decided (clearModelFiles), which never clears the request in
// progress's input. One that has slid out leaves everything after it alone.
export function clearModelFilesBefore(
	items: ModelInput,
	lastClearedFileId: string | undefined,
) {
	if (!lastClearedFileId) return items;
	const references = fileReferences(items);
	const boundary = references.findIndex(
		(reference) => reference.fileId === lastClearedFileId,
	);
	if (boundary < 0) return items;
	const request = items.findLastIndex(isUserMessage);
	return clearReferences(
		items,
		references
			.slice(0, boundary + 1)
			.filter((reference) => reference.index !== request),
	);
}

function clearReferences(
	items: ModelInput,
	references: { index: number; fileId: string }[],
) {
	// A part's position among its item's references says which it is.
	const cleared = new Map<number, number>();
	for (const { index } of references)
		cleared.set(index, (cleared.get(index) ?? 0) + 1);
	return items.map((item, index) => {
		let left = cleared.get(index) ?? 0;
		if (!left) return item;
		const note = {
			type: "input_text" as const,
			text: isToolResult(item) ? clearedToolImage : clearedAttachment,
		};
		// An item's cleared references are its first ones.
		return replaceModelFiles(item, () => (left-- > 0 ? note : undefined));
	});
}

// Returns undefined while the files the transcript sends are below the
// trigger share of the file budget, by their recorded sizes. Otherwise clears
// the oldest down to the target share; a note stands in for each, and the
// text around it stays. Never cleared: the files of the request in
// progress's input (they must be read, and were checked to fit when sent),
// and those of the results at the end, which the model has not seen yet.
// Clearing the oldest rather than leaving out the newest keeps what the model
// looks at now (the screenshot it just took), and, like a slide, breaks the
// cached prefix once rather than at every request.
export function clearModelFiles(
	items: ModelInput,
	sizes: FileSizes,
	policy: WindowPolicy,
) {
	const bytes = (fileId: string) => {
		const size = sizes.get(fileId);
		// One that cannot be sent is a note already.
		return typeof size === "number" ? size : 0;
	};
	const references = fileReferences(items);
	let total = references.reduce(
		(sum, reference) => sum + bytes(reference.fileId),
		0,
	);
	if (total < policy.fileBytes * policy.trigger) return undefined;
	const request = items.findLastIndex(isUserMessage);
	let unseen = items.length;
	while (unseen > 0 && isToolResult(items[unseen - 1])) unseen--;
	const cleared: typeof references = [];
	for (const reference of references) {
		if (total <= policy.fileBytes * policy.target) break;
		if (reference.index === request || reference.index >= unseen) continue;
		cleared.push(reference);
		total -= bytes(reference.fileId);
	}
	if (!cleared.length) return undefined;
	return {
		items: clearReferences(items, cleared),
		lastClearedFileId: cleared[cleared.length - 1].fileId,
	};
}

// The pieces that can leave the window whole, as [start, end) ranges. Before
// the request in progress (at `request`), a whole exchange: a user message
// with the reply to it, so no question stays without its answer or the other
// way round. Within it, one model response's items together with the results
// of the calls it made: reasoning must stay with what follows it, and every
// call with its result.
function units(items: ModelInput, request: number) {
	const ranges: [number, number][] = [];
	let index = 0;
	while (index < items.length) {
		const start = index;
		if (start < request) {
			index++;
			while (index < request && !isUserMessage(items[index])) index++;
		} else if (isUserMessage(items[index]) || isToolResult(items[index]))
			index++;
		else {
			while (
				index < items.length &&
				!isUserMessage(items[index]) &&
				!isToolResult(items[index])
			)
				index++;
			while (index < items.length && isToolResult(items[index])) index++;
		}
		ranges.push([start, index]);
	}
	return ranges;
}

interface Slide {
	items: ModelInput;
	omitted: Omitted;
	// Where the kept items start in the transcript that was passed in.
	keptFrom: number;
	firstKeptToolCallId?: string;
}

// What a window is measured and cleared by.
export interface WindowMeasure {
	// A metadata-only history projection can supply its original body lengths.
	measure?: (items: ModelInput) => number;
	policy: WindowPolicy;
	// Instructions, tool definitions, and whatever else each request carries.
	fixedChars: number;
	tokensPerChar: number;
	readOnly: ReadOnlyTool;
}

// Returns undefined while the context is below the trigger. Otherwise clears
// old tool results and slides out the oldest pieces until the context is at
// the target, never the request in progress or its newest tool results. An
// earlier exchange leaves whole even with results among the newest (a
// previous request's long transcript can be what fills the window).
export function slideWindow(
	items: ModelInput,
	omitted: Omitted,
	{
		policy,
		fixedChars,
		tokensPerChar,
		readOnly,
		measure = contextChars,
	}: WindowMeasure,
): Slide | undefined {
	const size = (transcript: ModelInput, gone: Omitted) =>
		estimateTokens(
			fixedChars + measure([...windowNotice(gone, policy), ...transcript]),
			tokensPerChar,
		);
	if (size(items, omitted) < policy.tokens * policy.trigger) return undefined;
	const cleared = clearToolResults(items, policy.recentToolResults, readOnly);
	const request = items.findLastIndex(isUserMessage);
	// The work in progress: the request's own newest results.
	const protectedResults = new Set(
		items
			.flatMap((item, index) =>
				index > request && isToolResult(item) ? [index] : [],
			)
			.slice(-policy.recentToolResults),
	);
	const dropped = new Set<number>();
	const kept = () => cleared.items.filter((_, index) => !dropped.has(index));
	let keptFrom = 0;
	let gone = omitted;
	for (const [start, end] of units(cleared.items, request)) {
		if (size(kept(), gone) <= policy.tokens * policy.target) break;
		const piece = cleared.items.slice(start, end);
		const current = start >= request;
		// The request in progress stays; its own earlier steps may go.
		if (
			start === request ||
			piece.some((_, offset) => protectedResults.has(start + offset))
		)
			continue;
		for (let index = start; index < end; index++) dropped.add(index);
		if (!current) keptFrom = end;
		gone = {
			turns: gone.turns + (isUserMessage(piece[0]) ? 1 : 0),
			contextSegments: gone.contextSegments + (current ? 1 : 0),
			userTexts: [...gone.userTexts, ...piece.map(userText).filter(Boolean)],
		};
	}
	return {
		items: kept(),
		omitted: gone,
		keptFrom,
		...(cleared.firstKeptToolCallId
			? { firstKeptToolCallId: cleared.firstKeptToolCallId }
			: {}),
	};
}
