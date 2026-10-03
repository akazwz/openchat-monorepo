import type {
	Response,
	ResponseInputItem,
	ResponseUsage,
} from "openai/resources/responses/responses";

import type { OutputEvent } from "../types";

// This runtime deliberately speaks Responses. Keep native items rather than
// flattening reasoning signatures, message identity, phase, or content status.
export type ModelInput = ResponseInputItem[];
export type ModelResponse = Pick<
	Response,
	"id" | "output" | "status" | "incomplete_details"
> & {
	usage?: Partial<Pick<ResponseUsage, "input_tokens" | "output_tokens">> | null;
};

export type ModelEvent =
	| OutputEvent
	| { type: "response"; response: ModelResponse; error?: Error };

export type StreamResponse = (
	input: ModelInput,
	options: {
		modelStep: number;
		signal: AbortSignal;
	},
) => AsyncIterable<ModelEvent>;

// A request the provider answered with a refusal before generating anything,
// that it may take later: it was rate limited, overloaded, or failing on its
// own side, or the request got no answer at all. Nothing was generated or
// done, so the model step is closed as failed and the run waits and makes
// the request again (its owner backs off, and ends a run that keeps failing),
// rather than failing the run. A refusal that would not pass (a request the
// provider cannot take) is an ordinary error.
export class ModelRequestRefused extends Error {
	constructor(message: string, options: { cause: unknown }) {
		super(message, options);
		this.name = "ModelRequestRefused";
	}
}
