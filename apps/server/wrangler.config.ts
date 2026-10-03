import { defineWranglerConfig } from "wrangler/experimental-config";

export default defineWranglerConfig({
	types: {
		generate: true,
	},
	assetsDirectory: "../web/build/client",
});
