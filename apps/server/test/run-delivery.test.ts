import { env } from "cloudflare:workers";
import { beforeEach, expect, test } from "vitest";

import { activeRunSnapshot } from "@/modules/runs/delivery";
import {
	contentChunks,
	splitPart,
	partModelChars,
	type PartDescriptor,
} from "@/modules/threads/content";
import type { MessagePart } from "@/modules/threads/types";

let bodyReads = 0;
let requestedAt = -1;
let part: PartDescriptor;
let blocks: string[];
beforeEach(() => {
	bodyReads = 0;
	requestedAt = -1;
	Object.assign(env, {
		RUN_ACTORS: {
			getByName: () => ({
				readHead: async () =>
					JSON.stringify({
						run: {
							id: "run",
							threadId: "thread",
							turnId: "turn",
							requestId: "request",
							attempt: 1,
							model: "model",
							reasoningEffort: null,
							status: 2,
							revision: 7,
							createdAt: new Date(),
							startedAt: new Date(),
							finishedAt: null,
							cancelRequested: false,
						},
						input: {
							id: "user",
							role: "user",
							parts: [],
							createdAt: new Date(),
							updatedAt: new Date(),
						},
						output: {
							id: "assistant",
							role: "assistant",
							parts: [],
							createdAt: new Date(),
							updatedAt: new Date(),
						},
						commitSeq: 12,
					}),
				readParts: async (_user: string, at: number, after: number) => {
					requestedAt = at;
					return after < 0 ? [JSON.stringify(part)] : [];
				},
				readBody: async (_user: string, encoded: string, after: number) => {
					bodyReads++;
					const frozen = JSON.parse(encoded) as PartDescriptor;
					return blocks
						.slice(after + 1, Math.min(after + 11, frozen.chunks))
						.map((data, offset) => ({ idx: after + 1 + offset, data }));
				},
			}),
		},
	});
});
function content(value: MessagePart) {
	const { meta, body } = splitPart(value);
	blocks = [...contentChunks(body)];
	part = {
		id: value.id,
		ordinal: 0,
		meta,
		generation: "g",
		chars: body.length,
		modelChars: partModelChars(value),
		chunks: blocks.length,
		stepIndex: 1,
	};
}

test("a snapshot omits a long tool body before any body RPC", async () => {
	content({
		id: "result",
		content: {
			case: "toolResult",
			value: {
				toolCallId: "call",
				name: "read",
				output: "x".repeat(2_000_000),
				isError: false,
			},
		},
	});
	const snapshot = await activeRunSnapshot("run", "owner");
	expect(snapshot?.outputMessage.parts[0].content).toMatchObject({
		case: "toolResult",
		value: { output: null, outputOmitted: true },
	});
	expect(bodyReads).toBe(0);
	expect(requestedAt).toBe(12);
});

test("paged body reads use the frozen descriptor even if new chunks arrive", async () => {
	content({
		id: "text",
		content: { case: "text", value: "中😀".repeat(100_000) },
	});
	blocks.push("newer delta");
	const snapshot = await activeRunSnapshot("run", "owner");
	expect(snapshot?.revision).toBe(7);
	expect(snapshot?.outputMessage.parts[0].content).toEqual({
		case: "text",
		value: "中😀".repeat(100_000),
	});
	expect(bodyReads).toBeGreaterThan(1);
});
