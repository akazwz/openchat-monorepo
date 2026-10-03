import { create, fromJson } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";

import {
	AssistantMessageStatus,
	MessagePartSchema,
	MessagePhase,
	type MessagePart as ProtoPart,
	ToolSurface,
} from "@/gen/heveta/v1/thread_pb";
import { fileResource } from "@/modules/files/rpc-codec";
import { type ToolSurface as Surface, toolArguments } from "@/runtime/tools";

import { listedOutputChars } from "./content";
import type { MessagePart } from "./types";

const surfaces: Record<Surface, ToolSurface> = {
	service: ToolSurface.SERVICE,
	computer: ToolSurface.COMPUTER,
	browser: ToolSurface.BROWSER,
	delivery: ToolSurface.DELIVERY,
};

// A listed message's tool outputs longer than this, as JSON, are left out
// (ToolResult.output_omitted): most are a line or two, and those shown in
// place; the rest are fetched when their row is opened.

export interface PartOptions {
	// For a message in a list: long tool outputs are left out.
	omitLongOutputs?: boolean;
}

export function partToProto(
	part: MessagePart,
	options: PartOptions = {},
): ProtoPart {
	const content = part.content;
	const metadata = part.assistantText;
	const common = {
		id: part.id,
		assistantText: metadata
			? {
					messageId: metadata.messageId,
					contentIndex: metadata.contentIndex,
					phase:
						metadata.phase === "commentary"
							? MessagePhase.COMMENTARY
							: metadata.phase === "final_answer"
								? MessagePhase.FINAL_ANSWER
								: MessagePhase.UNSPECIFIED,
					refusal: metadata.refusal,
					status:
						metadata.status === "completed"
							? AssistantMessageStatus.COMPLETED
							: metadata.status === "incomplete"
								? AssistantMessageStatus.INCOMPLETE
								: metadata.status === "in_progress"
									? AssistantMessageStatus.IN_PROGRESS
									: AssistantMessageStatus.UNSPECIFIED,
				}
			: undefined,
	};
	switch (content.case) {
		case "text":
		case "reasoning":
			return create(MessagePartSchema, { ...common, content });
		case "toolCall":
			return create(MessagePartSchema, {
				...common,
				content: {
					case: "toolCall",
					value: {
						...content.value,
						arguments: toolArguments(content.value.arguments),
						surface: content.value.surface
							? surfaces[content.value.surface]
							: ToolSurface.UNSPECIFIED,
					},
				},
			});
		case "toolResult": {
			const omitted =
				content.value.outputOmitted === true ||
				(options.omitLongOutputs === true &&
					JSON.stringify(content.value.output).length > listedOutputChars);
			return create(MessagePartSchema, {
				...common,
				content: {
					case: "toolResult",
					value: {
						...content.value,
						output: omitted
							? undefined
							: fromJson(ValueSchema, content.value.output),
						outputOmitted: omitted,
						images: (content.value.images ?? []).map(fileResource),
					},
				},
			});
		}
		case "file":
			return create(MessagePartSchema, {
				...common,
				content: { case: "file", value: fileResource(content.value) },
			});
	}
}
