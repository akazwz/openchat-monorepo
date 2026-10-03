// Unit tests replace Cloudflare bindings; no production resources are contacted.
// Rate limits never refuse here; tests that need a binding set it.
const unlimited: RateLimit = { limit: async () => ({ success: true }) };
// Every address is invited here; the invitation test sets its own.
const everyoneInvited = {
	get: async () => "invited",
} as unknown as KVNamespace;
export const env = {
	AUTH_ADDRESS_LIMITER: unlimited,
	INVITES: everyoneInvited,
} as Cloudflare.Env & {
	DEVICE_CONNECTIONS: DurableObjectNamespace<
		import("@/modules/devices/connection").DeviceConnection
	>;
	RUN_ACTORS: DurableObjectNamespace<import("@/modules/runs/actor").RunActor>;
	USER_HUBS: DurableObjectNamespace<import("@/modules/events/hub").UserHub>;
	SANDBOX: DurableObjectNamespace<
		import("@/modules/sandbox/computer-object").Computer
	>;
};

// Loopback exports resolve the same class namespaces as the former named bindings.
export const exports = {
	get RunActor() {
		return env.RUN_ACTORS;
	},
	get UserHub() {
		return env.USER_HUBS;
	},
	get DeviceConnection() {
		return env.DEVICE_CONNECTIONS;
	},
	get Computer() {
		return env.SANDBOX;
	},
} as Cloudflare.Exports;

// Minimal stand-in so Durable Object classes can be constructed with fakes.
export class DurableObject<E = Cloudflare.Env> {
	constructor(
		protected ctx: DurableObjectState,
		protected env: E,
	) {}
}

// Base classes the Sandbox SDK extends; its code is loaded, never run here.
export class WorkerEntrypoint<E = Cloudflare.Env> {
	constructor(
		protected ctx: ExecutionContext,
		protected env: E,
	) {}
}
export class RpcTarget {}
