import type {
	ResponseOutputItem,
	ResponseOutputMessage,
	ResponseOutputRefusal,
	ResponseOutputText,
	ResponseStreamEvent,
} from "openai/resources/responses/responses";

import type { ModelReasoning, ModelText, OutputEvent } from "../types";

type TextContent = ResponseOutputText | ResponseOutputRefusal;

// Decode provider events into runtime output. Product message IDs, protobufs,
// database rows, and UI parts do not belong at this boundary.
export class ResponsesOutput {
	private readonly responseKey = crypto.randomUUID();
	private readonly messages = new Map<number, ResponseOutputMessage>();
	private readonly texts = new Map<string, ModelText>();
	private readonly reasonings = new Map<string, ModelReasoning>();

	accept(event: ResponseStreamEvent): OutputEvent[] {
		switch (event.type) {
			case "response.output_item.added":
			case "response.output_item.done":
				return this.item(event.output_index, event.item);
			case "response.content_part.added":
			case "response.content_part.done":
				if (event.part.type !== "output_text" && event.part.type !== "refusal")
					return [];
				return this.content(
					event.output_index,
					event.item_id,
					event.content_index,
					event.part,
				);
			case "response.output_text.delta":
			case "response.refusal.delta": {
				const message = this.message(event.output_index, event.item_id);
				const id = this.textId(event.output_index, event.content_index);
				const events: OutputEvent[] = [];
				if (!this.texts.has(id))
					events.push(
						...this.textSnapshot(
							id,
							message,
							event.content_index,
							"",
							event.type === "response.refusal.delta",
						),
					);
				const text = this.texts.get(id)!;
				this.texts.set(id, { ...text, text: text.text + event.delta });
				events.push({ type: "textDelta", textId: id, delta: event.delta });
				return events;
			}
			// A reasoning item's summary may come in several parts, read as
			// paragraphs of one reasoning part.
			case "response.reasoning_summary_part.added":
				return event.summary_index > 0
					? this.reasoningDelta(event.output_index, "\n\n")
					: [];
			case "response.reasoning_summary_text.delta":
				return this.reasoningDelta(event.output_index, event.delta);
			// A model that shows its reasoning itself rather than a summary of
			// it (DeepSeek).
			case "response.reasoning_text.delta":
				return this.reasoningDelta(event.output_index, event.delta);
			default:
				return [];
		}
	}

	finish(output: ResponseOutputItem[]): OutputEvent[] {
		return output.flatMap((item, index) => this.item(index, item));
	}

	private textId(outputIndex: number, contentIndex: number) {
		return `${this.responseKey}:${outputIndex}:${contentIndex}`;
	}

	private message(index: number, id: string) {
		const message = this.messages.get(index);
		if (!message || message.id !== id)
			throw new Error("Model text arrived without its message");
		return message;
	}

	private item(index: number, item: ResponseOutputItem): OutputEvent[] {
		// Its summary is what people see; the reasoning itself stays in the
		// native execution checkpoint, encrypted. A model that gives no summary
		// but its reasoning as text (DeepSeek) shows that.
		if (item.type === "reasoning")
			return this.reasoningSnapshot(
				index,
				item.summary.length
					? item.summary.map((part) => part.text).join("\n\n")
					: (item.content ?? []).map((part) => part.text).join("\n\n"),
			);
		if (item.type !== "message") return [];
		const previous = this.messages.get(index);
		if (previous && previous.id !== item.id)
			throw new Error("Model message changed");
		this.messages.set(index, item);
		return item.content.flatMap((content, contentIndex) =>
			this.content(index, item.id, contentIndex, content),
		);
	}

	private content(
		outputIndex: number,
		messageId: string,
		contentIndex: number,
		content: TextContent,
	) {
		return this.textSnapshot(
			this.textId(outputIndex, contentIndex),
			this.message(outputIndex, messageId),
			contentIndex,
			content.type === "output_text" ? content.text : content.refusal,
			content.type === "refusal",
		);
	}

	private textSnapshot(
		id: string,
		message: ResponseOutputMessage,
		contentIndex: number,
		value: string,
		refusal: boolean,
	): OutputEvent[] {
		const text: ModelText = {
			id,
			modelMessageId: message.id,
			contentIndex,
			text: value,
			phase: message.phase ?? undefined,
			status: message.status,
			refusal,
		};
		const previous = this.texts.get(id);
		if (previous && JSON.stringify(previous) === JSON.stringify(text))
			return [];
		this.texts.set(id, text);
		return [{ type: "textSnapshot", text }];
	}

	private reasoningId(outputIndex: number) {
		return `${this.responseKey}:${outputIndex}:reasoning`;
	}

	private reasoningDelta(outputIndex: number, delta: string): OutputEvent[] {
		const id = this.reasoningId(outputIndex);
		const events: OutputEvent[] = [];
		let reasoning = this.reasonings.get(id);
		if (!reasoning) {
			reasoning = { id, text: "" };
			events.push({ type: "reasoningSnapshot", reasoning });
		}
		this.reasonings.set(id, { ...reasoning, text: reasoning.text + delta });
		events.push({ type: "reasoningDelta", reasoningId: id, delta });
		return events;
	}

	// The final summary is authoritative. An item with none (reasoning kept
	// only in encrypted form) has nothing to show.
	private reasoningSnapshot(outputIndex: number, text: string): OutputEvent[] {
		if (!text) return [];
		const id = this.reasoningId(outputIndex);
		if (this.reasonings.get(id)?.text === text) return [];
		const reasoning = { id, text };
		this.reasonings.set(id, reasoning);
		return [{ type: "reasoningSnapshot", reasoning }];
	}
}
