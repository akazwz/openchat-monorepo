import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vitest/config";

// Unit tests of the app's state logic. Not vite.config.ts: the React Router
// plugin builds pages, which these tests do not render.
export default defineConfig({
	resolve: {
		alias: {
			"~": fileURLToPath(new URL("./app", import.meta.url)),
		},
	},
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
	},
});
