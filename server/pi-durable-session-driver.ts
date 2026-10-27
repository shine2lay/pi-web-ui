import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	createRegistry,
	defineTool,
	Harness,
	type Conversation,
	type ConversationId,
	type EntryRecord,
	type Registry,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Type } from "typebox";
import {
	loadDurablePeerModule,
	type DurableModels,
} from "./durable/models-adapter.js";
import {
	createExtensionHookBridge,
	type ExtensionHookBridge,
} from "./durable-extension-port.js";
import {
	formatDurableSessionKey,
	parseDurableSessionKey,
	resolveDurableStorageMode,
	type DurableAppendCustomEntryOptions,
	type DurableCreateSessionOptions,
	type DurableCustomEntryRecord,
	type DurableFollowUpDisposition,
	type DurableFollowUpOptions,
	type DurableForkSessionOptions,
	type DurableListSessionsFilter,
	type DurableOpenSessionTarget,
	type DurablePromptOptions,
	type DurablePromptToolCallSimulation,
	type DurableSessionEntry,
	type DurableSessionEntryType,
	type DurableSessionEvent,
	type DurableSessionEventListener,
	type DurableSessionLookupQuery,
	type DurableSessionLookupResult,
	type DurableSessionOrigin,
	type DurableSessionPort,
	type DurableSessionSummary,
	type DurableSetThinkingOptions,
	type DurableSteerDisposition,
	type DurableSteerOptions,
	type DurableStorageModeState,
	type DurableSwitchModelOptions,
	type DurableThinkingLevel,
	type DurableTranscriptMessage,
	type DurableTurnResult,
} from "./durable-session-port.js";

export type DurableModelSelection = {
	provider: string;
	id?: string;
	modelId?: string;
	thinkingLevel?: DurableThinkingLevel;
};
export type DurableSessionCategory = "InteractiveSession" | "SubagentSession";
export type DurableEntryKind =
	| "ai.turn"
	| "ai.tool_call"
	| "app.pi.compaction"
	| "app.pi.custom"
	| "app.pi.extension_message";
export type DurableEntryRecord = DurableSessionEntry & {
	kind: string;
	payload?: Record<string, unknown>;
};
export type DurableMessageRecord = DurableTranscriptMessage & {
	customType?: string;
	display?: boolean;
	details?: Record<string, unknown>;
	stopReason?: string;
};
export type DurableSessionMetadata = DurableSessionSummary & {
	conversationId?: number;
	category: DurableSessionCategory;
	title?: string;
	leafEntryId: string | null;
	model: { provider: string; id: string; modelId: string; thinkingLevel?: DurableThinkingLevel };
	turnCount: number;
};
export type DurableSessionCreateOptions = Omit<DurableCreateSessionOptions, "model"> & {
	sessionKey?: string;
	title?: string;
	model?: DurableModelSelection;
	category?: DurableSessionCategory;
	parentSessionKey?: string;
	forkFromEntryId?: string;
};
export type DurableSessionOpenResult = DurableSessionMetadata & {
	created?: boolean;
	reopened?: boolean;
	recoveredInterruptedTurn?: boolean;
	metadata: DurableSessionMetadata;
};
export type DurablePromptResult = DurableTurnResult & {
	userMessage?: DurableMessageRecord;
};
export type DurableToolCallSpec = DurablePromptToolCallSimulation;
export interface DurableToolExecutionResult {
	toolCallId: string;
	toolName: string;
	content: Array<{ type: string; text?: string }>;
	details?: Record<string, unknown>;
	isError: boolean;
}
export type DurableToolHandler = (
	input: Record<string, unknown>,
	context: {
		toolCallId: string;
		toolName: string;
		abortSignal: AbortSignal;
	},
) => Promise<{
	content: Array<{ type: string; text?: string }>;
	details?: Record<string, unknown>;
	isError?: boolean;
}>;
export interface DurableCustomMessagePayload {
	customType: string;
	content: string;
	display?: boolean;
	details?: Record<string, unknown>;
}
export interface DurableCompactionOptions {
	focus?: string;
	keepRecentTokens?: number;
	summary?: string;
}
export interface DurableCompactionResult {
	status: "compacted" | "cancelled";
	compacted: boolean;
	cancelled: boolean;
	summary: string;
	removedEntryCount: number;
	keptEntryCount: number;
}
export interface DurableBranchLeafInfo {
	sessionKey: string;
	leafEntryId: string | null;
	entryCount: number;
	parentSessionKey?: string | null;
	forkFromEntryId?: string | null;
}
export type DurableSessionPortEvent = DurableSessionEvent & {
	compaction?: DurableCompactionResult;
	outcome?: string;
	args?: Record<string, unknown>;
	result?: DurableToolExecutionResult;
	isError?: boolean;
};
export type DurableSessionPortListener = DurableSessionEventListener;

function normalizeModelSpec(model?: DurableModelSelection): {
	provider: string;
	id: string;
	modelId: string;
	thinkingLevel?: DurableThinkingLevel;
} {
	const provider = model?.provider ?? "faux";
	const id = model?.id ?? model?.modelId ?? "pi-durable-default";
	return {
		provider,
		id,
		modelId: id,
		thinkingLevel: model?.thinkingLevel,
	};
}

const DEFAULT_MODEL_SELECTION = normalizeModelSpec({
	provider: "faux",
	id: "pi-durable-default",
});

const PI_WEB_UI_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pi_web_ui_sessions (
	session_key TEXT PRIMARY KEY,
	conversation_id INTEGER NOT NULL,
	cwd TEXT NOT NULL,
	category TEXT NOT NULL DEFAULT 'InteractiveSession',
	title TEXT,
	model_provider TEXT NOT NULL,
	model_id TEXT NOT NULL,
	thinking_level TEXT NOT NULL DEFAULT 'off',
	parent_session_key TEXT,
	fork_from_entry_id TEXT,
	turn_count INTEGER NOT NULL DEFAULT 0,
	next_entry_seq INTEGER NOT NULL DEFAULT 1,
	active_turn_id TEXT,
	active_turn_prompt TEXT,
	active_turn_options_json TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS pi_web_ui_entries (
	session_key TEXT NOT NULL,
	seq INTEGER NOT NULL,
	entry_id TEXT NOT NULL,
	parent_id TEXT,
	kind TEXT NOT NULL,
	type TEXT NOT NULL,
	timestamp INTEGER NOT NULL,
	payload_json TEXT NOT NULL,
	PRIMARY KEY (session_key, seq),
	UNIQUE (session_key, entry_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_pi_web_ui_entries_session_seq
	ON pi_web_ui_entries (session_key, seq ASC);
`;

export function durableDatabaseFileName(cwd: string): string {
	const digest = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
	return `pi-durable-w3-${digest}.sqlite`;
}

export interface SqliteDurableBackendConfig {
	dbPath: string;
	cwd: string;
}

export interface SqliteDurablePragmas {
	journalMode: string;
	synchronous: number;
	schemaVersion: number;
}

export interface PersistedSessionRow {
	session_key: string;
	conversation_id: number;
	cwd: string;
	category: DurableSessionCategory;
	title: string | null;
	model_provider: string;
	model_id: string;
	thinking_level: DurableThinkingLevel;
	parent_session_key: string | null;
	fork_from_entry_id: string | null;
	turn_count: number;
	next_entry_seq: number;
	active_turn_id: string | null;
	active_turn_prompt: string | null;
	active_turn_options_json: string | null;
	created_at: number;
	updated_at: number;
}

interface PersistedEntryRow {
	session_key: string;
	seq: number;
	entry_id: string;
	parent_id: string | null;
	kind: DurableEntryKind;
	type: DurableEntryRecord["type"];
	timestamp: number;
	payload_json: string;
}

/**
 * SQLite WAL storage wrapper around @earendil-works/pi-durable SqliteStorage (schema v2).
 */
export class SqliteDurableBackend {
	readonly dbPath: string;
	readonly cwd: string;
	readonly rawDb: DatabaseSync;
	readonly storage: SqliteStorage;
	private closed = false;

	private constructor(
		dbPath: string,
		cwd: string,
		rawDb: DatabaseSync,
		storage: SqliteStorage,
	) {
		this.dbPath = dbPath;
		this.cwd = cwd;
		this.rawDb = rawDb;
		this.storage = storage;
	}

	static async open(config: SqliteDurableBackendConfig): Promise<SqliteDurableBackend> {
		const storage = await openNodeSqliteStorage(config.dbPath);
		const rawDb = new DatabaseSync(config.dbPath);
		rawDb.exec("PRAGMA journal_mode = WAL;");
		rawDb.exec("PRAGMA synchronous = NORMAL;");
		rawDb.exec("PRAGMA foreign_keys = ON;");
		rawDb.exec("PRAGMA busy_timeout = 5000;");
		rawDb.exec(PI_WEB_UI_SCHEMA_SQL);
		return new SqliteDurableBackend(config.dbPath, config.cwd, rawDb, storage);
	}

	readPragmas(): SqliteDurablePragmas {
		const jm = this.rawDb.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
		const sync = this.rawDb.prepare("PRAGMA synchronous").get() as { synchronous?: number } | undefined;
		let schemaVersion = 0;
		try {
			const ver = this.rawDb
				.prepare("SELECT MAX(version) AS version FROM durable_schema")
				.get() as { version?: number } | undefined;
			schemaVersion = Number(ver?.version ?? 0);
		} catch {
			const uv = this.rawDb.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
			schemaVersion = Number(uv?.user_version ?? 0);
		}
		return {
			journalMode: String(jm?.journal_mode ?? "").toLowerCase(),
			synchronous: Number(sync?.synchronous ?? 0),
			schemaVersion,
		};
	}

	getSessionRow(sessionKey: string): PersistedSessionRow | undefined {
		return this.rawDb
			.prepare("SELECT * FROM pi_web_ui_sessions WHERE session_key = ?")
			.get(sessionKey) as PersistedSessionRow | undefined;
	}

	listSessionRows(): PersistedSessionRow[] {
		return this.rawDb
			.prepare("SELECT * FROM pi_web_ui_sessions ORDER BY created_at ASC, session_key ASC")
			.all() as unknown as PersistedSessionRow[];
	}

	upsertSessionRow(row: PersistedSessionRow): void {
		this.rawDb
			.prepare(
				`INSERT INTO pi_web_ui_sessions (
					session_key, conversation_id, cwd, category, title,
					model_provider, model_id, thinking_level,
					parent_session_key, fork_from_entry_id,
					turn_count, next_entry_seq,
					active_turn_id, active_turn_prompt, active_turn_options_json,
					created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT(session_key) DO UPDATE SET
					conversation_id = excluded.conversation_id,
					cwd = excluded.cwd,
					category = excluded.category,
					title = excluded.title,
					model_provider = excluded.model_provider,
					model_id = excluded.model_id,
					thinking_level = excluded.thinking_level,
					parent_session_key = excluded.parent_session_key,
					fork_from_entry_id = excluded.fork_from_entry_id,
					turn_count = excluded.turn_count,
					next_entry_seq = excluded.next_entry_seq,
					active_turn_id = excluded.active_turn_id,
					active_turn_prompt = excluded.active_turn_prompt,
					active_turn_options_json = excluded.active_turn_options_json,
					updated_at = excluded.updated_at`,
			)
			.run(
				row.session_key,
				row.conversation_id,
				row.cwd,
				row.category,
				row.title,
				row.model_provider,
				row.model_id,
				row.thinking_level,
				row.parent_session_key,
				row.fork_from_entry_id,
				row.turn_count,
				row.next_entry_seq,
				row.active_turn_id,
				row.active_turn_prompt,
				row.active_turn_options_json,
				row.created_at,
				row.updated_at,
			);
	}

	appendEntryRow(sessionKey: string, entry: DurableEntryRecord): number {
		const session = this.getSessionRow(sessionKey);
		if (!session) {
			throw new Error(`Unknown durable session: ${sessionKey}`);
		}
		const seq = session.next_entry_seq;
		const tsMs = Number.isFinite(Date.parse(entry.timestamp))
			? Date.parse(entry.timestamp)
			: Date.now();
		this.rawDb
			.prepare(
				`INSERT INTO pi_web_ui_entries (
					session_key, seq, entry_id, parent_id, kind, type, timestamp, payload_json
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				sessionKey,
				seq,
				entry.id,
				entry.parentId,
				entry.kind,
				entry.type,
				tsMs,
				JSON.stringify(entry.payload ?? {}),
			);
		this.rawDb
			.prepare(
				"UPDATE pi_web_ui_sessions SET next_entry_seq = ?, updated_at = ? WHERE session_key = ?",
			)
			.run(seq + 1, Date.now(), sessionKey);
		return seq;
	}

	listEntryRows(sessionKey: string): DurableEntryRecord[] {
		const rows = this.rawDb
			.prepare(
				"SELECT * FROM pi_web_ui_entries WHERE session_key = ? ORDER BY seq ASC",
			)
			.all(sessionKey) as unknown as PersistedEntryRow[];
		return rows.map((row) => {
			const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
			return {
				id: row.entry_id,
				sessionKey: row.session_key,
				parentId: row.parent_id,
				kind: row.kind,
				type: row.type,
				timestamp: new Date(row.timestamp).toISOString(),
				customType: typeof payload.customType === "string" ? payload.customType : undefined,
				data: payload,
				payload,
			};
		});
	}

	clearEntries(sessionKey: string): void {
		this.rawDb
			.prepare("DELETE FROM pi_web_ui_entries WHERE session_key = ?")
			.run(sessionKey);
	}

	markInterruptedTurnInSqlite(
		sessionKey: string,
		turnId: string,
		prompt: string,
		optionsSnapshot: Record<string, unknown>,
	): void {
		this.rawDb
			.prepare(
				`UPDATE pi_web_ui_sessions
				 SET active_turn_id = ?, active_turn_prompt = ?, active_turn_options_json = ?, updated_at = ?
				 WHERE session_key = ?`,
			)
			.run(turnId, prompt, JSON.stringify(optionsSnapshot), Date.now(), sessionKey);
	}

	clearActiveTurn(sessionKey: string): void {
		this.rawDb
			.prepare(
				`UPDATE pi_web_ui_sessions
				 SET active_turn_id = NULL, active_turn_prompt = NULL, active_turn_options_json = NULL, updated_at = ?
				 WHERE session_key = ?`,
			)
			.run(Date.now(), sessionKey);
	}

	deleteSessionRow(sessionKey: string): boolean {
		this.clearEntries(sessionKey);
		const res = this.rawDb
			.prepare("DELETE FROM pi_web_ui_sessions WHERE session_key = ?")
			.run(sessionKey);
		return res.changes > 0;
	}

	countRunningTasks(conversationId: number): number {
		const row = this.rawDb
			.prepare(
				"SELECT COUNT(*) AS cnt FROM tasks WHERE conversation_id = ? AND status != 'terminal'",
			)
			.get(conversationId) as { cnt?: number } | undefined;
		return Number(row?.cnt ?? 0);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		try {
			this.rawDb.close();
		} catch {
			// Ignore close error if already closed.
		}
		await this.storage.close(BACKGROUND_CONTEXT);
	}
}

export interface ActiveTurnPlan {
	sessionKey: string;
	turnIndex: number;
	prompt: string;
	assistantResponse?: string;
	toolCalls: readonly DurableToolCallSpec[];
	selectedTools?: readonly string[];
	toolRoundsDispatched: number;
}

export type CustomModelResponder = (params: {
	model: { provider: string; id: string };
	context: { messages: ReadonlyArray<{ role: string; content?: unknown }> };
	activeTurn?: ActiveTurnPlan;
}) => Promise<{ text?: string; stopReason?: "stop" | "toolUse" }> | { text?: string; stopReason?: "stop" | "toolUse" };

function extractLastUserText(messages: ReadonlyArray<{ role?: string; content?: unknown }>): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role === "user") {
			if (typeof m.content === "string") return m.content;
			if (Array.isArray(m.content)) {
				return m.content
					.map((part) =>
						part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string"
							? String((part as { text: string }).text)
							: "",
					)
					.join("");
			}
		}
	}
	return "";
}

type PeerPiAiModule = {
	fauxProvider: (options?: {
		provider?: string;
		models?: Array<{ id: string; reasoning?: boolean }>;
		tokensPerSecond?: number;
	}) => {
		provider: unknown;
		setResponses: (responses: unknown[]) => void;
		appendResponses: (responses: unknown[]) => void;
	};
	fauxAssistantMessage: (
		content: unknown,
		options?: {
			provider?: string;
			model?: string;
			stopReason?: "stop" | "toolUse" | "error" | "aborted";
			errorMessage?: string;
		},
	) => unknown;
	fauxToolCall: (
		name: string,
		args: Record<string, unknown>,
		options?: { id?: string },
	) => unknown;
};

type PeerCreateModelsModule = {
	createModels: (options?: { credentials?: unknown }) => DurableModels & {
		setProvider(provider: unknown): void;
	};
};

let peerPiAiCache: PeerPiAiModule | null = null;
let peerCreateModelsCache: PeerCreateModelsModule | null = null;

async function getPeerPiAi(): Promise<{
	ai: PeerPiAiModule;
	createModels: PeerCreateModelsModule["createModels"];
}> {
	if (!peerPiAiCache) {
		peerPiAiCache = await loadDurablePeerModule<PeerPiAiModule>("@earendil-works/pi-ai");
	}
	if (!peerCreateModelsCache) {
		peerCreateModelsCache = await loadDurablePeerModule<PeerCreateModelsModule>(
			"@earendil-works/pi-ai",
			"models",
		);
	}
	return { ai: peerPiAiCache, createModels: peerCreateModelsCache.createModels };
}

/**
 * Deterministic / pluggable model call executor backed by @earendil-works/pi-durable peer Models
 * for @earendil-works/pi-durable GenerationTask.
 */
export class PiModelCallExecutor {
	private readonly activeTurnsByConversation = new Map<number, ActiveTurnPlan>();
	private readonly defaultResponsesByConversation = new Map<number, string>();
	private readonly registeredFauxProviders = new Map<
		string,
		ReturnType<PeerPiAiModule["fauxProvider"]>
	>();
	private customResponder?: CustomModelResponder;
	private readonly ai: PeerPiAiModule;
	readonly models: DurableModels & { setProvider(provider: unknown): void };

	private constructor(
		ai: PeerPiAiModule,
		models: DurableModels & { setProvider(provider: unknown): void },
		customResponder?: CustomModelResponder,
	) {
		this.ai = ai;
		this.models = models;
		this.customResponder = customResponder;
		this.ensureProvider(DEFAULT_MODEL_SELECTION.provider, DEFAULT_MODEL_SELECTION.modelId);
	}

	static async create(customResponder?: CustomModelResponder): Promise<PiModelCallExecutor> {
		const { ai, createModels } = await getPeerPiAi();
		const models = createModels();
		return new PiModelCallExecutor(ai, models, customResponder);
	}

	ensureProvider(provider: string, modelId: string): ReturnType<PeerPiAiModule["fauxProvider"]> {
		const existing = this.registeredFauxProviders.get(provider);
		if (existing) {
			return existing;
		}
		const faux = this.ai.fauxProvider({
			provider,
			models: [
				{ id: modelId, reasoning: true },
				{ id: DEFAULT_MODEL_SELECTION.modelId, reasoning: true },
				{ id: "claude-sonnet-4-5", reasoning: true },
				{ id: "claude-opus-4-7", reasoning: true },
				{ id: "gpt-5", reasoning: true },
				{ id: "deterministic", reasoning: true },
			],
			tokensPerSecond: 0,
		});
		this.models.setProvider(faux.provider);
		this.registeredFauxProviders.set(provider, faux);
		return faux;
	}

	setCustomResponder(responder: CustomModelResponder | undefined): void {
		this.customResponder = responder;
	}

	setActiveTurn(
		conversationId: number,
		plan: ActiveTurnPlan | undefined,
		model: DurableModelSelection = DEFAULT_MODEL_SELECTION,
	): void {
		if (!plan) {
			this.activeTurnsByConversation.delete(conversationId);
			return;
		}
		this.activeTurnsByConversation.set(conversationId, plan);
		if (plan.assistantResponse !== undefined) {
			this.defaultResponsesByConversation.set(conversationId, plan.assistantResponse);
		}
		const resolvedModel = normalizeModelSpec(model);
		const faux = this.ensureProvider(resolvedModel.provider, resolvedModel.id);
		const stepFactory = async (
			context: { messages: ReadonlyArray<{ role: string; content?: unknown }> },
			_options: unknown,
			_state: unknown,
			activeModel: { provider: string; id: string },
		) => {
			const hasToolResultSinceLastUser = (() => {
				const msgs = context.messages ?? [];
				for (let i = msgs.length - 1; i >= 0; i--) {
					const role = msgs[i]?.role;
					if (role === "toolResult") return true;
					if (role === "user") return false;
				}
				return false;
			})();

			if (this.customResponder) {
				const custom = await this.customResponder({
					model: activeModel,
					context,
					activeTurn: plan,
				});
				return this.ai.fauxAssistantMessage(custom.text ?? "", {
					model: activeModel.id,
					provider: activeModel.provider,
					stopReason: custom.stopReason ?? "stop",
				});
			}

			if (
				plan.toolCalls.length > 0 &&
				plan.toolRoundsDispatched === 0 &&
				!hasToolResultSinceLastUser
			) {
				plan.toolRoundsDispatched += 1;
				const blocks = plan.toolCalls.map((tc, index) =>
					this.ai.fauxToolCall(
						tc.toolName,
						(tc.input ?? {}) as Record<string, unknown>,
						{ id: tc.toolCallId || `call-${plan.turnIndex + 1}-${index + 1}` },
					),
				);
				return this.ai.fauxAssistantMessage(blocks, {
					model: activeModel.id,
					provider: activeModel.provider,
					stopReason: "toolUse",
				});
			}

			const promptText = plan.prompt ?? extractLastUserText(context.messages ?? []);
			const responseText =
				plan.assistantResponse ??
				(this.defaultResponsesByConversation.size > 0
					? [...this.defaultResponsesByConversation.values()].at(-1)
					: undefined) ??
				`ack:${promptText}`;
			return this.ai.fauxAssistantMessage(responseText, {
				model: activeModel.id,
				provider: activeModel.provider,
				stopReason: "stop",
			});
		};

		const steps: unknown[] = [stepFactory, stepFactory, stepFactory, stepFactory];
		faux.setResponses(steps);
	}

	getActiveTurn(conversationId: number): ActiveTurnPlan | undefined {
		return this.activeTurnsByConversation.get(conversationId);
	}

	setDefaultResponse(conversationId: number, response: string): void {
		this.defaultResponsesByConversation.set(conversationId, response);
	}
}

/**
 * Tool executor bridging @earendil-works/pi-durable ToolTask and ExtensionHookBridge.
 */
export class PiToolExecutor {
	private readonly handlers = new Map<string, DurableToolHandler>();
	private readonly registrations = new Map<string, ToolRegistration>();
	private readonly turnToolSpecs = new Map<string, DurableToolCallSpec>();
	private readonly turnResults: DurableToolExecutionResult[] = [];
	private activeSessionKey = "";
	private hookBridge: ExtensionHookBridge;
	private emitEvent?: (sessionKey: string, event: DurableSessionPortEvent) => void;

	constructor(
		hookBridge: ExtensionHookBridge,
		emitEvent?: (sessionKey: string, event: DurableSessionPortEvent) => void,
	) {
		this.hookBridge = hookBridge;
		this.emitEvent = emitEvent;
	}

	setHookBridge(hookBridge: ExtensionHookBridge): void {
		this.hookBridge = hookBridge;
	}

	setEventEmitter(emitEvent: (sessionKey: string, event: DurableSessionPortEvent) => void): void {
		this.emitEvent = emitEvent;
	}

	setActiveSession(sessionKey: string, specs: DurableToolCallSpec[]): void {
		this.activeSessionKey = sessionKey;
		this.turnToolSpecs.clear();
		this.turnResults.length = 0;
		for (let i = 0; i < specs.length; i++) {
			const spec = specs[i]!;
			const id = spec.toolCallId || `call-1-${i + 1}`;
			this.turnToolSpecs.set(id, spec);
			this.turnToolSpecs.set(`${spec.toolName}:${id}`, spec);
		}
	}

	consumeTurnResults(): DurableToolExecutionResult[] {
		return [...this.turnResults];
	}

	registerTool(toolName: string, handler?: DurableToolHandler): ToolRegistration {
		if (handler) {
			this.handlers.set(toolName, handler);
		}
		const existing = this.registrations.get(toolName);
		if (existing) {
			return existing;
		}
		const registration = defineTool({
			name: toolName,
			description: `Durable tool ${toolName}`,
			parameters: Type.Record(Type.String(), Type.Unknown()),
			replay: "safe",
			execute: async (rawArgs, api, context) => {
				const input =
					rawArgs && typeof rawArgs === "object"
						? (rawArgs as Record<string, unknown>)
						: {};
				const toolCallId =
					(api as { callId?: string; toolCallId?: string }).callId ??
					(api as { toolCallId?: string }).toolCallId ??
					`call-${toolName}`;
				const sessionKey = this.activeSessionKey;
				const spec =
					this.turnToolSpecs.get(toolCallId) ??
					this.turnToolSpecs.get(`${toolName}:${toolCallId}`);

				const decision = await this.hookBridge.tool_call({
					toolCallId,
					toolName,
					input,
					sessionKey,
				});

				this.emitEvent?.(sessionKey, {
					type: "tool_execution_start",
					sessionKey,
					timestamp: Date.now(),
					toolCallId,
					toolName,
					toolArgs: input,
					args: input,
				});

				if (decision.block) {
					const blockedResult: DurableToolExecutionResult = {
						toolCallId,
						toolName,
						content: [
							{
								type: "text",
								text: decision.reason ?? `Tool ${toolName} blocked by extension`,
							},
						],
						details: { blocked: true, reason: decision.reason },
						isError: true,
					};
					const patched = await this.hookBridge.tool_result({
						toolCallId,
						toolName,
						input,
						content: blockedResult.content,
						details: blockedResult.details,
						isError: true,
						sessionKey,
					});
					const finalBlocked: DurableToolExecutionResult = {
						toolCallId,
						toolName,
						content:
							(patched.content as DurableToolExecutionResult["content"] | undefined) ??
							blockedResult.content,
						details:
							patched.details && typeof patched.details === "object"
								? {
										...blockedResult.details,
										...(patched.details as Record<string, unknown>),
									}
								: blockedResult.details,
						isError: patched.isError ?? true,
					};
					this.turnResults.push(finalBlocked);
					this.emitEvent?.(sessionKey, {
						type: "tool_execution_end",
						sessionKey,
						timestamp: Date.now(),
						toolCallId,
						toolName,
						toolResult: {
							content: finalBlocked.content,
							details: finalBlocked.details,
							isError: finalBlocked.isError,
						},
						result: finalBlocked,
						isError: finalBlocked.isError,
					});
					return {
						content: finalBlocked.content.map((c) => ({
							type: "text" as const,
							text: c.text ?? "",
						})),
						details: (finalBlocked.details ?? null) as never,
					};
				}

				const runPromise = (async () => {
					if (spec?.execute) {
						return await spec.execute(input);
					}
					const registeredHandler = this.handlers.get(toolName);
					if (registeredHandler) {
						return await registeredHandler(input, {
							toolCallId,
							toolName,
							abortSignal: context.abortSignal ?? new AbortController().signal,
						});
					}
					return {
						content: [{ type: "text", text: `${toolName}:ok` }],
						details: { input },
						isError: false,
					};
				})();

				const rawResult = await Promise.race([
					runPromise,
					new Promise<never>((_, reject) => {
						const signal = context.abortSignal;
						if (!signal) {
							return;
						}
						if (signal.aborted) {
							reject(signal.reason ?? new Error("Tool aborted"));
							return;
						}
						signal.addEventListener(
							"abort",
							() => reject(signal.reason ?? new Error("Tool aborted")),
							{ once: true },
						);
					}),
				]);

				const rawContent = Array.isArray(rawResult.content)
					? (rawResult.content as Array<{ type: string; text?: string }>)
					: [];
				const rawDetails =
					rawResult.details && typeof rawResult.details === "object"
						? (rawResult.details as Record<string, unknown>)
						: undefined;

				const patched = await this.hookBridge.tool_result({
					toolCallId,
					toolName,
					input,
					content: rawContent,
					details: rawDetails,
					isError: Boolean(rawResult.isError),
					sessionKey,
				});

				const finalResult: DurableToolExecutionResult = {
					toolCallId,
					toolName,
					content:
						(patched.content as DurableToolExecutionResult["content"] | undefined) ??
						rawContent,
					details:
						patched.details && typeof patched.details === "object"
							? {
									...rawDetails,
									...(patched.details as Record<string, unknown>),
								}
							: rawDetails,
					isError: patched.isError ?? Boolean(rawResult.isError),
				};
				this.turnResults.push(finalResult);

				this.emitEvent?.(sessionKey, {
					type: "tool_execution_end",
					sessionKey,
					timestamp: Date.now(),
					toolCallId,
					toolName,
					toolResult: {
						content: finalResult.content,
						details: finalResult.details,
						isError: finalResult.isError,
					},
					result: finalResult,
					isError: finalResult.isError,
				});

				return {
					content: finalResult.content.map((c) => ({
						type: "text" as const,
						text: c.text ?? "",
					})),
					details: (finalResult.details ?? null) as never,
				};
			},
		});
		this.registrations.set(toolName, registration);
		return registration;
	}

	getAllRegistrations(): ToolRegistration[] {
		return [...this.registrations.values()];
	}
}

function extractTextFromMessageContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
					return part.text;
				}
				return "";
			})
			.join("");
	}
	return String(content ?? "");
}

/**
 * Runtime coordinator wrapping @earendil-works/pi-durable Harness, SqliteDurableBackend,
 * PiModelCallExecutor, and PiToolExecutor.
 */
export class DurableEngine {
	readonly backend: SqliteDurableBackend;
	readonly modelExecutor: PiModelCallExecutor;
	readonly toolExecutor: PiToolExecutor;
	readonly registry: Registry;
	readonly harness: Harness;

	private constructor(
		backend: SqliteDurableBackend,
		modelExecutor: PiModelCallExecutor,
		toolExecutor: PiToolExecutor,
		registry: Registry,
		harness: Harness,
	) {
		this.backend = backend;
		this.modelExecutor = modelExecutor;
		this.toolExecutor = toolExecutor;
		this.registry = registry;
		this.harness = harness;
	}

	private extCounter = 0;

	static async open(params: {
		backend: SqliteDurableBackend;
		modelExecutor: PiModelCallExecutor;
		toolExecutor: PiToolExecutor;
	}): Promise<DurableEngine> {
		const registry = createRegistry();
		for (const defaultTool of ["bash", "read", "write", "edit", "grep", "find", "ls"]) {
			params.toolExecutor.registerTool(defaultTool);
		}
		const registrations = params.toolExecutor.getAllRegistrations();
		registry.install({ name: "pi-web-ui-default-tools", tools: registrations });

		const harness = await Harness.open(
			params.backend.storage,
			{
				models: params.modelExecutor.models,
				registry,
				settings: {
					toolExecution: "sequential",
				},
			},
			BACKGROUND_CONTEXT,
		);

		return new DurableEngine(
			params.backend,
			params.modelExecutor,
			params.toolExecutor,
			registry,
			harness,
		);
	}

	ensureToolsRegistered(toolNames: readonly string[]): ToolRegistration[] {
		const newlyAdded: ToolRegistration[] = [];
		for (const name of toolNames) {
			const existed = this.toolExecutor
				.getAllRegistrations()
				.some((r) => r.name === name);
			const reg = this.toolExecutor.registerTool(name);
			if (!existed) {
				newlyAdded.push(reg);
			}
		}
		if (newlyAdded.length > 0) {
			this.extCounter += 1;
			this.registry.install({
				name: `pi-web-ui-dynamic-tools-${this.extCounter}`,
				tools: newlyAdded,
			});
		}
		return this.toolExecutor.getAllRegistrations();
	}

	async createConversation(model: DurableModelSelection, thinkingLevel: DurableThinkingLevel): Promise<Conversation> {
		const resolved = normalizeModelSpec(model);
		this.modelExecutor.ensureProvider(resolved.provider, resolved.id);
		const allTools = this.toolExecutor.getAllRegistrations();
		return await this.harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: {
					model: { provider: resolved.provider, modelId: resolved.id },
					thinkingLevel: thinkingLevel === "off" ? null : thinkingLevel,
					tools: allTools,
					modelTools: allTools,
				},
			},
			BACKGROUND_CONTEXT,
		);
	}

	async openConversation(conversationId: number): Promise<Conversation | undefined> {
		return await this.harness.conversation(conversationId as ConversationId, BACKGROUND_CONTEXT);
	}

	async scanNativeEntries(conversationId: number): Promise<EntryRecord[]> {
		const conv = await this.openConversation(conversationId);
		if (!conv) return [];
		const page = await conv.entries({ order: "ascending" }, 10_000, undefined, BACKGROUND_CONTEXT);
		return [...page.items];
	}

	async runConversationTurn(params: {
		sessionKey: string;
		conversationId: number;
		turnIndex: number;
		prompt: string;
		model: DurableModelSelection;
		assistantResponse?: string;
		toolCalls: readonly DurableToolCallSpec[];
		selectedTools?: readonly string[];
	}): Promise<{
		assistantText: string;
		toolResults: DurableToolExecutionResult[];
	}> {
		const toolNames = params.toolCalls.map((tc) => tc.toolName);
		const allTools = this.ensureToolsRegistered(toolNames);

		const conv = await this.openConversation(params.conversationId);
		if (!conv) {
			throw new Error(`Durable conversation ${params.conversationId} not found`);
		}

		await conv.configure(
			{
				tools: allTools,
				modelTools: allTools,
			},
			BACKGROUND_CONTEXT,
		);

		const normalizedSpecs = params.toolCalls.map((spec, idx) => ({
			...spec,
			toolCallId: spec.toolCallId || `call-${params.turnIndex + 1}-${idx + 1}`,
		}));

		this.toolExecutor.setActiveSession(params.sessionKey, normalizedSpecs);
		this.modelExecutor.setActiveTurn(
			params.conversationId,
			{
				sessionKey: params.sessionKey,
				turnIndex: params.turnIndex,
				prompt: params.prompt,
				assistantResponse: params.assistantResponse,
				toolCalls: normalizedSpecs,
				selectedTools: params.selectedTools,
				toolRoundsDispatched: 0,
			},
			params.model,
		);

		try {
			const sub = await conv.submit(
				{
					type: "input",
					content: params.prompt,
					whenBusy: "followUp",
				},
				BACKGROUND_CONTEXT,
			);
			await sub.wait(BACKGROUND_CONTEXT);
			await conv.waitForIdle(BACKGROUND_CONTEXT);

			const entries = await this.scanNativeEntries(params.conversationId);
			let assistantText = params.assistantResponse ?? `ack:${params.prompt}`;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i];
				if (entry?.model?.[0]?.role === "assistant") {
					const msg = entry.model[0] as { stopReason?: string; content?: unknown };
					if (msg.stopReason !== "toolUse") {
						assistantText = extractTextFromMessageContent(msg.content);
						break;
					}
				}
			}

			const toolResults = this.toolExecutor.consumeTurnResults();
			return { assistantText, toolResults };
		} finally {
			this.modelExecutor.setActiveTurn(params.conversationId, undefined);
		}
	}

	async close(): Promise<void> {
		await this.harness.close(BACKGROUND_CONTEXT);
		await this.backend.close();
	}
}

interface SessionMemoryRecord {
	metadata: DurableSessionMetadata;
	conversationId: number;
	messages: DurableMessageRecord[];
	entries: DurableEntryRecord[];
	leafEntryId: string | null;
	streaming: boolean;
	abortRequested: boolean;
	steerQueue: string[];
	followUpQueue: string[];
}

export interface PiDurableSessionDriverOptions {
	dbDir: string;
	defaultCwd?: string;
	hookBridge?: ExtensionHookBridge;
	customModelResponder?: CustomModelResponder;
}

function reconstructMessagesFromEntries(entries: readonly DurableEntryRecord[]): DurableMessageRecord[] {
	const messages: DurableMessageRecord[] = [];
	for (const entry of entries) {
		if (entry.type === "compaction") {
			const summary = String(entry.payload?.summary ?? "");
			const keptCount = Number(entry.payload?.keptCount ?? 4);
			const preserved = messages.slice(-Math.max(1, keptCount));
			messages.length = 0;
			const tsMs = Number.isFinite(Date.parse(entry.timestamp))
				? Date.parse(entry.timestamp)
				: Date.now();
			messages.push(
				{
					id: `${entry.id}-summary`,
					entryId: entry.id,
					role: "system",
					content: summary,
					timestamp: tsMs,
					customType: "compaction_summary",
				},
				...preserved,
			);
			continue;
		}
		if (entry.type === "message" || entry.type === "custom_message") {
			const msg = entry.payload as unknown as DurableMessageRecord;
			if (msg && typeof msg === "object" && typeof msg.role === "string") {
				messages.push({ ...msg, entryId: msg.entryId ?? entry.id });
			}
		}
	}
	return messages;
}

/**
 * Wave 3.1 @earendil-works/pi-durable SQLite WAL session driver implementing DurableSessionPort.
 */
export class PiDurableSessionDriver implements DurableSessionPort {
	readonly mode = "durable" as const;
	readonly dbDir: string;
	private readonly defaultCwd: string;
	private hookBridge: ExtensionHookBridge;
	private readonly customModelResponder?: CustomModelResponder;
	private readonly enginesByDbPath = new Map<string, Promise<DurableEngine>>();
	private readonly resolvedEngines = new Map<string, DurableEngine>();
	private readonly sessions = new Map<string, SessionMemoryRecord>();
	private readonly sessionDbPath = new Map<string, string>();
	private readonly listeners = new Map<string, Set<DurableSessionPortListener>>();
	private readonly wildcardListeners = new Set<DurableSessionPortListener>();
	private activeKey: string | null = null;
	private idCounter = 0;

	constructor(options: PiDurableSessionDriverOptions) {
		this.dbDir = options.dbDir;
		this.defaultCwd = options.defaultCwd ?? process.cwd();
		this.hookBridge = options.hookBridge ?? createExtensionHookBridge();
		this.customModelResponder = options.customModelResponder;
		mkdirSync(this.dbDir, { recursive: true });
	}

	private nextId(prefix: string): string {
		this.idCounter += 1;
		return `${prefix}-${Date.now()}-${this.idCounter}`;
	}

	private resolveKey(sessionKey?: string): string {
		const key = sessionKey ?? this.activeKey;
		if (!key) {
			throw new Error("No active durable session key provided or selected");
		}
		return key;
	}

	private resolveDbPathForCwd(cwd: string): string {
		return join(this.dbDir, durableDatabaseFileName(cwd));
	}

	async getEngineForCwd(cwd = this.defaultCwd): Promise<DurableEngine> {
		const dbPath = this.resolveDbPathForCwd(cwd);
		let pending = this.enginesByDbPath.get(dbPath);
		if (!pending) {
			pending = (async () => {
				const backend = await SqliteDurableBackend.open({ dbPath, cwd });
				const modelExecutor = await PiModelCallExecutor.create(this.customModelResponder);
				const toolExecutor = new PiToolExecutor(this.hookBridge, (sk, ev) =>
					this.emit(sk, ev),
				);
				const engine = await DurableEngine.open({
					backend,
					modelExecutor,
					toolExecutor,
				});
				this.resolvedEngines.set(dbPath, engine);
				this.hydrateSessionsFromBackend(engine);
				return engine;
			})();
			this.enginesByDbPath.set(dbPath, pending);
		}
		return await pending;
	}

	private hydrateSessionsFromBackend(engine: DurableEngine): void {
		const rows = engine.backend.listSessionRows();
		for (const row of rows) {
			if (this.sessions.has(row.session_key)) continue;
			const entries = engine.backend.listEntryRows(row.session_key);
			const messages = reconstructMessagesFromEntries(entries);
			const leafEntryId = entries.length > 0 ? entries[entries.length - 1]!.id : null;
			const metadata: DurableSessionMetadata = {
				sessionKey: row.session_key,
				sessionId: row.session_key,
				cwd: row.cwd,
				dbPath: engine.backend.dbPath,
				origin: "durable-native",
				category: row.category,
				name: row.title ?? undefined,
				title: row.title ?? undefined,
				model: normalizeModelSpec({
					provider: row.model_provider,
					id: row.model_id,
					modelId: row.model_id,
				}),
				thinkingLevel: row.thinking_level,
				createdAt: new Date(row.created_at).toISOString(),
				updatedAt: new Date(row.updated_at).toISOString(),
				turnCount: row.turn_count,
				entryCount: entries.length,
				messageCount: messages.length,
				leafEntryId,
				parentSessionKey: row.parent_session_key ?? null,
				forkFromEntryId: row.fork_from_entry_id ?? null,
				conversationId: row.conversation_id,
			};
			this.sessions.set(row.session_key, {
				metadata,
				conversationId: row.conversation_id,
				messages,
				entries,
				leafEntryId,
				streaming: false,
				abortRequested: false,
				steerQueue: [],
				followUpQueue: [],
			});
			this.sessionDbPath.set(row.session_key, engine.backend.dbPath);
		}
	}

	private emit(
		sessionKey: string,
		event: Omit<DurableSessionPortEvent, "timestamp"> & { timestamp?: number },
	): void {
		const fullEvent: DurableSessionPortEvent = {
			timestamp: Date.now(),
			...event,
		};
		const scoped = this.listeners.get(sessionKey);
		if (scoped) {
			for (const fn of scoped) {
				fn(fullEvent);
			}
		}
		for (const fn of this.wildcardListeners) {
			fn(fullEvent);
		}
	}

	private getEngineForSessionSync(sessionKey: string): DurableEngine {
		const dbPath =
			this.sessionDbPath.get(sessionKey) ?? this.resolveDbPathForCwd(this.defaultCwd);
		const engine = this.resolvedEngines.get(dbPath);
		if (!engine) {
			throw new Error(`Durable engine not initialized for session ${sessionKey}`);
		}
		return engine;
	}

	private persistMetadataSync(record: SessionMemoryRecord): void {
		const engine = this.getEngineForSessionSync(record.metadata.sessionKey);
		const existing = engine.backend.getSessionRow(record.metadata.sessionKey);
		const createdMs = Number.isFinite(Date.parse(record.metadata.createdAt))
			? Date.parse(record.metadata.createdAt)
			: Date.now();
		const updatedMs = Number.isFinite(Date.parse(record.metadata.updatedAt))
			? Date.parse(record.metadata.updatedAt)
			: Date.now();
		engine.backend.upsertSessionRow({
			session_key: record.metadata.sessionKey,
			conversation_id: record.conversationId,
			cwd: record.metadata.cwd,
			category: record.metadata.category,
			title: record.metadata.title ?? record.metadata.name ?? null,
			model_provider: record.metadata.model.provider,
			model_id: record.metadata.model.id,
			thinking_level: record.metadata.thinkingLevel,
			parent_session_key: record.metadata.parentSessionKey ?? null,
			fork_from_entry_id: record.metadata.forkFromEntryId ?? null,
			turn_count: record.metadata.turnCount,
			next_entry_seq: existing?.next_entry_seq ?? record.entries.length + 1,
			active_turn_id: existing?.active_turn_id ?? null,
			active_turn_prompt: existing?.active_turn_prompt ?? null,
			active_turn_options_json: existing?.active_turn_options_json ?? null,
			created_at: createdMs,
			updated_at: updatedMs,
		});
	}

	private appendEntryInternal(
		record: SessionMemoryRecord,
		kind: DurableEntryKind,
		type: DurableSessionEntryType,
		payload: Record<string, unknown>,
		timestamp = Date.now(),
		customType?: string,
	): DurableEntryRecord {
		const isoTs = new Date(timestamp).toISOString();
		const entry: DurableEntryRecord = {
			id: this.nextId("entry"),
			sessionKey: record.metadata.sessionKey,
			parentId: record.leafEntryId,
			kind,
			type,
			timestamp: isoTs,
			customType,
			data: payload,
			payload,
		};
		record.entries.push(entry);
		record.leafEntryId = entry.id;
		record.metadata.leafEntryId = entry.id;
		record.metadata.entryCount = record.entries.length;
		record.metadata.messageCount = record.messages.length;
		record.metadata.updatedAt = isoTs;
		const engine = this.getEngineForSessionSync(record.metadata.sessionKey);
		engine.backend.appendEntryRow(record.metadata.sessionKey, entry);
		return entry;
	}

	private mustGetSession(sessionKey?: string): SessionMemoryRecord {
		const key = this.resolveKey(sessionKey);
		const record = this.sessions.get(key);
		if (!record) {
			throw new Error(`Unknown durable session: ${key}`);
		}
		return record;
	}

	async getDatabasePragmas(cwd = this.defaultCwd): Promise<SqliteDurablePragmas> {
		const engine = await this.getEngineForCwd(cwd);
		return engine.backend.readPragmas();
	}

	async registerTool(toolName: string, handler?: DurableToolHandler, cwd = this.defaultCwd): Promise<void> {
		const engine = await this.getEngineForCwd(cwd);
		const reg = engine.toolExecutor.registerTool(toolName, handler);
		engine.registry.install({
			name: `pi-web-ui-tool-${toolName}-${Date.now()}`,
			tools: [reg],
		});
	}

	async create(options: DurableSessionCreateOptions = {}): Promise<DurableSessionOpenResult> {
		const cwd = options.cwd || this.defaultCwd;
		const engine = await this.getEngineForCwd(cwd);
		const sessionId = options.sessionId ?? options.sessionKey ?? this.nextId("session");
		const sessionKey =
			options.sessionKey ??
			formatDurableSessionKey(cwd, sessionId);

		const existing = this.sessions.get(sessionKey);
		if (existing) {
			this.activeKey = sessionKey;
			return {
				...existing.metadata,
				created: false,
				reopened: true,
				recoveredInterruptedTurn: false,
				metadata: { ...existing.metadata },
			};
		}

		const model = normalizeModelSpec(options.model);
		const thinkingLevel = options.thinkingLevel ?? "off";
		const origin: DurableSessionOrigin = "durable-native";
		const conv = await engine.createConversation(model, thinkingLevel);
		const nowIso = new Date().toISOString();
		const title = options.title ?? options.name;
		const metadata: DurableSessionMetadata = {
			sessionKey,
			sessionId,
			cwd,
			dbPath: engine.backend.dbPath,
			origin,
			category: options.category ?? "InteractiveSession",
			name: title,
			title,
			model,
			thinkingLevel,
			createdAt: nowIso,
			updatedAt: nowIso,
			turnCount: 0,
			entryCount: 0,
			messageCount: 0,
			leafEntryId: null,
			parentSessionKey: options.parentSessionKey ?? null,
			forkFromEntryId: options.forkFromEntryId ?? null,
			conversationId: Number(conv.id),
		};

		const record: SessionMemoryRecord = {
			metadata,
			conversationId: Number(conv.id),
			messages: [],
			entries: [],
			leafEntryId: null,
			streaming: false,
			abortRequested: false,
			steerQueue: [],
			followUpQueue: [],
		};
		this.sessions.set(sessionKey, record);
		this.sessionDbPath.set(sessionKey, engine.backend.dbPath);
		this.activeKey = sessionKey;
		this.persistMetadataSync(record);

		return {
			...metadata,
			created: true,
			reopened: false,
			recoveredInterruptedTurn: false,
			metadata: { ...metadata },
		};
	}

	async open(
		target: string | DurableOpenSessionTarget,
		fallbackCreate?: Omit<DurableSessionCreateOptions, "sessionKey">,
	): Promise<DurableSessionOpenResult> {
		const targetObj: DurableOpenSessionTarget =
			typeof target === "string" ? { sessionKey: target } : target;
		const cwd = targetObj.cwd ?? fallbackCreate?.cwd ?? this.defaultCwd;
		const engine = await this.getEngineForCwd(cwd);
		this.hydrateSessionsFromBackend(engine);

		const lookupKey =
			targetObj.sessionKey ??
			(targetObj.sessionId ? formatDurableSessionKey(cwd, targetObj.sessionId) : undefined);

		let existing = lookupKey ? this.sessions.get(lookupKey) : undefined;
		if (!existing && targetObj.sessionId) {
			for (const candidate of this.sessions.values()) {
				if (
					candidate.metadata.sessionId === targetObj.sessionId ||
					candidate.metadata.sessionKey === targetObj.sessionId
				) {
					existing = candidate;
					break;
				}
			}
		}

		if (existing) {
			this.activeKey = existing.metadata.sessionKey;
			const recoveredInterruptedTurn = await this.recoverInterruptedSessionTurnIfNeeded(
				engine,
				existing,
			);
			return {
				...existing.metadata,
				created: false,
				reopened: true,
				recoveredInterruptedTurn,
				metadata: { ...existing.metadata },
			};
		}

		if (fallbackCreate) {
			const createKey =
				lookupKey ?? targetObj.sessionId ?? this.nextId("session");
			return await this.create({
				...fallbackCreate,
				cwd,
				sessionKey: createKey,
				sessionId: targetObj.sessionId ?? createKey,
			});
		}
		throw new Error(`Durable session not found: ${lookupKey ?? targetObj.sessionId ?? ""}`);
	}

	private async recoverInterruptedSessionTurnIfNeeded(
		engine: DurableEngine,
		record: SessionMemoryRecord,
	): Promise<boolean> {
		const row = engine.backend.getSessionRow(record.metadata.sessionKey);
		const runningTasks = engine.backend.countRunningTasks(record.conversationId);
		const hasActiveTurnMarker = Boolean(row?.active_turn_id);

		if (!hasActiveTurnMarker && runningTasks === 0) {
			return false;
		}

		let parsedOptions: DurablePromptOptions = {};
		if (row?.active_turn_options_json) {
			try {
				parsedOptions = JSON.parse(row.active_turn_options_json) as DurablePromptOptions;
			} catch {
				parsedOptions = {};
			}
		}

		const promptText = row?.active_turn_prompt ?? "recovered turn";
		const turnIndex = Math.max(0, record.metadata.turnCount - 1);

		const conv = await engine.openConversation(record.conversationId);
		if (conv) {
			engine.modelExecutor.setActiveTurn(
				record.conversationId,
				{
					sessionKey: record.metadata.sessionKey,
					turnIndex,
					prompt: promptText,
					assistantResponse: parsedOptions.assistantResponse,
					toolCalls: parsedOptions.toolCalls ?? [],
					selectedTools: parsedOptions.selectedTools,
					toolRoundsDispatched: 1,
				},
				record.metadata.model,
			);
			try {
				await conv.waitForIdle(BACKGROUND_CONTEXT);
			} finally {
				engine.modelExecutor.setActiveTurn(record.conversationId, undefined);
			}
		}

		const hasAssistantFinish =
			record.messages.length > 0 &&
			record.messages[record.messages.length - 1]?.role === "assistant";

		if (!hasAssistantFinish) {
			const nativeEntries = await engine.scanNativeEntries(record.conversationId);
			for (const e of nativeEntries) {
				if (
					e.kind === "pi.tool-result" ||
					e.kind === "ai.tool_call" ||
					e.model?.[0]?.role === "toolResult"
				) {
					const toolMsg = e.model?.[0] as
						| {
								toolCallId?: string;
								toolName?: string;
								content?: ReadonlyArray<{ text?: unknown }>;
								details?: Record<string, unknown>;
								isError?: boolean;
						  }
						| undefined;
					const data = (e.data && typeof e.data === "object" && !Array.isArray(e.data)
						? e.data
						: {}) as {
						toolCallId?: string;
						toolName?: string;
						call?: { id?: string; name?: string };
					};
					const resolvedToolCallId =
						toolMsg?.toolCallId ?? data.call?.id ?? data.toolCallId;
					const resolvedToolName =
						toolMsg?.toolName ?? data.call?.name ?? data.toolName;
					const alreadyHasToolResult = record.messages.some(
						(m) => m.role === "toolResult" && m.toolCallId === resolvedToolCallId,
					);
					if (!alreadyHasToolResult) {
						const trId = this.nextId("msg");
						const trNow = Date.now();
						const trMsg: DurableMessageRecord = {
							id: trId,
							entryId: trId,
							role: "toolResult",
							content: (toolMsg?.content ?? []).map((part) => ({
								type: "text",
								text:
									part && typeof part === "object" && "text" in part && typeof part.text === "string"
										? part.text
										: "",
							})),
							timestamp: trNow,
							toolCallId: typeof resolvedToolCallId === "string" ? resolvedToolCallId : undefined,
							toolName: typeof resolvedToolName === "string" ? resolvedToolName : undefined,
							details: toolMsg?.details,
							isError: Boolean(toolMsg?.isError),
						};
						const toolEntry = this.appendEntryInternal(
							record,
							"ai.tool_call",
							"message",
							trMsg as unknown as Record<string, unknown>,
							trNow,
						);
						trMsg.entryId = toolEntry.id;
						record.messages.push(trMsg);
					}
				}
			}

			let recoveredAssistantText =
				parsedOptions.assistantResponse ?? `ack:${promptText}`;
			for (let i = nativeEntries.length - 1; i >= 0; i--) {
				const e = nativeEntries[i];
				if (e?.model?.[0]?.role === "assistant") {
					const msg = e.model[0] as { stopReason?: string; content?: unknown };
					if (msg.stopReason !== "toolUse") {
						recoveredAssistantText = extractTextFromMessageContent(msg.content);
						break;
					}
				}
			}

			const assistantNow = Date.now();
			const assistantId = this.nextId("msg");
			const assistantMsg: DurableMessageRecord = {
				id: assistantId,
				entryId: assistantId,
				role: "assistant",
				content: recoveredAssistantText,
				timestamp: assistantNow,
				stopReason: "stop",
			};
			const assistantEntry = this.appendEntryInternal(
				record,
				"ai.turn",
				"message",
				assistantMsg as unknown as Record<string, unknown>,
				assistantNow,
			);
			assistantMsg.entryId = assistantEntry.id;
			record.messages.push(assistantMsg);
		}

		engine.backend.clearActiveTurn(record.metadata.sessionKey);
		record.metadata.messageCount = record.messages.length;
		this.persistMetadataSync(record);
		return true;
	}

	getStorageMode(): DurableStorageModeState {
		return resolveDurableStorageMode({ dbDir: this.dbDir });
	}

	getSessionKey(): string {
		const record = this.mustGetSession();
		return record.metadata.sessionKey;
	}

	getSummary(sessionKey?: string): DurableSessionSummary {
		const record = this.mustGetSession(sessionKey);
		return { ...record.metadata };
	}

	getSessionMetadata(sessionKey?: string): DurableSessionMetadata | undefined {
		const key = sessionKey ?? this.activeKey;
		if (!key) return undefined;
		const record = this.sessions.get(key);
		return record ? { ...record.metadata } : undefined;
	}

	async list(filter?: DurableListSessionsFilter): Promise<DurableSessionMetadata[]> {
		return await this.listSessions(filter);
	}

	async delete(sessionKey: string): Promise<boolean> {
		const record = this.sessions.get(sessionKey);
		const cwd = record?.metadata.cwd ?? this.defaultCwd;
		const engine = await this.getEngineForCwd(cwd);
		const removed = engine.backend.deleteSessionRow(sessionKey) || this.sessions.has(sessionKey);
		this.sessions.delete(sessionKey);
		this.sessionDbPath.delete(sessionKey);
		if (this.activeKey === sessionKey) {
			this.activeKey = null;
		}
		return removed;
	}

	async listSessions(filter?: DurableListSessionsFilter): Promise<DurableSessionMetadata[]> {
		const cwd = filter?.cwd ?? this.defaultCwd;
		const engine = await this.getEngineForCwd(cwd);
		this.hydrateSessionsFromBackend(engine);
		let all = [...this.sessions.values()].map((s) => ({ ...s.metadata }));
		if (filter?.cwd) {
			all = all.filter((s) => s.cwd === filter.cwd);
		}
		if (filter?.origin) {
			all = all.filter((s) => s.origin === filter.origin);
		}
		if (filter?.limit && filter.limit > 0) {
			all = all.slice(0, filter.limit);
		}
		return all;
	}

	async lookupSession(
		queryInput: DurableSessionLookupQuery | string,
	): Promise<DurableSessionLookupResult> {
		const query: DurableSessionLookupQuery =
			typeof queryInput === "string" ? { sessionKey: queryInput } : queryInput;
		const cwd = query.cwd ?? this.defaultCwd;
		const engine = await this.getEngineForCwd(cwd);
		this.hydrateSessionsFromBackend(engine);
		if (query.sessionKey) {
			const hit = this.sessions.get(query.sessionKey);
			if (hit) {
				return {
					found: true,
					origin: hit.metadata.origin,
					sessionKey: hit.metadata.sessionKey,
					sessionId: hit.metadata.sessionId,
					cwd: hit.metadata.cwd,
					dbPath: hit.metadata.dbPath,
					sourceSessionFile: hit.metadata.sourceSessionFile ?? null,
				};
			}
			let parsed: { dbName: string; sessionId: string } | null = null;
			try {
				parsed = parseDurableSessionKey(query.sessionKey);
			} catch {
				parsed = null;
			}
			if (parsed) {
				for (const candidate of this.sessions.values()) {
					if (candidate.metadata.sessionId === parsed.sessionId) {
						return {
							found: true,
							origin: candidate.metadata.origin,
							sessionKey: candidate.metadata.sessionKey,
							sessionId: candidate.metadata.sessionId,
							cwd: candidate.metadata.cwd,
							dbPath: candidate.metadata.dbPath,
							sourceSessionFile: candidate.metadata.sourceSessionFile ?? null,
						};
					}
				}
			}
		}
		if (query.sessionId) {
			for (const candidate of this.sessions.values()) {
				if (
					candidate.metadata.sessionId === query.sessionId ||
					candidate.metadata.sessionKey === query.sessionId
				) {
					return {
						found: true,
						origin: candidate.metadata.origin,
						sessionKey: candidate.metadata.sessionKey,
						sessionId: candidate.metadata.sessionId,
						cwd: candidate.metadata.cwd,
						dbPath: candidate.metadata.dbPath,
						sourceSessionFile: candidate.metadata.sourceSessionFile ?? null,
					};
				}
			}
		}
		return {
			found: false,
			origin: "not-found",
			sessionKey: query.sessionKey ?? null,
			sessionId: query.sessionId ?? null,
			cwd: query.cwd ?? null,
			dbPath: null,
			sourceSessionFile: query.sessionFile ?? null,
		};
	}

	getMessages(sessionKey?: string): DurableMessageRecord[] {
		const record = this.mustGetSession(sessionKey);
		return record.messages.map((m) => ({ ...m }));
	}

	getEntries(sessionKey?: string): DurableEntryRecord[] {
		const record = this.mustGetSession(sessionKey);
		return record.entries.map((e) => ({ ...e }));
	}

	async prompt(
		text: string,
		promptOptions: DurablePromptOptions = {},
		sessionKey?: string,
	): Promise<DurablePromptResult> {
		const record = this.mustGetSession(sessionKey ?? promptOptions.sessionKey);
		const key = record.metadata.sessionKey;
		const engine = await this.getEngineForCwd(record.metadata.cwd);
		const appendedEntries: DurableEntryRecord[] = [];
		const toolResults: DurableToolExecutionResult[] = [];
		const toolTranscriptMessages: DurableMessageRecord[] = [];

		const beforeStart = await this.hookBridge.before_agent_start({
			prompt: text,
			systemPrompt: promptOptions.systemPrompt,
			selectedTools: promptOptions.selectedTools,
			sessionKey: key,
		});

		if (beforeStart.customMessages && beforeStart.customMessages.length > 0) {
			for (const custom of beforeStart.customMessages) {
				const entry = await this.appendCustomMessage(
					{
						customType: String(custom.customType ?? "extension"),
						content: String(custom.content ?? ""),
						display: typeof custom.display === "boolean" ? custom.display : true,
						details:
							custom.details && typeof custom.details === "object"
								? (custom.details as Record<string, unknown>)
								: undefined,
					},
					key,
				);
				appendedEntries.push(entry);
			}
		}

		const effectivePrompt = beforeStart.prompt ?? text;
		const turnIndex = record.metadata.turnCount;

		if (beforeStart.handled) {
			const handledUserMsg: DurableMessageRecord = {
				id: this.nextId("msg"),
				entryId: this.nextId("entry-handled"),
				role: "user",
				content: effectivePrompt,
				timestamp: Date.now(),
			};
			return {
				sessionKey: key,
				turnIndex,
				outcome: "handled",
				prompt: effectivePrompt,
				userMessage: handledUserMsg,
				assistantMessage: undefined,
				toolResults: [],
				appendedEntries,
			};
		}

		const turnStartTime = Date.now();
		record.streaming = true;
		record.abortRequested = false;
		record.metadata.turnCount += 1;
		record.metadata.updatedAt = new Date(turnStartTime).toISOString();

		const turnId = this.nextId("turn");
		engine.backend.markInterruptedTurnInSqlite(key, turnId, effectivePrompt, {
			assistantResponse: promptOptions.assistantResponse,
			selectedTools: promptOptions.selectedTools,
			toolCalls: (promptOptions.toolCalls ?? []).map((tc) => ({
				toolCallId: tc.toolCallId,
				toolName: tc.toolName,
				input: tc.input,
			})),
		});

		this.emit(key, { type: "agent_start", sessionKey: key });
		await this.hookBridge.turn_start({
			turnIndex,
			timestamp: turnStartTime,
			sessionKey: key,
		});
		this.emit(key, { type: "turn_start", sessionKey: key, turnIndex });

		const userMsgId = this.nextId("msg");
		const userMessage: DurableMessageRecord = {
			id: userMsgId,
			entryId: userMsgId,
			role: "user",
			content: effectivePrompt,
			timestamp: turnStartTime,
		};
		const userEntry = this.appendEntryInternal(
			record,
			"ai.turn",
			"message",
			userMessage as unknown as Record<string, unknown>,
			turnStartTime,
		);
		userMessage.entryId = userEntry.id;
		record.messages.push(userMessage);
		record.metadata.messageCount = record.messages.length;
		appendedEntries.push(userEntry);
		this.emit(key, { type: "message_end", sessionKey: key, message: userMessage });

		const transformedMessages = await this.hookBridge.transformContext(
			record.messages,
			key,
		);
		record.messages = transformedMessages.map((m) => {
			const id = String(m.id ?? this.nextId("msg"));
			return {
				id,
				entryId: String((m as { entryId?: string }).entryId ?? id),
				role: (m.role as DurableMessageRecord["role"]) ?? "user",
				content: m.content as DurableMessageRecord["content"],
				timestamp: Number(m.timestamp ?? Date.now()),
				customType: typeof m.customType === "string" ? m.customType : undefined,
				display: typeof m.display === "boolean" ? m.display : undefined,
				details:
					m.details && typeof m.details === "object"
						? (m.details as Record<string, unknown>)
						: undefined,
			};
		});

		if (record.abortRequested) {
			record.streaming = false;
			engine.backend.clearActiveTurn(key);
			this.persistMetadataSync(record);
			await this.hookBridge.turn_end({
				turnIndex,
				outcome: "aborted",
				sessionKey: key,
			});
			this.emit(key, {
				type: "turn_end",
				sessionKey: key,
				turnIndex,
				outcome: "aborted",
			});
			this.emit(key, { type: "agent_end", sessionKey: key });
			return {
				sessionKey: key,
				turnIndex,
				outcome: "aborted",
				prompt: effectivePrompt,
				userMessage,
				assistantMessage: undefined,
				toolResults: toolTranscriptMessages,
				appendedEntries,
			};
		}

		const engineTurn = await engine.runConversationTurn({
			sessionKey: key,
			conversationId: record.conversationId,
			turnIndex,
			prompt: effectivePrompt,
			model: record.metadata.model,
			assistantResponse: promptOptions.assistantResponse,
			toolCalls: promptOptions.toolCalls ?? [],
			selectedTools: promptOptions.selectedTools,
		});

		for (const tr of engineTurn.toolResults) {
			toolResults.push(tr);
			const toolMsgId = this.nextId("msg");
			const toolNow = Date.now();
			const toolMessage: DurableMessageRecord = {
				id: toolMsgId,
				entryId: toolMsgId,
				role: "toolResult",
				content: tr.content,
				timestamp: toolNow,
				toolCallId: tr.toolCallId,
				toolName: tr.toolName,
				isError: tr.isError,
				details: tr.details,
			};
			const toolEntry = this.appendEntryInternal(
				record,
				"ai.tool_call",
				"message",
				toolMessage as unknown as Record<string, unknown>,
				toolNow,
			);
			toolMessage.entryId = toolEntry.id;
			record.messages.push(toolMessage);
			record.metadata.messageCount = record.messages.length;
			toolTranscriptMessages.push(toolMessage);
			appendedEntries.push(toolEntry);
		}

		if (record.abortRequested) {
			record.streaming = false;
			engine.backend.clearActiveTurn(key);
			this.persistMetadataSync(record);
			await this.hookBridge.turn_end({
				turnIndex,
				outcome: "aborted",
				sessionKey: key,
			});
			this.emit(key, {
				type: "turn_end",
				sessionKey: key,
				turnIndex,
				outcome: "aborted",
			});
			this.emit(key, { type: "agent_end", sessionKey: key });
			return {
				sessionKey: key,
				turnIndex,
				outcome: "aborted",
				prompt: effectivePrompt,
				userMessage,
				assistantMessage: undefined,
				toolResults: toolTranscriptMessages,
				appendedEntries,
			};
		}

		const assistantNow = Date.now();
		const assistantMsgId = this.nextId("msg");
		const assistantMessage: DurableMessageRecord = {
			id: assistantMsgId,
			entryId: assistantMsgId,
			role: "assistant",
			content: engineTurn.assistantText,
			timestamp: assistantNow,
			stopReason: "stop",
		};
		this.emit(key, {
			type: "message_start",
			sessionKey: key,
			message: assistantMessage,
		});
		this.emit(key, {
			type: "message_update",
			sessionKey: key,
			message: assistantMessage,
		});
		const assistantEntry = this.appendEntryInternal(
			record,
			"ai.turn",
			"message",
			assistantMessage as unknown as Record<string, unknown>,
			assistantNow,
		);
		assistantMessage.entryId = assistantEntry.id;
		record.messages.push(assistantMessage);
		record.metadata.messageCount = record.messages.length;
		appendedEntries.push(assistantEntry);
		this.emit(key, {
			type: "message_end",
			sessionKey: key,
			message: assistantMessage,
		});

		record.streaming = false;
		engine.backend.clearActiveTurn(key);
		this.persistMetadataSync(record);

		await this.hookBridge.turn_end({
			turnIndex,
			outcome: "completed",
			sessionKey: key,
		});
		this.emit(key, {
			type: "turn_end",
			sessionKey: key,
			turnIndex,
			outcome: "completed",
		});
		this.emit(key, { type: "agent_end", sessionKey: key });

		return {
			sessionKey: key,
			turnIndex,
			outcome: "completed",
			prompt: effectivePrompt,
			userMessage,
			assistantMessage,
			toolResults: toolTranscriptMessages,
			appendedEntries,
		};
	}

	async steer(
		text: string,
		optionsOrKey?: string | DurableSteerOptions,
	): Promise<DurableSteerDisposition> {
		const sessionKey =
			typeof optionsOrKey === "string" ? optionsOrKey : optionsOrKey?.sessionKey;
		const record = this.mustGetSession(sessionKey);
		record.steerQueue.push(text);
		if (!record.streaming) {
			const next = record.steerQueue.shift();
			if (next !== undefined) {
				await this.prompt(next, {}, record.metadata.sessionKey);
				return "delivered";
			}
		}
		return "queued";
	}

	async followUp(
		text: string,
		optionsOrKey?: string | DurableFollowUpOptions,
	): Promise<DurableFollowUpDisposition> {
		const sessionKey =
			typeof optionsOrKey === "string" ? optionsOrKey : optionsOrKey?.sessionKey;
		const record = this.mustGetSession(sessionKey);
		record.followUpQueue.push(text);
		if (!record.streaming) {
			const next = record.followUpQueue.shift();
			if (next !== undefined) {
				await this.prompt(next, {}, record.metadata.sessionKey);
				return "delivered";
			}
		}
		return "queued";
	}

	async abort(sessionKey?: string): Promise<void> {
		const record = this.mustGetSession(sessionKey);
		record.abortRequested = true;
		record.streaming = false;
		const engine = await this.getEngineForCwd(record.metadata.cwd);
		const conv = await engine.openConversation(record.conversationId);
		if (conv) {
			await conv.abort(BACKGROUND_CONTEXT);
		}
		engine.backend.clearActiveTurn(record.metadata.sessionKey);
	}

	isStreaming(sessionKey?: string): boolean {
		const record = this.mustGetSession(sessionKey);
		return record.streaming;
	}

	async switchModel(
		model: DurableModelSelection,
		options?: DurableSwitchModelOptions,
	): Promise<void> {
		await this.setModel(model, options?.sessionKey);
	}

	async setModel(model: DurableModelSelection, sessionKey?: string): Promise<void> {
		const record = this.mustGetSession(sessionKey);
		const resolved = normalizeModelSpec(model);
		const previous = { ...record.metadata.model };
		record.metadata.model = resolved;
		const engine = await this.getEngineForCwd(record.metadata.cwd);
		engine.modelExecutor.ensureProvider(resolved.provider, resolved.id);
		const conv = await engine.openConversation(record.conversationId);
		if (conv) {
			await conv.configure(
				{
					model: { provider: resolved.provider, modelId: resolved.id },
				},
				BACKGROUND_CONTEXT,
			);
		}
		this.appendEntryInternal(record, "app.pi.custom", "model_change", {
			previous,
			next: resolved,
		});
		this.persistMetadataSync(record);
		await this.hookBridge.appendEntry(
			"model_select",
			{
				provider: resolved.provider,
				modelId: resolved.id,
				previousProvider: previous.provider,
				previousModelId: previous.id,
			},
			{ sessionKey: record.metadata.sessionKey },
		);
	}

	async setThinkingLevel(
		levelOrOptions: DurableThinkingLevel | (DurableSetThinkingOptions & { thinkingLevel: DurableThinkingLevel }),
		optionsOrKey?: string | DurableSetThinkingOptions,
	): Promise<void> {
		const level =
			typeof levelOrOptions === "string"
				? levelOrOptions
				: levelOrOptions.thinkingLevel;
		const resolvedKey =
			typeof levelOrOptions === "string"
				? typeof optionsOrKey === "string"
					? optionsOrKey
					: optionsOrKey?.sessionKey
				: levelOrOptions.sessionKey;
		const record = this.mustGetSession(resolvedKey);
		const previous = record.metadata.thinkingLevel;
		record.metadata.thinkingLevel = level;
		const engine = await this.getEngineForCwd(record.metadata.cwd);
		const conv = await engine.openConversation(record.conversationId);
		if (conv) {
			await conv.configure(
				{
					thinkingLevel: level === "off" ? null : level,
				},
				BACKGROUND_CONTEXT,
			);
		}
		this.appendEntryInternal(record, "app.pi.custom", "thinking_level_change", {
			previous,
			next: level,
		});
		this.persistMetadataSync(record);
	}

	async appendCustomMessage(
		payload: DurableCustomMessagePayload,
		sessionKey?: string,
	): Promise<DurableEntryRecord> {
		const record = this.mustGetSession(sessionKey);
		await this.getEngineForCwd(record.metadata.cwd);
		const now = Date.now();
		const msgId = this.nextId("custom");
		const msg: DurableMessageRecord = {
			id: msgId,
			entryId: msgId,
			role: "custom",
			content: payload.content,
			timestamp: now,
			customType: payload.customType,
			display: payload.display ?? true,
			details: payload.details,
		};
		const entry = this.appendEntryInternal(
			record,
			"app.pi.extension_message",
			"custom_message",
			msg as unknown as Record<string, unknown>,
			now,
			payload.customType,
		);
		msg.entryId = entry.id;
		record.messages.push(msg);
		record.metadata.messageCount = record.messages.length;
		this.persistMetadataSync(record);
		return entry;
	}

	async appendCustomEntry<T = unknown>(
		customType: string,
		data: T,
		optionsOrKey?: string | DurableAppendCustomEntryOptions,
	): Promise<DurableCustomEntryRecord<T>> {
		const resolvedKey =
			typeof optionsOrKey === "string"
				? optionsOrKey
				: optionsOrKey?.sessionKey;
		const record = this.mustGetSession(resolvedKey);
		await this.getEngineForCwd(record.metadata.cwd);
		const payloadObj: Record<string, unknown> = {
			customType,
			data,
		};
		const entry = this.appendEntryInternal(
			record,
			"app.pi.custom",
			"custom",
			payloadObj,
			Date.now(),
			customType,
		);
		this.persistMetadataSync(record);
		await this.hookBridge.appendEntry(customType, data, {
			sessionKey: record.metadata.sessionKey,
		});
		return {
			id: entry.id,
			sessionKey: record.metadata.sessionKey,
			parentId: entry.parentId,
			type: "custom",
			kind: entry.kind,
			customType,
			data,
			timestamp: entry.timestamp,
		};
	}

	async compact(
		options: { summary?: string; keepRecentTokens?: number; focus?: string } = {},
		sessionKey?: string,
	): Promise<DurableCompactionResult> {
		const record = this.mustGetSession(sessionKey);
		const key = record.metadata.sessionKey;
		await this.getEngineForCwd(record.metadata.cwd);

		const hookResult = await this.hookBridge.session_before_compact({
			entryCount: record.entries.length,
			tokenCount: options.keepRecentTokens,
			instructions: options.focus,
			sessionKey: key,
		});

		if (hookResult.cancel) {
			const cancelled: DurableCompactionResult = {
				status: "cancelled",
				compacted: false,
				cancelled: true,
				summary: "",
				removedEntryCount: 0,
				keptEntryCount: record.entries.length,
			};
			return cancelled;
		}

		const summary =
			hookResult.summary ??
			options.summary ??
			`Compacted ${record.entries.length} entries (${options.focus ?? "general"})`;
		const keptCount = Math.min(record.entries.length, 4);
		const removedCount = Math.max(0, record.entries.length - keptCount);
		const keptMessages = record.messages.slice(-Math.max(1, keptCount));

		const summaryId = this.nextId("summary");
		const compEntry = this.appendEntryInternal(record, "app.pi.compaction", "compaction", {
			summary,
			removedCount,
			keptCount,
			focus: options.focus,
		});

		record.messages = [
			{
				id: summaryId,
				entryId: compEntry.id,
				role: "system",
				content: summary,
				timestamp: Date.now(),
				customType: "compaction_summary",
			},
			...keptMessages,
		];
		record.metadata.messageCount = record.messages.length;
		this.persistMetadataSync(record);

		const result: DurableCompactionResult = {
			status: "compacted",
			compacted: true,
			cancelled: false,
			summary,
			removedEntryCount: removedCount,
			keptEntryCount: keptCount,
		};
		return result;
	}

	async fork(
		targetOrOptions?: string | DurableForkSessionOptions,
		fromEntryId?: string,
		sourceSessionKey?: string,
	): Promise<DurableSessionOpenResult> {
		const targetSessionKey =
			typeof targetOrOptions === "string"
				? targetOrOptions
				: this.nextId("session-fork");
		const resolvedFromEntryId =
			typeof targetOrOptions === "string"
				? fromEntryId
				: targetOrOptions?.fromEntryId;
		const resolvedSourceKey =
			typeof targetOrOptions === "string"
				? sourceSessionKey
				: targetOrOptions?.sourceSessionKey;

		const source = this.mustGetSession(resolvedSourceKey);
		const engine = await this.getEngineForCwd(source.metadata.cwd);
		const conv = await engine.createConversation(
			source.metadata.model,
			source.metadata.thinkingLevel,
		);
		const nowIso = new Date().toISOString();
		let cutoffIndex = source.entries.length;
		if (resolvedFromEntryId) {
			const idx = source.entries.findIndex((e) => e.id === resolvedFromEntryId);
			if (idx >= 0) {
				cutoffIndex = idx + 1;
			}
		}
		const copiedEntries = source.entries.slice(0, cutoffIndex).map((e) => ({
			...e,
			sessionKey: targetSessionKey,
		}));
		const copiedMessages = reconstructMessagesFromEntries(copiedEntries);
		const leafId =
			copiedEntries.length > 0
				? copiedEntries[copiedEntries.length - 1]!.id
				: null;
		const title =
			typeof targetOrOptions === "object" && targetOrOptions?.name
				? targetOrOptions.name
				: source.metadata.title
					? `${source.metadata.title} (fork)`
					: undefined;
		const metadata: DurableSessionMetadata = {
			sessionKey: targetSessionKey,
			sessionId: targetSessionKey,
			cwd: source.metadata.cwd,
			dbPath: engine.backend.dbPath,
			origin: "durable-native",
			category: source.metadata.category,
			name: title,
			title,
			model: { ...source.metadata.model },
			thinkingLevel: source.metadata.thinkingLevel,
			createdAt: nowIso,
			updatedAt: nowIso,
			turnCount: source.metadata.turnCount,
			entryCount: copiedEntries.length,
			messageCount: copiedMessages.length,
			leafEntryId: leafId,
			parentSessionKey: source.metadata.sessionKey,
			forkFromEntryId:
				resolvedFromEntryId ?? (source.leafEntryId !== null ? source.leafEntryId : null),
			conversationId: Number(conv.id),
		};

		const forked: SessionMemoryRecord = {
			metadata,
			conversationId: Number(conv.id),
			messages: copiedMessages,
			entries: copiedEntries,
			leafEntryId: leafId,
			streaming: false,
			abortRequested: false,
			steerQueue: [],
			followUpQueue: [],
		};

		this.sessions.set(targetSessionKey, forked);
		this.sessionDbPath.set(targetSessionKey, engine.backend.dbPath);
		this.activeKey = targetSessionKey;
		this.persistMetadataSync(forked);
		engine.backend.clearEntries(targetSessionKey);
		for (const entry of copiedEntries) {
			engine.backend.appendEntryRow(targetSessionKey, entry);
		}

		return {
			...metadata,
			created: true,
			reopened: false,
			recoveredInterruptedTurn: false,
			metadata: { ...metadata },
		};
	}

	getBranchLeaf(sessionKey?: string): DurableBranchLeafInfo {
		const record = this.mustGetSession(sessionKey);
		return {
			sessionKey: record.metadata.sessionKey,
			leafEntryId: record.leafEntryId,
			entryCount: record.entries.length,
			parentSessionKey: record.metadata.parentSessionKey,
			forkFromEntryId: record.metadata.forkFromEntryId,
		};
	}

	subscribe(
		listener: DurableSessionPortListener,
		sessionKey?: string,
	): () => void {
		if (!sessionKey) {
			this.wildcardListeners.add(listener);
			return () => {
				this.wildcardListeners.delete(listener);
			};
		}
		let set = this.listeners.get(sessionKey);
		if (!set) {
			set = new Set();
			this.listeners.set(sessionKey, set);
		}
		set.add(listener);
		return () => {
			set?.delete(listener);
		};
	}

	getHookBridge(): ExtensionHookBridge {
		return this.hookBridge;
	}

	setHookBridge(bridge: ExtensionHookBridge): void {
		this.hookBridge = bridge;
		for (const engine of this.resolvedEngines.values()) {
			engine.toolExecutor.setHookBridge(bridge);
		}
	}

	async close(): Promise<void> {
		const engines = [...this.resolvedEngines.values()];
		this.resolvedEngines.clear();
		this.enginesByDbPath.clear();
		for (const engine of engines) {
			await engine.close();
		}
	}
}

export function createPiDurableSessionDriver(
	options: PiDurableSessionDriverOptions,
): PiDurableSessionDriver {
	return new PiDurableSessionDriver(options);
}




