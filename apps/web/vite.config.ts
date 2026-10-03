import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [reactRouter()],
	server: {
		proxy: {
			"/heveta.v1.": "http://localhost:8787",
			"/files/": "http://localhost:8787",
			"/avatars/": "http://localhost:8787",
			"/device/": { target: "http://localhost:8787", ws: true },
			"/upload": "http://localhost:8787",
			"/computer-file": "http://localhost:8787",
			// A shell on the computer, over a WebSocket (docs/sandbox.md).
			"/terminal": { target: "http://localhost:8787", ws: true },
			// The event channel, a WebSocket (docs/sync.md).
			"/events": { target: "http://localhost:8787", ws: true },
			// The computer's screen, VNC over a WebSocket (docs/sandbox.md).
			"/screen": { target: "http://localhost:8787", ws: true },
		},
	},
	resolve: {
		tsconfigPaths: true,
	},
});
