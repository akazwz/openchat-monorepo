import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { expect, test, vi } from "vitest";

import {
	type BrowserSession,
	browserExecutor,
} from "@/modules/sandbox/browser";
import definitions from "@/modules/sandbox/browser-tools.json";
import type { ComputerHandle } from "@/modules/sandbox/computer";
import type { StoreFile } from "@/modules/sandbox/tools";

type CallResult = Awaited<ReturnType<BrowserSession["callTool"]>>;

const signal = new AbortController().signal;
const call = (name: string, args: Record<string, unknown> = {}) => ({
	callId: "call-1",
	name,
	arguments: args,
});

function setup(...clients: BrowserSession[]) {
	const computer = { save: vi.fn(async () => {}) };
	const store = vi.fn<StoreFile>(async (file) => ({
		id: "file-1",
		mimeType: file.mimeType,
		fileName: file.fileName,
		size: BigInt(file.size),
	}));
	const connect = vi.fn(async () => {
		const client = clients.shift();
		if (!client) throw new Error("No more clients");
		return client;
	});
	const executor = browserExecutor(
		computer as unknown as ComputerHandle,
		store,
		connect,
	);
	return { computer, store, connect, executor };
}
// A session whose tool calls go to `callTool` (counted in `calls`). The tabs a
// new session lists are `tabs`, one unless a test says.
const client = (
	callTool: (request: { name: string }) => Promise<CallResult>,
	tabs = ["- 0: (current) [Start](about:blank)"],
) => {
	const calls = vi.fn(callTool);
	return {
		generation: 0,
		calls,
		callTool: (async (request: { name: string }) =>
			request.name === "browser_tabs"
				? {
						content: [
							{ type: "text", text: `### Open tabs\n${tabs.join("\n")}` },
						],
					}
				: calls(request)) as BrowserSession["callTool"],
		close: vi.fn(async () => {}),
	};
};
const answer = (result: CallResult) => client(async () => result);

test("the tool definitions match the Playwright MCP the image installs", () => {
	const manifest = JSON.parse(
		readFileSync(
			fileURLToPath(new URL("../package.json", import.meta.url)),
			"utf8",
		),
	);
	const dockerfile = readFileSync(
		fileURLToPath(new URL("../sandbox/Dockerfile", import.meta.url)),
		"utf8",
	);
	const version = manifest.devDependencies["@playwright/mcp"];
	expect(definitions.version).toBe(version);
	expect(dockerfile).toContain(`@playwright/mcp@${version}`);
});

const output = async (outcome: Promise<{ output: string } | undefined>) =>
	(await outcome)?.output;

test("keeps one session and reconnects once when the server lost it", async () => {
	const first = client(async ({ name }) => {
		if (name === "browser_click")
			throw new StreamableHTTPError(404, "Session not found");
		return { content: [{ type: "text", text: "first" }] };
	});
	const second = answer({ content: [{ type: "text", text: "second" }] });
	const { executor, connect } = setup(first, second);
	expect(await output(executor.execute(call("browser_snapshot"), signal))).toBe(
		"first",
	);
	expect(await output(executor.execute(call("browser_click"), signal))).toBe(
		"second",
	);
	expect(await output(executor.execute(call("browser_snapshot"), signal))).toBe(
		"second",
	);
	expect(connect).toHaveBeenCalledTimes(2);
	expect(first.close).toHaveBeenCalledOnce();
});

test("does not repeat a call that failed otherwise: one that acts has an unknown outcome", async () => {
	const failing = () =>
		client(async () => {
			throw new StreamableHTTPError(500, "Internal error");
		});
	const clicking = failing();
	const reading = failing();
	const next = answer({ content: [{ type: "text", text: "ok" }] });
	const { executor, connect } = setup(clicking, reading, next);
	// The click may have happened: reported as unknown, never as failed.
	expect(await executor.execute(call("browser_click"), signal)).toBeUndefined();
	expect(clicking.calls).toHaveBeenCalledOnce();
	expect(clicking.close).toHaveBeenCalledOnce();
	// Reading changes nothing: its failure is one, and says why.
	expect(await executor.execute(call("browser_snapshot"), signal)).toEqual({
		output: "The browser call failed: Streamable HTTP error: Internal error",
		isError: true,
	});
	expect(reading.calls).toHaveBeenCalledOnce();
	expect(await output(executor.execute(call("browser_snapshot"), signal))).toBe(
		"ok",
	);
	expect(connect).toHaveBeenCalledTimes(3);
});

test("a new session tells the model its current tab is the first, when more than one is open", async () => {
	const tabs = [
		"- 0: (current) [Mail](https://mail.example)",
		"- 1: [Report](https://report.example)",
	];
	const { executor } = setup(
		client(async () => ({ content: [{ type: "text", text: "page" }] }), tabs),
	);
	const first = await output(
		executor.execute(call("browser_snapshot"), signal),
	);
	expect(first).toContain("current tab is the first one");
	expect(first).toContain(tabs[1]);
	expect(first).toMatch(/page$/);
	// Once per session.
	expect(await output(executor.execute(call("browser_snapshot"), signal))).toBe(
		"page",
	);
});
