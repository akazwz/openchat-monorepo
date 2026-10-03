import { defineConfig, triggers } from "cf/config";

export default defineConfig({
	worker: {
		name: "heveta-site",
		compatibilityDate: "2026-09-20",
		workersDev: false,
		triggers: [
			triggers.fetch({
				pattern: "heveta.com/*",
				zone: "heveta.com",
			}),
		],
	},
});
