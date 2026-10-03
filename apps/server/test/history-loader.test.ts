import { beforeEach, expect, test, vi } from "vitest";

import type { Database } from "@/db/client";
import {
	loadHistoryWindow,
	type HistoryBody,
} from "@/modules/runs/history-loader";
import { partModelChars, splitPart } from "@/modules/threads/content";
import type { Message, MessagePart } from "@/modules/threads/types";
import {
	noEarlierTurns,
	windowedHistory,
} from "@/runtime/adapters/thread-history";
import type { WindowPolicy } from "@/runtime/window";

const fake = vi.hoisted(() => ({
	bodies: new Map<string, string>(),
	reads: [] as string[],
}));
vi.mock("@/modules/threads/content-store", () => ({
	archivedPartBody: async (
		_db: unknown,
		_messageId: string,
		part: HistoryBody,
	) => {
		fake.reads.push(part.id);
		return fake.bodies.get(part.id)!;
	},
}));
const message = (
	role: Message["role"],
	turnId: string,
	parts: MessagePart[],
): Message => ({
	id: `${turnId}-${role}`,
	turnId,
	threadId: "thread",
	runId: role === "user" ? null : turnId,
	role,
	parts,
	createdAt: new Date(),
	updatedAt: new Date(),
});
const text = (id: string, value: string): MessagePart => ({
	id,
	content: { case: "text", value },
});
const tool = (id: string, output: string): MessagePart[] => [
	{
		id: `${id}-call`,
		content: {
			case: "toolCall",
			value: { id, name: "read", arguments: '{ "query": "test\\nline" }' },
		},
	},
	{
		id: `${id}-result`,
		content: {
			case: "toolResult",
			value: { toolCallId: id, name: "read", output, isError: false },
		},
	},
];
const policy: WindowPolicy = {
	tokens: 100_000,
	trigger: 0.8,
	target: 0.6,
	recentToolResults: 1,
	omittedUserChars: 200,
	fileBytes: 10_000_000,
};
const options = {
	policy,
	fixedChars: 100,
	tokensPerChar: 1,
	reads: [] as const,
	readOnly: () => true,
};
function project(history: Message[]) {
	const bodies = new Map<MessagePart, HistoryBody>();
	const projected = history.map((message) => ({
		...message,
		parts:
			message.role === "user"
				? message.parts
				: message.parts.map((original, ordinal) => {
						const { meta, body } = splitPart(original);
						fake.bodies.set(original.id, body);
						const part = structuredClone(original);
						if (part.content.case === "text")
							part.content.value = body ? "x" : "";
						else if (part.content.case === "toolCall")
							part.content.value.arguments = "x";
						else if (part.content.case === "toolResult")
							part.content.value.output = "x";
						bodies.set(part, {
							id: original.id,
							ordinal,
							meta,
							generation: "",
							chunks: body ? 1 : 0,
							chars: body.length,
							modelChars: partModelChars(original),
							stepIndex: null,
							messageId: message.id,
						});
						return part;
					}),
	}));
	return { projected, bodies };
}
beforeEach(() => {
	fake.bodies.clear();
	fake.reads = [];
});

test("metadata planning rebuilds exactly the retained native history, preserving argument bytes and text order", async () => {
	const history = [
		message("user", "1", [text("input", "go")]),
		message("assistant", "1", [
			text("a", "first\n"),
			text("b", '"quoted"😀'),
			...tool("call", '{"answer":true}'),
		]),
		message("user", "2", [text("input2", "next")]),
	];
	const { projected, bodies } = project(history);
	expect(
		await loadHistoryWindow(
			{} as Database,
			projected,
			bodies,
			noEarlierTurns,
			{},
			options,
		),
	).toEqual(windowedHistory(history, noEarlierTurns, {}, options));
});

test("an older long tool body cleared by the window is never fetched", async () => {
	const history = [
		message("user", "1", [text("input", "go")]),
		message("assistant", "1", [
			...tool("old", "long".repeat(100_000)),
			...tool("recent", "kept"),
		]),
		message("user", "2", [text("input2", "next")]),
	];
	const { projected, bodies } = project(history);
	const state = { firstKeptToolCallId: "recent" };
	expect(
		await loadHistoryWindow(
			{} as Database,
			projected,
			bodies,
			noEarlierTurns,
			state,
			options,
		),
	).toEqual(windowedHistory(history, noEarlierTurns, state, options));
	expect(fake.reads).not.toContain("old-result");
	expect(fake.reads).toContain("recent-result");
});

test("a long previous turn slides out using original body lengths before any body fetch", async () => {
	const history = [
		message("user", "1", [text("input", "go")]),
		message("assistant", "1", [text("huge", "answer".repeat(100_000))]),
		message("user", "2", [text("input2", "next")]),
	];
	const { projected, bodies } = project(history);
	expect(
		await loadHistoryWindow(
			{} as Database,
			projected,
			bodies,
			noEarlierTurns,
			{},
			options,
		),
	).toEqual(windowedHistory(history, noEarlierTurns, {}, options));
	expect(fake.reads).toEqual([]);
});
