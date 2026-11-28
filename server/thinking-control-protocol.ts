import type { LeadThinkingRequest } from "./lead-thinking.js";
import type { BulkChatScope } from "./protocol.js";

/** Thinking controls only; lead policy is separate from dated bulk switches and worker defaults. */
export type ThinkingClientCommand =
	| LeadThinkingRequest
	| { type: "set_thinking_all_chats"; level: string; scope?: BulkChatScope }
	| { type: "set_default_thinking"; level: string }
	| { type: "clear_default_thinking" }
	| { type: "set_thinking"; level: string };

export interface ThinkingDispatchSession {
	setThinkingAllChats?(from: unknown, to: unknown, dryRun?: unknown): Promise<unknown>;
	setThinkingScopeChats?(level: string, scope?: unknown): Promise<void>;
	setDefaultThinking?(level: string): void;
	clearDefaultThinking?(): void;
	setThinking(level: string): void;
	leadThinkingControl?(msg: LeadThinkingRequest): void;
}
