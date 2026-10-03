import { env } from "cloudflare:workers";
import OpenAI from "openai";

import { appConfig, findModel } from "@/config";

// What tags a request's AI Gateway log entry.
type GatewayMetadata = Record<string, string | number>;

// Sends a Responses request through the AI binding and returns the raw
// response (a stream when the body asks for one). Inside a Worker the binding
// is pre-authenticated with the account and routes every catalog model
// ("openai/…", "alibaba/…") through our AI Gateway, so no API token is stored.
// A model reached at its provider's own API (ModelOption.gateway) goes
// through the gateway's pass-through, which adds the provider key it holds.
// The binding serializes the body itself, so it is handed the object: the
// agent loop's requests carry their files' data (up to the model file
// budget), and every serialized or parsed copy of such a body is that much
// more of the isolate's memory.
export async function sendModelRequest(
	{ model, ...body }: { model: string },
	options: { metadata?: GatewayMetadata; signal?: AbortSignal },
): Promise<Response> {
	const provider = findModel(model)?.gateway;
	if (provider)
		return env.AI.gateway(appConfig.aiGatewayId).run(
			{
				provider: provider.provider,
				endpoint: "responses",
				headers: {
					"Content-Type": "application/json",
					"cf-aig-skip-cache": true,
					...(options.metadata
						? { "cf-aig-metadata": JSON.stringify(options.metadata) }
						: {}),
				},
				query: { ...body, model: provider.model },
			},
			{ signal: options.signal },
		);
	const response: unknown = await env.AI.run(model, body, {
		gateway: {
			id: appConfig.aiGatewayId,
			// Model calls are never cached.
			skipCache: true,
			...(options.metadata ? { metadata: options.metadata } : {}),
		},
		returnRawResponse: true,
		signal: options.signal,
	});
	if (!(response instanceof Response))
		throw new Error("The AI binding returned no raw response");
	return response;
}

// The SDK's client, for small requests (a conversation's title): it
// serializes the body, which is parsed back here for the binding. Only
// Responses requests are made; the SDK's URL host is never contacted. Its own
// retries (two) stay: it sends a request again only before any response has
// arrived (a failed connection, 408/409/429/5xx). The agent loop's requests
// do not go through it (runtime/responses/cloudflare.ts).
async function bindingFetch(
	input: string | URL | Request,
	init?: RequestInit,
): Promise<Response> {
	const request = new Request(input, init);
	if (!new URL(request.url).pathname.endsWith("/responses"))
		throw new Error(`Unsupported model request: ${request.url}`);
	const metadata = request.headers.get("cf-aig-metadata");
	return sendModelRequest(await request.json<{ model: string }>(), {
		metadata: metadata ? (JSON.parse(metadata) as GatewayMetadata) : undefined,
		signal: init?.signal ?? undefined,
	});
}

export function openai() {
	return new OpenAI({
		// Required by the SDK; the binding authenticates, not this key.
		apiKey: "ai-binding",
		fetch: bindingFetch,
	});
}

// Tags the request's AI Gateway log entry, as an SDK request header.
export function gatewayMetadata(metadata: GatewayMetadata) {
	return { "cf-aig-metadata": JSON.stringify(metadata) };
}
