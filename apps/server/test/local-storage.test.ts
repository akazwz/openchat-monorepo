import { afterEach, beforeEach, expect, test, vi } from "vitest";

import type { Database } from "@/db/client";
import type { RunRecord } from "@/db/schema/runs";
import { LocalRunStorage, type RunBatch } from "@/modules/runs/local-storage";
import { RunStatus } from "@/modules/runs/types";
import { StepStatus } from "@/modules/steps/types";
import { contentChunks, joinPart } from "@/modules/threads/content";
import { scanText, sliceText } from "@/modules/threads/text-source";
import type { Message, MessagePart } from "@/modules/threads/types";
import type { LoopCheckpoint } from "@/runtime/checkpoint";

import { localStorageFixture } from "./local-storage-fixture";

const fake = vi.hoisted(() => ({
	control: undefined as RunRecord | undefined,
	pinFails: false,
	pages: new Map<number, string>(),
	archiveFails: false,
}));
vi.mock("@/modules/runs/queries", () => ({
	getRunById: async () => fake.control,
}));
vi.mock("@/modules/files/lifecycle", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/modules/files/lifecycle")>()),
	claimFiles: async () => {
		if (fake.pinFails) throw new Error("pins unavailable");
	},
	referenceFiles: async () => {},
}));
vi.mock("@/modules/runs/archive", () => ({
	importArchivePage: async (
		_db: unknown,
		_seal: unknown,
		page: { index: number; digest: string },
	) => {
		const previous = fake.pages.get(page.index);
		if (previous && previous !== page.digest)
			throw new Error("different page replay");
		fake.pages.set(page.index, page.digest);
		if (fake.archiveFails) {
			fake.archiveFails = false;
			throw new Error("lost archive acknowledgment");
		}
	},
	finalizeArchive: async (
		_db: unknown,
		seal: { run: RunRecord; revision: number },
	) => ({ ...seal.run, revision: seal.revision }),
}));
const at = new Date("2026-09-01T00:00:00Z");
const run: RunRecord = {
	id: "run",
	threadId: "thread",
	turnId: "turn",
	userId: "owner",
	requestId: "request",
	deviceId: null,
	requestHash: "hash",
	attempt: 1,
	model: "model",
	reasoningEffort: null,
	revision: 1,
	status: RunStatus.RUNNING,
	error: "",
	cancelRequested: false,
	createdAt: at,
	startedAt: at,
	finishedAt: null,
};
const message = (role: Message["role"]): Message => ({
	id: role,
	threadId: run.threadId,
	turnId: run.turnId,
	runId: role === "user" ? null : run.id,
	role,
	parts: [],
	createdAt: at,
	updatedAt: at,
});
const db = {
	transaction: async <T>(fn: (tx: unknown) => Promise<T>) =>
		fn({
			select: () => ({
				from: () => ({ where: () => ({ for: async () => [fake.control] }) }),
			}),
		}),
	update: () => ({ set: () => ({ where: async () => {} }) }),
} as unknown as Database;
let fixture: ReturnType<typeof localStorageFixture>;
let local: LocalRunStorage;
const batch = (
	changes: RunBatch["changes"],
	checkpoint?: LoopCheckpoint,
): RunBatch => ({
	id: crypto.randomUUID(),
	run,
	changes,
	checkpoint,
	final: false,
});
const part = (text = ""): MessagePart => ({
	id: "text",
	content: { case: "text", value: text },
});
const point = (
	messages: LoopCheckpoint["messages"],
	phase: LoopCheckpoint["phase"] = "ready",
): LoopCheckpoint => ({ version: 4, phase, messages, lastStepIndex: 0 });
function body(id: string) {
	const descriptor = local
		.partsPage(local.state()!.commitSeq)
		.find((value) => value.id === id)!;
	let after = -1;
	let text = "";
	while (after + 1 < descriptor.chunks) {
		const rows = local.bodyPage(descriptor, after);
		text += rows.map((row) => row.data).join("");
		after = rows.at(-1)!.idx;
	}
	return joinPart(descriptor, text);
}
beforeEach(async () => {
	fake.control = { ...run };
	fake.pinFails = false;
	fake.pages.clear();
	fake.archiveFails = false;
	fixture = localStorageFixture();
	local = new LocalRunStorage(fixture.storage);
	await local.initialize(run, message("user"), message("assistant"));
});
afterEach(() => fixture.close());

test("streaming a 2 MB body writes each delta once; earlier snapshot positions remain immutable", async () => {
	await local.save(db, batch([{ type: "part", part: part() }]));
	const initial = local.state()!;
	const initialHead = local.partsPage(initial.commitSeq)[0];
	const delta = "中😀".repeat(4_000);
	for (let index = 0; index < 100; index++)
		await local.save(
			db,
			batch([{ type: "textDelta", partId: "text", text: delta }]),
		);
	expect(fixture.metrics.contentBytes).toBe(Buffer.byteLength(delta) * 100);
	expect(fixture.metrics.maxBlockBytes).toBeLessThanOrEqual(48 * 1024);
	expect(local.bodyPage(initialHead)).toEqual([]);
	expect(body("text")).toEqual(part(delta.repeat(100)));
	expect(sliceText(local.textChunks(), 16_001, 4_000)).toEqual({
		...sliceText([delta.repeat(100)], 16_001, 4_000),
	});
});

test("a committed batch replay preserves revision and original notification; conflicting reuse is rejected", async () => {
	const save = batch([{ type: "part", part: part("hello") }]);
	const first = await local.save(db, save);
	const bytes = fixture.metrics.contentBytes;
	const repeated = await new LocalRunStorage(fixture.storage).save(db, save);
	expect(repeated).toEqual(first);
	expect(fixture.metrics.contentBytes).toBe(bytes);
	await expect(
		local.save(db, {
			...save,
			changes: [{ type: "part", part: part("different") }],
		}),
	).rejects.toThrow("Conflicting run batch");
});

test("native context appends new items once and a slid window survives restart", async () => {
	const messages: LoopCheckpoint["messages"] = [
		{ role: "user", content: "go" },
	];
	await local.save(db, batch([], point(messages)));
	const bytes = fixture.metrics.contentBytes;
	const item = {
		type: "reasoning" as const,
		id: "reason",
		encrypted_content: "opaque".repeat(100_000),
		summary: [],
	};
	const appended = [...messages, item];
	await local.save(db, batch([], point(appended)));
	expect(fixture.metrics.contentBytes - bytes).toBe(
		Buffer.byteLength(JSON.stringify(item)),
	);
	await local.save(db, batch([], point([item])));
	local = new LocalRunStorage(fixture.storage);
	expect(local.checkpoint()?.messages).toEqual([item]);
	expect(
		fixture.sqlite
			.prepare("SELECT count(distinct epoch) AS total FROM native_items")
			.get()?.total,
	).toBe(1);
});

test("tool requests stay pending until a durable start intent, then retain identity through completion", async () => {
	const messages: LoopCheckpoint["messages"] = [
		{
			type: "function_call",
			call_id: "call",
			name: "send",
			arguments: '{ "text": "ok" }',
		},
	];
	const requested: LoopCheckpoint = {
		...point(messages, "tools"),
		lastStepIndex: 1,
		pendingCalls: [
			{
				callId: "call",
				name: "send",
				arguments: '{ "text": "ok" }',
				stepIndex: 1,
				started: false,
			},
		],
		steps: [{ index: 1, kind: "tool", toolName: "send", status: "pending" }],
	};
	await local.save(db, batch([], requested));
	const pending = local.steps()[0];
	expect(pending).toMatchObject({
		status: StepStatus.PENDING,
		startedAt: null,
		finishedAt: null,
	});
	expect(
		new LocalRunStorage(fixture.storage).checkpoint()?.pendingCalls?.[0]
			.started,
	).toBe(false);
	await local.save(
		db,
		batch([], {
			...requested,
			pendingCalls: requested.pendingCalls!.map((call) => ({
				...call,
				started: true,
			})),
			steps: [{ index: 1, kind: "tool", toolName: "send", status: "running" }],
		}),
	);
	expect(local.steps()[0]).toMatchObject({
		id: pending.id,
		status: StepStatus.RUNNING,
		startedAt: expect.any(Date),
	});
	expect(
		new LocalRunStorage(fixture.storage).checkpoint()?.pendingCalls?.[0]
			.started,
	).toBe(true);
	await local.save(
		db,
		batch([], {
			...point([
				...messages,
				{ type: "function_call_output", call_id: "call", output: "sent" },
			]),
			lastStepIndex: 1,
			steps: [{ index: 1, kind: "tool", status: "completed" }],
		}),
	);
	expect(local.steps()[0]).toMatchObject({
		id: pending.id,
		status: StepStatus.COMPLETED,
		finishedAt: expect.any(Date),
	});
});

test("a result is staged before file pins; restart completes it without exposing an uncommitted part", async () => {
	const result: MessagePart = {
		id: "result",
		content: {
			case: "toolResult",
			value: {
				toolCallId: "call",
				name: "image",
				output: "saved",
				isError: false,
				images: [
					{
						id: "file",
						fileName: "image.png",
						mimeType: "image/png",
						size: 100n,
					},
				],
			},
		},
	};
	fake.pinFails = true;
	await expect(
		local.save(db, batch([{ type: "part", part: result }])),
	).rejects.toThrow("pins unavailable");
	expect(fixture.metrics.syncs).toBeGreaterThan(1);
	expect(local.partsPage(local.state()!.commitSeq)).toEqual([]);
	expect(
		fixture.sqlite.prepare("SELECT count(*) AS total FROM part_chunks").get()
			?.total,
	).toBe(1);
	fake.pinFails = false;
	local = new LocalRunStorage(fixture.storage);
	await local.resolvePending(db);
	expect(body("result")).toEqual(result);
});

test("sealing freezes output and lost archive acknowledgments retry the same pages", async () => {
	await local.save(
		db,
		batch([{ type: "part", part: part("long".repeat(300_000)) }]),
	);
	await local.save(db, {
		...batch([]),
		run: { ...run, status: RunStatus.COMPLETED, finishedAt: at },
		final: true,
	});
	const seal = local.state()!.seal;
	expect(local.state()!.run.status).toBe(RunStatus.RUNNING);
	await expect(local.save(db, batch([]))).rejects.toThrow("sealed");
	fake.archiveFails = true;
	await expect(local.archive(db)).rejects.toThrow(
		"lost archive acknowledgment",
	);
	local = new LocalRunStorage(fixture.storage);
	expect(local.state()!.seal).toEqual(seal);
	await local.archive(db);
	expect(fake.pages.size).toBeGreaterThan(1);
	expect(local.state()!.run).toMatchObject({
		status: RunStatus.COMPLETED,
		revision: seal!.revision,
	});
});

test("cancel intent has one public writer and never rolls back a committed cancel", async () => {
	const stale = batch([{ type: "part", part: part("partial") }]);
	await local.observeControl({ ...run, cancelRequested: true });
	const revision = local.state()!.run.revision;
	await local.observeControl({ ...run, cancelRequested: true });
	expect(local.state()!.run.revision).toBe(revision);
	await local.save(db, stale);
	expect(local.state()!.run.cancelRequested).toBe(true);
});

test("text scanning finds a match across blocks and reads UTF-16 windows without splitting emoji", () => {
	const text = "😀".repeat(8_000) + "needle" + "x".repeat(500);
	const chunks = [...contentChunks(text)];
	expect(scanText(["start nee", "dle end"], ["needle", "end"]).score).toBe(2);
	for (const offset of [1, 15_999, 16_001, text.length + 100])
		expect(sliceText(chunks, offset, 4_000)).toMatchObject({
			...textWindowEquivalent(text, offset, 4_000),
			length: text.length,
		});
});
function textWindowEquivalent(text: string, offset: number, limit: number) {
	let start = Math.min(offset, text.length);
	if (start && /[\uDC00-\uDFFF]/.test(text[start] ?? "")) start--;
	let end = Math.min(start + limit, text.length);
	if (end && /[\uDC00-\uDFFF]/.test(text[end] ?? "")) end--;
	return { text: text.slice(start, end), start, end };
}
