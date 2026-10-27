/**
 * Wave 3 thin seam: Extension hook bridge for the pi-durable SQLite engine.
 *
 * Bridges pi extension lifecycle hooks (`before_agent_start`, `context` /
 * `transformContext`, `turn_start`, `turn_end`, `tool_call`, `tool_result`,
 * `session_before_compact`) and `appendEntry` custom-entry persistence in SQLite
 * so the durable engine (#601), extension bridge (#602), bootstrap/migrator (#603),
 * and agent-service cutover (#604) can evolve in parallel without file collisions.
 */

export type DurableExtensionMessageRole = "user" | "assistant" | "system" | "toolResult" | "custom";

export interface DurableExtensionMessage {
	role: DurableExtensionMessageRole;
	content: unknown;
	timestamp?: number;
	customType?: string;
	display?: boolean;
	details?: unknown;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	[key: string]: unknown;
}

export interface ExtensionCustomMessageDraft {
	customType: string;
	content: unknown;
	display?: boolean;
	details?: unknown;
}

export interface ExtensionPersistedEntryRecord<T = unknown> {
	id: string;
	parentId: string | null;
	sessionKey: string;
	/** SQLite durable entry kind, e.g. `custom.<customType>`. */
	kind: string;
	customType: string;
	data: T;
	timestamp: string;
}

export interface ExtensionAppendEntryOptions {
	sessionKey?: string;
	parentId?: string | null;
	timestamp?: string;
}

/**
 * Backing SQLite custom-entry persistence contract used by `ExtensionHookBridge.appendEntry`.
 * Real implementations commit `custom.<customType>` rows into the conversation's SQLite WAL store.
 */
export interface ExtensionSqliteEntryStore {
	appendEntry<T = unknown>(
		customType: string,
		data: T,
		options?: ExtensionAppendEntryOptions,
	): Promise<ExtensionPersistedEntryRecord<T>> | ExtensionPersistedEntryRecord<T>;
	getEntries(sessionKey?: string): readonly ExtensionPersistedEntryRecord[];
	flush?(): Promise<void>;
}

export interface BeforeAgentStartHookEvent {
	type: "before_agent_start";
	prompt: string;
	systemPrompt?: string;
	selectedTools?: readonly string[];
	sessionKey?: string;
}

export interface BeforeAgentStartHookResult {
	prompt?: string;
	systemPrompt?: string;
	selectedTools?: readonly string[];
	customMessages?: readonly ExtensionCustomMessageDraft[];
	handled?: boolean;
}

export interface ContextHookEvent {
	type: "context";
	messages: readonly DurableExtensionMessage[];
	sessionKey?: string;
}

export interface ContextHookResult {
	messages: DurableExtensionMessage[];
}

export interface TurnStartHookEvent {
	type: "turn_start";
	turnIndex: number;
	timestamp: number;
	sessionKey?: string;
}

export interface TurnEndHookEvent {
	type: "turn_end";
	turnIndex: number;
	message?: DurableExtensionMessage;
	toolResults?: readonly DurableExtensionMessage[];
	outcome?: "completed" | "aborted" | "error";
	sessionKey?: string;
}

export interface TurnEndHookResult {
	continue?: boolean;
	appendedEntries?: readonly ExtensionPersistedEntryRecord[];
}

export interface ToolCallHookEvent {
	type: "tool_call";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	sessionKey?: string;
}

export interface ToolCallHookDecision {
	block?: boolean;
	reason?: string;
	input?: Record<string, unknown>;
}

export interface ToolResultHookEvent {
	type: "tool_result";
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	content: unknown[];
	details?: unknown;
	isError: boolean;
	sessionKey?: string;
}

export interface ToolResultHookPatch {
	content?: unknown[];
	details?: unknown;
	isError?: boolean;
}

export interface SessionBeforeCompactHookEvent {
	type: "session_before_compact";
	sessionKey?: string;
	entryCount: number;
	tokenCount?: number;
	instructions?: string;
	customInstructions?: string;
}

export interface SessionBeforeCompactHookResult {
	cancel?: boolean;
	reason?: string;
	summary?: string;
	customData?: unknown;
}

export type BeforeAgentStartHookHandler = (
	event: BeforeAgentStartHookEvent,
) => Promise<BeforeAgentStartHookResult | undefined> | BeforeAgentStartHookResult | undefined;

export type ContextHookHandler = (
	event: ContextHookEvent,
) =>
	| Promise<ContextHookResult | readonly DurableExtensionMessage[] | undefined>
	| ContextHookResult
	| readonly DurableExtensionMessage[]
	| undefined;

export type TurnStartHookHandler = (event: TurnStartHookEvent) => Promise<void> | void;

export type TurnEndHookHandler = (
	event: TurnEndHookEvent,
) => Promise<TurnEndHookResult | undefined> | TurnEndHookResult | undefined;

export type ToolCallHookHandler = (
	event: ToolCallHookEvent,
) => Promise<ToolCallHookDecision | undefined> | ToolCallHookDecision | undefined;

export type ToolResultHookHandler = (
	event: ToolResultHookEvent,
) => Promise<ToolResultHookPatch | undefined> | ToolResultHookPatch | undefined;

export type SessionBeforeCompactHookHandler = (
	event: SessionBeforeCompactHookEvent,
) => Promise<SessionBeforeCompactHookResult | undefined> | SessionBeforeCompactHookResult | undefined;

export interface ExtensionHookHandlerMap {
	before_agent_start: BeforeAgentStartHookHandler;
	context: ContextHookHandler;
	turn_start: TurnStartHookHandler;
	turn_end: TurnEndHookHandler;
	tool_call: ToolCallHookHandler;
	tool_result: ToolResultHookHandler;
	session_before_compact: SessionBeforeCompactHookHandler;
}

export type ExtensionHookName = keyof ExtensionHookHandlerMap;

/**
 * Extension hook bridge contract between pi extensions and the pi-durable engine.
 */
export interface ExtensionHookBridge {
	on<K extends ExtensionHookName>(hookName: K, handler: ExtensionHookHandlerMap[K]): () => void;
	onBeforeAgentStart(handler: BeforeAgentStartHookHandler): () => void;
	onContext(handler: ContextHookHandler): () => void;
	onTurnStart(handler: TurnStartHookHandler): () => void;
	onTurnEnd(handler: TurnEndHookHandler): () => void;
	onToolCall(handler: ToolCallHookHandler): () => void;
	onToolResult(handler: ToolResultHookHandler): () => void;
	onSessionBeforeCompact(handler: SessionBeforeCompactHookHandler): () => void;

	before_agent_start(
		event: Omit<BeforeAgentStartHookEvent, "type"> & { type?: "before_agent_start" },
	): Promise<BeforeAgentStartHookResult>;
	context(event: Omit<ContextHookEvent, "type"> & { type?: "context" }): Promise<ContextHookResult>;
	transformContext(
		messages: readonly DurableExtensionMessage[],
		sessionKey?: string,
	): Promise<DurableExtensionMessage[]>;
	turn_start(event: Omit<TurnStartHookEvent, "type"> & { type?: "turn_start" }): Promise<void>;
	turn_end(event: Omit<TurnEndHookEvent, "type"> & { type?: "turn_end" }): Promise<TurnEndHookResult>;
	tool_call(event: Omit<ToolCallHookEvent, "type"> & { type?: "tool_call" }): Promise<ToolCallHookDecision>;
	tool_result(event: Omit<ToolResultHookEvent, "type"> & { type?: "tool_result" }): Promise<ToolResultHookPatch>;
	session_before_compact(
		event: Omit<SessionBeforeCompactHookEvent, "type"> & { type?: "session_before_compact" },
	): Promise<SessionBeforeCompactHookResult>;

	appendEntry<T = unknown>(
		customType: string,
		data: T,
		options?: ExtensionAppendEntryOptions,
	): Promise<ExtensionPersistedEntryRecord<T>>;
	getPersistedEntries(sessionKey?: string): readonly ExtensionPersistedEntryRecord[];
	flush(): Promise<void>;
}

export interface ExtensionHookBridgeOptions {
	defaultSessionKey?: string;
	entryStore?: ExtensionSqliteEntryStore;
}

/**
 * Deterministic in-memory SQLite entry store reference implementation for contract tests
 * and fallback staging before a live SQLite store is bound.
 */
export function createInMemorySqliteEntryStore(defaultSessionKey = "default:session"): ExtensionSqliteEntryStore {
	const entries: ExtensionPersistedEntryRecord[] = [];
	let seq = 0;

	return {
		appendEntry<T = unknown>(
			customType: string,
			data: T,
			options?: ExtensionAppendEntryOptions,
		): ExtensionPersistedEntryRecord<T> {
			const trimmedType = customType.trim();
			if (!trimmedType) {
				throw new Error("ExtensionHookBridge.appendEntry requires a non-empty customType");
			}
			const sessionKey = options?.sessionKey ?? defaultSessionKey;
			const sessionEntries = entries.filter((entry) => entry.sessionKey === sessionKey);
			const parentId = options?.parentId !== undefined ? options.parentId : (sessionEntries.at(-1)?.id ?? null);
			seq += 1;
			const record: ExtensionPersistedEntryRecord<T> = {
				id: `ext-entry-${seq}`,
				parentId,
				sessionKey,
				kind: `custom.${trimmedType}`,
				customType: trimmedType,
				data: structuredClone(data),
				timestamp: options?.timestamp ?? new Date().toISOString(),
			};
			entries.push(record);
			return record;
		},
		getEntries(sessionKey?: string): readonly ExtensionPersistedEntryRecord[] {
			if (!sessionKey) return [...entries];
			return entries.filter((entry) => entry.sessionKey === sessionKey);
		},
		async flush(): Promise<void> {
			// In-memory store writes synchronously; nothing buffered.
		},
	};
}

/**
 * Create an `ExtensionHookBridge` instance that runs registered handlers in load order
 * and persists `appendEntry` rows into the configured `ExtensionSqliteEntryStore`.
 */
export function createExtensionHookBridge(options: ExtensionHookBridgeOptions = {}): ExtensionHookBridge {
	const defaultSessionKey = options.defaultSessionKey ?? "default:session";
	const store = options.entryStore ?? createInMemorySqliteEntryStore(defaultSessionKey);

	const beforeAgentStartHandlers = new Set<BeforeAgentStartHookHandler>();
	const contextHandlers = new Set<ContextHookHandler>();
	const turnStartHandlers = new Set<TurnStartHookHandler>();
	const turnEndHandlers = new Set<TurnEndHookHandler>();
	const toolCallHandlers = new Set<ToolCallHookHandler>();
	const toolResultHandlers = new Set<ToolResultHookHandler>();
	const beforeCompactHandlers = new Set<SessionBeforeCompactHookHandler>();

	const register = <T>(set: Set<T>, handler: T): (() => void) => {
		set.add(handler);
		return () => {
			set.delete(handler);
		};
	};

	const bridge: ExtensionHookBridge = {
		on<K extends ExtensionHookName>(hookName: K, handler: ExtensionHookHandlerMap[K]): () => void {
			switch (hookName) {
				case "before_agent_start":
					return register(beforeAgentStartHandlers, handler as BeforeAgentStartHookHandler);
				case "context":
					return register(contextHandlers, handler as ContextHookHandler);
				case "turn_start":
					return register(turnStartHandlers, handler as TurnStartHookHandler);
				case "turn_end":
					return register(turnEndHandlers, handler as TurnEndHookHandler);
				case "tool_call":
					return register(toolCallHandlers, handler as ToolCallHookHandler);
				case "tool_result":
					return register(toolResultHandlers, handler as ToolResultHookHandler);
				case "session_before_compact":
					return register(beforeCompactHandlers, handler as SessionBeforeCompactHookHandler);
			}
		},
		onBeforeAgentStart: (handler) => register(beforeAgentStartHandlers, handler),
		onContext: (handler) => register(contextHandlers, handler),
		onTurnStart: (handler) => register(turnStartHandlers, handler),
		onTurnEnd: (handler) => register(turnEndHandlers, handler),
		onToolCall: (handler) => register(toolCallHandlers, handler),
		onToolResult: (handler) => register(toolResultHandlers, handler),
		onSessionBeforeCompact: (handler) => register(beforeCompactHandlers, handler),

		async before_agent_start(input): Promise<BeforeAgentStartHookResult> {
			let prompt = input.prompt;
			let systemPrompt = input.systemPrompt;
			let selectedTools = input.selectedTools ? [...input.selectedTools] : undefined;
			const customMessages: ExtensionCustomMessageDraft[] = [];
			let handled = false;

			for (const handler of beforeAgentStartHandlers) {
				const out = await handler({
					type: "before_agent_start",
					prompt,
					systemPrompt,
					selectedTools,
					sessionKey: input.sessionKey ?? defaultSessionKey,
				});
				if (!out) continue;
				if (out.prompt !== undefined) prompt = out.prompt;
				if (out.systemPrompt !== undefined) systemPrompt = out.systemPrompt;
				if (out.selectedTools !== undefined) selectedTools = [...out.selectedTools];
				if (out.customMessages?.length) customMessages.push(...out.customMessages);
				if (out.handled) {
					handled = true;
					break;
				}
			}
			await bridge.flush();
			return {
				prompt,
				systemPrompt,
				selectedTools,
				customMessages,
				handled,
			};
		},

		async context(input): Promise<ContextHookResult> {
			let current = input.messages.map((msg) => ({ ...msg }));
			const sessionKey = input.sessionKey ?? defaultSessionKey;
			for (const handler of contextHandlers) {
				const out = await handler({
					type: "context",
					messages: current,
					sessionKey,
				});
				if (!out) continue;
				if (Array.isArray(out)) {
					current = out.map((msg) => ({ ...msg }));
				} else if ("messages" in out && Array.isArray(out.messages)) {
					current = out.messages.map((msg) => ({ ...msg }));
				}
			}
			await bridge.flush();
			return { messages: current };
		},

		async transformContext(
			messages: readonly DurableExtensionMessage[],
			sessionKey?: string,
		): Promise<DurableExtensionMessage[]> {
			const res = await bridge.context({ messages, sessionKey });
			return res.messages;
		},

		async turn_start(input): Promise<void> {
			const event: TurnStartHookEvent = {
				type: "turn_start",
				turnIndex: input.turnIndex,
				timestamp: input.timestamp,
				sessionKey: input.sessionKey ?? defaultSessionKey,
			};
			for (const handler of turnStartHandlers) {
				await handler(event);
			}
			await bridge.flush();
		},

		async turn_end(input): Promise<TurnEndHookResult> {
			const sessionKey = input.sessionKey ?? defaultSessionKey;
			const beforeCount = store.getEntries(sessionKey).length;
			let shouldContinue = false;
			const appendedEntries: ExtensionPersistedEntryRecord[] = [];

			for (const handler of turnEndHandlers) {
				const out = await handler({
					type: "turn_end",
					turnIndex: input.turnIndex,
					message: input.message,
					toolResults: input.toolResults,
					outcome: input.outcome ?? "completed",
					sessionKey,
				});
				if (out?.continue) shouldContinue = true;
				if (out?.appendedEntries?.length) appendedEntries.push(...out.appendedEntries);
			}
			const afterEntries = store.getEntries(sessionKey).slice(beforeCount);
			for (const entry of afterEntries) {
				if (!appendedEntries.some((existing) => existing.id === entry.id)) {
					appendedEntries.push(entry);
				}
			}
			await bridge.flush();
			return {
				continue: shouldContinue,
				appendedEntries,
			};
		},

		async tool_call(input): Promise<ToolCallHookDecision> {
			let currentInput: Record<string, unknown> = { ...input.input };
			const sessionKey = input.sessionKey ?? defaultSessionKey;
			for (const handler of toolCallHandlers) {
				const out = await handler({
					type: "tool_call",
					toolCallId: input.toolCallId,
					toolName: input.toolName,
					input: currentInput,
					sessionKey,
				});
				if (!out) continue;
				if (out.input) currentInput = { ...out.input };
				if (out.block) {
					await bridge.flush();
					return {
						block: true,
						reason: out.reason ?? "Tool execution blocked by extension hook",
						input: currentInput,
					};
				}
			}
			await bridge.flush();
			return {
				block: false,
				input: currentInput,
			};
		},

		async tool_result(input): Promise<ToolResultHookPatch> {
			let content = [...input.content];
			let details = input.details;
			let isError = input.isError;
			const sessionKey = input.sessionKey ?? defaultSessionKey;
			for (const handler of toolResultHandlers) {
				const out = await handler({
					type: "tool_result",
					toolCallId: input.toolCallId,
					toolName: input.toolName,
					input: input.input,
					content,
					details,
					isError,
					sessionKey,
				});
				if (!out) continue;
				if (out.content !== undefined) content = [...out.content];
				if (out.details !== undefined) details = out.details;
				if (out.isError !== undefined) isError = out.isError;
			}
			await bridge.flush();
			return {
				content,
				details,
				isError,
			};
		},

		async session_before_compact(input): Promise<SessionBeforeCompactHookResult> {
			const sessionKey = input.sessionKey ?? defaultSessionKey;
			let summary: string | undefined;
			let customData: unknown;
			for (const handler of beforeCompactHandlers) {
				const out = await handler({
					type: "session_before_compact",
					sessionKey,
					entryCount: input.entryCount,
					tokenCount: input.tokenCount,
					instructions: input.instructions,
					customInstructions: input.customInstructions,
				});
				if (!out) continue;
				if (out.cancel) {
					await bridge.flush();
					return {
						cancel: true,
						reason: out.reason ?? "Compaction cancelled by extension hook",
					};
				}
				if (out.summary !== undefined) summary = out.summary;
				if (out.customData !== undefined) customData = out.customData;
			}
			await bridge.flush();
			return {
				cancel: false,
				summary,
				customData,
			};
		},

		async appendEntry<T = unknown>(
			customType: string,
			data: T,
			entryOptions?: ExtensionAppendEntryOptions,
		): Promise<ExtensionPersistedEntryRecord<T>> {
			const record = await store.appendEntry(customType, data, {
				...entryOptions,
				sessionKey: entryOptions?.sessionKey ?? defaultSessionKey,
			});
			await bridge.flush();
			return record;
		},

		getPersistedEntries(sessionKey?: string): readonly ExtensionPersistedEntryRecord[] {
			return store.getEntries(sessionKey);
		},

		async flush(): Promise<void> {
			await store.flush?.();
		},
	};

	return bridge;
}
