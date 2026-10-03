import { AppError, ErrorCode } from "@/lib/errors";
import type { MessagePart } from "@/modules/threads/types";
import type {
	OutputEvent,
	ToolCallEvent,
	ToolResultEvent,
} from "@/runtime/types";

import type { PartChange } from "./types";

// The Run executor owns this product projection. Provider/runtime output knows
// nothing about product message IDs, protobufs, or database message parts.
export class RunOutput {
	private readonly active = new Map<string, MessagePart>();
	private pending: PartChange[] = [];
	pendingBytes = 0;

	// Only the currently generated text/reasoning stays in memory. Completed
	// parts and tool outputs belong to durable storage, not this projection.
	takeChanges(): PartChange[] {
		const changes = this.pending;
		this.pending = [];
		this.pendingBytes = 0;
		return structuredClone(changes);
	}

	releaseBoundary() {
		this.active.clear();
	}

	applyTool(event: ToolCallEvent | ToolResultEvent) {
		if (event.type === "toolCall")
			this.upsert({
				id: `${event.callId}:call`,
				content: {
					case: "toolCall",
					value: {
						id: event.callId,
						name: event.name,
						arguments: event.arguments,
						...(event.surface ? { surface: event.surface } : {}),
					},
				},
			});
		else {
			this.upsert({
				id: `${event.callId}:result`,
				content: {
					case: "toolResult",
					value: {
						toolCallId: event.callId,
						name: event.name,
						output: event.output,
						isError: event.isError,
						...(event.images.length ? { images: event.images } : {}),
					},
				},
			});
			// A file the call shows the person follows it in the reply.
			event.shown.forEach((file, index) => {
				this.upsert({
					id: `${event.callId}:file:${index}`,
					content: { case: "file", value: file },
				});
			});
		}
	}

	apply(event: OutputEvent) {
		if (event.type === "textDelta") {
			this.appendText(event.textId, event.delta);
			return;
		}
		if (event.type === "reasoningSnapshot") {
			this.upsert({
				id: event.reasoning.id,
				content: { case: "reasoning", value: { text: event.reasoning.text } },
			});
			return;
		}
		if (event.type === "reasoningDelta") {
			this.appendReasoning(event.reasoningId, event.delta);
			return;
		}
		const text = event.text;
		this.upsert({
			id: text.id,
			assistantText: {
				messageId: text.modelMessageId,
				contentIndex: text.contentIndex,
				phase: text.phase,
				status: text.status,
				refusal: text.refusal,
			},
			content: { case: "text", value: text.text },
		});
	}

	private upsert(part: MessagePart) {
		const previous = this.active.get(part.id);
		if (previous && previous.content.case !== part.content.case)
			throw new AppError("Run output part changed type", ErrorCode.Internal);
		this.pending.push({ type: "part", part });
		const content = part.content;
		this.pendingBytes +=
			4 *
			(content.case === "text"
				? content.value.length
				: content.case === "reasoning"
					? content.value.text.length
					: content.case === "toolCall"
						? content.value.arguments.length
						: content.case === "toolResult"
							? JSON.stringify(content.value.output).length
							: 256);
		if (
			content.case === "reasoning" ||
			(content.case === "text" && part.assistantText?.status === "in_progress")
		)
			this.active.set(part.id, part);
		else this.active.delete(part.id);
	}

	private append(partId: string, text: string, reasoning: boolean) {
		const part = this.active.get(partId);
		if (!part || part.content.case !== (reasoning ? "reasoning" : "text"))
			throw new AppError("Run text part was not declared", ErrorCode.Internal);
		if (part.content.case === "text")
			this.active.set(partId, {
				...part,
				content: { case: "text", value: part.content.value + text },
			});
		else if (part.content.case === "reasoning")
			this.active.set(partId, {
				...part,
				content: {
					case: "reasoning",
					value: { text: part.content.value.text + text },
				},
			});
		const last = this.pending.at(-1);
		if (last?.type === "textDelta" && last.partId === partId) last.text += text;
		else this.pending.push({ type: "textDelta", partId, text });
		this.pendingBytes += text.length * 4;
	}
	private appendText(partId: string, text: string) {
		this.append(partId, text, false);
	}
	private appendReasoning(partId: string, text: string) {
		this.append(partId, text, true);
	}

	finish() {
		for (const part of this.active.values()) {
			if (part.assistantText?.status !== "in_progress") continue;
			this.upsert({
				...part,
				assistantText: { ...part.assistantText, status: "incomplete" },
			});
		}
	}
}
