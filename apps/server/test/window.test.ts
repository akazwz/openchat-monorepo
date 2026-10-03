import type { ResponseInputItem } from "openai/resources/responses/responses";
import { expect, test } from "vitest";

import type { Message } from "@/modules/threads/types";
import {
	noEarlierTurns,
	windowedHistory,
} from "@/runtime/adapters/thread-history";
import { modelFileReference } from "@/runtime/responses/model-files";
import type { ModelInput } from "@/runtime/responses/types";
import {
	clearedAttachment,
	clearedEffectResult,
	clearedToolImage,
	clearedToolResult,
	clearModelFiles,
	clearModelFilesBefore,
	clearToolResults,
	clearToolResultsBefore,
	contextChars,
	nothingOmitted,
	slideWindow,
	type WindowPolicy,
	windowNotice,
} from "@/runtime/window";

const user = (text: string): ResponseInputItem => ({
	role: "user",
	content: text,
});
const reply = (id: string, text: string): ResponseInputItem => ({
	type: "message",
	id,
	role: "assistant",
	status: "completed",
	content: [{ type: "output_text", text, annotations: [] }],
});
const reasoning = (id: string): ResponseInputItem => ({
	type: "reasoning",
	id,
	summary: [],
	encrypted_content: "e".repeat(200),
});
const call = (id: string): ResponseInputItem => ({
	type: "function_call",
	call_id: id,
	name: "web_fetch",
	arguments: JSON.stringify({ url: `https://example.com/${id}` }),
});
const result = (id: string, text: string): ResponseInputItem => ({
	type: "function_call_output",
	call_id: id,
	output: text,
});
const outputOf = (items: ModelInput, id: string) =>
	items.find(
		(item) =>
			"type" in item &&
			item.type === "function_call_output" &&
			item.call_id === id,
	);
const policyFor = (items: ModelInput, target: number): WindowPolicy => ({
	// With one token per character, the trigger sits just under this size.
	tokens: Math.floor(contextChars(items) / 0.81),
	trigger: 0.8,
	target,
	recentToolResults: 3,
	omittedUserChars: 8_000,
	fileBytes: 1_000,
});
// web_fetch, the tool of these fixtures, changes nothing.
const readOnly = () => true;
// One token per character, and nothing sent besides the transcript.
const measure = (policy: WindowPolicy) => ({
	policy,
	fixedChars: 0,
	tokensPerChar: 1,
	readOnly,
});

// Two earlier turns, then a request whose own steps read five pages.
const earlier: ModelInput = [
	user("first question"),
	reasoning("rs-1"),
	reply("msg-1", "b".repeat(2_000)),
	user("second question"),
	call("c1"),
	result("c1", "x".repeat(4_000)),
	reply("msg-2", "c".repeat(1_000)),
];
const request: ModelInput = [
	user("current request"),
	...["c2", "c3", "c4", "c5", "c6"].flatMap((id) => [
		call(id),
		result(id, id.repeat(300)),
	]),
];
const transcript = [...earlier, ...request];

test("below the trigger nothing moves", () => {
	const roomy = { ...policyFor(transcript, 0.2), tokens: 1_000_000 };
	expect(
		slideWindow(transcript, nothingOmitted, measure(roomy)),
	).toBeUndefined();
});

test("past the trigger old results clear, then the oldest pieces slide out whole", () => {
	const slide = slideWindow(
		transcript,
		nothingOmitted,
		measure(policyFor(transcript, 0.3)),
	);
	if (!slide) throw new Error("expected a slide");
	// Every result but the newest three is cleared; the calls stay.
	for (const id of ["c1", "c2", "c3"]) {
		const output = outputOf(transcript, id);
		const kept = outputOf(slide.items, id);
		if (kept) expect(kept).toMatchObject({ output: clearedToolResult });
		else expect(output).toBeDefined();
	}
	for (const id of ["c4", "c5", "c6"])
		expect(outputOf(slide.items, id)).toEqual(outputOf(transcript, id));
	expect(slide.firstKeptToolCallId).toBe("c4");
	// Earlier turns went first, whole: reasoning with its reply, calls with
	// their results. The user's words are kept for the notice.
	expect(slide.items[0]).toEqual(user("current request"));
	expect(slide.keptFrom).toBe(earlier.length);
	expect(slide.omitted.turns).toBe(2);
	expect(slide.omitted.userTexts).toEqual([
		"first question",
		"second question",
	]);
	expect(
		contextChars([
			...windowNotice(slide.omitted, policyFor(transcript, 0.3)),
			...slide.items,
		]),
	).toBeLessThanOrEqual(policyFor(transcript, 0.3).tokens * 0.3);
});

test("an earlier question never leaves without its answer", () => {
	// Sliding out the long question alone would reach the target.
	const items: ModelInput = [
		user("q".repeat(6_000)),
		reply("msg-a", "short answer"),
		user("next question"),
		reply("msg-b", "next answer"),
		user("current request"),
	];
	const slide = slideWindow(
		items,
		nothingOmitted,
		measure({
			...policyFor(items, 0.9),
			target: (contextChars(items) - 5_000) / policyFor(items, 0.9).tokens,
			// The notice then quotes nothing of it.
			omittedUserChars: 10,
		}),
	);
	if (!slide) throw new Error("expected a slide");
	expect(slide.items[0]).toEqual(user("next question"));
	expect(slide.keptFrom).toBe(2);
	expect(slide.omitted.turns).toBe(1);
});

test("the request in progress and its newest results always stay; its earlier steps may go", () => {
	const policy = policyFor(transcript, 0.01);
	const slide = slideWindow(transcript, nothingOmitted, measure(policy));
	if (!slide) throw new Error("expected a slide");
	expect(slide.items).toEqual([
		user("current request"),
		...["c4", "c5", "c6"].flatMap((id) => [
			call(id),
			result(id, id.repeat(300)),
		]),
	]);
	expect(slide.omitted).toMatchObject({ turns: 2, contextSegments: 2 });
	// Every call in the window still has its result, and nothing else.
	const ids = (type: string) =>
		slide.items.flatMap((item) =>
			"type" in item && item.type === type && "call_id" in item
				? [item.call_id]
				: [],
		);
	expect(ids("function_call_output")).toEqual(ids("function_call"));
	const notice = windowNotice(slide.omitted, policy);
	expect(notice).toHaveLength(1);
	expect(JSON.stringify(notice)).toContain("first question");
	expect(JSON.stringify(notice)).toContain("conversation_search");
});

test("with no more results than it keeps, nothing is cleared", () => {
	const few = [
		user("q"),
		call("a"),
		result("a", "A"),
		call("b"),
		result("b", "B"),
	];
	expect(clearToolResults(few, 3, readOnly)).toEqual({
		items: few,
		firstKeptToolCallId: "a",
	});
	expect(clearToolResults([user("q")], 3, readOnly)).toEqual({
		items: [user("q")],
		firstKeptToolCallId: undefined,
	});
});

test("a rebuilt window clears exactly the results before the saved boundary", () => {
	const items = [
		user("q"),
		call("a"),
		result("a", "A"),
		call("b"),
		result("b", "B"),
	];
	expect(clearToolResultsBefore(items, "b", readOnly)).toEqual([
		user("q"),
		call("a"),
		result("a", clearedToolResult),
		call("b"),
		result("b", "B"),
	]);
	// A boundary that has slid out itself leaves everything after it alone.
	expect(clearToolResultsBefore(items, "gone", readOnly)).toEqual(items);
});

test("an earlier exchange that fills the window slides out whole, though it holds the newest results", () => {
	// A previous request read four long pages; the new one has no results
	// of its own yet.
	const items: ModelInput = [
		user("earlier request"),
		...["e1", "e2", "e3", "e4"].flatMap((id) => [
			call(id),
			result(id, id.repeat(2_000)),
		]),
		reply("msg-e", "the answer"),
		user("new question"),
	];
	const slide = slideWindow(
		items,
		nothingOmitted,
		measure(policyFor(items, 0.2)),
	);
	if (!slide) throw new Error("expected a slide");
	expect(slide.items).toEqual([user("new question")]);
	expect(slide.keptFrom).toBe(items.length - 1);
	expect(slide.omitted).toMatchObject({
		turns: 1,
		contextSegments: 0,
		userTexts: ["earlier request"],
	});
});

test("a cleared result of a call that took effect says not to repeat it", () => {
	const send: ResponseInputItem = {
		type: "function_call",
		call_id: "s",
		name: "email_send",
		arguments: "{}",
	};
	const items = [
		user("q"),
		send,
		result("s", "Sent."),
		call("a"),
		result("a", "A"),
		call("b"),
		result("b", "B"),
		call("c"),
		result("c", "C"),
		call("d"),
		result("d", "D"),
	];
	const webOnly = (name: string) => name === "web_fetch";
	const { items: cleared } = clearToolResults(items, 3, webOnly);
	expect(outputOf(cleared, "s")).toMatchObject({ output: clearedEffectResult });
	expect(outputOf(cleared, "a")).toMatchObject({ output: clearedToolResult });
	expect(outputOf(cleared, "b")).toMatchObject({ output: "B" });
	// A rebuild says the same.
	expect(clearToolResultsBefore(items, "b", webOnly)).toEqual(cleared);
});

const image = (fileId: string) => ({
	type: "input_image" as const,
	image_url: modelFileReference(fileId),
	detail: "auto" as const,
});
const screenshot = (id: string): ModelInput => [
	{
		type: "function_call",
		call_id: id,
		name: "browser_take_screenshot",
		arguments: "{}",
	},
	{
		type: "function_call_output",
		call_id: id,
		output: [{ type: "input_text", text: "Took a screenshot" }, image(id)],
	},
];
const attached = (text: string, fileId: string): ResponseInputItem => ({
	role: "user",
	content: [{ type: "input_text", text }, image(fileId)],
});

test("past the file budget's trigger the oldest files are cleared, never the input's or the unseen ones", () => {
	const items: ModelInput = [
		attached("look at this", "photo"),
		reply("msg-1", "a cat"),
		attached("now browse", "sketch"),
		...screenshot("s1"),
		...screenshot("s2"),
		...screenshot("s3"),
	];
	const sizes = new Map([
		["photo", 300],
		["sketch", 100],
		["s1", 200],
		["s2", 200],
		["s3", 200],
	]);
	const policy = { ...policyFor(items, 0.3), fileBytes: 1_000 };
	// 800 bytes (80%) are not yet the trigger.
	expect(
		clearModelFiles(items, new Map([...sizes, ["photo", 99]]), policy),
	).toBeUndefined();
	const clearing = clearModelFiles(items, sizes, policy);
	if (!clearing) throw new Error("expected a clearing");
	// Oldest first down to 300 bytes: the earlier photo, then the first two
	// screenshots. The new input's sketch and the screenshot the model has
	// not seen yet stay whatever they cost.
	expect(clearing.lastClearedFileId).toBe("s2");
	expect(clearing.items[0]).toEqual({
		role: "user",
		content: [
			{ type: "input_text", text: "look at this" },
			{ type: "input_text", text: clearedAttachment },
		],
	});
	expect(clearing.items[2]).toEqual(items[2]);
	for (const id of ["s1", "s2"])
		expect(outputOf(clearing.items, id)).toEqual({
			type: "function_call_output",
			call_id: id,
			output: [
				{ type: "input_text", text: "Took a screenshot" },
				{ type: "input_text", text: clearedToolImage },
			],
		});
	expect(outputOf(clearing.items, "s3")).toEqual(outputOf(items, "s3"));
	// Rebuilt from the saved boundary, the same files are cleared.
	expect(clearModelFilesBefore(items, "s2")).toEqual(clearing.items);
	expect(clearModelFilesBefore(items, "gone")).toEqual(items);
});

test("a new run clears an earlier exchange's images instead of dropping the exchange", () => {
	const message = (
		id: string,
		role: "user" | "assistant",
		parts: Message["parts"],
	): Message => ({
		id,
		threadId: "thread",
		turnId: id.slice(0, 2),
		runId: role === "user" ? null : "run",
		role,
		parts,
		createdAt: new Date(0),
		updatedAt: new Date(0),
	});
	const file = (id: string, size: number) => ({
		id,
		mimeType: "image/png",
		fileName: `${id}.png`,
		size: BigInt(size),
	});
	const history = [
		message("t1-in", "user", [
			{ id: "p1", content: { case: "text", value: "what is this" } },
			{ id: "p2", content: { case: "file", value: file("photo", 700) } },
		]),
		message("t1-out", "assistant", [
			{ id: "p3", content: { case: "text", value: "a cat" } },
		]),
		message("t2-in", "user", [
			{ id: "p4", content: { case: "text", value: "and this" } },
			{ id: "p5", content: { case: "file", value: file("drawing", 200) } },
		]),
	];
	const options = {
		policy: { ...policyFor([], 0.2), tokens: 1_000_000, fileBytes: 1_000 },
		fixedChars: 0,
		tokensPerChar: 1,
		reads: ["image", "pdf"] as const,
		readOnly,
	};
	const windowed = windowedHistory(history, noEarlierTurns, {}, options);
	// Both turns stay; the earlier photo is a note, the new drawing is sent.
	expect(windowed.omitted).toEqual(nothingOmitted);
	expect(
		windowed.items.map((item) => ("role" in item ? item.role : "")),
	).toEqual(["user", "assistant", "user"]);
	expect(JSON.stringify(windowed.items[0])).toContain(clearedAttachment);
	expect(JSON.stringify(windowed.items[0])).not.toContain(
		modelFileReference("photo"),
	);
	expect(JSON.stringify(windowed.items[2])).toContain(
		modelFileReference("drawing"),
	);
	expect(windowed.moved).toMatchObject({
		startTurnId: "t1",
		lastClearedFileId: "photo",
	});
	// The next run rebuilds the same items from the saved boundary.
	expect(
		windowedHistory(
			history,
			noEarlierTurns,
			{ lastClearedFileId: "photo" },
			options,
		).items,
	).toEqual(windowed.items);
});
