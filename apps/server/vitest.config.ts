import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
			"cloudflare:workers": fileURLToPath(
				new URL("./test/env.ts", import.meta.url),
			),
		},
	},
	test: {
		environment: "node",
		setupFiles: ["./test/setup.ts"],
		clearMocks: true,
		restoreMocks: true,
		// These packages import their own modules without file extensions,
		// which Node's ESM loader rejects; Vite resolves them.
		server: {
			deps: { inline: ["@cloudflare/sandbox"] },
		},
	},
});
