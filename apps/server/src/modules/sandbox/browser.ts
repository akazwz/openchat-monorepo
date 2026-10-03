import { Buffer } from "node:buffer";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
	StreamableHTTPClientTransport,
	StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { errorDetails } from "@/lib/error-details";
import { AppError, ErrorCode } from "@/lib/errors";
import type { FileReference } from "@/modules/files/types";
import type { ToolOutcome, ToolSet, ToolSpec } from "@/runtime/tools";

import definitions from "./browser-tools.json";
import {
	type ComputerHandle,
	type SandboxMachine,
	savedOutcome,
	traced,
} from "./computer";
import { clip, outputChars } from "./output";
import type { StoreFile } from "./tools";

// The Playwright MCP server in the computer (sandbox/browser-mcp.sh), which
// drives the browser on its screen. It serves only requests addressed to
// localhost:8931.
const port = 8931;
const endpoint = new URL(`http://localhost:${port}/mcp`);

// What the agent is offered of Playwright MCP's tools (browser-tools.json,
// generated from the version in the image): going to pages and tabs, reading
// them, and acting on their elements. Left out: closing the browser (it is
// the one on the person's screen, kept open between calls), running code,
// and developer tools (network, console, media emulation, window size).
const offered = new Set([
	"browser_navigate",
	"browser_navigate_back",
	"browser_tabs",
	"browser_snapshot",
	"browser_find",
	"browser_take_screenshot",
	"browser_wait_for",
	"browser_click",
	"browser_hover",
	"browser_type",
	"browser_fill_form",
	"browser_select_option",
	"browser_press_key",
	"browser_handle_dialog",
	"browser_file_upload",
]);

// Playwright MCP's own definitions; its schemas have optional properties,
// which strict mode does not allow.
export const browserSpecs: ToolSpec[] = definitions.tools
	.filter((tool) => offered.has(tool.name))
	.map((tool) => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.inputSchema,
		readOnly: tool.readOnly,
		// One page, driven in the model's order: a snapshot after a wait sees
		// what it waited for, a file is sent after it is saved.
		concurrent: false,
		strict: false,
		surface: "browser",
	}));
export const isBrowserTool = (name: string) => offered.has(name);
const readOnly = new Set(
	browserSpecs.filter((spec) => spec.readOnly).map((spec) => spec.name),
);

// How long a call is waited for: past the server's own longest wait (a
// navigation, 60 s by default in Playwright MCP), so a slow page is answered
// by the server as a result, not cut off here. The SDK's own default is 60 s.
const callTimeoutMs = 120_000;

// An open session with the server: its calls, and ending it. Opened on the
// container of `generation` (see ComputerHandle.ready).
export interface BrowserSession {
	generation: number;
	callTool: Client["callTool"];
	close(): Promise<void>;
}

// Connects to the server, starting the browser and the server if they are not
// running (and the screen it shows on, which heveta-browser starts when a
// new computer has not yet). Requests reach the container through the
// sandbox's RPC as plain data (the server's messages are JSON text): a
// Request object's body crosses as a stream, which the sandbox reports as
// disconnected on every call. An AbortSignal cannot cross either, so a
// request is not cancelled midway. Responses, the server's event stream
// among them, stream back. Each step is logged for the run (traced).
export function connectBrowser(
	computer: ComputerHandle,
	machine: Pick<SandboxMachine, "exec" | "containerFetch">,
) {
	const context = { runId: computer.runId };
	return async (): Promise<BrowserSession> => {
		const generation = await traced("ready", context, () => computer.ready());
		const started = await traced("startBrowser", context, () =>
			machine.exec("heveta-browser-mcp"),
		);
		if (!started.success)
			throw new AppError(
				`The browser could not start: ${started.stderr.trim()}`,
				ErrorCode.Unavailable,
			);
		const client = new Client({ name: "heveta", version: "1" });
		const transport = new StreamableHTTPClientTransport(endpoint, {
			fetch: async (url, init) => {
				const request = new Request(url, init);
				return machine.containerFetch(
					request.url,
					{
						method: request.method,
						headers: Object.fromEntries(request.headers),
						body: request.body ? await request.text() : undefined,
					},
					port,
				);
			},
		});
		await traced("connectBrowser", context, () => client.connect(transport));
		return {
			generation,
			callTool: (...args) => client.callTool(...args),
			// Without its signal, closing the client cannot end the stream the
			// server sends on (pings and requests); ending the session on the
			// server does, unless the server no longer has it (404).
			async close() {
				try {
					await transport.terminateSession();
				} catch (error) {
					if (!(error instanceof StreamableHTTPError && error.code === 404))
						throw error;
				} finally {
					await client.close();
				}
			},
		};
	};
}

type CallResult = Awaited<ReturnType<Client["callTool"]>>;

// A result as the model reads it: its text (a long page cut, with the tool to
// search the rest), and its images stored like any file the model reads.
async function toOutcome(
	result: CallResult,
	store: StoreFile,
): Promise<ToolOutcome> {
	const texts: string[] = [];
	const images: FileReference[] = [];
	for (const part of Array.isArray(result.content) ? result.content : []) {
		if (part.type === "text") texts.push(part.text);
		else if (part.type === "image") {
			const bytes = Buffer.from(part.data, "base64");
			images.push(
				await store({
					content: new Response(bytes).body!,
					size: bytes.length,
					fileName: `screenshot.${part.mimeType.split("/")[1] ?? "png"}`,
					mimeType: part.mimeType,
				}),
			);
		} else if (part.type === "resource" && "text" in part.resource)
			texts.push(part.resource.text);
	}
	const text = texts.join("\n");
	return {
		output:
			text.length > outputChars
				? `${clip(text)}\n\n(Cut to ${outputChars} characters; find the rest with browser_find.)`
				: text,
		...(result.isError === true ? { isError: true } : {}),
		...(images.length ? { images } : {}),
	};
}

// A new session's current tab is the browser's first, whichever tab the
// agent was using. With more than one open, it is told so, and which they
// are, with the session's first result.
async function newSessionNote(open: BrowserSession) {
	try {
		const listed = await open.callTool(
			{ name: "browser_tabs", arguments: { action: "list" } },
			undefined,
			{ timeout: callTimeoutMs },
		);
		const text = (Array.isArray(listed.content) ? listed.content : [])
			.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("\n");
		const tabs = text.split("\n").filter((line) => /^- \d+:/.test(line));
		if (tabs.length < 2) return undefined;
		return `(A new browser session started, so the current tab is the first one. If you were working in another, select it with browser_tabs. Open tabs:\n${tabs.join("\n")})`;
	} catch (error) {
		console.warn("[Browser] Tabs not listed", errorDetails(error));
		return undefined;
	}
}

const message = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

// The browser tools' calls (docs/sandbox.md), one MCP session per execution
// of a run, ended with it, and opened again when one is lost.
export function browserExecutor(
	computer: ComputerHandle,
	store: StoreFile,
	connect: () => Promise<BrowserSession>,
): ToolSet["executor"] {
	let opened: Promise<BrowserSession> | undefined;
	// What the open session's first result tells the model (newSessionNote).
	let note: string | undefined;
	const session = () => {
		opened ??= connect()
			.then(async (open) => {
				note = await newSessionNote(open);
				return open;
			})
			.catch((error: unknown) => {
				opened = undefined;
				if (error instanceof AppError) throw error;
				console.warn("[Browser] Session not opened", errorDetails(error));
				throw new AppError(
					`The browser could not be reached (${message(error)}); nothing was done. Try again shortly.`,
					ErrorCode.Unavailable,
				);
			});
		return opened;
	};
	const end = async () => {
		const ending = opened;
		opened = undefined;
		note = undefined;
		try {
			await (await ending)?.close();
		} catch (error) {
			console.warn("[Browser] Session not ended", errorDetails(error));
		}
	};
	return {
		async execute(call, signal) {
			let result: CallResult | undefined;
			let open: BrowserSession | undefined;
			for (let sent = 0; !result; sent++) {
				// Opening a session acts on no page: its failure is the call's.
				open = await session();
				const current = open;
				try {
					result = await traced(
						call.name,
						{ runId: computer.runId, callId: call.callId },
						() =>
							current.callTool(
								{ name: call.name, arguments: call.arguments },
								undefined,
								{ signal, timeout: callTimeoutMs },
							),
					);
				} catch (error) {
					// A failure outside the tool (the page's own errors come back as
					// results) leaves the session in doubt: the next call opens a
					// new one. The call is repeated only when the server no longer
					// knew the session (404: the computer restarted), so it cannot
					// have acted.
					void end();
					if (error instanceof StreamableHTTPError && error.code === 404) {
						if (sent > 0) throw error;
						console.warn(
							"[Browser] Session gone; reconnecting",
							errorDetails(error),
						);
						continue;
					}
					// Any other failure (a lost connection, the wait's end) may have
					// come after the page acted: a call that changes something is
					// reported as unknown, so the model checks the page before
					// doing it again; one that reads only failed, and says why.
					if (signal.aborted) throw error;
					console.warn("[Browser] Call failed", errorDetails(error));
					if (!readOnly.has(call.name)) return undefined;
					return {
						output: `The browser call failed: ${message(error)}`,
						isError: true,
					};
				}
			}
			let outcome = await toOutcome(result, store);
			if (note) {
				outcome = { ...outcome, output: `${note}\n\n${outcome.output}` };
				note = undefined;
			}
			// A file saved by name lands in the workspace, which must keep it.
			if (
				open &&
				typeof call.arguments.filename === "string" &&
				!outcome.isError
			)
				return savedOutcome(computer, open.generation, outcome, call.callId);
			return outcome;
		},
		close: end,
	};
}
