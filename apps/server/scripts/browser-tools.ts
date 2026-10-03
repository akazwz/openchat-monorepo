// Writes src/modules/sandbox/browser-tools.json: the tool definitions of the
// Playwright MCP version pinned in package.json (and installed in the
// computer's image, sandbox/Dockerfile), read from its own tools/list. The
// agent is offered them before the computer runs (docs/sandbox.md), and a
// pinned copy keeps every request's definitions the same.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const require = createRequire(import.meta.url);
const packageFile = require.resolve("@playwright/mcp/package.json");
const { version, bin } = JSON.parse(readFileSync(packageFile, "utf8"));

// Listing needs no browser: nothing listens at this endpoint.
const client = new Client({ name: "heveta-browser-tools", version: "1" });
await client.connect(
	new StdioClientTransport({
		command: process.execPath,
		args: [
			join(dirname(packageFile), bin["playwright-mcp"]),
			"--cdp-endpoint",
			"http://127.0.0.1:9",
		],
	}),
);
const { tools } = await client.listTools();
await client.close();

const definitions = {
	version,
	tools: tools.map((tool) => {
		// JSON Schema metadata, not part of a function's parameters.
		const { $schema: _, ...inputSchema } = tool.inputSchema as Record<
			string,
			unknown
		>;
		return {
			name: tool.name,
			description: tool.description ?? "",
			readOnly: tool.annotations?.readOnlyHint === true,
			inputSchema,
		};
	}),
};
writeFileSync(
	join(
		dirname(fileURLToPath(import.meta.url)),
		"../src/modules/sandbox/browser-tools.json",
	),
	`${JSON.stringify(definitions, null, "\t")}\n`,
);
console.log(
	`Wrote ${definitions.tools.length} tools of Playwright MCP ${version}`,
);
