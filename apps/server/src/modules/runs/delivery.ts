import { exports } from "cloudflare:workers";

import type { RunRecord } from "@/db/schema/runs";
import { objectLocation } from "@/lib/location";
import {
	joinPart,
	omitPartBody,
	type PartDescriptor,
} from "@/modules/threads/content";
import { decodeParts, type StoredMessagePart } from "@/modules/threads/storage";
import { scanText, sliceText } from "@/modules/threads/text-source";
import type { Message, MessagePart } from "@/modules/threads/types";

import { publicRun } from "./records";
import { acceptanceTimeoutMs } from "./types";

const actor = (runId: string) =>
	exports.RunActor.getByName(runId, objectLocation);

// The armed actor wakes after the acceptance could have ended: by then the
// run either committed or never will.
const armedWakeupMs = 2 * acceptanceTimeoutMs;

// Before accepting a run: its actor wakes after the acceptance window whatever
// happens next, so a run that commits always runs, even if the dispatch after
// the commit is lost. One that never commits is found missing and forgotten.
export async function armRun(runId: string) {
	await actor(runId).ensure(runId, armedWakeupMs);
}

// After the commit: the actor starts at once.
export async function dispatchRun(runId: string) {
	await actor(runId).ensure(runId);
}

export async function cancelRunExecution(runId: string) {
	await actor(runId).cancel(runId);
}

async function activeBody(runId: string, userId: string, part: PartDescriptor) {
	const chunks: string[] = [];
	let after = -1;
	while (chunks.length < part.chunks) {
		const rows = await actor(runId).readBody(
			userId,
			JSON.stringify(part),
			after,
		);
		if (!rows.length) throw new Error("Run body source changed");
		for (const row of rows) {
			if (row.idx !== chunks.length) throw new Error("Run body is incomplete");
			chunks.push(row.data);
		}
		after = rows.at(-1)!.idx;
	}
	return chunks.join("");
}

async function activeParts(
	runId: string,
	userId: string,
	at: number,
	toolCallId?: string,
) {
	const parts: MessagePart[] = [];
	let after = -1;
	while (true) {
		const page = (await actor(runId).readParts(userId, at, after)).map(
			(value) => JSON.parse(value) as PartDescriptor,
		);
		if (!page.length) break;
		for (const part of page) {
			if (
				toolCallId &&
				(part.meta.content.case !== "toolResult" ||
					part.meta.content.value.toolCallId !== toolCallId)
			)
				continue;
			const omitted = !toolCallId && omitPartBody(part, true);
			parts.push(
				joinPart(
					part,
					omitted ? "" : await activeBody(runId, userId, part),
					omitted,
				),
			);
		}
		after = page.at(-1)!.ordinal;
		if (toolCallId && parts.length) break;
	}
	return parts;
}

function decodeHead(value: string) {
	const head = JSON.parse(value) as {
		run: RunRecord;
		input: Message;
		output: Message;
		commitSeq: number;
	};
	head.run.createdAt = new Date(head.run.createdAt);
	head.run.startedAt = head.run.startedAt ? new Date(head.run.startedAt) : null;
	head.run.finishedAt = head.run.finishedAt
		? new Date(head.run.finishedAt)
		: null;
	for (const message of [head.input, head.output]) {
		message.createdAt = new Date(message.createdAt);
		message.updatedAt = new Date(message.updatedAt);
	}
	head.input.parts = decodeParts(
		head.input.parts as unknown as StoredMessagePart[],
	);
	return head;
}

export async function activeRunSnapshot(runId: string, userId: string) {
	const encoded = await actor(runId).readHead(userId);
	const head = encoded ? decodeHead(encoded) : undefined;
	if (!head) return undefined;
	return {
		run: publicRun(head.run),
		inputMessage: head.input,
		outputMessage: {
			...head.output,
			parts: await activeParts(runId, userId, head.commitSeq),
		},
		revision: head.run.revision,
	};
}

export async function activeToolResult(
	runId: string,
	userId: string,
	toolCallId: string,
) {
	const encoded = await actor(runId).readHead(userId);
	const head = encoded ? decodeHead(encoded) : undefined;
	return head
		? (await activeParts(runId, userId, head.commitSeq, toolCallId))[0]
		: undefined;
}

// A run reads its own committed text directly. Calling back into its actor
// would otherwise wait on the execution making the tool call.
export interface ActiveTextSource {
	runId: string;
	local: import("./local-storage").LocalRunStorage;
}
export async function activeTextSearch(
	runId: string,
	userId: string,
	terms: string[],
	own?: ActiveTextSource,
) {
	if (own?.runId === runId) return scanText(own.local.textChunks(), terms);
	return actor(runId).searchText(userId, terms);
}
export async function activeTextRead(
	runId: string,
	userId: string,
	offset: number,
	limit: number,
	own?: ActiveTextSource,
) {
	if (own?.runId === runId)
		return sliceText(own.local.textChunks(), offset, limit);
	return actor(runId).readText(userId, offset, limit);
}
