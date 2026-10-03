import {
	bindings,
	defineConfig,
	defineContainer,
	exports,
	triggers,
} from "cf/config";

import { invitesNamespaceId } from "./cloudflare-resources.ts";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

// Keep the existing app and Computer namespace when changing configuration tools.
const computer = defineContainer({
	name: "heveta-computer-native",
	schedulingPolicy: "durable-object",
	images: { computer: { dockerfile: "./sandbox/Dockerfile" } },
});

export default defineConfig({
	containers: [computer],
	worker: {
		name: "heveta",
		compatibilityDate: "2026-09-20",
		compatibilityFlags: ["enable_request_signal", "nodejs_compat"],
		entrypoint,
		workersDev: false,
		// Co-locate API and DO work with PlanetScale Postgres; assets stay at the edge.
		placement: {
			region: "aws:us-west-2",
		},
		observability: {
			enabled: true,
			issues: {
				enabled: true,
			},
		},
		assets: {
			notFoundHandling: "single-page-application",
			runWorkerFirst: [
				"/heveta.v1.AuthService/*",
				"/heveta.v1.FileService/*",
				"/heveta.v1.ThreadService/*",
				"/heveta.v1.TurnService/*",
				"/heveta.v1.RunService/*",
				"/heveta.v1.ModelService/*",
				"/heveta.v1.MemoryService/*",
				"/heveta.v1.EventService/*",
				"/events",
				"/heveta.v1.ComputerService/*",
				"/heveta.v1.DeviceService/*",
				"/device/*",
				"/heveta.v1.MailService/*",
				"/screen",
				"/upload",
				"/terminal",
				"/computer-file",
				"/files/*",
				"/avatars/*",
			],
		},
		domains: ["app.heveta.com"],
		triggers: [
			triggers.scheduled({
				schedule: "17 * * * *",
			}),
			triggers.email({
				addresses: ["*@heveta.com"],
			}),
		],
		env: {
			EMAIL_FROM: bindings.text("noreply@heveta.com"),
			AGENT_MAIL_DOMAIN: bindings.text("agent.heveta.com"),
			TINYFISH_API_KEY: bindings.secret(),
			JINA_API_KEY: bindings.secret(),
			TURN_KEY_ID: bindings.secret(),
			TURN_API_TOKEN: bindings.secret(),
			HYPERDRIVE: bindings.hyperdrive({
				id: "f067b74e6c654a9489525c797a5c8f04",
				dev: {
					connectionString:
						"postgresql://heveta:password_123456@127.0.0.1:55437/heveta",
				},
			}),
			INVITES: bindings.kv({
				id: invitesNamespaceId,
			}),
			// The previous preview bucket was the same bucket; local dev remains simulated.
			BUCKET: bindings.r2({
				name: "heveta-files",
			}),
			EMAIL: bindings.sendEmail({
				allowedSenderAddresses: ["noreply@heveta.com"],
			}),
			AGENT_MAIL: bindings.sendEmail({}),
			AI: bindings.ai({
				dev: {
					remote: true,
				},
			}),
			AUTH_ADDRESS_LIMITER: bindings.rateLimit({
				namespace: "1001",
				simple: {
					limit: 30,
					period: 60,
				},
			}),
			ASSETS: bindings.assets(),
		},
		exports: {
			RunActor: exports.durableObject({
				storage: "sqlite",
			}),
			UserHub: exports.durableObject({
				storage: "sqlite",
			}),
			DeviceConnection: exports.durableObject({ storage: "sqlite" }),
			Computer: exports.durableObject({
				storage: "sqlite",
				container: computer,
			}),
		},
	},
});
