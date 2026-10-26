import type { AgentEvent, EntryRecord } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";

export interface DurableTurnResult {
	costUSD: number;
	contextTokens: number;
	model: string;
	aborted?: boolean;
}
export interface DurableEventSink {
	onTextDelta(text: string): void;
	onThinkingDelta?(text: string): void;
	onToolStart?(id: string, name: string, input: unknown): void;
	onToolUpdate?(id: string, output: string): void;
	onToolEnd?(id: string, result: unknown): void;
	onEntry?(entry: EntryRecord): void;
	onTurnComplete?(result: DurableTurnResult): void;
	onError?(error: Error): void;
}

/** Use durable's atomic event cursor: message counters must not span multiple tool rounds. */
export class DurableStreamBridge {
	private readonly text = new Map<number, string>();
	private readonly thinking = new Map<number, string>();
	private readonly tools = new Set<string>();
	private readonly ended = new Set<string>();
	readonly entries: EntryRecord[] = [];
	constructor(readonly sink: DurableEventSink) {}
	private block(index: number, block: { type: string; text?: string; thinking?: string }): void {
		const values = block.type === "text" ? this.text : block.type === "thinking" ? this.thinking : undefined;
		if (!values) return;
		const value = block.type === "text" ? (block.text ?? "") : (block.thinking ?? "");
		const before = values.get(index) ?? "";
		if (value.startsWith(before) && value.length > before.length) {
			if (block.type === "text") this.sink.onTextDelta(value.slice(before.length));
			else this.sink.onThinkingDelta?.(value.slice(before.length));
		}
		values.set(index, value);
	}
	accept(event: AgentEvent): void {
		switch (event.type) {
			case "message_start":
				this.text.clear();
				this.thinking.clear();
				break;
			case "message_update":
				for (const change of event.changes) {
					if (change.type === "text_delta" || change.type === "thinking_delta") {
						const values = change.type === "text_delta" ? this.text : this.thinking;
						values.set(change.contentIndex, (values.get(change.contentIndex) ?? "") + change.delta);
						if (change.type === "text_delta") this.sink.onTextDelta(change.delta);
						else this.sink.onThinkingDelta?.(change.delta);
					} else if (change.type === "message")
						change.message.content.forEach((block, index) => this.block(index, block));
					else if ("block" in change) this.block(change.contentIndex, change.block);
				}
				break;
			case "message_end":
				for (const message of event.entry.model ?? [])
					if (message.role === "assistant") message.content.forEach((block, index) => this.block(index, block));
				break;
			case "tool_execution_start":
				if (!this.tools.has(event.toolCallId)) {
					this.tools.add(event.toolCallId);
					this.sink.onToolStart?.(event.toolCallId, event.toolName, event.args);
				}
				break;
			case "tool_execution_update":
				if (event.output)
					this.sink.onToolUpdate?.(
						event.toolCallId,
						"set" in event.output ? event.output.set : (event.output.append ?? ""),
					);
				break;
			case "tool_execution_end":
				if (!this.ended.has(event.toolCallId)) {
					this.ended.add(event.toolCallId);
					this.sink.onToolEnd?.(event.toolCallId, event.result ?? event.entry);
				}
				break;
			case "entry_appended":
				this.entries.push(event.entry);
				this.sink.onEntry?.(event.entry);
				break;
			case "snapshot":
				// Reattachment/overflow can replace pending batches with an authoritative snapshot.
				if (event.generation?.message)
					event.generation.message.content.forEach((block, index) => this.block(index, block));
				break;
			case "task_failed":
				this.sink.onError?.(new Error(event.message));
				break;
		}
	}
}

export function entryText(entry: EntryRecord): string {
	return (entry.model ?? [])
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((item) => item.type === "text")
						.map((item) => (item as { text: string }).text)
						.join(""),
		)
		.join("");
}

export function entryData(entry: EntryRecord): Readonly<Record<string, JsonValue>> | undefined {
	return entry.data && typeof entry.data === "object" && !Array.isArray(entry.data) ? entry.data : undefined;
}
