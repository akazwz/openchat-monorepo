import { fromBinary, fromJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampMs } from "@bufbuild/protobuf/wkt";
import {
	type Client,
	Code,
	type ConnectError,
	createClient,
} from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { env } from "cloudflare:workers";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
	vi,
} from "vitest";

import { emailBudget } from "@/config";
import { createDatabase } from "@/db/client";
import {
	avatarGarbage,
	devices,
	emailFiles,
	emails,
	files,
	memories,
	messageFiles,
	messages,
	runs,
	sessions,
	steps,
	threads,
	turns,
	users,
	verificationCodes,
} from "@/db/schema";
import { messageParts, runArchivePages } from "@/db/schema/message-content";
import { AuthService } from "@/gen/heveta/v1/auth_pb";
import { ComputerService } from "@/gen/heveta/v1/computer_pb";
import { ErrorDetailSchema, ErrorReason } from "@/gen/heveta/v1/error_pb";
import { type UserEvent, UserEventSchema } from "@/gen/heveta/v1/event_pb";
import { FileSchema, FileService } from "@/gen/heveta/v1/file_pb";
import { MailService } from "@/gen/heveta/v1/mail_pb";
import { MemoryService } from "@/gen/heveta/v1/memory_pb";
import { ModelService } from "@/gen/heveta/v1/model_pb";
import {
	type Run,
	type RunEvent,
	RunService,
	type RunSnapshot,
} from "@/gen/heveta/v1/run_pb";
import { RunStatus } from "@/gen/heveta/v1/run_status_pb";
import {
	MessagePhase,
	MessageRole,
	ThreadService,
	ToolConsent,
} from "@/gen/heveta/v1/thread_pb";
import { TurnService } from "@/gen/heveta/v1/turn_pb";
import worker from "@/index";
import { ErrorCode } from "@/lib/errors";
import { sha256 } from "@/lib/hash";
import { purgeAvatarGarbage } from "@/modules/auth/avatar";
import { purgeExpiredAuthRecords } from "@/modules/auth/service";
import { actingUserHeader, liveEventSession } from "@/modules/auth/session";
import { hubHeaders } from "@/modules/events/hub";
import { cleanupFiles } from "@/modules/files/lifecycle";
import { sniffMimeType } from "@/modules/files/types";
import { uploadFile } from "@/modules/files/upload";
import { mailboxOf } from "@/modules/mail/mailbox";
import { mailToolSet } from "@/modules/mail/tools";
import {
	addMemory,
	deleteMemory,
	searchMemories,
	updateMemory,
} from "@/modules/memories/service";
import { memoryContext, memoryTools } from "@/modules/memories/tools";
import * as runArchive from "@/modules/runs/archive";
import { prepareRun } from "@/modules/runs/commands";
import { recordConsent } from "@/modules/runs/consent";
import * as runDelivery from "@/modules/runs/delivery";
import { dispatchRun } from "@/modules/runs/delivery";
import { executeRun } from "@/modules/runs/driver";
import { LocalRunStorage } from "@/modules/runs/local-storage";
import { getRunById, loadRunForExecution } from "@/modules/runs/queries";
import { loadRunMessages, publicRun } from "@/modules/runs/records";
import { publishRunState } from "@/modules/runs/service";
import type { RunInput } from "@/modules/runs/types";
import { RunStatus as StoredRunStatus } from "@/modules/runs/types";
import type { SandboxMachine } from "@/modules/sandbox/computer";
import { connectionHeaders } from "@/modules/sandbox/connections";
import {
	clearWorkspace,
	listSnapshots,
	restartComputer,
	restoreSnapshot,
	workspaceUsage,
} from "@/modules/sandbox/manage";
import {
	type RunComputer,
	type StoreFile,
	sandboxExecutor,
} from "@/modules/sandbox/tools";
import { placeUploads } from "@/modules/sandbox/uploads";
import { Workspace, WorkspaceLostError } from "@/modules/sandbox/workspace";
import {
	createSchedule,
	deleteSchedule,
	fireSchedule,
	listSchedules,
	nextOccurrence,
} from "@/modules/schedules/service";
import { StepKind, StepStatus } from "@/modules/steps/types";
import { joinPart, omitPartBody } from "@/modules/threads/content";
import {
	readConversation,
	searchConversations,
} from "@/modules/threads/history";
import { updateContextWindow } from "@/modules/threads/service";
import { scanText, sliceText } from "@/modules/threads/text-source";
import { conversationTools } from "@/modules/threads/tools";
import { handler } from "@/rpc/router";
import { ResponsesOutput } from "@/runtime/responses/output";
import type {
	ModelInput,
	ModelResponse,
	StreamResponse,
} from "@/runtime/responses/types";
import type { ModelText } from "@/runtime/types";

import { localStorageFixture } from "./local-storage-fixture";

const fake = vi.hoisted(() => ({
	mode: "normal",
	requests: 0,
	// Model requests in "images" mode.
	inputs: [] as ModelInput[],
	release: undefined as (() => void) | undefined,
	actors: new Map<string, AbortController>(),
	hanging: false,
	// How often the "consent" mode's send_out ran.
	sent: 0,
	jobs: new Set<Promise<void>>(),
	locals: new Map<
		string,
		{ local: LocalRunStorage; fixture: ReturnType<typeof localStorageFixture> }
	>(),
	// Schedules' alarms, by schedule ID.
	alarms: new Map<string, Date>(),
	// Actors armed before acceptance, by run ID; arming fails while set.
	armed: [] as string[],
	armFails: false,
}));
// A schedule's alarm is a Durable Object's; here it is only recorded, and the
// test rings it (fireSchedule).
vi.mock("@/modules/schedules/delivery", () => ({
	async armSchedule(id: string, at: Date) {
		fake.alarms.set(id, at);
	},
	async disarmSchedule(id: string) {
		fake.alarms.delete(id);
	},
}));
// This suite replaces provider generation; background title generation uses
// the same provider and must not leave SDK retries running between fixtures.
vi.mock("@/modules/threads/title", () => ({
	generateThreadTitle: async () => {},
}));
// Model delivery in Node. Each executor owns a connection and cancellation
// signal independent of RPCs; this harness does not simulate Durable Objects.
vi.mock("@/modules/runs/delivery", () => ({
	async armRun(runId: string) {
		if (fake.armFails) throw new Error("actor unreachable");
		fake.armed.push(runId);
	},
	async dispatchRun(runId: string) {
		if (fake.actors.has(runId)) return;
		const controller = new AbortController();
		fake.actors.set(runId, controller);
		const database = createDatabase();
		let entry = fake.locals.get(runId);
		if (!entry) {
			const fixture = localStorageFixture();
			entry = { local: new LocalRunStorage(fixture.storage), fixture };
			fake.locals.set(runId, entry);
		}
		const local = entry.local;
		const job = executeRun(database.db, runId, controller.signal, local)
			.then(async (waiting) => {
				// The run waits for the person; an answer dispatches it again.
				if (waiting) return;
				await local.archive(database.db);
				const current = await getRunById(database.db, runId);
				if (current) await publishRunState(database.db, current);
			})
			.finally(async () => {
				try {
					await database.close();
				} finally {
					fake.actors.delete(runId);
				}
			});
		fake.jobs.add(job);
		// Cleanup awaits the original promise and reports executor failures.
		void job.catch(() => {});
	},
	async activeRunSnapshot(runId: string) {
		const instance = await localOf(runId);
		const state = instance?.state();
		if (!state) return undefined;
		const local = fake.locals.get(runId)!.local;
		const parts = [];
		let after = -1;
		while (true) {
			const page = local.partsPage(state.commitSeq, after);
			if (!page.length) break;
			for (const part of page) {
				const omitted = omitPartBody(part, true);
				let body = "";
				let chunk = -1;
				while (!omitted && chunk + 1 < part.chunks) {
					const blocks = local.bodyPage(part, chunk);
					body += blocks.map((row) => row.data).join("");
					chunk = blocks.at(-1)!.idx;
				}
				parts.push(joinPart(part, body, omitted));
			}
			after = page.at(-1)!.ordinal;
		}
		return {
			run: publicRun(state.run),
			inputMessage: state.input,
			outputMessage: { ...state.output, parts },
			revision: state.run.revision,
		};
	},
	async activeToolResult(runId: string, _userId: string, callId: string) {
		const local = fake.locals.get(runId)?.local;
		if (!local) return undefined;
		let after = -1;
		while (true) {
			const parts = local.partsPage(local.state()!.commitSeq, after);
			if (!parts.length) return undefined;
			for (const part of parts)
				if (
					part.meta.content.case === "toolResult" &&
					part.meta.content.value.toolCallId === callId
				) {
					let body = "";
					let chunk = -1;
					while (chunk + 1 < part.chunks) {
						const blocks = local.bodyPage(part, chunk);
						body += blocks.map((row) => row.data).join("");
						chunk = blocks.at(-1)!.idx;
					}
					return joinPart(part, body);
				}
			after = parts.at(-1)!.ordinal;
		}
	},
	async activeTextSearch(runId: string, _userId: string, terms: string[]) {
		const local = fake.locals.get(runId)?.local;
		return local && scanText(local.textChunks(), terms);
	},
	async activeTextRead(
		runId: string,
		_userId: string,
		offset: number,
		limit: number,
	) {
		const local = fake.locals.get(runId)?.local;
		return local && sliceText(local.textChunks(), offset, limit);
	},
	// As the actor does: the execution that asked ends first, the answer is
	// recorded, and the run is woken.
	async answerRunToolCall(
		runId: string,
		_userId: string,
		callId: string,
		approved: boolean,
	) {
		await Promise.allSettled(fake.jobs);
		const local = await localOf(runId);
		const database = createDatabase();
		try {
			const run = await getRunById(database.db, runId);
			if (!run || !local) return false;
			const { answered } = await recordConsent(
				database.db,
				local,
				run,
				callId,
				approved ? "granted" : "refused",
			);
			if (answered) await dispatchRun(runId);
			return answered;
		} finally {
			await database.close();
		}
	},
	async cancelRunExecution(runId: string) {
		fake.actors.get(runId)?.abort();
		const database = createDatabase();
		try {
			const run = await getRunById(database.db, runId);
			if (run) await (await localOf(runId))?.observeControl(run);
		} finally {
			await database.close();
		}
	},
}));
async function localOf(runId: string) {
	let entry = fake.locals.get(runId);
	if (!entry) {
		const fixture = localStorageFixture();
		entry = { local: new LocalRunStorage(fixture.storage), fixture };
		fake.locals.set(runId, entry);
	}
	if (!entry.local.state()) {
		const database = createDatabase();
		try {
			const run = await getRunById(database.db, runId);
			if (!run) return undefined;
			const { input, output } = await loadRunMessages(database.db, run);
			await entry.local.initialize(run, input, output);
		} finally {
			await database.close();
		}
	}
	return entry.local;
}

// Each user's computer as the Worker reaches it: the connections it is asked
// to take, and the sessions whose connections it is asked to close.
const computers = vi.hoisted(() => ({
	requests: [] as { userId: string; request: Request }[],
	closed: [] as { userId: string; sessionId: string }[],
}));
vi.mock("@/modules/sandbox/machine", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/modules/sandbox/machine")>()),
	userMachine: (userId: string) => ({
		fetch: async (request: Request) => {
			computers.requests.push({ userId, request });
			return new Response("computer");
		},
		closeConnections: async (sessionId: string) => {
			computers.closed.push({ userId, sessionId });
		},
	}),
}));
// In "images" mode the run also has take_images, which stores two images:
// one it shows the person, one the model reads as its result; its text
// output is takeImages.output.
const takeImages = vi.hoisted(() => ({ output: "took" }));
vi.mock("@/modules/runs/tools", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/modules/runs/tools")>();
	const { composeToolSets, localToolSet } = await import("@/runtime/tools");
	const { storeFile } = await import("@/modules/files/service");
	const { fileReference } = await import("@/modules/files/types");
	return {
		runTools: (...args: Parameters<typeof actual.runTools>) => {
			const tools = actual.runTools(...args);
			// In "hang" mode the run also has hang, a call that runs until its
			// run's host stops.
			if (fake.mode === "hang")
				return composeToolSets([
					tools,
					localToolSet([
						{
							name: "hang",
							description: "hang",
							parameters: {
								type: "object",
								properties: {},
								additionalProperties: false,
							},
							readOnly: false,
							concurrent: false,
							execute: (_args, { signal }) =>
								new Promise((_resolve, reject) => {
									fake.hanging = true;
									signal.addEventListener(
										"abort",
										() => reject(signal.reason),
										{
											once: true,
										},
									);
								}),
						},
					]),
				]);
			// In "consent" mode the run also has send_out, which takes effect
			// outside and so waits for the person's consent.
			if (fake.mode === "consent")
				return composeToolSets([
					tools,
					localToolSet([
						{
							name: "send_out",
							description: "send_out",
							parameters: {
								type: "object",
								properties: {},
								additionalProperties: false,
							},
							readOnly: false,
							concurrent: false,
							consent: true,
							execute: async () => {
								fake.sent++;
								return { output: "sent" };
							},
						},
					]),
				]);
			if (fake.mode !== "images") return tools;
			const [db, run] = args;
			const store = async (fileName: string) =>
				fileReference(
					await storeFile(db, run.userId, {
						content: new Response(
							new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
						).body!,
						size: 8,
						fileName,
						mimeType: "image/png",
					}),
				);
			return composeToolSets([
				tools,
				localToolSet([
					{
						name: "take_images",
						description: "take_images",
						parameters: {
							type: "object",
							properties: {},
							additionalProperties: false,
						},
						readOnly: false,
						concurrent: false,
						execute: async () => ({
							output: takeImages.output,
							shown: [await store("shown.png")],
							images: [await store("viewed.png")],
						}),
					},
				]),
			]);
		},
	};
});
vi.mock("@/runtime/responses/cloudflare", () => ({
	createCloudflareResponses: (): StreamResponse =>
		async function* (input, { signal }) {
			fake.requests++;
			if (fake.mode === "images") {
				fake.inputs.push(structuredClone(input));
				if (
					!input.some(
						(item) => "type" in item && item.type === "function_call_output",
					)
				) {
					const call: ModelResponse = {
						id: crypto.randomUUID(),
						status: "completed",
						incomplete_details: null,
						usage: { output_tokens: 1 },
						output: [
							{
								type: "function_call",
								id: "fc-take",
								call_id: "take",
								name: "take_images",
								arguments: "{}",
								status: "completed",
							},
						],
					};
					yield* new ResponsesOutput().finish(call.output);
					yield { type: "response", response: call };
					return;
				}
			}
			if (
				fake.mode === "consent" &&
				!input.some(
					(item) => "type" in item && item.type === "function_call_output",
				)
			) {
				const call: ModelResponse = {
					id: crypto.randomUUID(),
					status: "completed",
					incomplete_details: null,
					usage: { output_tokens: 1 },
					output: [
						{
							type: "function_call",
							id: "fc-send",
							call_id: "send",
							name: "send_out",
							arguments: "{}",
							status: "completed",
						},
					],
				};
				yield* new ResponsesOutput().finish(call.output);
				yield { type: "response", response: call };
				return;
			}
			if (fake.mode === "hang") fake.inputs.push(structuredClone(input));
			if (
				fake.mode === "hang" &&
				!input.some(
					(item) => "type" in item && item.type === "function_call_output",
				)
			) {
				const call: ModelResponse = {
					id: crypto.randomUUID(),
					status: "completed",
					incomplete_details: null,
					usage: { output_tokens: 1 },
					output: [
						{
							type: "function_call",
							id: "fc-hang",
							call_id: "hang",
							name: "hang",
							arguments: "{}",
							status: "completed",
						},
					],
				};
				yield* new ResponsesOutput().finish(call.output);
				yield { type: "response", response: call };
				return;
			}
			if (fake.mode === "failure")
				throw new Error("private upstream credentials must not leak");
			// In "refused" mode the provider turns down the first request (a
			// rate limit) before generating anything; later ones go through.
			if (fake.mode === "refused" && fake.requests === 1) {
				const { ModelRequestRefused } =
					await import("@/runtime/responses/types");
				throw new ModelRequestRefused("The model provider refused", {
					cause: new Error("HTTP 429"),
				});
			}
			if (fake.mode === "pause") {
				const text: ModelText = {
					id: crypto.randomUUID(),
					modelMessageId: crypto.randomUUID(),
					contentIndex: 0,
					text: "",
					phase: "final_answer",
					status: "in_progress",
					refusal: false,
				};
				yield { type: "textSnapshot", text };
				yield { type: "textDelta", textId: text.id, delta: "partial answer" };
				// No more provider events arrive until explicitly released or cancelled.
				await new Promise<void>((resolve, reject) => {
					const cleanup = () => {
						signal.removeEventListener("abort", onAbort);
						fake.release = undefined;
					};
					const onAbort = () => {
						cleanup();
						reject(signal.reason);
					};
					fake.release = () => {
						cleanup();
						resolve();
					};
					signal.addEventListener("abort", onAbort, { once: true });
					if (signal.aborted) onAbort();
				});
				yield {
					type: "textSnapshot",
					text: { ...text, text: "final answer", status: "completed" },
				};
				yield {
					type: "response",
					response: {
						id: crypto.randomUUID(),
						status: "completed",
						incomplete_details: null,
						usage: { output_tokens: 10 },
						output: [
							{
								type: "message",
								id: text.modelMessageId,
								role: "assistant",
								status: "completed",
								phase: "final_answer",
								content: [
									{
										type: "output_text",
										text: "final answer",
										annotations: [],
									},
								],
							},
						],
					},
				};
				return;
			}
			const response: ModelResponse = {
				id: crypto.randomUUID(),
				status: "completed",
				incomplete_details: null,
				usage: { output_tokens: 10 },
				output: [
					{
						type: "reasoning",
						id: crypto.randomUUID(),
						summary: [],
						encrypted_content: "fixture-encrypted-reasoning",
					},
					{
						type: "message",
						id: crypto.randomUUID(),
						role: "assistant",
						status: "completed",
						phase: "commentary",
						content: [
							{ type: "output_text", text: "progress", annotations: [] },
						],
					},
					{
						type: "message",
						id: crypto.randomUUID(),
						role: "assistant",
						status: "completed",
						phase: "final_answer",
						content: [
							{ type: "output_text", text: "final answer", annotations: [] },
						],
					},
				],
			};
			yield* new ResponsesOutput().finish(response.output);
			yield { type: "response", response };
		},
}));

const url = process.env.TEST_DATABASE_URL;
// Uploads must carry a real image signature.
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
async function settleExecutors() {
	for (const controller of fake.actors.values()) controller.abort();
	const jobs = [...fake.jobs];
	fake.jobs.clear();
	await Promise.all(jobs);
}
const active = (run: Run) =>
	run.status === RunStatus.QUEUED || run.status === RunStatus.RUNNING;
// This suite uses only the explicitly supplied disposable PostgreSQL database.
describe.skipIf(!url)("PostgreSQL + Connect integration", () => {
	// The same driver as the Worker's (db/client.ts).
	const pool = new Pool({
		connectionString: url ?? "postgresql://unused",
		max: 5,
	});
	const db = drizzle({ client: pool });
	const put = vi.fn(async () => ({})),
		get = vi.fn<(key: string) => Promise<unknown>>(async () => null),
		remove = vi.fn(async () => {}),
		sendEmail = vi.fn(async () => {});
	const pending: Promise<unknown>[] = [];
	// Each user's hub, as the Durable Object would receive it: frames are
	// decoded with the generated schema, so the encoding path is real.
	const hub = {
		closeFails: false,
		events: [] as { userId: string; event: UserEvent }[],
		endedSessions: [] as { userId: string; sessionId: string }[],
		requests: [] as { userId: string; request: Request }[],
	};
	const eventsOf = (userId: string) =>
		hub.events
			.filter((item) => item.userId === userId)
			.map((item) => item.event);
	// A signed-in browser: its session cookie ("name=value") and the account
	// its pages act for.
	interface TestSession {
		cookie: string;
		userId: string;
	}
	let ownerSession: TestSession, otherSession: TestSession;
	const sessionHeaders = (session: TestSession) => ({
		cookie: session.cookie,
		[actingUserHeader]: session.userId,
	});
	// Calls as a signed-in browser (`session`) or anyone, from `address` as
	// Cloudflare reports the caller's.
	function transport(session?: TestSession, address?: string) {
		return createConnectTransport({
			baseUrl: "https://test.invalid",
			interceptors: [
				(next) => async (req) => {
					if (session)
						for (const [name, value] of Object.entries(sessionHeaders(session)))
							req.header.set(name, value);
					if (address) req.header.set("CF-Connecting-IP", address);
					return next(req);
				},
			],
			fetch: (input, init) =>
				handler.fetch(new Request(input, init), env, {
					waitUntil: (promise: Promise<unknown>) => pending.push(promise),
				} as unknown as ExecutionContext),
		});
	}
	// Uploads the way the app does: POST /upload with the file as the body.
	async function upload(
		file: { content: Uint8Array; mimeType: string; fileName: string },
		session = ownerSession,
	) {
		const response = await uploadFile(
			new Request(
				`https://test.invalid/upload?name=${encodeURIComponent(file.fileName)}`,
				{
					method: "POST",
					headers: {
						...sessionHeaders(session),
						"content-type": file.mimeType,
						"content-length": String(file.content.length),
					},
					body: file.content,
				},
			),
		);
		const body: JsonValue = await response.json();
		if (!response.ok)
			throw Object.assign(new Error("Upload failed"), {
				status: response.status,
				...(body as object),
			});
		return fromJson(FileSchema, body);
	}
	function clients(session = ownerSession) {
		const t = transport(session);
		return {
			thread: createClient(ThreadService, t),
			turn: createClient(TurnService, t),
			run: createClient(RunService, t),
			file: createClient(FileService, t),
			auth: createClient(AuthService, t),
			memory: createClient(MemoryService, t),
			model: createClient(ModelService, t),
			computer: createClient(ComputerService, t),
			mail: createClient(MailService, t),
		};
	}
	const publicAuth = createClient(AuthService, transport());
	// Signs in the way people do: request a code, read it from the mail, send
	// it back with its challenge.
	async function sentCode(email: string, client = publicAuth) {
		const { challenge } = await client.sendSignInCode({
			email,
		});
		const [sent] = await db
			.select()
			.from(verificationCodes)
			.where(eq(verificationCodes.id, challenge));
		return { challenge, code: sent.code };
	}
	async function signInAs(email: string) {
		let setCookie = "";
		const { user } = await publicAuth.signInWithEmailCode(
			await sentCode(email),
			{ onHeader: (headers) => (setCookie = headers.get("set-cookie") ?? "") },
		);
		if (!user || !setCookie) throw new Error("Missing session");
		return {
			cookie: setCookie.split(";")[0],
			userId: user.id,
			user,
			setCookie,
		};
	}
	// The ID of a signed-in browser's session, which only the server knows.
	async function sessionIdOf(session: TestSession) {
		const [row] = await db
			.select({ id: sessions.id })
			.from(sessions)
			.where(
				eq(sessions.tokenHash, await sha256(session.cookie.split("=")[1])),
			);
		return row?.id;
	}
	// StartTurn creates conversations; fixtures seed empty threads directly.
	async function thread(title = "test") {
		const [row] = await db
			.insert(threads)
			.values({ userId: "owner", title })
			.returning();
		return row.id;
	}
	// A run's record of its operations, which only the server reads.
	const stepsOf = async (runId: string) => {
		const local = fake.locals.get(runId)?.local;
		if (local && !local.state()?.seal) return local.steps();
		return db
			.select()
			.from(steps)
			.where(eq(steps.runId, runId))
			.orderBy(asc(steps.index));
	};
	async function snapshot(
		runId: string,
		client: Client<typeof RunService> = clients().run,
	) {
		const { snapshot } = await client.getRun({ runId });
		if (!snapshot?.run) throw new Error("Missing run snapshot");
		return snapshot;
	}
	async function finishRun(
		started: RunSnapshot | undefined,
		client: Client<typeof RunService> = clients().run,
	) {
		if (!started?.run) throw new Error("Missing accepted run");
		const runId = started.run.id;
		// The executor runs in this process; wait for its terminal commit.
		let current = started;
		await vi.waitFor(
			async () => {
				current = await snapshot(runId, client);
				expect(current.run && active(current.run)).toBe(false);
			},
			{ timeout: 10_000, interval: 20 },
		);
		return current;
	}
	async function run(threadId: string, requestId = crypto.randomUUID()) {
		const client = clients().run;
		const accepted = await clients().turn.startTurn({
			threadId,
			requestId,
			input: { text: "research" },
		});
		return finishRun(accepted.snapshot, client);
	}
	const terminal = (snapshot: RunSnapshot): Run => {
		if (!snapshot.run || active(snapshot.run))
			throw new Error("Missing terminal run");
		return snapshot.run;
	};
	beforeAll(async () => {
		Object.assign(env, {
			HYPERDRIVE: { connectionString: url },
			EMAIL_FROM: "test@example.com",
			BUCKET: { put, get, delete: remove },
			EMAIL: { send: sendEmail },
			AGENT_MAIL_DOMAIN: "agent.test",
			USER_HUBS: {
				getByName: (userId: string) => ({
					publish: async (frames: Uint8Array[]) => {
						for (const frame of frames)
							hub.events.push({
								userId,
								event: fromBinary(UserEventSchema, frame),
							});
					},
					closeSession: async (sessionId: string) => {
						if (hub.closeFails) throw new Error("Hub unavailable");
						hub.endedSessions.push({ userId, sessionId });
					},
					fetch: async (request: Request) => {
						hub.requests.push({ userId, request });
						return new Response("hub");
					},
				}),
			},
		});
		await migrate(db, { migrationsFolder: "drizzle/migrations" });
	});
	beforeEach(async () => {
		await settleExecutors();
		for (const entry of fake.locals.values()) entry.fixture.close();
		fake.locals.clear();
		await Promise.all(pending.splice(0));
		await pool.query(
			"TRUNCATE users,threads,messages,runs,files,verification_codes,sessions,memories,avatar_garbage RESTART IDENTITY CASCADE",
		);
		fake.mode = "normal";
		fake.alarms.clear();
		fake.requests = 0;
		fake.inputs = [];
		fake.release = undefined;
		put.mockClear();
		get.mockReset();
		get.mockImplementation(async () => null);
		remove.mockClear();
		sendEmail.mockClear();
		for (const [id, email] of [
			["owner", "owner@example.com"],
			["other", "other@example.com"],
		])
			await db.insert(users).values({ id, email, username: id });
		ownerSession = await signInAs("owner@example.com");
		otherSession = await signInAs("other@example.com");
		hub.events.length = 0;
		hub.closeFails = false;
		hub.endedSessions.length = 0;
		computers.requests.length = 0;
		computers.closed.length = 0;
		hub.requests.length = 0;
	});
	afterEach(async () => {
		await settleExecutors();
		await Promise.all(pending.splice(0));
	});
	afterAll(async () => {
		try {
			await settleExecutors();
			await Promise.all(pending);
		} finally {
			await pool.end();
		}
	});

	test("native targets stay owned and immutable across replay, retry and revocation", async () => {
		const deviceId = crypto.randomUUID();
		await db.insert(devices).values({
			id: deviceId,
			userId: "owner",
			clientId: crypto.randomUUID(),
			name: "QA Mac",
			platform: "macos",
			osVersion: "macOS QA",
			workspacePath: "/tmp/qa",
			tokenHash: "test-only",
		});
		const prepare = (userId: string, input: RunInput) =>
			prepareRun(
				db,
				userId,
				input,
				{
					id: crypto.randomUUID(),
					armedAt: Date.now(),
					ready: Promise.resolve(),
				},
				new AbortController().signal,
			);
		const input: RunInput = {
			requestId: crypto.randomUUID(),
			modelId: "",
			input: {
				case: "newTurn",
				value: { threadId: "", text: "native target", fileIds: [], deviceId },
			},
		};
		await expect(
			prepare("other", { ...input, requestId: crypto.randomUUID() }),
		).rejects.toMatchObject({ code: ErrorCode.NotFound });
		const first = await prepare("owner", input);
		expect(first.run.deviceId).toBe(deviceId);
		await expect(
			prepare("owner", {
				...input,
				input: {
					case: "newTurn",
					value: {
						threadId: "",
						text: "native target",
						fileIds: [],
						deviceId: "",
					},
				},
			}),
		).rejects.toMatchObject({ code: ErrorCode.AlreadyExists });
		await db
			.update(runs)
			.set({ status: StoredRunStatus.COMPLETED, finishedAt: new Date() })
			.where(eq(runs.id, first.run.id));
		const retried = await prepare("owner", {
			requestId: crypto.randomUUID(),
			modelId: "",
			input: {
				case: "retryTurn",
				value: { turnId: first.run.turnId, previousRunId: first.run.id },
			},
		});
		expect(retried.run.deviceId).toBe(deviceId);
		await db
			.update(devices)
			.set({ revokedAt: new Date() })
			.where(eq(devices.id, deviceId));
		const replay = await prepare("owner", input);
		expect(replay.run.id).toBe(first.run.id);
		expect(replay.run.deviceId).toBe(deviceId);
		await expect(
			prepare("owner", { ...input, requestId: crypto.randomUUID() }),
		).rejects.toMatchObject({ code: ErrorCode.NotFound });
	});

	test("runs preserve message boundaries, are idempotent, and regenerate without duplicating user input", async () => {
		const id = await thread(),
			requestId = crypto.randomUUID();
		const firstSnapshot = await run(id, requestId);
		const first = terminal(firstSnapshot);
		expect(first.status).toBe(RunStatus.COMPLETED);
		expect(first.attempt).toBe(1);
		expect(firstSnapshot.inputMessage?.turnId).toBe(first.turnId);
		expect(firstSnapshot.inputMessage?.runId).toBe("");
		expect(firstSnapshot.outputMessage?.runId).toBe(first.id);
		expect(await stepsOf(first.id)).toMatchObject([
			{
				index: 1,
				kind: StepKind.MODEL,
				status: StepStatus.COMPLETED,
				inputTokens: null,
				outputTokens: 10,
			},
		]);
		expect(fake.requests).toBe(1);
		const initial = await clients().thread.listMessages({ threadId: id });
		expect(initial.messages.map((message) => message.role)).toEqual([
			MessageRole.USER,
			MessageRole.ASSISTANT,
		]);
		expect(initial.messages[1].parts.map((part) => part.content)).toEqual([
			{ case: "text", value: "progress" },
			{ case: "text", value: "final answer" },
		]);
		expect(
			initial.messages[1].parts.map((part) => part.assistantText?.phase),
		).toEqual([MessagePhase.COMMENTARY, MessagePhase.FINAL_ANSWER]);
		expect(terminal(await run(id, requestId)).id).toBe(first.id);
		expect(fake.requests).toBe(1);
		const accepted = await clients().turn.retryTurn({
			turnId: first.turnId,
			previousRunId: first.id,
			requestId: crypto.randomUUID(),
		});
		const next = terminal(await finishRun(accepted.snapshot));
		expect(next.id).not.toBe(first.id);
		expect(next.turnId).toBe(first.turnId);
		expect(next.attempt).toBe(first.attempt + 1);
		const attempts = await db
			.select({ id: runs.id })
			.from(runs)
			.where(eq(runs.turnId, first.turnId))
			.orderBy(desc(runs.id));
		expect(attempts.map((attempt) => attempt.id)).toEqual([next.id, first.id]);
		const current = await clients().thread.listMessages({ threadId: id });
		expect(current.messages).toHaveLength(2);
		// The turn shows its latest attempt's reply, which carries its run as
		// of the same read: a run change applies to it at the next revision.
		const latest = await snapshot(next.id);
		expect(current.messages[1]).toMatchObject({
			runId: next.id,
			runStatus: RunStatus.COMPLETED,
			runAttempt: next.attempt,
			runCancelRequested: false,
			runRevision: latest.revision,
		});
		expect(latest.outputMessage?.runRevision).toBe(latest.revision);
		expect(await db.select().from(messages)).toHaveLength(3);
		expect(
			await db.select().from(turns).where(eq(turns.threadId, id)),
		).toHaveLength(1);
		expect((await snapshot(first.id)).run?.status).toBe(RunStatus.COMPLETED);
	});
	test("active output is written to SQLite and final bodies are archived once", async () => {
		fake.mode = "pause";
		const accepted = await clients().turn.startTurn({
			threadId: await thread(),
			requestId: crypto.randomUUID(),
			input: { text: "hello" },
		});
		const id = accepted.snapshot!.run!.id;
		await vi.waitFor(async () =>
			expect((await snapshot(id)).run?.status).toBe(RunStatus.RUNNING),
		);
		const [placeholder] = await db
			.select()
			.from(messages)
			.where(eq(messages.runId, id));
		expect(placeholder.parts).toEqual([]);
		expect(placeholder.text).toBe("");
		await vi.waitFor(() =>
			expect(fake.locals.get(id)!.local.checkpoint()?.phase).toBe("model"),
		);
		await vi.waitFor(() => expect(fake.release).toBeDefined());
		fake.release!();
		const finished = await finishRun(accepted.snapshot);
		expect(finished.outputMessage?.parts.length).toBeGreaterThan(0);
		expect(fake.locals.get(id)!.local.state()?.seal).toBeDefined();
		const [archive] = await db
			.select()
			.from(messages)
			.where(eq(messages.runId, id));
		expect(archive.parts).toEqual([]);
		expect(archive.text).toContain("final answer");
	});

	test("a replay waits for active output without holding a PostgreSQL Run lock", async () => {
		fake.mode = "pause";
		const request = {
			threadId: await thread(),
			requestId: crypto.randomUUID(),
			input: { text: "start" },
		};
		const accepted = await clients().turn.startTurn(request);
		const id = accepted.snapshot!.run!.id;
		await vi.waitFor(async () =>
			expect((await snapshot(id)).outputMessage?.parts[0]?.content).toEqual({
				case: "text",
				value: "partial answer",
			}),
		);
		const entered = Promise.withResolvers<void>();
		const resume = Promise.withResolvers<void>();
		const original = runDelivery.activeRunSnapshot;
		const spy = vi
			.spyOn(runDelivery, "activeRunSnapshot")
			.mockImplementation(async (...args) => {
				entered.resolve();
				await resume.promise;
				return original(...args);
			});
		const replay = clients().turn.startTurn(request);
		try {
			await entered.promise;
			await db.transaction(async (tx) => {
				await tx.execute(sql`set local lock_timeout='250ms'`);
				await tx
					.update(runs)
					.set({ error: "lock probe" })
					.where(eq(runs.id, id));
			});
		} finally {
			resume.resolve();
			spy.mockRestore();
		}
		const result = await replay;
		expect(result.snapshot?.run?.id).toBe(id);
		expect(result.snapshot?.outputMessage?.parts[0]?.content).toEqual({
			case: "text",
			value: "partial answer",
		});
		fake.release!();
		await finishRun(accepted.snapshot);
	});

	test("conversation tools read committed active text and follow the final archive", async () => {
		fake.mode = "pause";
		const threadId = await thread("active text");
		const accepted = await clients().turn.startTurn({
			threadId,
			requestId: crypto.randomUUID(),
			input: { text: "start" },
		});
		const id = accepted.snapshot!.run!.id;
		await vi.waitFor(async () =>
			expect((await snapshot(id)).outputMessage?.parts[0]?.content).toEqual({
				case: "text",
				value: "partial answer",
			}),
		);
		expect(
			(await searchConversations(db, "owner", "partial"))[0],
		).toMatchObject({
			id: threadId,
			snippets: [{ role: "assistant", text: "partial answer" }],
		});
		expect(
			(await readConversation(db, "owner", threadId)).messages.map(
				(row) => row.text,
			),
		).toEqual(["start", "partial answer"]);
		expect(await searchConversations(db, "other", "partial")).toEqual([]);
		fake.release!();
		await finishRun(accepted.snapshot);
		expect(
			(await readConversation(db, "owner", threadId)).messages.map(
				(row) => row.text,
			),
		).toEqual(["start", "final answer"]);
	});

	test("StartTurn without a thread creates one conversation per request ID", async () => {
		const requestId = crypto.randomUUID();
		const text =
			"请帮我总结一下这篇关于分布式系统一致性模型的论文，重点说明线性一致性和因果一致性的区别";
		const request = { threadId: "", requestId, input: { text } };
		const accepted = await clients().turn.startTurn(request);
		const threadId = accepted.snapshot?.run?.threadId;
		if (!threadId) throw new Error("Missing created thread ID");
		expect(accepted.thread?.id).toBe(threadId);
		// Created with its first reply being written.
		expect(accepted.thread?.running).toBe(true);
		expect(accepted.snapshot?.inputMessage?.threadId).toBe(threadId);
		const { thread: created } = await clients().thread.getThread({ threadId });
		expect(created?.title).toBe(Array.from(text).slice(0, 40).join(""));
		const completed = terminal(await finishRun(accepted.snapshot));
		expect(completed.status).toBe(RunStatus.COMPLETED);
		// A lost response is replayed with the same payload: same thread and run.
		const replay = await clients().turn.startTurn(request);
		expect(replay.snapshot?.run?.id).toBe(completed.id);
		expect(replay.snapshot?.run?.threadId).toBe(threadId);
		expect(replay.snapshot?.run?.turnId).toBe(accepted.snapshot?.run?.turnId);
		expect(replay.thread?.id).toBe(threadId);
		// Read again as it is now, the reply written.
		expect(replay.thread?.running).toBe(false);
		expect(fake.requests).toBe(1);
		await expect(
			clients().turn.startTurn({ ...request, input: { text: "different" } }),
		).rejects.toMatchObject({ code: Code.AlreadyExists });
		// The same payload under a thread ID is a different command.
		await expect(
			clients().turn.startTurn({ ...request, threadId }),
		).rejects.toMatchObject({ code: Code.AlreadyExists });
		const listed = await clients().thread.listThreads({});
		expect(listed.threads.map((item) => item.id)).toEqual([threadId]);
		// A rejected command leaves no conversation behind.
		await expect(
			clients().turn.startTurn({
				threadId: "",
				requestId: crypto.randomUUID(),
				input: { fileIds: ["missing-file"] },
			}),
		).rejects.toMatchObject({ code: Code.NotFound });
		expect((await clients().thread.listThreads({})).threads).toHaveLength(1);
	});
	test("request IDs reject changed payloads and resource ownership is enforced", async () => {
		const id = await thread(),
			requestId = crypto.randomUUID();
		await run(id, requestId);
		await expect(
			clients().turn.startTurn({
				threadId: id,
				requestId,
				input: { text: "different" },
			}),
		).rejects.toMatchObject({ code: Code.AlreadyExists });
		await expect(
			clients(otherSession).turn.startTurn({
				threadId: id,
				requestId: crypto.randomUUID(),
				input: { text: "hi" },
			}),
		).rejects.toMatchObject({ code: Code.NotFound });
		await expect(
			clients(otherSession).thread.listMessages({ threadId: id }),
		).rejects.toMatchObject({ code: Code.NotFound });
		await expect(
			clients(otherSession).thread.updateThread({
				thread: { id, title: "forged" },
				updateMask: { paths: ["title"] },
			}),
		).rejects.toMatchObject({ code: Code.NotFound });
		await expect(
			clients(otherSession).thread.deleteThread({ threadId: id }),
		).rejects.toMatchObject({ code: Code.NotFound });
		const file = await upload(
			{ content: png, mimeType: "image/png", fileName: "other.png" },
			otherSession,
		);
		await expect(
			clients().turn.startTurn({
				threadId: id,
				requestId: crypto.randomUUID(),
				input: { fileIds: [file?.id ?? ""] },
			}),
		).rejects.toMatchObject({ code: Code.NotFound });
	});
	// No sweep finds a run whose dispatch was lost: the run it commits is the
	// one its actor was armed for beforehand.
	test("a turn is accepted only after its run's actor is armed, for that run", async () => {
		const id = await thread();
		const send = () =>
			clients().turn.startTurn({
				threadId: id,
				requestId: crypto.randomUUID(),
				input: { text: "hello" },
			});
		fake.armFails = true;
		await expect(send()).rejects.toMatchObject({ code: Code.Unavailable });
		fake.armFails = false;
		expect(
			await db.select().from(runs).where(eq(runs.threadId, id)),
		).toHaveLength(0);
		const accepted = await send();
		expect(fake.armed.at(-1)).toBe(accepted.snapshot?.run?.id);
		await Promise.allSettled(fake.jobs);
	});
	test("deleting a conversation stops the reply being written in it", async () => {
		fake.mode = "pause";
		const id = await thread();
		const accepted = await clients().turn.startTurn({
			threadId: id,
			requestId: crypto.randomUUID(),
			input: { text: "slow" },
		});
		const runId = accepted.snapshot?.run?.id ?? "";
		await vi.waitFor(
			async () => {
				expect(
					(await snapshot(runId)).outputMessage?.parts[0]?.content,
				).toEqual({ case: "text", value: "partial answer" });
			},
			{ timeout: 3000 },
		);
		const running = [...fake.jobs];
		await clients().thread.deleteThread({ threadId: id });
		// Its execution was told, and ends without an error: nothing is left
		// to save or to retry.
		const settled = await Promise.allSettled(running);
		expect(settled.map((result) => result.status)).toEqual(["fulfilled"]);
		expect(await db.select().from(runs).where(eq(runs.id, runId))).toEqual([]);
	});
	test("a user has one main conversation: two devices asking at once make one, and it is neither listed nor deleted", async () => {
		const [first, second] = await Promise.all([
			clients().thread.getMainThread({}),
			clients().thread.getMainThread({}),
		]);
		const id = first.thread?.id ?? "";
		expect(first.thread?.main).toBe(true);
		expect(second.thread?.id).toBe(id);
		expect(
			(await db.select().from(threads).where(eq(threads.userId, "owner")))
				.filter((thread) => thread.main)
				.map((thread) => thread.id),
		).toEqual([id]);
		// The side nav's list is of side conversations.
		const listed = await clients().thread.listThreads({});
		expect(listed.threads.map((thread) => thread.id)).not.toContain(id);
		await expect(
			clients().thread.deleteThread({ threadId: id }),
		).rejects.toMatchObject({ code: Code.FailedPrecondition });
		await expect(
			clients().thread.updateThread({
				thread: { id, title: "renamed" },
				updateMask: { paths: ["title"] },
			}),
		).rejects.toMatchObject({ code: Code.FailedPrecondition });
		// Each account has its own.
		const other = await clients(otherSession).thread.getMainThread({});
		expect(other.thread?.id).not.toBe(id);
	});
	test("a run's progress reaches the user's devices in commit order; a duplicate StartTurn changes nothing", async () => {
		fake.mode = "pause";
		const id = await thread();
		const request = {
			threadId: id,
			requestId: crypto.randomUUID(),
			input: { text: "slow" },
		};
		const accepted = await clients().turn.startTurn(request);
		const runId = accepted.snapshot?.run?.id;
		if (!runId) throw new Error("Missing run ID");
		await vi.waitFor(
			async () => {
				expect(
					(await snapshot(runId)).outputMessage?.parts[0]?.content,
				).toEqual({ case: "text", value: "partial answer" });
			},
			{ timeout: 3000 },
		);
		// Acceptance: the conversation's new activity (its time, not its
		// record: a copy read at acceptance could land after a rename that
		// waited for it), then the new attempt as a snapshot.
		const [moved, created] = eventsOf("owner");
		expect(moved.event).toMatchObject({
			case: "threadActivity",
			value: { threadId: id, activeTime: accepted.snapshot?.run?.createTime },
		});
		expect(
			eventsOf("owner").some((event) => event.event.case === "thread"),
		).toBe(false);
		expect(created.event).toMatchObject({
			case: "run",
			value: {
				runId,
				event: {
					case: "snapshot",
					value: { revision: accepted.snapshot?.revision },
				},
			},
		});
		const current = await snapshot(runId);
		const [runningStep] = await stepsOf(runId);
		const published = eventsOf("owner").length;
		const duplicate = await clients().turn.startTurn(request);
		expect(duplicate.snapshot?.run?.id).toBe(runId);
		expect(duplicate.snapshot?.revision).toBe(current.revision);
		expect(eventsOf("owner")).toHaveLength(published);
		expect(fake.requests).toBe(1);
		const release = fake.release;
		if (!release) throw new Error("Model fixture is not paused");
		release();
		const completed = await finishRun(accepted.snapshot);
		// After the snapshot, every commit arrives once, in revision order.
		const runEventsOf = () =>
			eventsOf("owner").flatMap((event) =>
				event.event.case === "run" ? [event.event.value] : [],
			);
		// PG's terminal transaction is visible before the actor publishes its
		// final event. Await that event before inspecting its complete sequence.
		await vi.waitFor(() =>
			expect(runEventsOf().at(-1)?.event).toMatchObject({
				case: "snapshot",
				value: { revision: completed.revision },
			}),
		);
		const runEvents = runEventsOf();
		const changes = runEvents.slice(1);
		expect(changes.map((event) => event.event.case)).toEqual([
			...changes.slice(0, -1).map(() => "change"),
			"snapshot",
		]);
		const revisionOf = (event: RunEvent) =>
			event.event.case === "snapshot" || event.event.case === "change"
				? event.event.value.revision
				: undefined;
		expect(changes.map(revisionOf)).toEqual(
			changes.map((_, index) => (revisionOf(runEvents[0]) ?? 0) + index + 1),
		);
		expect(revisionOf(changes.at(-1) as RunEvent)).toBe(completed.revision);
		const last = changes.at(-1)?.event;
		expect(last?.case === "snapshot" && last.value.run?.status).toBe(
			RunStatus.COMPLETED,
		);
		expect(
			changes
				.flatMap((event) =>
					event.event.case === "change" ? event.event.value.changes : [],
				)
				.some(
					(part) =>
						part.change.case === "part" &&
						part.change.value.content.case === "text" &&
						part.change.value.content.value === "final answer",
				),
		).toBe(true);
		// Nothing reaches another user's devices.
		expect(eventsOf("other")).toHaveLength(0);
		// The step keeps its identity from start to end.
		const [finishedStep] = await stepsOf(runId);
		expect(finishedStep.id).toBe(runningStep.id);
		expect(finishedStep.status).toBe(StepStatus.COMPLETED);
		expect(fake.locals.get(runId)!.local.checkpoint()).toBeUndefined();
	});
	test("explicit CancelRun saves partial output, releases the active run, and prevents concurrent generation/deletion", async () => {
		fake.mode = "pause";
		const id = await thread(),
			requestId = crypto.randomUUID();
		const accepted = await clients().turn.startTurn({
			threadId: id,
			requestId,
			input: { text: "slow" },
		});
		const runId = accepted.snapshot?.run?.id;
		if (!runId) throw new Error("Missing run ID");
		await vi.waitFor(
			async () => {
				expect(
					(await snapshot(runId)).outputMessage?.parts[0]?.content,
				).toEqual({ case: "text", value: "partial answer" });
			},
			{ timeout: 3000 },
		);
		await expect(run(id)).rejects.toMatchObject({
			code: Code.FailedPrecondition,
		});
		await expect(
			clients(otherSession).run.cancelRun({
				lookup: { case: "runId", value: runId },
			}),
		).rejects.toMatchObject({ code: Code.NotFound });
		await expect(
			snapshot(runId, clients(otherSession).run),
		).rejects.toMatchObject({ code: Code.NotFound });
		const cancelled = await clients().run.cancelRun({
			lookup: { case: "requestId", value: requestId },
		});
		expect(cancelled.snapshot?.run?.cancelRequested).toBe(true);
		await vi.waitFor(
			async () => {
				expect((await snapshot(runId)).run?.status).toBe(RunStatus.CANCELLED);
			},
			{ timeout: 3000 },
		);
		const history = await clients().thread.listMessages({ threadId: id });
		expect((await stepsOf(runId))[0].status).toBe(StepStatus.CANCELLED);
		expect(history.messages[1].parts[0].content).toEqual({
			case: "text",
			value: "partial answer",
		});
		fake.mode = "normal";
		expect(terminal(await run(id)).status).toBe(RunStatus.COMPLETED);
	});
	test("a send stopped before the server took it is withdrawn, and never taken after", async () => {
		const id = await thread();
		const withdrawn = {
			code: Code.NotFound,
			details: [expect.anything()],
		};
		const reasonOf = (error: unknown) =>
			(error as ConnectError).findDetails(ErrorDetailSchema)[0]?.reason;
		// Stopped first: the send is withdrawn, and its copy arriving later is
		// refused and leaves nothing.
		const requestId = crypto.randomUUID();
		const stop = await clients()
			.run.cancelRun({ lookup: { case: "requestId", value: requestId } })
			.catch((error: unknown) => error);
		expect(stop).toMatchObject(withdrawn);
		expect(reasonOf(stop)).toBe(ErrorReason.REQUEST_WITHDRAWN);
		const late = await clients()
			.turn.startTurn({ threadId: id, requestId, input: { text: "late" } })
			.catch((error: unknown) => error);
		expect(late).toMatchObject({ code: Code.FailedPrecondition });
		expect(reasonOf(late)).toBe(ErrorReason.REQUEST_WITHDRAWN);
		expect(
			await db.select().from(runs).where(eq(runs.requestId, requestId)),
		).toEqual([]);
		// Racing, the two agree: either the send is withdrawn and refused, or
		// it is taken and the stop stops its reply.
		for (let round = 0; round < 5; round++) {
			const racing = crypto.randomUUID();
			const [started, stopped] = await Promise.allSettled([
				clients().turn.startTurn({
					threadId: id,
					requestId: racing,
					input: { text: "race" },
				}),
				clients().run.cancelRun({
					lookup: { case: "requestId", value: racing },
				}),
			]);
			const taken = await db
				.select()
				.from(runs)
				.where(eq(runs.requestId, racing));
			if (stopped.status === "rejected") {
				expect(reasonOf(stopped.reason)).toBe(ErrorReason.REQUEST_WITHDRAWN);
				expect(started.status).toBe("rejected");
				expect(taken).toEqual([]);
			} else {
				expect(started.status).toBe("fulfilled");
				expect(taken[0]?.cancelRequested).toBe(true);
			}
			await settleExecutors();
		}
	});
	test("attachments get paths of their own on the computer, in their message's folder", async () => {
		const csv = new TextEncoder().encode("a,b\n1,2\n");
		const first = await upload({
			content: csv,
			mimeType: "text/csv",
			fileName: "data.csv",
		});
		const second = await upload({
			content: csv,
			mimeType: "text/csv",
			fileName: "data.csv",
		});
		const odd = await upload({
			content: csv,
			mimeType: "text/csv",
			fileName: "../../etc/passwd",
		});
		const accepted = await clients().turn.startTurn({
			threadId: "",
			requestId: crypto.randomUUID(),
			input: { text: "sum these", fileIds: [first.id, second.id, odd.id] },
		});
		await finishRun(accepted.snapshot);
		const { messages: sent } = await clients().thread.listMessages({
			threadId: accepted.snapshot?.run?.threadId ?? "",
		});
		expect(
			sent[0].parts.flatMap((part) =>
				part.content.case === "file" ? [part.content.value.workspacePath] : [],
			),
		).toEqual([
			`/workspace/uploads/${sent[0].id}/data.csv`,
			`/workspace/uploads/${sent[0].id}/data (2).csv`,
			`/workspace/uploads/${sent[0].id}/.._.._etc_passwd`,
		]);
		// Files the model reads itself are limited in a message; others are not.
		const large = new Uint8Array(21 * 1024 * 1024);
		large.set(new TextEncoder().encode("%PDF-"));
		const pdf = await upload({
			content: large,
			mimeType: "application/pdf",
			fileName: "big.pdf",
		});
		await expect(
			clients().turn.startTurn({
				threadId: "",
				requestId: crypto.randomUUID(),
				input: { fileIds: [pdf.id] },
			}),
		).rejects.toMatchObject({ code: Code.InvalidArgument });
		const archive = await upload({
			content: large,
			mimeType: "application/zip",
			fileName: "big.zip",
		});
		// A file declared as a PDF is typed by its start: this one is a PDF.
		expect(archive.mimeType).toBe("application/pdf");
		const data = await upload({
			content: new Uint8Array(21 * 1024 * 1024),
			mimeType: "text/csv",
			fileName: "big.csv",
		});
		const bigSend = await clients().turn.startTurn({
			threadId: "",
			requestId: crypto.randomUUID(),
			input: { fileIds: [data.id] },
		});
		expect(terminal(await finishRun(bigSend.snapshot)).status).toBe(
			RunStatus.COMPLETED,
		);
	});
	// A run's start holds its conversation's row while it records the run and
	// moves the conversation's activity to it (prepareRun). A rename meanwhile
	// waits, then must describe the conversation as it is after: moved, and
	// with a reply being written.
	test("a rename that waited for a run's start lists the reply being written", async () => {
		const id = await thread();
		const finished = terminal(await run(id));
		const startedAt = new Date(Date.now() + 1000);
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let locked!: () => void;
		const isLocked = new Promise<void>((resolve) => {
			locked = resolve;
		});
		const starting = db.transaction(async (tx) => {
			await tx
				.select({ id: threads.id })
				.from(threads)
				.where(eq(threads.id, id))
				.for("update");
			await tx
				.update(runs)
				.set({ status: StoredRunStatus.RUNNING })
				.where(eq(runs.id, finished.id));
			await tx
				.update(threads)
				.set({ updatedAt: startedAt })
				.where(eq(threads.id, id));
			locked();
			await held;
		});
		await isLocked;
		const renaming = clients().thread.updateThread({
			thread: { id, title: "renamed" },
			updateMask: { paths: ["title"] },
		});
		// The rename is waiting for the row.
		await vi.waitFor(
			async () => {
				const { rows } = await pool.query(
					"select 1 from pg_stat_activity where wait_event_type = 'Lock' and query ilike 'update \"threads\"%'",
				);
				expect(rows.length).toBe(1);
			},
			{ timeout: 5000, interval: 20 },
		);
		release();
		await starting;
		const { thread: renamed } = await renaming;
		expect(renamed?.title).toBe("renamed");
		expect(renamed?.activeTime && timestampMs(renamed.activeTime)).toBe(
			startedAt.getTime(),
		);
		expect(renamed?.running).toBe(true);
		await db
			.update(runs)
			.set({ status: StoredRunStatus.COMPLETED })
			.where(eq(runs.id, finished.id));
	});
	test("a storage failure before the model request defers the run instead of failing it", async () => {
		const file = await upload({
			content: png,
			mimeType: "image/png",
			fileName: "image.png",
		});
		get.mockImplementation(async () => {
			throw new Error("R2 unavailable");
		});
		const accepted = await clients().turn.startTurn({
			threadId: "",
			requestId: crypto.randomUUID(),
			input: { fileIds: [file?.id ?? ""] },
		});
		const runId = accepted.snapshot?.run?.id;
		if (!runId) throw new Error("Missing run ID");
		const { thread: created } = await clients().thread.getThread({
			threadId: accepted.snapshot?.run?.threadId,
		});
		expect(created?.title).toBe("");
		// The fake actor surfaces the rethrown error; the real actor backs off.
		const jobs = [...fake.jobs];
		fake.jobs.clear();
		// Deferred for the actor to retry, keeping the storage error as its cause.
		await expect(Promise.all(jobs)).rejects.toMatchObject({
			name: "DeferredExecutionError",
			cause: expect.objectContaining({ message: "R2 unavailable" }),
		});
		const deferred = await snapshot(runId);
		expect(deferred.run?.status).toBe(RunStatus.RUNNING);
		// Its conversation is listed with a reply being written.
		const runningIn = async () =>
			(await clients().thread.listThreads({})).threads.find(
				(item) => item.id === deferred.run?.threadId,
			)?.running;
		expect(await runningIn()).toBe(true);
		expect(await stepsOf(runId)).toHaveLength(0);
		expect(fake.requests).toBe(0);
		const checkpoint = {
			checkpoint: fake.locals.get(runId)!.local.checkpoint()!,
		};
		expect(checkpoint.checkpoint.phase).toBe("ready");
		expect(JSON.stringify(checkpoint.checkpoint)).not.toContain("data:");
		get.mockImplementation(async () => ({
			size: png.length,
			body: new Response(png).body,
		}));
		await dispatchRun(runId);
		const completed = terminal(await finishRun(deferred));
		expect(completed.status).toBe(RunStatus.COMPLETED);
		expect(fake.requests).toBe(1);
		expect(await runningIn()).toBe(false);
	});
	test("a model request the provider refused for now defers the run, which goes on from where it was", async () => {
		fake.mode = "refused";
		const accepted = await clients().turn.startTurn({
			threadId: await thread(),
			requestId: crypto.randomUUID(),
			input: { text: "research" },
		});
		const runId = accepted.snapshot?.run?.id;
		if (!runId) throw new Error("Missing run ID");
		const jobs = [...fake.jobs];
		fake.jobs.clear();
		// The actor backs off and runs it again; it is not failed.
		await expect(Promise.all(jobs)).rejects.toMatchObject({
			name: "DeferredExecutionError",
			cause: expect.objectContaining({ name: "ModelRequestRefused" }),
		});
		expect((await snapshot(runId)).run?.status).toBe(RunStatus.RUNNING);
		const checkpoint = {
			checkpoint: fake.locals.get(runId)!.local.checkpoint()!,
		};
		expect(checkpoint.checkpoint.phase).toBe("ready");
		const record = async () =>
			(await stepsOf(runId)).map((step) => [
				step.index,
				step.kind,
				step.status,
			]);
		expect(await record()).toEqual([[1, StepKind.MODEL, StepStatus.FAILED]]);
		await dispatchRun(runId);
		const completed = terminal(await finishRun(accepted.snapshot));
		expect(completed.status).toBe(RunStatus.COMPLETED);
		expect(fake.requests).toBe(2);
		expect(await record()).toEqual([
			[1, StepKind.MODEL, StepStatus.FAILED],
			[2, StepKind.MODEL, StepStatus.COMPLETED],
		]);
		expect(
			(await snapshot(runId)).outputMessage?.parts.map((part) => part.content),
		).toContainEqual({ case: "text", value: "final answer" });
	});
	test("files a tool stores belong to the reply: shown in it, or read by the model as the call's result", async () => {
		fake.mode = "images";
		get.mockImplementation(async () => ({
			size: png.length,
			body: new Response(png).body,
		}));
		const id = await thread();
		expect(terminal(await run(id)).status).toBe(RunStatus.COMPLETED);
		const { messages } = await clients().thread.listMessages({ threadId: id });
		const parts = messages[1].parts.map((part) => part.content);
		const result = parts.findIndex((content) => content.case === "toolResult");
		expect(parts[result]).toMatchObject({
			case: "toolResult",
			value: { images: [{ fileName: "viewed.png" }] },
		});
		// The shown image follows the call in the reply.
		expect(parts[result + 1]).toMatchObject({
			case: "file",
			value: { fileName: "shown.png", mimeType: "image/png" },
		});
		// Both are kept: the reply references them.
		const references = await db
			.select({ fileId: messageFiles.fileId })
			.from(messageFiles)
			.where(eq(messageFiles.messageId, messages[1].id));
		expect(references).toHaveLength(2);
		// The model read the viewed image, not the shown one, as the result.
		expect(
			fake.inputs
				.at(-1)
				?.find(
					(item) =>
						typeof item === "object" &&
						item !== null &&
						"type" in item &&
						item.type === "function_call_output",
				),
		).toEqual({
			type: "function_call_output",
			call_id: "take",
			output: [
				{ type: "input_text", text: "took" },
				{
					type: "input_image",
					image_url: `data:image/png;base64,${Buffer.from(png).toString("base64")}`,
					detail: "auto",
				},
			],
		});
		// Deleting the conversation deletes both, for cleanup to remove.
		await clients().thread.deleteThread({ threadId: id });
		expect((await db.select().from(files)).map((file) => file.status)).toEqual([
			"deleting",
			"deleting",
		]);
	});
	test("a listed reply leaves long tool outputs out; only their owner gets one whole", async () => {
		fake.mode = "images";
		get.mockImplementation(async () => ({
			size: png.length,
			body: new Response(png).body,
		}));
		takeImages.output = "x".repeat(10_000);
		try {
			const id = await thread();
			expect(terminal(await run(id)).status).toBe(RunStatus.COMPLETED);
			const { messages } = await clients().thread.listMessages({
				threadId: id,
			});
			const listed = messages[1].parts.find(
				(part) => part.content.case === "toolResult",
			)?.content;
			expect(listed?.case).toBe("toolResult");
			if (listed?.case !== "toolResult") return;
			expect(listed.value.outputOmitted).toBe(true);
			expect(listed.value.output).toBeUndefined();
			const request = { messageId: messages[1].id, toolCallId: "take" };
			const { result } = await clients().thread.getToolResult(request);
			expect(result?.outputOmitted).toBe(false);
			expect(JSON.stringify(result?.output)).toContain("x".repeat(10_000));
			await expect(
				clients(otherSession).thread.getToolResult(request),
			).rejects.toMatchObject({ code: Code.NotFound });
		} finally {
			takeImages.output = "took";
		}
	});
	test("failures persist their terminal state without exposing upstream errors", async () => {
		fake.mode = "failure";
		const result = terminal(await run(await thread()));
		expect(result.status).toBe(RunStatus.FAILED);
		const [stored] = await db
			.select({ error: runs.error })
			.from(runs)
			.where(eq(runs.id, result.id));
		expect(stored.error).not.toContain("private");
		expect((await stepsOf(result.id))[0].status).toBe(StepStatus.FAILED);
	});
	test("a NUL character a model wrote never makes its output unsavable", async () => {
		// Postgres's jsonb rejects U+0000; message parts, checkpoints and the
		// context window are stored with U+FFFD in its place, keys included.
		const id = await thread();
		await db
			.update(threads)
			.set({ contextWindow: { "k\0ey": "va\0lue" } as never })
			.where(eq(threads.id, id));
		const [row] = await db.select().from(threads).where(eq(threads.id, id));
		expect(row.contextWindow).toEqual({ "k\uFFFDey": "va\uFFFDlue" });
	});
	test("an earlier reply keeps saying it failed; each reply carries its run's status", async () => {
		const id = await thread();
		fake.mode = "failure";
		const failed = terminal(await run(id));
		fake.mode = "normal";
		const completed = terminal(await run(id));
		const { messages: listed } = await clients().thread.listMessages({
			threadId: id,
		});
		expect(listed.map((message) => [message.runId, message.runStatus])).toEqual(
			[
				["", RunStatus.UNSPECIFIED],
				[failed.id, RunStatus.FAILED],
				["", RunStatus.UNSPECIFIED],
				[completed.id, RunStatus.COMPLETED],
			],
		);
		// The run's own snapshot carries it too.
		expect((await snapshot(failed.id)).outputMessage?.runStatus).toBe(
			RunStatus.FAILED,
		);
	});
	test("a call that needs consent waits for the person: approved it runs once, refused it never runs, and a stop ends the wait", async () => {
		fake.mode = "consent";
		fake.sent = 0;
		const consentOf = (current: RunSnapshot) => {
			const call = current.outputMessage?.parts.find(
				(part) => part.content.case === "toolCall",
			);
			return call?.content.case === "toolCall"
				? call.content.value.consent
				: undefined;
		};
		const answer = (runId: string, approved: boolean) =>
			clients().run.answerToolCall({ runId, toolCallId: "send", approved });
		// A run up to where its call asks: the execution has ended, the run has
		// not, and nothing was sent.
		const waitingRun = async () => {
			const accepted = await clients().turn.startTurn({
				threadId: await thread(),
				requestId: crypto.randomUUID(),
				input: { text: "send it" },
			});
			const runId = accepted.snapshot?.run?.id ?? "";
			await vi.waitFor(
				async () => {
					expect(consentOf(await snapshot(runId))).toBe(ToolConsent.REQUESTED);
					expect(fake.actors.has(runId)).toBe(false);
				},
				{ timeout: 10_000, interval: 20 },
			);
			expect(active((await snapshot(runId)).run as Run)).toBe(true);
			expect(
				(await stepsOf(runId)).map((step) => [step.kind, step.status]),
			).toEqual([
				[StepKind.MODEL, StepStatus.COMPLETED],
				[StepKind.TOOL, StepStatus.PENDING],
			]);
			return { accepted, runId };
		};

		const approved = await waitingRun();
		expect(fake.sent).toBe(0);
		const granted = await answer(approved.runId, true);
		expect(consentOf(granted.snapshot as RunSnapshot)).toBe(
			ToolConsent.GRANTED,
		);
		// The same answer again (a second device, a retry) changes nothing.
		await answer(approved.runId, true);
		const sent = await finishRun(approved.accepted.snapshot);
		expect(sent.run?.status).toBe(RunStatus.COMPLETED);
		expect(fake.sent).toBe(1);
		expect(consentOf(sent)).toBe(ToolConsent.GRANTED);
		expect(
			(await stepsOf(approved.runId)).map((step) => [step.kind, step.status]),
		).toEqual([
			[StepKind.MODEL, StepStatus.COMPLETED],
			[StepKind.TOOL, StepStatus.COMPLETED],
			[StepKind.MODEL, StepStatus.COMPLETED],
		]);
		// Too late for the other answer.
		await expect(answer(approved.runId, false)).rejects.toMatchObject({
			code: Code.FailedPrecondition,
		});

		const refused = await waitingRun();
		await answer(refused.runId, false);
		const unsent = await finishRun(refused.accepted.snapshot);
		expect(unsent.run?.status).toBe(RunStatus.COMPLETED);
		expect(fake.sent).toBe(1);
		expect(consentOf(unsent)).toBe(ToolConsent.REFUSED);
		// The model read that it did not happen, and replied.
		const result = unsent.outputMessage?.parts.find(
			(part) => part.content.case === "toolResult",
		);
		expect(
			result?.content.case === "toolResult" && [
				result.content.value.isError,
				JSON.stringify(result.content.value.output),
			],
		).toEqual([true, expect.stringContaining("did not approve")]);
		await expect(answer(refused.runId, true)).rejects.toMatchObject({
			code: Code.FailedPrecondition,
		});

		// A stop while it waits ends the run without the call; the actor wakes
		// on a stop (RunActor.cancel), which this harness does by hand.
		const stopped = await waitingRun();
		await clients().run.cancelRun({
			lookup: { case: "runId", value: stopped.runId },
		});
		await dispatchRun(stopped.runId);
		const ended = await finishRun(stopped.accepted.snapshot);
		expect(ended.run?.status).toBe(RunStatus.CANCELLED);
		expect(fake.sent).toBe(1);
		await expect(answer(stopped.runId, true)).rejects.toMatchObject({
			code: Code.FailedPrecondition,
		});
		// Someone else's run is not found.
		await expect(
			clients(otherSession).run.answerToolCall({
				runId: stopped.runId,
				toolCallId: "send",
				approved: true,
			}),
		).rejects.toMatchObject({ code: Code.NotFound });
	});
	test("a schedule wakes the agent in its own conversation: once per occurrence, waiting while it is busy, and gone when it is over", async () => {
		const day = 24 * 60 * 60_000;
		const start = new Date();
		const due = new Date(start.getTime() + 60_000);
		const after: Promise<unknown>[] = [];
		const ring = (id: string, now: Date) =>
			fireSchedule(db, id, now, (work) => after.push(work));
		const turnsOf = async (threadId: string) =>
			(await clients().thread.listMessages({ threadId })).messages.filter(
				(message) => message.role === MessageRole.USER,
			);
		// Months keep their day, or the month's last when it has none.
		expect(
			nextOccurrence(
				new Date("2026-01-31T08:00:00Z"),
				{ count: 1, unit: "month" },
				new Date("2026-01-31T08:00:01Z"),
			).toISOString(),
		).toBe("2026-02-28T08:00:00.000Z");

		const daily = await createSchedule(db, "owner", {
			instructions: "Summarize my mailbox",
			firstAt: due,
			every: { count: 1, unit: "day" },
		});
		expect(fake.alarms.get(daily.id)).toEqual(due);
		expect(await listSchedules(db, "owner")).toMatchObject([
			{ id: daily.id, every: { count: 1, unit: "day" } },
		]);
		// Its conversation is a side conversation, named for what it does.
		expect(
			(await clients().thread.getThread({ threadId: daily.threadId })).thread
				?.title,
		).toBe("Summarize my mailbox");
		// Rung early, nothing happens.
		expect(await ring(daily.id, start)).toEqual(due);
		expect(await turnsOf(daily.threadId)).toHaveLength(0);

		// Due: one turn, marked as the schedule's, and the next occurrence.
		fake.mode = "pause";
		const next = await ring(daily.id, new Date(due.getTime() + 5_000));
		expect(next).toEqual(new Date(due.getTime() + day));
		const [input] = await turnsOf(daily.threadId);
		expect(input.scheduled).toBe(true);
		expect(input.parts[0].content).toMatchObject({
			case: "text",
			value: "Summarize my mailbox",
		});
		// The next occurrence comes while that turn is still being answered:
		// it waits, and no second turn is made.
		const later = new Date(due.getTime() + day + 5_000);
		expect(await ring(daily.id, later)).toEqual(
			new Date(later.getTime() + 2 * 60_000),
		);
		expect(await turnsOf(daily.threadId)).toHaveLength(1);
		await vi.waitFor(() => expect(fake.release).toBeDefined());
		fake.release!();
		fake.mode = "normal";
		await Promise.all(after.splice(0));
		await vi.waitFor(
			async () =>
				expect(
					(await clients().thread.getThread({ threadId: daily.threadId }))
						.thread?.running,
				).toBe(false),
			{ timeout: 10_000, interval: 20 },
		);
		// Now it runs; rung again for the same occurrence (its alarm retried),
		// it is still one turn.
		expect(await ring(daily.id, later)).toEqual(
			new Date(due.getTime() + 2 * day),
		);
		await pool.query("UPDATE schedules SET next_at = $1 WHERE id = $2", [
			new Date(due.getTime() + day),
			daily.id,
		]);
		await ring(daily.id, later);
		expect(await turnsOf(daily.threadId)).toHaveLength(2);
		await Promise.all(after.splice(0));

		// One that runs once is gone after it has.
		const once = await createSchedule(db, "owner", {
			instructions: "Remind me to call the bank",
			firstAt: due,
		});
		expect(await ring(once.id, later)).toBeUndefined();
		expect(await turnsOf(once.threadId)).toHaveLength(1);
		expect((await listSchedules(db, "owner")).map((item) => item.id)).toEqual([
			daily.id,
		]);
		await Promise.all(after.splice(0));

		// Only its owner deletes it; deleting its conversation ends it too,
		// and an alarm left behind finds nothing to do.
		await expect(deleteSchedule(db, "other", daily.id)).rejects.toMatchObject({
			code: ErrorCode.NotFound,
		});
		await settleExecutors();
		await clients().thread.deleteThread({ threadId: daily.threadId });
		expect(await listSchedules(db, "owner")).toEqual([]);
		expect(await ring(daily.id, later)).toBeUndefined();
		// Not in the past, and not faster than every 15 minutes.
		await expect(
			createSchedule(db, "owner", { instructions: "x", firstAt: start }),
		).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
		await expect(
			createSchedule(db, "owner", {
				instructions: "x",
				firstAt: due,
				every: { count: 5, unit: "minute" },
			}),
		).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
	});
	test("a run whose host stopped during a tool call resumes from that call and finishes", async () => {
		fake.mode = "hang";
		fake.hanging = false;
		const accepted = await clients().turn.startTurn({
			threadId: await thread(),
			requestId: crypto.randomUUID(),
			input: { text: "go" },
		});
		const runId = accepted.snapshot?.run?.id ?? "";
		await vi.waitFor(() => expect(fake.hanging).toBe(true), {
			timeout: 10_000,
			interval: 20,
		});
		// The host goes away mid-call: its execution is lost, told nothing, and
		// the run stays active for the next one.
		const lost = fake.actors.get(runId);
		const lostJobs = [...fake.jobs];
		fake.actors.delete(runId);
		fake.jobs.clear();
		expect(active((await snapshot(runId)).run as Run)).toBe(true);
		await dispatchRun(runId);
		const finished = await finishRun(accepted.snapshot);
		// The lost execution never commits over the finished run.
		lost?.abort();
		await Promise.allSettled(lostJobs);
		expect((await snapshot(runId)).run?.status).toBe(RunStatus.COMPLETED);
		expect(finished.run?.status).toBe(RunStatus.COMPLETED);
		// The call may have taken effect, so it was not repeated: the model was
		// told its outcome is unknown (an error result), and went on.
		const result = finished.outputMessage?.parts.find(
			(part) => part.content.case === "toolResult",
		);
		expect(
			result?.content.case === "toolResult" &&
				JSON.stringify(result.content.value.output),
		).toContain("unknown");
		expect(
			(await stepsOf(runId)).map((step) => [step.kind, step.status]),
		).toEqual([
			[StepKind.MODEL, StepStatus.COMPLETED],
			[StepKind.TOOL, StepStatus.FAILED],
			[StepKind.MODEL, StepStatus.COMPLETED],
		]);
		// The resumed execution read the transcript the checkpoint saved: the
		// model's call and then its outcome, in the request after it.
		const resumed = fake.inputs.at(-1) ?? [];
		const kinds = resumed.flatMap((item) =>
			"type" in item &&
			(item.type === "function_call" || item.type === "function_call_output")
				? [[item.type, item.call_id]]
				: [],
		);
		expect(kinds).toEqual([
			["function_call", "hang"],
			["function_call_output", "hang"],
		]);
	});
	test("only the latest turn's current attempt can be retried", async () => {
		const id = await thread();
		const first = terminal(await run(id));
		const second = terminal(await run(id));
		await expect(
			clients().turn.retryTurn({
				turnId: first.turnId,
				previousRunId: first.id,
				requestId: crypto.randomUUID(),
			}),
		).rejects.toMatchObject({ code: Code.FailedPrecondition });
		const retried = await clients().turn.retryTurn({
			turnId: second.turnId,
			previousRunId: second.id,
			requestId: crypto.randomUUID(),
		});
		await finishRun(retried.snapshot);
		// A retry of the attempt it replaced is late: another is selected now.
		await expect(
			clients().turn.retryTurn({
				turnId: second.turnId,
				previousRunId: second.id,
				requestId: crypto.randomUUID(),
			}),
		).rejects.toMatchObject({ code: Code.FailedPrecondition });
		// Its steps are recorded in order.
		const recorded = await db
			.select()
			.from(steps)
			.where(eq(steps.runId, second.id))
			.orderBy(asc(steps.index));
		expect(recorded.map((step) => step.index)).toEqual([1]);
		expect(recorded[0].kind).toBe(StepKind.MODEL);
	});
	test("unused files and expired sign-in records are cleaned up; files a message references stay", async () => {
		const kept = await upload({
			content: png,
			mimeType: "image/png",
			fileName: "kept.png",
		});
		await clients().turn.startTurn({
			threadId: "",
			requestId: crypto.randomUUID(),
			input: { fileIds: [kept.id] },
		});
		const unclaimed = await upload({
			content: png,
			mimeType: "image/png",
			fileName: "unclaimed.png",
		});
		// A day later the upload never sent is garbage; the attachment is not.
		await db
			.update(files)
			.set({ createdAt: new Date(Date.now() - 2 * 86400_000) });
		// Garbage cannot be attached any more, so a send never races cleanup.
		await expect(
			clients().turn.startTurn({
				threadId: "",
				requestId: crypto.randomUUID(),
				input: { fileIds: [unclaimed.id] },
			}),
		).rejects.toMatchObject({ code: Code.FailedPrecondition });
		remove.mockClear();
		expect(await cleanupFiles(db)).toBe(1);
		const left = await db.select({ id: files.id }).from(files);
		expect(left.map((row) => row.id)).toContain(kept.id);
		expect(left.map((row) => row.id)).not.toContain(unclaimed.id);
		expect(remove).toHaveBeenCalled();
		const past = new Date(Date.now() - 1000);
		const expired = await db
			.update(sessions)
			.set({ expiresAt: past })
			.returning({ userId: sessions.userId, sessionId: sessions.id });
		await db.update(verificationCodes).set({
			expiresAt: new Date(Date.now() - 2 * 86400_000),
		});
		hub.endedSessions.length = 0;
		await purgeExpiredAuthRecords(db);
		expect(await db.select().from(sessions)).toHaveLength(0);
		// An expired session's open connections close, as a signed-out one's do.
		expect(hub.endedSessions).toEqual(expect.arrayContaining(expired));
		expect(hub.endedSessions).toHaveLength(expired.length);
		expect(await db.select().from(verificationCodes)).toHaveLength(0);
	});
	test("a workspace download is for its page's account and only the workspace; an upload must state its length", async () => {
		const request = (path: string, init?: RequestInit) =>
			worker.fetch(
				new Request(`https://test.invalid${path}`, init) as Parameters<
					typeof worker.fetch
				>[0],
				env,
				{ waitUntil: () => {} } as unknown as ExecutionContext,
			);
		// A path outside the workspace is refused before the computer is used.
		const outside = await request(
			`/computer-file?${new URLSearchParams({ path: "../etc/passwd" })}`,
			{ headers: sessionHeaders(ownerSession) },
		);
		expect(outside.status).toBe(400);
		// A page showing another account is refused.
		const elsewhere = await request(
			`/computer-file?${new URLSearchParams({ path: "notes.txt" })}`,
			{
				headers: {
					...sessionHeaders(ownerSession),
					[actingUserHeader]: "other",
				},
			},
		);
		expect(elsewhere.status).toBe(401);
		// An upload without its length is refused before the computer is used.
		const upload = await request(
			`/computer-file?${new URLSearchParams({ path: "/workspace", name: "a.txt" })}`,
			{
				method: "POST",
				headers: sessionHeaders(ownerSession),
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("data"));
						controller.close();
					},
				}),
				duplex: "half",
			} as RequestInit,
		);
		expect(upload.status).toBe(400);
	});
	test("conversations are listed by activity: a new turn moves one up, and pages neither repeat nor skip", async () => {
		const oldest = await thread("a");
		const middle = await thread("b");
		const newest = await thread("c");
		// Created one after another they may share a time; the ID orders them.
		terminal(await run(oldest));
		const ids: string[] = [];
		let pageToken = "";
		do {
			const page = await clients().thread.listThreads({
				pageSize: 2,
				pageToken,
			});
			ids.push(...page.threads.map((listed) => listed.id));
			pageToken = page.nextPageToken;
		} while (pageToken);
		expect(ids).toEqual([oldest, newest, middle]);
		const [first] = (await clients().thread.listThreads({ pageSize: 1 }))
			.threads;
		expect(first.activeTime).toBeDefined();
	});
	test("pagination scopes cursors, partial updates preserve flags, and R2 deletes accompany file deletes", async () => {
		await thread("中文 first");
		await thread("中文 second");
		await thread("different");
		const first = await clients().thread.listThreads({
			pageSize: 1,
			query: "中文",
		});
		expect(first.threads).toHaveLength(1);
		expect(first.nextPageToken).toBeTruthy();
		const second = await clients().thread.listThreads({
			pageSize: 1,
			query: "中文",
			pageToken: first.nextPageToken,
		});
		expect(second.threads[0].id).not.toBe(first.threads[0].id);
		expect(second.nextPageToken).toBe("");
		await expect(
			clients(otherSession).thread.listThreads({
				pageSize: 1,
				query: "中文",
				pageToken: first.nextPageToken,
			}),
		).rejects.toMatchObject({ code: Code.InvalidArgument });
		const id = first.threads[0].id;
		const updated = await clients().thread.updateThread({
			thread: { id, title: "renamed" },
			updateMask: { paths: ["title"] },
		});
		expect(updated.thread?.title).toBe("renamed");
		const file = await upload({
			fileName: "a b.png",
			mimeType: "image/png",
			content: png,
		});
		expect(file?.id).toBeTruthy();
		// The name travels in Content-Disposition; the key is only the ID.
		expect(file?.url).toMatch(/^\/files\/[0-9a-f-]{36}$/);
		expect(put).toHaveBeenCalledWith(
			expect.stringMatching(/^files\/[0-9a-f-]{36}$/),
			expect.any(ReadableStream),
			expect.objectContaining({
				httpMetadata: expect.objectContaining({
					contentDisposition: "inline; filename*=UTF-8''a%20b.png",
				}),
			}),
		);
		// A document declared as an image is refused; one declared as nothing
		// in particular is typed by its start.
		await expect(
			upload({
				fileName: "page.png",
				mimeType: "image/png",
				content: new TextEncoder().encode("<html></html>"),
			}),
		).rejects.toMatchObject({ status: 400, code: "invalid_argument" });
		expect(
			await upload({
				fileName: "shot",
				mimeType: "application/octet-stream",
				content: png,
			}),
		).toMatchObject({ mimeType: "image/png" });
		// Other files are stored as declared and download rather than render.
		const table = await upload({
			fileName: "表格.csv",
			mimeType: "text/csv; charset=utf-8",
			content: new TextEncoder().encode("a,b\n1,2\n"),
		});
		expect(table).toMatchObject({ mimeType: "text/csv" });
		expect(put).toHaveBeenLastCalledWith(
			expect.any(String),
			expect.any(ReadableStream),
			expect.objectContaining({
				httpMetadata: expect.objectContaining({
					contentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent("表格.csv")}`,
				}),
			}),
		);
		await expect(
			upload(
				{ fileName: "x.csv", mimeType: "text/csv", content: png },
				{ cookie: "__Host-heveta_session=not-a-session", userId: "owner" },
			),
		).rejects.toMatchObject({ status: 401 });
		const stored = () =>
			db
				.select({ id: files.id })
				.from(files)
				.where(eq(files.id, file?.id ?? ""));
		// Another user cannot delete it.
		await clients(otherSession).file.deleteFile({ fileId: file?.id });
		expect(remove).not.toHaveBeenCalled();
		expect(await stored()).toHaveLength(1);
		await clients().file.deleteFile({ fileId: file?.id });
		expect(remove).toHaveBeenCalledOnce();
		expect(await stored()).toHaveLength(0);
	});
	test("a first sign-in creates the account; codes work once and resist guessing", async () => {
		// Unknown and known addresses get the same answer and a code alike.
		sendEmail.mockClear();
		const code = await sentCode("New.Person@Example.com");
		expect(sendEmail).toHaveBeenCalledOnce();
		const attempts = await Promise.allSettled([
			publicAuth.signInWithEmailCode(code),
			publicAuth.signInWithEmailCode(code),
		]);
		expect(
			attempts.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		const [created] = await db
			.select()
			.from(users)
			.where(eq(users.email, "new.person@example.com"));
		// Named after the (lowercased) address's local part, reduced to allowed characters.
		expect(created.username).toBe("newperson");
		// A name is shown, not an identity: two accounts may share one.
		await db.insert(users).values({
			id: "taken",
			email: "someone@example.com",
			username: "twin",
		});
		const twin = await signInAs("twin@example.org");
		expect(twin.user?.username).toBe("twin");
		// Five wrong guesses retire the code, so the right one fails too. They
		// count against the guesser's challenge alone: the code its owner asked
		// for from elsewhere, just before, still signs in.
		const from = (address: string) =>
			createClient(AuthService, transport(undefined, address));
		const owners = await sentCode("guess@example.com", from("198.51.100.7"));
		const target = await sentCode("guess@example.com", from("203.0.113.9"));
		const wrong = target.code === "000000" ? "111111" : "000000";
		for (let attempt = 0; attempt < 5; attempt++)
			await expect(
				publicAuth.signInWithEmailCode({ ...target, code: wrong }),
			).rejects.toMatchObject({
				code: Code.InvalidArgument,
				rawMessage: "Invalid or expired verification code",
			});
		await expect(publicAuth.signInWithEmailCode(target)).rejects.toMatchObject({
			code: Code.InvalidArgument,
		});
		// A failed guess creates nothing.
		expect(
			await db.select().from(users).where(eq(users.email, "guess@example.com")),
		).toEqual([]);
		expect((await publicAuth.signInWithEmailCode(owners)).user?.email).toBe(
			"guess@example.com",
		);
	});
	test("a session is an HttpOnly cookie that acts for its own account, renews in use, and ends on sign-out or expiry", async () => {
		const session = await signInAs("owner@example.com");
		expect(session.setCookie).toMatch(
			/^__Host-heveta_session=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=\d+$/,
		);
		// The database keeps only its hash.
		const token = session.cookie.split("=")[1];
		expect(
			await db.select().from(sessions).where(eq(sessions.tokenHash, token)),
		).toEqual([]);
		const id = await sessionIdOf(session);
		expect(id).toBeTruthy();
		// A page still showing another account (signed in elsewhere since) is
		// refused, as is a request with no session.
		await expect(
			clients({ ...session, userId: "other" }).thread.listThreads({}),
		).rejects.toMatchObject({ code: Code.Unauthenticated });
		await expect(
			clients({ cookie: "", userId: "owner" }).thread.listThreads({}),
		).rejects.toMatchObject({ code: Code.Unauthenticated });
		// In use a day later, it is extended and its cookie sent again; not
		// again the same day.
		const day = 86400_000;
		await db
			.update(sessions)
			.set({ expiresAt: new Date(Date.now() + 29 * day - 60_000) })
			.where(eq(sessions.id, id));
		const cookieAfter = async () => {
			let sent: string | null = null;
			await clients(session).thread.listThreads(
				{},
				{ onHeader: (headers) => (sent = headers.get("set-cookie")) },
			);
			return sent;
		};
		expect(await cookieAfter()).toContain(session.cookie);
		const [renewed] = await db
			.select()
			.from(sessions)
			.where(eq(sessions.id, id));
		expect(renewed.expiresAt.getTime()).toBeGreaterThan(
			Date.now() + 29.9 * day,
		);
		expect(await cookieAfter()).toBeNull();
		// Signing out ends it and clears its cookie.
		let cleared: string | null = null;
		await clients(session).auth.signOut(
			{},
			{ onHeader: (headers) => (cleared = headers.get("set-cookie")) },
		);
		expect(cleared).toMatch(/^__Host-heveta_session=; .*Max-Age=0$/);
		await expect(clients(session).thread.listThreads({})).rejects.toMatchObject(
			{ code: Code.Unauthenticated },
		);
		// An expired one is refused.
		const late = await signInAs("owner@example.com");
		await db
			.update(sessions)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(sessions.id, (await sessionIdOf(late)) ?? ""));
		await expect(clients(late).thread.listThreads({})).rejects.toMatchObject({
			code: Code.Unauthenticated,
		});
	});
	test("failed session closure stays revoked and cleanup retries it", async () => {
		const id = (await sessionIdOf(ownerSession))!;
		expect(await liveEventSession(id)).toBe(true);
		hub.closeFails = true;
		await clients().auth.signOut({});
		const [pending] = await db
			.select()
			.from(sessions)
			.where(eq(sessions.id, id));
		expect(pending.revokedAt).toBeInstanceOf(Date);
		expect(await liveEventSession(id)).toBe(false);
		await expect(clients().thread.listThreads({})).rejects.toMatchObject({
			code: Code.Unauthenticated,
		});
		await purgeExpiredAuthRecords(db);
		expect(
			await db.select().from(sessions).where(eq(sessions.id, id)),
		).toHaveLength(1);
		hub.closeFails = false;
		await purgeExpiredAuthRecords(db);
		expect(
			await db.select().from(sessions).where(eq(sessions.id, id)),
		).toHaveLength(0);
		expect(hub.endedSessions).toContainEqual({
			userId: "owner",
			sessionId: id,
		});
		expect(await liveEventSession(id)).toBe(false);
	});

	test("a stored file is its owner's alone", async () => {
		const file = await upload({
			content: new TextEncoder().encode("secret"),
			mimeType: "text/plain",
			fileName: "notes.txt",
		});
		get.mockImplementation(async () => ({
			body: new Response("secret").body,
			size: 6,
			httpEtag: "etag",
			httpMetadata: { contentType: "text/plain" },
			writeHttpMetadata: () => {},
		}));
		const read = (headers: Record<string, string> = {}) =>
			worker.fetch(
				new Request(`https://test.invalid/files/${file.id}`, {
					headers,
				}) as Parameters<typeof worker.fetch>[0],
				env,
				{ waitUntil: () => {} } as unknown as ExecutionContext,
			);
		// An image element sends the session alone, without an account.
		expect(await (await read({ cookie: ownerSession.cookie })).text()).toBe(
			"secret",
		);
		expect((await read({ cookie: otherSession.cookie })).status).toBe(404);
		expect((await read()).status).toBe(401);
		// One being deleted is gone at once.
		await clients().file.deleteFile({ fileId: file.id });
		expect((await read({ cookie: ownerSession.cookie })).status).toBe(404);
	});
	test("avatar cleanup failure does not undo success and is retried durably", async () => {
		const first = (await clients().auth.setAvatar({ image: png })).user!;
		remove.mockRejectedValueOnce(new Error("R2 temporarily unavailable"));
		const second = (await clients().auth.setAvatar({ image: png })).user!;
		expect(second.avatarUrl).not.toBe(first.avatarUrl);
		expect(second.revision).toBe(first.revision + 1);
		expect((await clients().auth.getCurrentUser({})).user?.avatarUrl).toBe(
			second.avatarUrl,
		);
		expect(
			eventsOf("owner").some(
				({ event }) =>
					event.case === "user" && event.value.avatarUrl === second.avatarUrl,
			),
		).toBe(true);
		expect(
			(await db.select().from(avatarGarbage)).map((row) => row.key),
		).toEqual([first.avatarUrl.slice(1)]);
		await purgeAvatarGarbage(db);
		expect(remove).toHaveBeenLastCalledWith(first.avatarUrl.slice(1));
		expect(await db.select().from(avatarGarbage)).toEqual([]);
		// Interrupted uploads remain discoverable, but the current photo is
		// never in the collection queue.
		put.mockRejectedValueOnce(new Error("upload interrupted"));
		await expect(
			clients().auth.setAvatar({ image: png }),
		).rejects.toMatchObject({ code: Code.Internal });
		await db
			.update(avatarGarbage)
			.set({ deleteAfter: new Date(Date.now() - 1000) });
		await purgeAvatarGarbage(db);
		expect(await db.select().from(avatarGarbage)).toEqual([]);
		expect((await clients().auth.getCurrentUser({})).user?.avatarUrl).toBe(
			second.avatarUrl,
		);
	});

	test("profile and title revisions advance with each public change", async () => {
		const user = (await clients().auth.getCurrentUser({})).user!;
		const renamed = (
			await clients().auth.updateCurrentUser({ username: "New_name" })
		).user!;
		const avatar = (await clients().auth.setAvatar({ image: png })).user!;
		expect(renamed.revision).toBe(user.revision + 1);
		expect(avatar.revision).toBe(renamed.revision + 1);
		const id = await thread();
		const original = (await clients().thread.getThread({ threadId: id }))
			.thread!;
		const rename = (title: string) =>
			clients().thread.updateThread({
				thread: { id, title },
				updateMask: { paths: ["title"] },
			});
		const a = (await rename("A")).thread!;
		const b = (await rename("B")).thread!;
		expect(a.revision).toBe(original.revision + 1);
		expect(b.revision).toBe(a.revision + 1);
		expect(b.activeTime).toEqual(original.activeTime);
	});

	test("a profile photo is its owner's alone, and replacing it removes the one it replaced", async () => {
		const png = new Uint8Array([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
		]);
		await expect(
			clients().auth.setAvatar({ image: new TextEncoder().encode("<svg/>") }),
		).rejects.toMatchObject({ code: Code.InvalidArgument });
		put.mockClear();
		remove.mockClear();
		const first = (await clients().auth.setAvatar({ image: png })).user;
		const url = first?.avatarUrl ?? "";
		expect(url).toMatch(/^\/avatars\//);
		expect(put).toHaveBeenCalledWith(url.slice(1), png, expect.anything());
		get.mockImplementation(async () => ({
			body: new Response(png).body,
			size: png.length,
			httpEtag: "etag",
			httpMetadata: { contentType: "image/png" },
			writeHttpMetadata: () => {},
		}));
		const read = (path: string, headers: Record<string, string> = {}) =>
			worker.fetch(
				new Request(`https://test.invalid${path}`, {
					headers,
				}) as Parameters<typeof worker.fetch>[0],
				env,
				{ waitUntil: () => {} } as unknown as ExecutionContext,
			);
		expect((await read(url, { cookie: ownerSession.cookie })).status).toBe(200);
		expect((await read(url, { cookie: otherSession.cookie })).status).toBe(404);
		expect((await read(url)).status).toBe(401);
		// A new photo has a new address; the old object goes.
		const second = (await clients().auth.setAvatar({ image: png })).user;
		expect(second?.avatarUrl).not.toBe(url);
		expect(remove).toHaveBeenCalledWith(url.slice(1));
		const removed = (await clients().auth.removeAvatar({})).user;
		expect(removed?.avatarUrl).toBe("");
		expect(remove).toHaveBeenCalledWith(second?.avatarUrl.slice(1));
	});
	test("a code is sent only to an address with an account or an invitation", async () => {
		const reasonOf = (error: unknown) =>
			(error as ConnectError).findDetails(ErrorDetailSchema)[0]?.reason;
		const everyone = env.INVITES;
		Object.assign(env, {
			INVITES: {
				get: async (key: string) =>
					key === "friend@example.com" ? "2026-09-29T00:00:00Z" : null,
			},
		});
		try {
			sendEmail.mockClear();
			const refused = await publicAuth
				.sendSignInCode({
					email: "stranger@example.com",
				})
				.catch((error: unknown) => error);
			expect(refused).toMatchObject({ code: Code.PermissionDenied });
			expect(reasonOf(refused)).toBe(ErrorReason.NOT_INVITED);
			expect(sendEmail).not.toHaveBeenCalled();
			// Invited, as sign-in reads the address.
			await sentCode(" Friend@Example.com ");
			// An account needs no invitation.
			await sentCode("owner@example.com");
			expect(sendEmail).toHaveBeenCalledTimes(2);
		} finally {
			Object.assign(env, { INVITES: everyone });
		}
	});
	test("codes are bounded per network, per address, and for all addresses; unsent ones do not count", async () => {
		const email = "limits@example.com";
		const client = (address: string) =>
			createClient(AuthService, transport(undefined, address));
		const from = (address: string) => ({
			sendSignInCode: (request: { email: string }) =>
				client(address).sendSignInCode({
					...request,
				}),
		});
		const reasonOf = (error: unknown) =>
			(error as ConnectError).findDetails(ErrorDetailSchema)[0]?.reason;
		// Skips the resend cooldown.
		const later = () =>
			db
				.update(verificationCodes)
				.set({ createdAt: new Date(Date.now() - 120_000) })
				.where(eq(verificationCodes.email, email));
		for (let request = 0; request < 10; request++) {
			await later();
			await from("198.51.100.7").sendSignInCode({ email });
		}
		await later();
		await expect(
			from("198.51.100.7").sendSignInCode({ email }),
		).rejects.toMatchObject({ code: Code.ResourceExhausted });
		// An IPv6 host is one requester across its /64.
		for (let request = 0; request < 10; request++) {
			await later();
			await from(`2001:db8:5:7::${request + 1}`).sendSignInCode({ email });
		}
		await later();
		await expect(
			from("2001:0db8:0005:0007:ffff::9").sendSignInCode({ email }),
		).rejects.toMatchObject({ code: Code.ResourceExhausted });
		await from("203.0.113.9").sendSignInCode({ email });
		// A code whose mail failed neither holds back the next request nor
		// counts toward the day's.
		await later();
		sendEmail.mockRejectedValueOnce(new Error("Mail is down"));
		await expect(
			from("203.0.113.9").sendSignInCode({ email }),
		).rejects.toMatchObject({ code: Code.Unavailable });
		sendEmail.mockClear();
		await from("203.0.113.9").sendSignInCode({ email });
		expect(sendEmail).toHaveBeenCalledOnce();
		expect(
			await db
				.select()
				.from(verificationCodes)
				.where(eq(verificationCodes.email, email)),
		).toHaveLength(22);
		// All requesters together get a bounded number a day for one address.
		await db.insert(verificationCodes).values(
			Array.from({ length: 28 }, (_, index) => ({
				email,
				requesterHash: `elsewhere-${index}`,
				code: "000000",
				expiresAt: new Date(),
				createdAt: new Date(Date.now() - 120_000),
			})),
		);
		await later();
		await expect(
			from("192.0.2.1").sendSignInCode({ email }),
		).rejects.toMatchObject({ code: Code.ResourceExhausted });
		// And all addresses together a share of the account's sending quota.
		await db.insert(verificationCodes).values(
			Array.from({ length: emailBudget.signInCodesPerDay }, (_, index) => ({
				email: `budget-${index}@example.com`,
				requesterHash: `budget-${index}`,
				code: "000000",
				expiresAt: new Date(Date.now() + 60_000),
			})),
		);
		const paused = await from("192.0.2.1")
			.sendSignInCode({ email: "fresh@example.com" })
			.catch((error: unknown) => error);
		expect(paused).toMatchObject({ code: Code.ResourceExhausted });
		expect(reasonOf(paused)).toBe(ErrorReason.SIGN_IN_CODES_PAUSED);
	});
	test("memories are short plain-text entries the model sees in full and edits", async () => {
		const pnpm = await addMemory(db, "owner", "Prefers pnpm over npm");
		await addMemory(db, "owner", "用户的主要语言是 TypeScript");
		await addMemory(db, "owner", "Lives in 100% remote team_a");
		await addMemory(db, "other", "Prefers npm");
		// Entries are short: every one goes into each run's instructions.
		await addMemory(db, "other", "长".repeat(500));
		await expect(
			addMemory(db, "owner", "长".repeat(501)),
		).rejects.toMatchObject({ code: ErrorCode.InvalidArgument });
		await updateMemory(db, "owner", pnpm.id, "Prefers bun");
		await expect(
			updateMemory(db, "other", pnpm.id, "hijack"),
		).rejects.toMatchObject({ code: ErrorCode.NotFound });
		await expect(deleteMemory(db, "other", pnpm.id)).rejects.toMatchObject({
			code: ErrorCode.NotFound,
		});
		// The model sees the owner's whole memory, with ids to edit it by.
		const instructions = await memoryContext(db, "owner");
		expect(instructions).toContain(`[${pnpm.id}] Prefers bun`);
		expect(instructions).toContain("用户的主要语言是 TypeScript");
		expect(instructions).not.toContain("Prefers npm");
		expect(await memoryContext(db, "nobody")).toContain("(nothing saved yet)");
		await deleteMemory(db, "owner", pnpm.id);
		expect(await memoryContext(db, "owner")).not.toContain("Prefers bun");
		// Any keyword matches; more matched keywords rank first.
		expect(
			(await searchMemories(db, "owner", "TypeScript 语言 remote")).map(
				(memory) => memory.content,
			),
		).toEqual(["用户的主要语言是 TypeScript", "Lives in 100% remote team_a"]);
		// LIKE wildcards in a keyword are literal.
		expect(
			(await searchMemories(db, "owner", "100%")).map((m) => m.content),
		).toEqual(["Lives in 100% remote team_a"]);
		expect(await searchMemories(db, "owner", "_")).toHaveLength(1);
		expect(await searchMemories(db, "owner", "")).toEqual([]);
		// Storage is not capped; runs start with the newest 100 entries and
		// search for the rest.
		await db
			.insert(users)
			.values({ id: "many", email: "many@example.com", username: "many" });
		await db.insert(memories).values(
			Array.from({ length: 101 }, (_, index) => ({
				userId: "many",
				content: `entry ${index}`,
				updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)),
			})),
		);
		const many = await memoryContext(db, "many");
		expect(many).toContain("entry 100");
		expect(many).not.toContain("entry 0\n");
		expect(many).toContain("(1 older entry is not listed");
		expect((await searchMemories(db, "many", "entry")).length).toBeGreaterThan(
			0,
		);
		// Tools report outcomes as text the model reads.
		const [search, add] = memoryTools(db, "owner");
		const signal = new AbortController().signal;
		expect(
			(await add.execute({ content: "Uses Vim" }, { signal })).output,
		).toMatch(/^Saved memory /);
		expect(await memoryContext(db, "owner")).toContain("Uses Vim");
		expect((await search.execute({ query: "Vim" }, { signal })).output).toMatch(
			/\] Uses Vim$/,
		);
		expect((await search.execute({ query: "emacs" }, { signal })).output).toBe(
			"No memories found.",
		);
		// People review and delete through MemoryService, scoped to themselves.
		const listed = (await clients().memory.listMemories({})).memories;
		expect(listed.map((memory) => memory.content)).toEqual([
			"Uses Vim",
			"Lives in 100% remote team_a",
			"用户的主要语言是 TypeScript",
		]);
		await clients(otherSession).memory.deleteMemory({ memoryId: listed[0].id });
		expect((await clients().memory.listMemories({})).memories).toHaveLength(3);
		await clients().memory.deleteMemory({ memoryId: listed[0].id });
		await clients().memory.deleteMemory({ memoryId: listed[0].id });
		await clients().memory.deleteAllMemories({});
		expect((await clients().memory.listMemories({})).memories).toEqual([]);
		expect(
			(await clients(otherSession).memory.listMemories({})).memories,
		).toHaveLength(2);
	});
	test("a run's history starts where the context window does; what slid out is counted and quoted", async () => {
		// New conversations are titled in the background; answer at once.
		Object.assign(env, {
			AI: {
				run: async () =>
					Response.json(
						{ error: { message: "no titles here" } },
						{ status: 400 },
					),
			},
		});
		const say = async (text: string, threadId = "") => {
			const accepted = await clients().turn.startTurn({
				threadId,
				requestId: crypto.randomUUID(),
				input: { text },
			});
			await finishRun(accepted.snapshot, clients().run);
			return accepted.snapshot?.run;
		};
		const first = await say("第一个问题");
		const threadId = first?.threadId ?? "";
		await say("第二个问题", threadId);
		await say("第三个问题", threadId);
		const [, second] = await db
			.select({ id: turns.id })
			.from(turns)
			.where(eq(turns.threadId, threadId))
			.orderBy(asc(turns.id));
		await updateContextWindow(db, threadId, { startTurnId: second.id });
		const latest = await say("第四个问题", threadId);
		const prepared = await loadRunForExecution(db, latest?.id ?? "");
		const asked = prepared.history
			.filter((message) => message.role === "user")
			.flatMap((message) =>
				message.parts.map((part) =>
					part.content.case === "text" ? part.content.value : "",
				),
			);
		expect(asked).toEqual(["第二个问题", "第三个问题", "第四个问题"]);
		expect(prepared.earlier.turns).toBe(1);
		expect(
			prepared.earlier.inputs.map((message) => message.parts[0].content.value),
		).toEqual(["第一个问题"]);
		expect(prepared.contextWindow).toMatchObject({ startTurnId: second.id });
	});
	test("the agent searches and reads the user's conversations, this one included", async () => {
		// New conversations are titled in the background; answer at once.
		Object.assign(env, {
			AI: {
				run: async () =>
					Response.json(
						{ error: { message: "no titles here" } },
						{ status: 400 },
					),
			},
		});
		const converse = async (text: string, token = ownerSession) => {
			const accepted = await clients(token).turn.startTurn({
				threadId: "",
				requestId: crypto.randomUUID(),
				input: { text },
			});
			await finishRun(accepted.snapshot, clients(token).run);
			return accepted.snapshot?.run?.threadId ?? "";
		};
		const trip = await converse("周末带孩子去杭州动物园，门票多少钱？");
		const current = await converse("杭州还有什么适合孩子的地方？");
		await converse("杭州动物园的开放时间", otherSession);
		const [search, read] = conversationTools(db, "owner", current);
		const signal = new AbortController().signal;
		// Matching messages with their text; another person's are not searched.
		const found = (await search.execute({ query: "动物园 门票" }, { signal }))
			.output;
		expect(found).toContain(`[${trip}]`);
		expect(found).toContain("杭州动物园，门票多少钱");
		expect(found).not.toContain(`[${current}]`);
		expect(found).not.toContain("开放时间");
		// The current conversation is searched too (what slid out of the
		// model's window is found here), and marked.
		expect(
			(await search.execute({ query: "杭州" }, { signal })).output,
		).toContain(
			`[${current}] 杭州还有什么适合孩子的地方？ (this conversation)`,
		);
		expect(
			(await searchConversations(db, "owner", "final")).map((hit) => hit.id),
		).toEqual(expect.arrayContaining([trip, current]));
		expect((await search.execute({ query: "滑雪" }, { signal })).output).toBe(
			"No conversations found.",
		);
		// Reading gives the conversation in order, numbered, from any message.
		const transcript = (
			await read.execute({ conversation_id: trip, start: 0 }, { signal })
		).output;
		expect(transcript).toContain("Messages 0–1 of 2.");
		expect(transcript).toMatch(
			/#0 User, .*:\n周末带孩子去杭州动物园，门票多少钱？[\s\S]*#1 Assistant, .*:\nprogress\nfinal answer$/,
		);
		const rest = (
			await read.execute({ conversation_id: trip, start: 1 }, { signal })
		).output;
		expect(rest).toContain("Messages 1–1 of 2.");
		expect(rest).not.toContain("#0 User");
		expect(
			(await read.execute({ conversation_id: trip, start: 5 }, { signal }))
				.output,
		).toContain("No messages from 5 on; it has 2.");
		// Another person's conversation is not there.
		const others = await searchConversations(db, "other", "动物园");
		expect(others).toHaveLength(1);
		await expect(
			readConversation(db, "owner", others[0].id),
		).rejects.toMatchObject({ code: ErrorCode.NotFound });
	});
	test("a message's text is stored with it for the conversation tools, and a long one is read on within it", async () => {
		const id = await thread();
		expect(terminal(await run(id)).status).toBe(RunStatus.COMPLETED);
		const texts = () =>
			db
				.select({ role: messages.role, text: messages.text })
				.from(messages)
				.where(eq(messages.threadId, id))
				.orderBy(asc(messages.id));
		expect(await texts()).toEqual([
			{ role: "user", text: "research" },
			{ role: "assistant", text: "progress\nfinal answer" },
		]);
		expect(
			(await searchConversations(db, "owner", "final")).map((hit) => hit.id),
		).toEqual([id]);
		// A long final answer, slid out of the model's window, is read back
		// whole, part by part.
		const answer = `${"长".repeat(5_000)}end`;
		await db
			.update(messages)
			.set({ text: answer })
			.where(and(eq(messages.threadId, id), eq(messages.role, "assistant")));
		const [, read] = conversationTools(db, "owner", id);
		const signal = new AbortController().signal;
		const first = (
			await read.execute(
				{ conversation_id: id, start: 0, offset: 0 },
				{ signal },
			)
		).output;
		expect(first).toContain(
			"(Cut at character 4000 of 5003. Call conversation_read with start=1 and offset=4000 to read on in it.)",
		);
		const rest = (
			await read.execute(
				{ conversation_id: id, start: 1, offset: 4_000 },
				{ signal },
			)
		).output;
		expect(rest).toContain("from character 4000:");
		expect(rest).toMatch(/长end$/);
		expect(rest).not.toContain("Cut at");
	});
	test("changes reach the user's devices; a signed-out session's channels close", async () => {
		const id = await thread("old");
		await clients().thread.updateThread({
			thread: { id, title: "new" },
			updateMask: { paths: ["title"] },
		});
		await addMemory(db, "owner", "喜欢喝茶");
		await clients().auth.updateCurrentUser({ username: "renamed" });
		await clients().thread.deleteThread({ threadId: id });
		expect(eventsOf("owner").map((event) => event.event)).toMatchObject([
			{ case: "thread", value: { id, title: "new" } },
			{ case: "memory" },
			{ case: "user", value: { id: "owner", username: "renamed" } },
			{ case: "threadDeleted", value: id },
		]);
		expect(eventsOf("other")).toHaveLength(0);
		const session = await signInAs("owner@example.com");
		const ended = { userId: "owner", sessionId: await sessionIdOf(session) };
		await clients(session).auth.signOut({});
		// Its event channels and its connections to the computer.
		expect(hub.endedSessions).toEqual([ended]);
		expect(computers.closed).toEqual([ended]);
	});
	// A WebSocket a page opens: to `path`, with the session cookie, from a page
	// of `origin`, for the account in its address.
	const openSocket = (
		path: string,
		session: TestSession | undefined,
		options: { origin?: string; user?: string; upgrade?: boolean } = {},
		headers: Record<string, string> = {},
	) => {
		const url = new URL(`https://test.invalid${path}`);
		url.searchParams.set("user", options.user ?? session?.userId ?? "");
		return worker.fetch(
			new Request(url, {
				headers: {
					...(options.upgrade === false ? {} : { Upgrade: "websocket" }),
					origin: options.origin ?? "https://test.invalid",
					host: "test.invalid",
					...(session ? { cookie: session.cookie } : {}),
					...headers,
				},
			}) as Parameters<typeof worker.fetch>[0],
			env,
			{ waitUntil: () => {} } as unknown as ExecutionContext,
		);
	};
	test("the event channel opens for a page of this host, for its session's account", async () => {
		const session = await signInAs("owner@example.com");
		// A device's own header naming a session never reaches the hub.
		const forged = { [hubHeaders.session]: "forged" };
		const connect = (options?: Parameters<typeof openSocket>[2]) =>
			openSocket("/events", session, options, forged);
		expect((await connect({ upgrade: false })).status).toBe(426);
		// Another site's page, even a related one, cannot open it.
		expect(
			(await connect({ origin: "https://other.test.invalid" })).status,
		).toBe(403);
		expect((await connect({ user: "other" })).status).toBe(401);
		expect(
			(await openSocket("/events", undefined, { user: "owner" })).status,
		).toBe(401);
		expect(hub.requests).toHaveLength(0);
		expect(await (await connect()).text()).toBe("hub");
		expect(hub.requests).toHaveLength(1);
		const admitted = hub.requests[0];
		expect(admitted.userId).toBe("owner");
		expect(admitted.request.headers.get(hubHeaders.session)).toBe(
			await sessionIdOf(session),
		);
		// A signed-out session opens nothing.
		await clients(session).auth.signOut({});
		expect((await connect()).status).toBe(401);
		expect(hub.requests).toHaveLength(1);
	});
	test("a computer connection is its route's kind and its session's, whatever the device sends", async () => {
		const session = await signInAs("owner@example.com");
		const connect = (path: string) =>
			openSocket(
				`${path}?cols=80`,
				session,
				{},
				{
					[connectionHeaders.kind]: "screen",
					[connectionHeaders.session]: "forged",
				},
			);
		expect(await (await connect("/terminal")).text()).toBe("computer");
		expect(computers.requests).toHaveLength(1);
		const [{ userId, request }] = computers.requests;
		expect(userId).toBe("owner");
		expect(request.headers.get(connectionHeaders.kind)).toBe("terminal");
		expect(request.headers.get(connectionHeaders.session)).toBe(
			await sessionIdOf(session),
		);
		expect(new URL(request.url).searchParams.get("cols")).toBe("80");
		// Another site's page cannot open it.
		expect(
			(
				await openSocket("/screen", session, {
					origin: "https://other.test.invalid",
				})
			).status,
		).toBe(403);
		expect(computers.requests).toHaveLength(1);
	});
	// A computer in memory: files by path, snapshots by ID. A restart wipes
	// the disk, as a stopped container does.
	function fakeMachine() {
		const files = new Map<string, string>();
		const snapshots = new Map<string, Map<string, string>>();
		const workspace = (path: string) => path.startsWith("/workspace/");
		const machine = {
			files,
			snapshots,
			created: 0,
			destroyed: 0,
			// The container stopped: its Durable Object is told (onStop).
			stopped: () => {},
			// A container started: its Durable Object is told (onStart).
			started: () => {},
			// Times the workspace let the idle computer sleep.
			slept: 0,
			workspace: undefined as Workspace | undefined,
			destroy: async () => {
				machine.destroyed++;
				files.clear();
				machine.stopped();
			},
			restoreFails: false,
			// The browser's MCP server has its own tests (browser.test.ts).
			containerFetch: async (): Promise<Response> => {
				throw new Error("No servers run in this fake computer");
			},
			// Runs before a snapshot is taken; a test can hold it back.
			beforeSnapshot: async () => {},
			restart: () => {
				files.clear();
				machine.stopped();
			},
			exec: async (
				command: string,
				options?: { env?: Record<string, string | undefined> },
			) => {
				const result = (stdout: string, success = true) => ({
					success,
					exitCode: success ? 0 : 1,
					stdout,
					stderr: "",
					command,
					duration: 0,
					timestamp: "",
				});
				const restored = "/tmp/heveta-workspace-restored";
				if (command.startsWith(`printf %s "$SNAPSHOT" >${restored}`)) {
					files.set(restored, options?.env?.SNAPSHOT ?? "");
					return result("");
				}
				const marker = command.match(/^test -f (\S+)$/)?.[1];
				const found = marker ? files.has(marker) : true;
				// Collecting a finished command (sandbox/tools.ts): its code and
				// times, then its output and errors in base64; and removing its
				// files, as stopping it does.
				const callDir = options?.env?.CALL_DIR;
				const collected =
					callDir && command.includes("base64")
						? [
								...["exit", "start", "end"].map(
									(name) => `${files.get(`${callDir}/${name}`)}\n`,
								),
								...["out", "err"].map(
									(name) =>
										`${Buffer.from(files.get(`${callDir}/${name}`) ?? "").toString("base64")}\n`,
								),
							].join("")
						: undefined;
				if (callDir && command.includes('rm -rf "$CALL_DIR"'))
					for (const path of files.keys())
						if (path.startsWith(`${callDir}/`)) files.delete(path);
				if (collected !== undefined) return result(collected);
				// The workspace's size, and emptying it (settings).
				const inWorkspace = [...files].filter(([path]) => workspace(path));
				if (command.startsWith("find /workspace -mindepth 1 -delete"))
					for (const [path] of inWorkspace) files.delete(path);
				// The text tools (sandbox/tools.ts): what a file is, and a window
				// of its lines, as awk prints them.
				const file = options?.env?.FILE;
				const text = file === undefined ? undefined : files.get(file);
				const lines = (content: string) =>
					content === "" ? [] : content.replace(/\n$/, "").split("\n");
				if (file !== undefined && command.includes('test -f "$FILE"'))
					return {
						success: true,
						exitCode: 0,
						stdout:
							text === undefined
								? "missing\n"
								: text.includes("\u0000")
									? "binary\n"
									: `text ${Buffer.byteLength(text, "latin1")} ${lines(text).length}\n`,
						stderr: "",
						command,
						duration: 0,
						timestamp: "",
					};
				if (text !== undefined && command.startsWith("awk -v start="))
					return {
						success: true,
						exitCode: 0,
						stdout: Buffer.from(
							lines(text)
								.slice(Number(options?.env?.START) - 1)
								.map((line) => `${line}\n`)
								.join(""),
						)
							.subarray(0, Number(options?.env?.BYTES))
							.toString(),
						stderr: "",
						command,
						duration: 0,
						timestamp: "",
					};
				return result(
					marker
						? ""
						: command.startsWith("du -sb /workspace")
							? `${inWorkspace.reduce((bytes, [, content]) => bytes + Buffer.byteLength(content, "latin1"), 0)}\t/workspace\n`
							: `ran: ${command}`,
					found,
				);
			},
			// Commands run as the shell tool's process does: their output, exit
			// code, and times land in the call's files. One named in `running`
			// keeps running until `finish` ends it. One in `lost` is started by an
			// execution that is then lost: its wait never ends.
			running: new Set<string>(),
			lost: new Set<string>(),
			processes: new Map<
				string,
				{ command: string; exited: Promise<void>; finish: () => void }
			>(),
			// What a command does to the files, as it runs (a test sets it).
			beforeCommand: () => {},
			startProcess: async (
				_: string,
				{
					processId,
					env: callEnv,
				}: { processId: string; env: Record<string, string> },
			) => {
				machine.beforeCommand();
				const dir = callEnv.CALL_DIR;
				const command = callEnv.CALL_COMMAND;
				files.set(`${dir}/start`, String(Math.floor(Date.now() / 1000)));
				let finish = () => {};
				const exited = new Promise<void>((resolve) => {
					finish = () => {
						files.set(`${dir}/out`, `ran: ${command}`);
						files.set(`${dir}/err`, "");
						files.set(`${dir}/end`, String(Math.floor(Date.now() / 1000)));
						files.set(`${dir}/exit`, "0");
						machine.processes.delete(processId);
						resolve();
					};
				});
				machine.processes.set(processId, { command, exited, finish });
				if (!machine.running.has(command)) finish();
				return {
					waitForExit: () =>
						machine.lost.has(command) ? new Promise<void>(() => {}) : exited,
				};
			},
			getProcess: async (id: string) => {
				const process = machine.processes.get(id);
				return process
					? { status: "running", waitForExit: () => process.exited }
					: null;
			},
			killProcess: async (id: string) => {
				machine.processes.delete(id);
			},
			exists: async (path: string) => ({ exists: files.has(path) }),
			// Directories are implied by the files' paths.
			mkdir: async () => ({}),
			// Binary files are kept as latin1 strings, one character a byte;
			// raw reads and writes stream those bytes.
			readFile: (async (
				path: string,
				options: { encoding: "none" | "utf-8" },
			) => {
				const content = files.get(path);
				if (content === undefined) throw new Error(`File not found: ${path}`);
				if (options.encoding === "utf-8") return { content };
				const bytes = Buffer.from(content, "latin1");
				return {
					content: new Response(bytes).body,
					size: bytes.length,
					mimeType: "application/octet-stream",
				};
			}) as SandboxMachine["readFile"],
			writeFile: async (
				path: string,
				content: string | ReadableStream<Uint8Array>,
			) => {
				files.set(
					path,
					typeof content === "string"
						? content
						: Buffer.from(await new Response(content).arrayBuffer()).toString(
								"latin1",
							),
				);
			},
			createSnapshot: async () => {
				const id = crypto.randomUUID();
				await machine.beforeSnapshot();
				snapshots.set(id, new Map(files));
				machine.created++;
				return {
					snapshot: { id, size: 100 },
					image: "test-image",
					expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
				};
			},
			restoreSnapshotFilesystem: async ({ id }: { id: string }) => {
				if (machine.restoreFails) throw new Error("restore failed");
				files.clear();
				for (const [path, content] of snapshots.get(id) ?? [])
					if (path !== "/tmp/heveta-workspace-restored")
						files.set(path, content);
			},
		};
		return machine;
	}
	// The user's computer over a fake machine: the Computer Durable Object's
	// workspace (computer-object.ts), its storage in memory.
	function fakeComputer(machine: ReturnType<typeof fakeMachine>) {
		if (!machine.workspace) {
			const values = new Map<string, unknown>();
			const workspace = new Workspace(
				machine,
				{
					get: async <T>(key: string) =>
						structuredClone(values.get(key)) as T | undefined,
					put: async <T>(key: string, value: T) => {
						values.set(key, structuredClone(value));
					},
					delete: async (key: string) => values.delete(key),
				},
				{
					// A stopped fake starts again on its next call.
					running: () => true,
					stop: async () => {
						machine.slept++;
						machine.restart();
					},
					activeRuns: async (ids) =>
						(
							await db
								.select({ id: runs.id })
								.from(runs)
								.where(
									and(
										inArray(runs.id, ids),
										inArray(runs.status, [RunStatus.QUEUED, RunStatus.RUNNING]),
									),
								)
						).map((run) => run.id),
					changed: () => {},
				},
			);
			machine.stopped = () => {
				void workspace.stopped();
			};
			machine.started = () => workspace.started();
			machine.workspace = workspace;
		}
		const workspace = machine.workspace;
		return {
			ready: async (runId?: string) =>
				(await workspace.ready(runId)).generation,
			save: (generation: number) => workspace.save(generation),
			release: (runId: string) => workspace.release(runId),
			exec: machine.exec,
			snapshots: () => workspace.snapshots(),
			sleep: () => workspace.sleep(),
			restart: (discardUnsaved: boolean) => workspace.restart(discardUnsaved),
			restoreSnapshot: (id: string, discardUnsaved: boolean) =>
				workspace.restore(id, discardUnsaved),
			clearWorkspace: (discardUnsaved: boolean) =>
				workspace.clear(discardUnsaved),
		};
	}
	// Oldest first.
	const backupsOf = async (machine: ReturnType<typeof fakeMachine>) =>
		(await fakeComputer(machine).snapshots()).snapshots.toReversed();
	function computerFor(
		machine: ReturnType<typeof fakeMachine>,
		store: StoreFile = async () => {
			throw new Error("Nothing is stored in this test");
		},
	) {
		const computer = fakeComputer(machine);
		const executor = sandboxExecutor(computer, machine, store);
		const call = async (name: string, args: Record<string, unknown>) => {
			const outcome = await executor.execute(
				{ callId: crypto.randomUUID(), name, arguments: args },
				new AbortController().signal,
			);
			if (!outcome) throw new Error("The call's outcome is unknown");
			return outcome;
		};
		return { computer, call };
	}
	test("the computer's workspace is saved after every change and restored after a restart", async () => {
		const machine = fakeMachine();
		const { call } = computerFor(machine);
		expect(
			await call("write_file", { path: "notes/plan.md", content: "draft" }),
		).toEqual({ output: "Wrote /workspace/notes/plan.md." });
		await call("edit_file", {
			path: "notes/plan.md",
			old_text: "draft",
			new_text: "final",
		});
		// A stopped container comes back empty; the newest snapshot returns.
		machine.restart();
		expect(
			(await call("read_file", { path: "notes/plan.md", start_line: 1 }))
				.output,
		).toContain("final");
		// Reading changes nothing, so nothing is saved.
		expect(machine.created).toBe(2);
		expect(
			await call("edit_file", {
				path: "notes/plan.md",
				old_text: "missing",
				new_text: "x",
			}),
		).toMatchObject({ isError: true });
		expect(
			await call("read_file", { path: "nowhere.txt", start_line: 1 }),
		).toMatchObject({
			isError: true,
			output: "/workspace/nowhere.txt is not a file.",
		});
		// Shell calls always capture a full filesystem snapshot, including
		// changes outside the workspace.
		const shell = await call("shell", {
			command: "ls",
			workdir: "/workspace",
			timeout_seconds: 10,
		});
		expect(shell.output).toContain("Exit code: 0");
		expect(machine.created).toBe(3);
		machine.beforeCommand = () =>
			machine.files.set("/workspace/notes/out.txt", "made by a command");
		await call("shell", {
			command: "echo made > notes/out.txt",
			workdir: "/workspace",
			timeout_seconds: 10,
		});
		expect(machine.created).toBe(4);
	});
	test("files on the computer are sent to the user, and images viewed by the model, as stored copies", async () => {
		const machine = fakeMachine();
		const stored: { content: number[]; fileName: string; mimeType: string }[] =
			[];
		// Stores like the app: the file's start decides an image's type.
		const { call } = computerFor(machine, async (file) => {
			const content = [
				...new Uint8Array(await new Response(file.content).arrayBuffer()),
			];
			const mimeType = sniffMimeType(new Uint8Array(content)) ?? file.mimeType;
			stored.push({ content, fileName: file.fileName, mimeType });
			return {
				id: `copy-${stored.length}`,
				mimeType,
				fileName: file.fileName,
				size: BigInt(file.size),
			};
		});
		const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00];
		machine.files.set(
			"/workspace/shot.png",
			Buffer.from(png).toString("latin1"),
		);
		// The user and the model see the same copy of an image.
		const copy = expect.objectContaining({
			id: "copy-1",
			mimeType: "image/png",
		});
		expect(await call("send_file", { path: "shot.png" })).toEqual({
			output: "Sent to the user: /workspace/shot.png",
			shown: [copy],
			images: [copy],
		});
		// The copy holds the file's exact bytes.
		expect(stored[0]).toEqual({
			content: png,
			fileName: "shot.png",
			mimeType: "image/png",
		});
		// Any other file is sent for download; the model is not sent it.
		machine.files.set("/workspace/report.csv", "a,b\n1,2\n");
		expect(await call("send_file", { path: "report.csv" })).toEqual({
			output: "Sent to the user: /workspace/report.csv",
			shown: [expect.objectContaining({ id: "copy-2" })],
		});
		expect(await call("view_image", { path: "/workspace/shot.png" })).toEqual({
			output: "/workspace/shot.png",
			images: [expect.objectContaining({ id: "copy-3" })],
		});
		expect(await call("view_image", { path: "report.csv" })).toMatchObject({
			isError: true,
			output: expect.stringContaining("not a PNG"),
		});
		// A file that is no image is turned away before it is copied.
		expect(stored).toHaveLength(3);
		expect(await call("send_file", { path: "missing.png" })).toMatchObject({
			isError: true,
			output: expect.stringContaining("File not found"),
		});
		// Sending and viewing change nothing on the computer.
		expect(await backupsOf(machine)).toHaveLength(0);
	});
	test("a command outlasting an interrupted execution keeps running; the next collects it, a stop kills it", async () => {
		const machine = fakeMachine();
		const computer = fakeComputer(machine);
		const store: StoreFile = async () => {
			throw new Error("Nothing is stored in this test");
		};
		const signal = new AbortController().signal;
		const call = {
			callId: "long-1",
			name: "shell",
			arguments: { command: "make build", workdir: "", timeout_seconds: 1800 },
		};
		machine.running.add("make build");
		// The execution that starts it is lost (its actor restarted) while the
		// command still runs.
		machine.lost.add("make build");
		void sandboxExecutor(computer, machine, store).execute(call, signal);
		await vi.waitFor(() =>
			expect(machine.processes.has("shell-long-1")).toBe(true),
		);
		machine.lost.clear();
		// The next execution finds it by the call and waits for it.
		const next = sandboxExecutor(computer, machine, store);
		const collected = next.resume?.(call, signal);
		machine.processes.get("shell-long-1")?.finish();
		expect(await collected).toEqual({
			output: "Exit code: 0\nran: make build",
			isError: false,
		});
		// Its files are gone once collected; a call that never ran has none.
		expect(
			[...machine.files.keys()].some((path) => path.includes("long-1")),
		).toBe(false);
		expect(
			await next.resume?.({ ...call, callId: "never-ran" }, signal),
		).toBeUndefined();
		// A stop kills a running command.
		const stop = new AbortController();
		const stopped = next.execute({ ...call, callId: "long-2" }, stop.signal);
		await vi.waitFor(() =>
			expect(machine.processes.has("shell-long-2")).toBe(true),
		);
		stop.abort(new Error("stopped"));
		await expect(stopped).rejects.toThrow("stopped");
		expect(machine.processes.has("shell-long-2")).toBe(false);
	});
	test("a message's attachments go into its own folder on the computer, once, and count as placed only once saved", async () => {
		const machine = fakeMachine();
		const { computer } = computerFor(machine);
		const contents = new Map<string, string>();
		get.mockImplementation(async (key: string) => {
			const text = contents.get(key);
			return text === undefined ? null : { body: new Response(text).body };
		});
		const csv = async (text: string) => {
			const file = await upload({
				content: new TextEncoder().encode(text),
				mimeType: "text/csv",
				fileName: "表格.csv",
			});
			const [row] = await db
				.select({ storageKey: files.storageKey })
				.from(files)
				.where(eq(files.id, file.id));
			contents.set(row.storageKey, text);
			return file;
		};
		const send = async (fileIds: string[], threadId = "") => {
			const accepted = await clients().turn.startTurn({
				threadId,
				requestId: crypto.randomUUID(),
				input: { text: "look", fileIds },
			});
			await finishRun(accepted.snapshot);
			return {
				folder: `/workspace/uploads/${accepted.snapshot?.inputMessage?.id}`,
				threadId: accepted.thread?.id ?? threadId,
			};
		};
		const place = (threadId: string) =>
			placeUploads(db, "owner", () => ({ computer, machine }), threadId);
		// Two files of one name in one message are numbered.
		const first = await csv("a,b\n1,2\n");
		const twin = await csv("c,d\n");
		const sent = await send([first.id, twin.id]);
		await place(sent.threadId);
		expect(machine.files.get(`${sent.folder}/表格.csv`)).toBe("a,b\n1,2\n");
		expect(machine.files.get(`${sent.folder}/表格 (2).csv`)).toBe("c,d\n");
		expect(await backupsOf(machine)).toHaveLength(1);
		// Placed once: a resumed run or a later attempt leaves the agent's edit.
		machine.files.set(`${sent.folder}/表格.csv`, "edited");
		await place(sent.threadId);
		expect(machine.files.get(`${sent.folder}/表格.csv`)).toBe("edited");
		expect(await backupsOf(machine)).toHaveLength(1);
		// Another message's file of the same name has a folder of its own.
		const other = await csv("e,f\n");
		const later = await send([other.id]);
		// The computer restarts while it is put there: it is not placed.
		const write = machine.writeFile;
		machine.writeFile = async (path, content) => {
			await write(path, content);
			machine.restart();
		};
		await expect(place(later.threadId)).rejects.toBeInstanceOf(
			WorkspaceLostError,
		);
		machine.writeFile = write;
		// It is not left behind with its message: the conversation's next run,
		// for a message without attachments, puts it there.
		await send([], later.threadId);
		await place(later.threadId);
		expect(machine.files.get(`${later.folder}/表格.csv`)).toBe("e,f\n");
		// The restart brought back the saved workspace, the first message's
		// attachments with it.
		expect(machine.files.has(`${sent.folder}/表格 (2).csv`)).toBe(true);
	});
	test("from settings the workspace is measured, restored, cleared, and the computer restarted, keeping the state each replaced, never under a reply using it", async () => {
		const machine = fakeMachine();
		const { call } = computerFor(machine);
		const computer = fakeComputer(machine);
		await call("write_file", { path: "a.txt", content: "first" });
		await call("write_file", { path: "a.txt", content: "second" });
		expect(await workspaceUsage("owner", computer)).toBe(6);
		const listed = await listSnapshots("owner", computer);
		const [newest, older] = listed.snapshots;
		expect(listed.currentId).toBe(newest.id);
		// A change the person made in the terminal, not saved yet (a
		// connection is saved when it closes).
		machine.files.set("/workspace/notes.txt", "unsaved");
		// Restoring saves the current state first and keeps it, then restarts
		// the computer, which comes back with the chosen snapshot whole.
		await restoreSnapshot("owner", older.id, false, computer);
		expect(machine.destroyed).toBe(1);
		const restored = await listSnapshots("owner", computer);
		const [before] = restored.snapshots;
		expect(restored.currentId).toBe(older.id);
		expect(before).toMatchObject({ pinned: true });
		expect(machine.snapshots.get(before.id)?.get("/workspace/notes.txt")).toBe(
			"unsaved",
		);
		await computer.ready();
		expect(machine.files.get("/workspace/a.txt")).toBe("first");
		expect(machine.files.has("/workspace/notes.txt")).toBe(false);
		// Saves after it, a burst in the same hour, never push it out.
		for (let count = 0; count < 12; count++)
			await call("write_file", { path: "b.txt", content: String(count) });
		expect(
			(await listSnapshots("owner", computer)).snapshots.map(
				(snapshot) => snapshot.id,
			),
		).toContain(before.id);
		// Clearing keeps the state before it too, unsaved changes included.
		machine.files.set("/workspace/draft.txt", "unsaved");
		await clearWorkspace("owner", false, computer);
		expect(await workspaceUsage("owner", computer)).toBe(0);
		const cleared = await listSnapshots("owner", computer);
		const beforeClear = cleared.snapshots.find(
			(snapshot) => snapshot.pinned && snapshot.id !== before.id,
		);
		expect(
			machine.snapshots.get(beforeClear?.id ?? "")?.get("/workspace/draft.txt"),
		).toBe("unsaved");
		// Restarting saves first as well.
		machine.files.set("/workspace/late.txt", "unsaved");
		await restartComputer("owner", false, computer);
		expect(machine.destroyed).toBe(2);
		await computer.ready();
		expect(machine.files.get("/workspace/late.txt")).toBe("unsaved");
		await expect(
			restoreSnapshot("owner", "missing", false, computer),
		).rejects.toMatchObject({ code: ErrorCode.NotFound });
		// A reply using the computer holds it: nothing is pulled from under it.
		fake.mode = "pause";
		const accepted = await clients().turn.startTurn({
			threadId: await thread(),
			requestId: crypto.randomUUID(),
			input: { text: "slow" },
		});
		const runId = accepted.snapshot?.run?.id ?? "";
		await computer.ready(runId);
		for (const action of [
			() => clearWorkspace("owner", false, computer),
			() => restartComputer("owner", true, computer),
			() => restoreSnapshot("owner", newest.id, false, computer),
		])
			await expect(action()).rejects.toMatchObject({
				code: ErrorCode.FailedPrecondition,
				reason: ErrorReason.COMPUTER_BUSY,
			});
		// Once it ends, even without releasing it, the computer is free.
		await clients().run.cancelRun({ lookup: { case: "runId", value: runId } });
		expect(terminal(await finishRun(accepted.snapshot)).status).toBe(
			RunStatus.CANCELLED,
		);
		await restartComputer("owner", false, computer);
		expect(machine.destroyed).toBe(3);
	});
	test("changes that cannot be saved keep the computer on, and are replaced only when given up", async () => {
		const machine = fakeMachine();
		const computer = fakeComputer(machine);
		let generation = await computer.ready();
		machine.files.set("/workspace/a.txt", "saved");
		await computer.save(generation);
		// The disk fills up: the next change cannot be saved.
		machine.files.set("/workspace/a.txt", "unsaved");
		machine.beforeSnapshot = async () => {
			throw new Error("No space left on device");
		};
		await expect(computer.save(generation)).rejects.toThrow("No space");
		expect((await computer.snapshots()).unsavedSince).toBeTypeOf("number");
		// Sleeping would lose it: the idle computer stays on.
		await computer.sleep();
		expect(machine.slept).toBe(0);
		// Nothing replaces it unless the person gives it up.
		for (const action of [
			() => restartComputer("owner", false, computer),
			() => clearWorkspace("owner", false, computer),
		])
			await expect(action()).rejects.toMatchObject({
				code: ErrorCode.FailedPrecondition,
				reason: ErrorReason.WORKSPACE_UNSAVED,
			});
		expect(machine.files.get("/workspace/a.txt")).toBe("unsaved");
		await restartComputer("owner", true, computer);
		expect(machine.destroyed).toBe(1);
		expect((await computer.snapshots()).unsavedSince).toBeUndefined();
		generation = await computer.ready();
		expect(machine.files.get("/workspace/a.txt")).toBe("saved");
		// Saved, the idle computer sleeps; but not when something asked for it
		// while it was being saved.
		machine.files.set("/workspace/a.txt", "changed");
		let release!: () => void;
		machine.beforeSnapshot = () =>
			new Promise<void>((resolve) => {
				release = resolve;
			});
		const sleeping = computer.sleep();
		await vi.waitFor(() => expect(release).toBeDefined());
		const using = computer.ready();
		release();
		await sleeping;
		expect(machine.slept).toBe(0);
		await using;
		machine.beforeSnapshot = async () => {};
		await computer.sleep();
		expect(machine.slept).toBe(1);
	});
	test("an empty workspace is never saved over the user's, and a failed restore runs nothing", async () => {
		const machine = fakeMachine();
		const { call } = computerFor(machine);
		await call("write_file", { path: "a.txt", content: "kept" });
		const saved = await backupsOf(machine);
		// The container restarts in the middle of a call.
		const write = machine.writeFile;
		machine.writeFile = async (
			path: string,
			content: string | ReadableStream<Uint8Array>,
		) => {
			await write(path, content);
			machine.restart();
		};
		const lost = await call("write_file", { path: "b.txt", content: "new" });
		expect(lost).toMatchObject({ isError: true });
		expect(lost.output).toContain("The computer restarted during this call");
		expect(await backupsOf(machine)).toEqual(saved);
		machine.writeFile = write;
		machine.restoreFails = true;
		await expect(
			call("shell", {
				command: "ls",
				workdir: "/workspace",
				timeout_seconds: 10,
			}),
		).rejects.toMatchObject({ code: ErrorCode.Unavailable });
		expect(await backupsOf(machine)).toEqual(saved);
		machine.restoreFails = false;
		expect(
			(await call("read_file", { path: "a.txt", start_line: 1 })).output,
		).toContain("kept");
	});
	test("saves run one at a time; one across a container restart is dropped; older ones are thinned to one an hour", async () => {
		const machine = fakeMachine();
		const computer = fakeComputer(machine);
		let generation = await computer.ready();
		// Each save here follows a change: one with none keeps the snapshot
		// it has (the test above).
		let changes = 0;
		const change = () =>
			machine.files.set("/workspace/counter.txt", String(++changes));
		// The first save holds its snapshot; the second waits for it.
		let started = 0;
		let release!: () => void;
		machine.beforeSnapshot = () => {
			started++;
			return started === 1
				? new Promise<void>((resolve) => {
						release = resolve;
					})
				: Promise.resolve();
		};
		change();
		const first = computer.save(generation);
		await vi.waitFor(() => expect(started).toBe(1));
		change();
		const second = computer.save(generation);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(started).toBe(1);
		release();
		expect([await first, await second]).toEqual(["saved", "saved"]);
		expect(started).toBe(2);
		const saved = await backupsOf(machine);
		// The container restarts while a snapshot is taken: it holds the new
		// container's empty disk, and is dropped.
		machine.beforeSnapshot = async () => machine.restart();
		change();
		expect(await computer.save(generation)).toBe("lost");
		expect(await backupsOf(machine)).toEqual(saved);
		machine.beforeSnapshot = async () => {};
		// Work prepared on the container before it restarted is lost with it,
		// even if the new one has been restored since.
		const stale = generation;
		generation = await computer.ready();
		change();
		expect(await computer.save(stale)).toBe("lost");
		// Three saves an hour for twelve hours: kept are the newest two, then
		// the newest of each earlier hour, ten in all.
		const hour = 60 * 60 * 1000;
		const start = Math.ceil(Date.now() / hour) * hour + hour;
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			for (let at = 0; at < 12; at++)
				for (let minute = 0; minute < 3; minute++) {
					vi.setSystemTime(start + at * hour + minute * 60_000);
					change();
					await computer.save(generation);
				}
		} finally {
			vi.useRealTimers();
		}
		const kept = (await computer.snapshots()).snapshots.map(
			(snapshot) => snapshot.createdAt - start,
		);
		expect(kept).toEqual([
			11 * hour + 2 * 60_000,
			11 * hour + 60_000,
			...[10, 9, 8, 7, 6, 5, 4, 3].map((at) => at * hour + 2 * 60_000),
		]);
		// Only retained handles stay visible; discarded platform snapshots
		// remain immutable until Cloudflare expires them.
		expect(machine.snapshots.size).toBeGreaterThan(10);
		expect(
			(await computer.snapshots()).snapshots.map((snapshot) => snapshot.id),
		).not.toContain(saved[0].id);
	});
	test("a container that started again without its stop reported is restored before use, and work from before is lost, never saved", async () => {
		const machine = fakeMachine();
		const computer = fakeComputer(machine);
		const generation = await computer.ready();
		machine.files.set("/workspace/a.txt", "kept");
		expect(await computer.save(generation)).toBe("saved");
		// Attaching to the same container asks again, and finds it restored.
		machine.started();
		expect(await computer.ready()).toBe(generation);
		// The SDK may never learn of a container that vanished; the next one it
		// starts is reported. Known restored until then, the computer is not
		// asked again; after it, it is, and is restored.
		machine.files.clear();
		machine.started();
		machine.files.set("/workspace/b.txt", "on an empty disk");
		await computer.ready();
		expect(machine.files.get("/workspace/a.txt")).toBe("kept");
		expect(machine.files.has("/workspace/b.txt")).toBe(false);
		// Work prepared on the container that vanished is lost, even though the
		// new one is restored now.
		machine.files.set("/workspace/c.txt", "changed");
		expect(await computer.save(generation)).toBe("lost");
	});
	test("a failed final archive retries the sealed result without another model request", async () => {
		await pool.query(`
			CREATE SEQUENCE refused_messages;
			CREATE FUNCTION refuse_first_write() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN IF nextval('refused_messages') = 1 THEN RAISE EXCEPTION 'connection lost'; END IF; RETURN NEW; END $$;
			CREATE TRIGGER refuse_first_write BEFORE UPDATE ON messages FOR EACH ROW EXECUTE FUNCTION refuse_first_write();
		`);
		try {
			const accepted = await clients().turn.startTurn({
				threadId: await thread(),
				requestId: crypto.randomUUID(),
				input: { text: "hello" },
			});
			const id = accepted.snapshot!.run!.id;
			const jobs = [...fake.jobs];
			fake.jobs.clear();
			await expect(Promise.all(jobs)).rejects.toThrow();
			expect(fake.locals.get(id)!.local.state()?.seal).toBeDefined();
			expect((await snapshot(id)).run?.status).toBe(RunStatus.RUNNING);
			expect(fake.requests).toBe(1);
			await dispatchRun(id);
			const final = await finishRun(accepted.snapshot);
			expect(final.run?.status).toBe(RunStatus.COMPLETED);
			expect(
				final.outputMessage?.parts.map((part) => part.content),
			).toContainEqual({ case: "text", value: "final answer" });
			expect(fake.requests).toBe(1);
		} finally {
			await pool.query(
				"DROP TRIGGER refuse_first_write ON messages; DROP FUNCTION refuse_first_write(); DROP SEQUENCE refused_messages;",
			);
		}
	});

	test("an archive page committed before a lost acknowledgment is replayed without duplicate rows", async () => {
		const original = runArchive.importArchivePage;
		let lost = false;
		const spy = vi
			.spyOn(runArchive, "importArchivePage")
			.mockImplementation(async (...args) => {
				await original(...args);
				if (!lost) {
					lost = true;
					throw new Error("archive acknowledgment lost");
				}
			});
		try {
			const accepted = await clients().turn.startTurn({
				threadId: await thread(),
				requestId: crypto.randomUUID(),
				input: { text: "hello" },
			});
			const id = accepted.snapshot!.run!.id;
			const jobs = [...fake.jobs];
			fake.jobs.clear();
			await expect(Promise.all(jobs)).rejects.toThrow(
				"archive acknowledgment lost",
			);
			const messageId = accepted.snapshot!.outputMessage!.id;
			const before = await db
				.select()
				.from(messageParts)
				.where(eq(messageParts.messageId, messageId));
			expect(before.length).toBeGreaterThan(0);
			expect(fake.locals.get(id)!.local.state()?.archive?.pages).toBe(0);
			await dispatchRun(id);
			await finishRun(accepted.snapshot);
			expect(
				await db
					.select()
					.from(messageParts)
					.where(eq(messageParts.messageId, messageId)),
			).toEqual(before);
			expect(
				await db
					.select()
					.from(runArchivePages)
					.where(eq(runArchivePages.runId, id)),
			).toHaveLength(1);
			expect(fake.requests).toBe(1);
		} finally {
			spy.mockRestore();
		}
	});

	test("a lost final archive acknowledgment confirms the terminal Run without executing again", async () => {
		const original = runArchive.finalizeArchive;
		let lost = false;
		const spy = vi
			.spyOn(runArchive, "finalizeArchive")
			.mockImplementation(async (...args) => {
				const result = await original(...args);
				if (!lost) {
					lost = true;
					throw new Error("final archive acknowledgment lost");
				}
				return result;
			});
		try {
			const accepted = await clients().turn.startTurn({
				threadId: await thread(),
				requestId: crypto.randomUUID(),
				input: { text: "hello" },
			});
			const id = accepted.snapshot!.run!.id;
			const jobs = [...fake.jobs];
			fake.jobs.clear();
			await expect(Promise.all(jobs)).rejects.toThrow(
				"final archive acknowledgment lost",
			);
			expect((await snapshot(id)).run?.status).toBe(RunStatus.COMPLETED);
			expect(fake.locals.get(id)!.local.state()?.run.status).toBe(
				StoredRunStatus.RUNNING,
			);
			await dispatchRun(id);
			await Promise.all(fake.jobs);
			fake.jobs.clear();
			expect(fake.locals.get(id)!.local.state()?.run.status).toBe(
				StoredRunStatus.COMPLETED,
			);
			expect(fake.requests).toBe(1);
		} finally {
			spy.mockRestore();
		}
	});

	// Mail as Email Routing hands it to the Worker's email() handler.
	async function deliver(to: string, raw: string) {
		const rejected: string[] = [];
		await worker.email({
			from: "ada@example.com",
			to,
			raw: new Response(raw).body!,
			rawSize: raw.length,
			headers: new Headers(),
			setReject: (reason: string) => rejected.push(reason),
		} as unknown as ForwardableEmailMessage);
		return rejected;
	}
	const mime = (
		messageId: string,
		parts: { type: string; name?: string; body: string }[],
	) =>
		[
			'From: "Ada" <ada@example.com>',
			"To: agent@agent.test",
			"Subject: Report",
			`Message-ID: ${messageId}`,
			"References: <root@example.com>",
			"MIME-Version: 1.0",
			'Content-Type: multipart/mixed; boundary="b"',
			"",
			...parts.flatMap((part) => [
				"--b",
				`Content-Type: ${part.type}`,
				// Attachments as mail programs send them: base64, byte for byte.
				...(part.name
					? [
							`Content-Disposition: attachment; filename="${part.name}"`,
							"Content-Transfer-Encoding: base64",
						]
					: []),
				"",
				part.name ? Buffer.from(part.body).toString("base64") : part.body,
			]),
			"--b--",
			"",
		].join("\r\n");
	const report = mime("<m1@example.com>", [
		{
			type: "text/html; charset=utf-8",
			body: '<h1>Hello</h1><p>Confirm at <a href="https://example.com/verify?t=1">this link</a>.</p><img src="https://tracker.example/p.png" alt="pixel">',
		},
		// Claims to be a PDF, and is not.
		{ type: "application/pdf", name: "report.pdf", body: "not a pdf" },
		{ type: "text/csv", name: "data.csv", body: "a,b" },
	]);
	const attachmentsOf = (emailId: string) =>
		db
			.select({ file: files })
			.from(emailFiles)
			.innerJoin(files, eq(files.id, emailFiles.fileId))
			.where(eq(emailFiles.emailId, emailId))
			.orderBy(asc(files.id));
	test("mail reaches only its agent's mailbox, is kept once, and keeps its attachments as the user's files while it stays", async () => {
		const mailbox = await mailboxOf(db, "owner");
		// Given once, generated, and the same from then on.
		expect(mailbox.name).toMatch(/^[a-hj-km-np-z2-9]{8}$/);
		expect(await mailboxOf(db, "owner")).toEqual(mailbox);
		expect((await clients().mail.getMailbox({})).mailbox).toMatchObject({
			address: `${mailbox.name}@agent.test`,
			recipientLimit: 5,
			recipientsUsed: 0,
		});
		// Another domain, an address nobody has, or the right name at another
		// domain: refused, and nothing kept.
		for (const to of [
			"someone@heveta.com",
			"nobody@agent.test",
			`${mailbox.name}@elsewhere.test`,
		])
			expect(await deliver(to, report)).toHaveLength(1);
		expect(await db.select().from(emails)).toHaveLength(0);
		// Any case and a subaddress reach it.
		expect(
			await deliver(`${mailbox.name.toUpperCase()}+news@Agent.Test`, report),
		).toEqual([]);
		const [kept] = await db.select().from(emails);
		expect(kept).toMatchObject({
			userId: "owner",
			status: "received",
			fromAddress: "ada@example.com",
			fromName: "Ada",
			subject: "Report",
			messageId: "<m1@example.com>",
			references: "<root@example.com>",
		});
		// An HTML-only body as text: links keep their addresses, images go.
		expect(kept.text).toContain("Hello");
		expect(kept.text).toContain("https://example.com/verify?t=1");
		expect(kept.text).not.toContain("tracker");
		// Delivered again (a retry): kept once.
		expect(await deliver(`${mailbox.name}@agent.test`, report)).toEqual([]);
		expect(await db.select().from(emails)).toHaveLength(1);
		expect(
			eventsOf("owner").filter((event) => event.event.case === "mail"),
		).toHaveLength(1);
		// Its attachments are the user's files; a type the content does not
		// bear out is not taken.
		const attached = (await attachmentsOf(kept.id)).map((row) => row.file);
		expect(attached).toEqual([
			expect.objectContaining({
				userId: "owner",
				fileName: "report.pdf",
				mimeType: "application/octet-stream",
				status: "stored",
			}),
			expect.objectContaining({ fileName: "data.csv", mimeType: "text/csv" }),
		]);
		const { email } = await clients().mail.getEmail({ emailId: kept.id });
		expect(email?.attachments.map((file) => file.url)).toEqual(
			attached.map((file) => `/files/${file.id}`),
		);
		// Nobody vouched for its sender (no results from Cloudflare's server).
		expect(email?.senderVerified).toBe(false);
		// Unread until opened; opening it again changes nothing.
		expect(email?.unread).toBe(true);
		expect((await clients().mail.getMailbox({})).mailbox?.unreadCount).toBe(1);
		await clients().mail.markEmailRead({ emailId: kept.id });
		await clients().mail.markEmailRead({ emailId: kept.id });
		expect((await clients().mail.getMailbox({})).mailbox?.unreadCount).toBe(0);
		expect(
			(await clients().mail.getEmail({ emailId: kept.id })).email?.unread,
		).toBe(false);
		await expect(
			clients(otherSession).mail.markEmailRead({ emailId: kept.id }),
		).rejects.toMatchObject({ code: Code.NotFound });
		// The owner's alone.
		await expect(
			clients(otherSession).mail.getEmail({ emailId: kept.id }),
		).rejects.toMatchObject({ code: Code.NotFound });
		await expect(
			clients(otherSession).mail.deleteEmail({ emailId: kept.id }),
		).rejects.toMatchObject({ code: Code.NotFound });
		// Kept while the email is, however old.
		await db
			.update(files)
			.set({ createdAt: new Date(Date.now() - 2 * 86400_000) });
		expect(await cleanupFiles(db)).toBe(0);
		// Deleted with it.
		await clients().mail.deleteEmail({ emailId: kept.id });
		expect(await db.select().from(emails)).toHaveLength(0);
		expect(await cleanupFiles(db)).toBe(2);
		expect(await db.select().from(files)).toHaveLength(0);
		// A sender Cloudflare's mail server vouched for, as it marks one on top.
		await deliver(
			`${mailbox.name}@agent.test`,
			`Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=example.com\r\n${mime("<m3@example.com>", [{ type: "text/plain", body: "Signed" }])}`,
		);
		const [signed] = await db.select().from(emails);
		expect(
			(await clients().mail.getEmail({ emailId: signed.id })).email
				?.senderVerified,
		).toBe(true);
	});
	test("the agent sends within its recipient limit and all agents' share of the quota, once per call; a send cut off is found again and never repeated", async () => {
		const sent: EmailMessageBuilder[] = [];
		let failure: unknown;
		Object.assign(env, {
			AGENT_MAIL: {
				send: async (message: EmailMessageBuilder) => {
					if (failure) throw failure;
					sent.push(message);
					return { messageId: `sent-${sent.length}` };
				},
			},
		});
		const mailbox = await mailboxOf(db, "owner");
		const noComputer: RunComputer = {
			attached: async () => {
				throw new Error("No computer in this test");
			},
			release: async () => {},
		};
		const tools = mailToolSet(db, "owner", "run-1", noComputer);
		const signal = new AbortController().signal;
		const sendCall = (callId: string, args: Record<string, unknown>) => ({
			callId,
			name: "email_send",
			arguments: {
				to: [],
				cc: [],
				bcc: [],
				subject: "",
				text: "Thanks",
				reply_to: "",
				attachments: [],
				...args,
			},
		});
		const send = (callId: string, args: Record<string, unknown>) =>
			tools.executor.execute(sendCall(callId, args), signal);
		const [received] = await db
			.insert(emails)
			.values({
				userId: "owner",
				status: "received",
				fromAddress: "ada@example.com",
				to: [],
				cc: [],
				bcc: [],
				replyTo: [],
				subject: "Report",
				text: "Here it is",
				messageId: "<m1@example.com>",
				references: "<root@example.com>",
			})
			.returning();
		// A reply goes in its thread, from the agent's own address.
		const reply = {
			to: ["ada@example.com", "bob@example.com"],
			reply_to: received.id,
		};
		expect((await send("c1", reply))?.output).toContain(
			"send to 3 more recipients",
		);
		expect(sent).toEqual([
			expect.objectContaining({
				from: { email: `${mailbox.name}@agent.test`, name: "Heveta" },
				to: ["ada@example.com", "bob@example.com"],
				subject: "Re: Report",
				text: "Thanks",
				headers: {
					"In-Reply-To": "<m1@example.com>",
					References: "<root@example.com> <m1@example.com>",
				},
			}),
		]);
		// A reply with no recipients goes to the sender, or where the email
		// asks replies to go.
		await db
			.update(emails)
			.set({ replyTo: [{ address: "team@example.com", name: "Team" }] })
			.where(eq(emails.id, received.id));
		expect((await send("c0", { reply_to: received.id }))?.output).toContain(
			"to team@example.com",
		);
		expect(sent[1]).toMatchObject({
			to: ["team@example.com"],
			headers: { "In-Reply-To": "<m1@example.com>" },
		});
		// The same call again sends nothing more.
		expect((await send("c1", reply))?.output).toContain("Sent");
		expect(sent).toHaveLength(2);
		// Refused by Email Service: nothing kept, nothing counted.
		failure = Object.assign(new Error("invalid address"), {
			code: "E_VALIDATION_ERROR",
		});
		await expect(
			send("c2", { to: ["not an address"], subject: "Hi" }),
		).rejects.toThrow("E_VALIDATION_ERROR");
		// Email Service's own failure (or one on the way): it may have gone
		// out, so it stays unconfirmed, holds its place in the limit, and its
		// outcome stays unknown.
		failure = Object.assign(new Error("internal error"), {
			code: "E_INTERNAL_SERVER_ERROR",
		});
		expect(
			await send("c3", { to: ["carol@example.com"], subject: "Hi" }),
		).toMatchObject({
			isError: true,
			output: expect.stringContaining("unknown"),
		});
		expect(
			await tools.executor.resume?.(
				sendCall("c3", { to: ["carol@example.com"], subject: "Hi" }),
				signal,
			),
		).toMatchObject({
			isError: true,
			output: expect.stringContaining("unknown"),
		});
		failure = undefined;
		// 4 of 5 used: 3 more are refused, saying what is left.
		await expect(
			send("c4", {
				to: ["d@example.com", "e@example.com", "f@example.com"],
				subject: "Hi",
			}),
		).rejects.toThrow("1 is left");
		// Two at once never pass the limit together.
		const both = await Promise.allSettled([
			send("c5", { to: ["g@example.com"], subject: "Hi" }),
			send("c6", { to: ["h@example.com"], subject: "Hi" }),
		]);
		expect(both.map((result) => result.status).sort()).toEqual([
			"fulfilled",
			"rejected",
		]);
		expect(sent).toHaveLength(3);
		// A call cut off before its email was recorded never sent one; one
		// that was sent says so.
		await expect(
			tools.executor.resume?.(sendCall("c7", {}), signal),
		).rejects.toThrow("not sent");
		expect(
			(await tools.executor.resume?.(sendCall("c1", reply), signal))?.output,
		).toContain("Sent");
		const rows = await db
			.select()
			.from(emails)
			.where(eq(emails.userId, "owner"))
			.orderBy(asc(emails.id));
		expect(rows.map((row) => row.status)).toEqual([
			"received",
			"sent",
			"sent",
			"sending",
			"sent",
		]);
		expect((await clients().mail.getMailbox({})).mailbox?.recipientsUsed).toBe(
			5,
		);
		// All agents together stay within their share of the account's
		// sending quota: another user's agent, within its own limit, is
		// refused once the share is used.
		const share = emailBudget.agentRecipientsPerDay;
		emailBudget.agentRecipientsPerDay = 5;
		try {
			await expect(
				mailToolSet(db, "other", "run-2", noComputer).executor.execute(
					sendCall("o1", { to: ["i@example.com"], subject: "Hi" }),
					signal,
				),
			).rejects.toThrow("sending budget");
		} finally {
			emailBudget.agentRecipientsPerDay = share;
		}
		expect(sent).toHaveLength(3);
		// What was sent stays: it is what the limit counts.
		await expect(
			clients().mail.deleteEmail({ emailId: rows[1].id }),
		).rejects.toMatchObject({ code: Code.FailedPrecondition });
	});
	test("an email's attachments go to the computer in a folder of its own, and files from it go out as attachments the sent email keeps", async () => {
		const sent: EmailMessageBuilder[] = [];
		Object.assign(env, {
			AGENT_MAIL: {
				send: async (message: EmailMessageBuilder) => {
					sent.push(message);
					return { messageId: "sent-1" };
				},
			},
		});
		const machine = fakeMachine();
		const computer = fakeComputer(machine);
		const tools = mailToolSet(db, "owner", "run-1", {
			attached: async () => ({ computer, machine }),
			release: async () => {},
		});
		const call = async (name: string, args: Record<string, unknown>) => {
			const outcome = await tools.executor.execute(
				{ callId: crypto.randomUUID(), name, arguments: args },
				new AbortController().signal,
			);
			if (!outcome) throw new Error("The call's outcome is unknown");
			return outcome;
		};
		const mailbox = await mailboxOf(db, "owner");
		await deliver(
			`${mailbox.name}@agent.test`,
			mime("<m2@example.com>", [
				{ type: "text/plain", body: "Two notes" },
				{ type: "text/plain", name: "note.txt", body: "first" },
				{ type: "text/plain", name: "note.txt", body: "second" },
			]),
		);
		const [email] = await db.select().from(emails);
		const contents = new Map(
			(await attachmentsOf(email.id)).map(({ file }, index) => [
				file.storageKey,
				["first", "second"][index],
			]),
		);
		get.mockImplementation(async (key: string) => {
			const text = contents.get(key);
			return text === undefined ? null : { body: new Response(text).body };
		});
		expect(
			(await call("email_list", { folder: "inbox", query: "", before: "" }))
				.output,
		).toContain(
			// The name is the sender's claim, after the verdict on its address.
			'From: ada@example.com (not verified, may be forged); the name it gives, unverified: "Ada" · Subject: Report · 2 attachments · unread',
		);
		expect(
			(await call("email_read", { id: email.id, start: 0 })).output,
		).toContain("note.txt (text/plain, 5 B); note.txt (text/plain, 6 B)");
		// The agent reading it reads it.
		const [read] = await db
			.select({ readAt: emails.readAt })
			.from(emails)
			.where(eq(emails.id, email.id));
		expect(read.readAt).not.toBeNull();
		const folder = `/workspace/mail/${email.id}`;
		expect(await call("email_save_attachments", { id: email.id })).toEqual({
			output: `Put on your computer:\n${folder}/note.txt\n${folder}/note (2).txt`,
		});
		expect(machine.files.get(`${folder}/note.txt`)).toBe("first");
		expect(machine.files.get(`${folder}/note (2).txt`)).toBe("second");
		// Saved like any change on the computer.
		expect(await backupsOf(machine)).toHaveLength(1);
		// A file from the computer goes out as an attachment, and the sent
		// email keeps its copy.
		machine.files.set("/workspace/out.csv", "x,y\n");
		expect(
			(
				await call("email_send", {
					to: ["ada@example.com"],
					cc: [],
					bcc: [],
					subject: "Numbers",
					text: "Attached.",
					reply_to: "",
					attachments: ["out.csv"],
				})
			).output,
		).toContain("Sent");
		expect(sent[0].attachments).toEqual([
			expect.objectContaining({
				filename: "out.csv",
				disposition: "attachment",
			}),
		]);
		expect(
			new TextDecoder().decode(sent[0].attachments?.[0].content as Uint8Array),
		).toBe("x,y\n");
		const [outgoing] = await db
			.select()
			.from(emails)
			.where(eq(emails.status, "sent"));
		expect(
			(await attachmentsOf(outgoing.id)).map(({ file }) => file.fileName),
		).toEqual(["out.csv"]);
		// A file that is not there sends nothing.
		await expect(
			call("email_send", {
				to: ["ada@example.com"],
				cc: [],
				bcc: [],
				subject: "Missing",
				text: "Attached.",
				reply_to: "",
				attachments: ["missing.pdf"],
			}),
		).rejects.toThrow("could not be read");
		expect(sent).toHaveLength(1);
	});
});
