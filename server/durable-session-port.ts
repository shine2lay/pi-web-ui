/**
 * Wave 3 thin seam: `DurableSessionPort` contract for the pi-durable SQLite engine,
 * clean-environment bootstrap, `.jsonl` migration lookup, and `agent-service.ts` cutover.
 *
 * Allows #601 (pi-durable SQLite engine driver), #602 (extension hook bridge),
 * #603 (clean-environment bootstrap + `.jsonl` migrator), and #604 (agent-service wiring)
 * to be developed and tested in parallel worktrees without file collisions.
 */

import { join } from "node:path";
import { durableDatabaseName } from "./durable-migrator.js";
import {
	createExtensionHookBridge,
	type DurableExtensionMessage,
	type ExtensionHookBridge,
	type ExtensionPersistedEntryRecord,
} from "./durable-extension-port.js";

export type DurableThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type DurableStorageMode = "durable-only" | "migrated";

export type DurableSessionOrigin = "durable-native" | "migrated-jsonl";

export interface DurableStorageModeState {
	/**
	 * `"durable-only"` when the environment boots cleanly into SQLite WAL with no `.jsonl`
	 * legacy transcripts; `"migrated"` when existing `.jsonl` transcripts were discovered/imported.
	 */
	mode: DurableStorageMode;
	/** True when starting in a fresh environment with zero `.jsonl` files. */
	cleanBoot: boolean;
	/** Directory containing durable SQLite `*.db` files. */
	dbDir: string;
	/** Optional legacy `.jsonl` session root directory (null when disabled or absent). */
	legacySessionDir: string | null;
	/** Number of legacy `.jsonl` files detected at boot. */
	legacyJsonlCount: number;
	/** Number of sessions migrated from `.jsonl` into SQLite WAL. */
	migratedSessions: number;
}

export interface DurableModelSpec {
	provider: string;
	id: string;
	thinkingLevel?: DurableThinkingLevel;
}

export interface DurableSessionSummary {
	sessionKey: string;
	sessionId: string;
	cwd: string;
	dbPath: string;
	name?: string;
	origin: DurableSessionOrigin;
	sourceSessionFile?: string | null;
	parentSessionKey?: string | null;
	forkFromEntryId?: string | null;
	model?: DurableModelSpec;
	thinkingLevel: DurableThinkingLevel;
	createdAt: string;
	updatedAt: string;
	entryCount: number;
	messageCount: number;
}

export interface DurableCreateSessionOptions {
	cwd?: string;
	sessionId?: string;
	name?: string;
	model?: DurableModelSpec;
	thinkingLevel?: DurableThinkingLevel;
	systemPrompt?: string;
	activate?: boolean;
}

export interface DurableOpenSessionTarget {
	sessionKey?: string;
	sessionId?: string;
	sessionFile?: string;
	cwd?: string;
	activate?: boolean;
}

export interface DurableListSessionsFilter {
	cwd?: string;
	origin?: DurableSessionOrigin;
	query?: string;
	limit?: number;
}

export interface DurableForkSessionOptions {
	sourceSessionKey?: string;
	fromEntryId?: string;
	newSessionId?: string;
	name?: string;
	cwd?: string;
	activate?: boolean;
}

export interface DurableSwitchModelOptions {
	sessionKey?: string;
	persist?: boolean;
}

export interface DurableSetThinkingOptions {
	sessionKey?: string;
	persist?: boolean;
}

export interface DurablePromptToolCallSimulation {
	toolCallId: string;
	toolName: string;
	input: Record<string, unknown>;
	execute?: (input: Record<string, unknown>) => Promise<{
		content: unknown[];
		details?: unknown;
		isError?: boolean;
	}>;
}

export interface DurablePromptOptions {
	sessionKey?: string;
	attachments?: readonly unknown[];
	systemPrompt?: string;
	selectedTools?: readonly string[];
	signal?: AbortSignal;
	/** Optional simulated tool calls for deterministic contract tests without model calls. */
	toolCalls?: readonly DurablePromptToolCallSimulation[];
	/** Optional deterministic assistant response text for contract tests. */
	assistantResponse?: string;
}

export type DurableSteerDisposition = "delivered" | "queued" | "handled";

export interface DurableSteerOptions {
	sessionKey?: string;
	source?: "user" | "extension";
}

export type DurableFollowUpDisposition = "queued" | "delivered" | "handled";

export interface DurableFollowUpOptions {
	sessionKey?: string;
	source?: "user" | "extension";
}

export type DurableSessionEventType =
	| "agent_start"
	| "turn_start"
	| "message_start"
	| "message_update"
	| "message_end"
	| "tool_execution_start"
	| "tool_execution_end"
	| "turn_end"
	| "agent_end"
	| "entry_appended"
	| "model_changed"
	| "thinking_level_changed"
	| "session_aborted";

export interface DurableSessionEvent {
	type: DurableSessionEventType;
	sessionKey: string;
	turnIndex?: number;
	timestamp: number;
	message?: DurableTranscriptMessage;
	entry?: DurableSessionEntry;
	toolCallId?: string;
	toolName?: string;
	toolArgs?: Record<string, unknown>;
	toolResult?: { content: unknown[]; details?: unknown; isError: boolean };
	model?: DurableModelSpec;
	thinkingLevel?: DurableThinkingLevel;
}

export type DurableSessionEventListener = (event: DurableSessionEvent) => void;

export interface DurableTranscriptMessage extends DurableExtensionMessage {
	id: string;
	entryId: string;
	role: "user" | "assistant" | "system" | "toolResult" | "custom";
	content: unknown;
	timestamp: number;
}

export type DurableSessionEntryType =
	"session_init" | "message" | "custom" | "custom_message" | "model_change" | "thinking_level_change" | "compaction";

export interface DurableSessionEntry<TData = unknown> {
	id: string;
	parentId: string | null;
	sessionKey: string;
	type: DurableSessionEntryType;
	/** Underlying durable SQLite row kind (`ai.turn`, `custom.<type>`, etc.). */
	kind: string;
	timestamp: string;
	customType?: string;
	data?: TData;
	message?: DurableTranscriptMessage;
}

export interface DurableCustomEntryRecord<T = unknown> {
	id: string;
	parentId: string | null;
	sessionKey: string;
	type: "custom";
	kind: string;
	customType: string;
	data: T;
	timestamp: string;
}

export interface DurableAppendCustomEntryOptions {
	sessionKey?: string;
	parentId?: string | null;
	timestamp?: string;
}

export interface DurableTurnResult {
	sessionKey: string;
	turnIndex: number;
	outcome: "completed" | "aborted" | "handled" | "error";
	prompt: string;
	assistantMessage?: DurableTranscriptMessage;
	toolResults: DurableTranscriptMessage[];
	appendedEntries: DurableSessionEntry[];
}

export interface DurableSessionLookupQuery {
	sessionKey?: string;
	sessionId?: string;
	sessionFile?: string;
	cwd?: string;
}

export interface DurableSessionLookupResult {
	found: boolean;
	origin: DurableSessionOrigin | "not-found";
	sessionKey: string | null;
	sessionId: string | null;
	cwd: string | null;
	dbPath: string | null;
	sourceSessionFile: string | null;
}

/**
 * Primary Wave 3 engine seam between `server/agent-service.ts` (#604) and the
 * `pi-durable` SQLite session driver (#601), extension bridge (#602), and
 * bootstrap/migrator (#603).
 */
export interface DurableSessionPort {
	readonly extensionBridge?: ExtensionHookBridge;

	// Session lifecycle
	create(options?: DurableCreateSessionOptions): Promise<DurableSessionSummary>;
	open(target: DurableOpenSessionTarget | string): Promise<DurableSessionSummary>;
	list(filter?: DurableListSessionsFilter): Promise<DurableSessionSummary[]>;
	delete(sessionKey: string): Promise<boolean>;
	fork(options: DurableForkSessionOptions): Promise<DurableSessionSummary>;
	switchModel(model: DurableModelSpec, options?: DurableSwitchModelOptions): Promise<void>;
	setThinkingLevel(level: DurableThinkingLevel, options?: DurableSetThinkingOptions): Promise<void>;

	// Turn execution
	prompt(text: string, options?: DurablePromptOptions): Promise<DurableTurnResult>;
	steer(text: string, options?: DurableSteerOptions): Promise<DurableSteerDisposition>;
	followUp(text: string, options?: DurableFollowUpOptions): Promise<DurableFollowUpDisposition>;
	abort(sessionKey?: string): Promise<void>;
	subscribe(listener: DurableSessionEventListener, sessionKey?: string): () => void;

	// Transcript & custom-entry access
	getMessages(sessionKey?: string): DurableTranscriptMessage[];
	getEntries(sessionKey?: string): DurableSessionEntry[];
	appendCustomEntry<T = unknown>(
		customType: string,
		data: T,
		options?: DurableAppendCustomEntryOptions,
	): Promise<DurableCustomEntryRecord<T>> | DurableCustomEntryRecord<T>;
	getSessionKey(): string;

	// Storage mode: clean durable-only boot vs migrated session lookup
	getStorageMode(): DurableStorageModeState;
	lookupSession(
		query: DurableSessionLookupQuery | string,
	): Promise<DurableSessionLookupResult> | DurableSessionLookupResult;
}

export interface ResolveDurableStorageModeOptions {
	dbDir: string;
	legacySessionDir?: string | null;
	legacyJsonlFiles?: readonly string[];
	migratedSessions?: number;
}

/**
 * Format a canonical durable session key `<dbName>:<sessionId>` matching `DurableSessionDriver`.
 */
export function formatDurableSessionKey(cwd: string, sessionId: string): string {
	return `${durableDatabaseName(cwd)}:${sessionId}`;
}

/**
 * Parse a `<dbName>:<sessionId>` durable session key.
 */
export function parseDurableSessionKey(sessionKey: string): { dbName: string; sessionId: string } {
	const idx = sessionKey.indexOf(":");
	if (idx <= 0 || idx === sessionKey.length - 1) {
		throw new Error(`Invalid durable session key: ${sessionKey}`);
	}
	return {
		dbName: sessionKey.slice(0, idx),
		sessionId: sessionKey.slice(idx + 1),
	};
}

/**
 * Determine whether the durable runtime booted cleanly in durable-only mode
 * (zero `.jsonl` files) or in migrated mode with imported `.jsonl` transcripts.
 */
export function resolveDurableStorageMode(options: ResolveDurableStorageModeOptions): DurableStorageModeState {
	const legacyJsonlCount = options.legacyJsonlFiles?.length ?? 0;
	const migratedSessions = options.migratedSessions ?? 0;
	const cleanBoot = legacyJsonlCount === 0 && migratedSessions === 0;
	return {
		mode: cleanBoot ? "durable-only" : "migrated",
		cleanBoot,
		dbDir: options.dbDir,
		legacySessionDir: options.legacySessionDir ?? null,
		legacyJsonlCount,
		migratedSessions,
	};
}

export interface MigratedSeedEntry<TData = unknown> {
	id: string;
	parentId: string | null;
	type: DurableSessionEntryType;
	kind: string;
	timestamp: string;
	customType?: string;
	data?: TData;
	message?: DurableTranscriptMessage;
}

export interface MigratedSeedMessage {
	id: string;
	role: DurableTranscriptMessage["role"];
	content: unknown;
	timestamp: number;
	customType?: string;
	display?: boolean;
	details?: unknown;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

export interface MigratedSessionSeed {
	sessionId: string;
	cwd: string;
	sourceSessionFile: string;
	name?: string;
	model?: DurableModelSpec;
	thinkingLevel?: DurableThinkingLevel;
	entries?: readonly MigratedSeedEntry[];
	messages?: readonly MigratedSeedMessage[];
}

export interface InMemoryDurableSessionPortOptions {
	defaultCwd?: string;
	dbDir?: string;
	legacySessionDir?: string | null;
	migratedSeeds?: readonly MigratedSessionSeed[];
	extensionBridge?: ExtensionHookBridge;
}

interface InternalSessionRecord {
	summary: DurableSessionSummary;
	entries: DurableSessionEntry[];
	messages: DurableTranscriptMessage[];
	turnCount: number;
	aborted: boolean;
	steers: string[];
	followUps: string[];
}

/**
 * Reference in-memory implementation of `DurableSessionPort` for contract verification,
 * fresh-environment boot tests (no `.jsonl` files), and migrated-session resume tests.
 */
export function createInMemoryDurableSessionPort(options: InMemoryDurableSessionPortOptions = {}): DurableSessionPort {
	const defaultCwd = options.defaultCwd ?? "/workspace/default";
	const dbDir = options.dbDir ?? "/workspace/.pi-durable";
	const seeds = options.migratedSeeds ?? [];
	const storageMode = resolveDurableStorageMode({
		dbDir,
		legacySessionDir: options.legacySessionDir ?? (seeds.length > 0 ? "/workspace/.pi/sessions" : null),
		legacyJsonlFiles: seeds.map((seed) => seed.sourceSessionFile),
		migratedSessions: seeds.length,
	});

	const sessions = new Map<string, InternalSessionRecord>();
	const bySessionFile = new Map<string, string>();
	const listeners = new Map<string, Set<DurableSessionEventListener>>();
	const wildcardListeners = new Set<DurableSessionEventListener>();

	let activeSessionKey = "";
	let idCounter = 0;

	const nextId = (prefix: string): string => {
		idCounter += 1;
		return `${prefix}-${idCounter}`;
	};

	const emit = (event: DurableSessionEvent): void => {
		for (const listener of wildcardListeners) {
			listener(event);
		}
		const scoped = listeners.get(event.sessionKey);
		if (scoped) {
			for (const listener of scoped) {
				listener(event);
			}
		}
	};

	const appendEntryInternal = <T = unknown>(
		record: InternalSessionRecord,
		entryInput: {
			type: DurableSessionEntryType;
			kind: string;
			customType?: string;
			data?: T;
			message?: DurableTranscriptMessage;
			parentId?: string | null;
			timestamp?: string;
		},
	): DurableSessionEntry<T> => {
		const parentId = entryInput.parentId !== undefined ? entryInput.parentId : (record.entries.at(-1)?.id ?? null);
		const timestamp = entryInput.timestamp ?? new Date().toISOString();
		const entry: DurableSessionEntry<T> = {
			id: nextId("entry"),
			parentId,
			sessionKey: record.summary.sessionKey,
			type: entryInput.type,
			kind: entryInput.kind,
			timestamp,
			...(entryInput.customType !== undefined ? { customType: entryInput.customType } : {}),
			...(entryInput.data !== undefined ? { data: structuredClone(entryInput.data) } : {}),
			...(entryInput.message !== undefined ? { message: entryInput.message } : {}),
		};
		record.entries.push(entry);
		record.summary.entryCount = record.entries.length;
		record.summary.updatedAt = timestamp;
		return entry;
	};

	const bridge =
		options.extensionBridge ??
		createExtensionHookBridge({
			defaultSessionKey: "unbound:session",
			entryStore: {
				appendEntry<T = unknown>(
					customType: string,
					data: T,
					entryOptions?: { sessionKey?: string; parentId?: string | null; timestamp?: string },
				): ExtensionPersistedEntryRecord<T> {
					const targetKey = entryOptions?.sessionKey ?? activeSessionKey;
					const target = sessions.get(targetKey);
					if (!target) {
						throw new Error(`Cannot appendEntry for unknown durable session: ${targetKey}`);
					}
					const entry = appendEntryInternal(target, {
						type: "custom",
						kind: `custom.${customType}`,
						customType,
						data,
						parentId: entryOptions?.parentId,
						timestamp: entryOptions?.timestamp,
					});
					emit({
						type: "entry_appended",
						sessionKey: targetKey,
						timestamp: Date.now(),
						entry,
					});
					return {
						id: entry.id,
						parentId: entry.parentId,
						sessionKey: targetKey,
						kind: entry.kind,
						customType,
						data: entry.data as T,
						timestamp: entry.timestamp,
					};
				},
				getEntries(sessionKey?: string): readonly ExtensionPersistedEntryRecord[] {
					const targetRecords = sessionKey
						? [sessions.get(sessionKey)].filter((item): item is InternalSessionRecord => Boolean(item))
						: [...sessions.values()];
					const out: ExtensionPersistedEntryRecord[] = [];
					for (const rec of targetRecords) {
						for (const entry of rec.entries) {
							if (entry.type === "custom" && entry.customType) {
								out.push({
									id: entry.id,
									parentId: entry.parentId,
									sessionKey: rec.summary.sessionKey,
									kind: entry.kind,
									customType: entry.customType,
									data: entry.data,
									timestamp: entry.timestamp,
								});
							}
						}
					}
					return out;
				},
			},
		});

	// Hydrate any migrated `.jsonl` seeds into the in-memory SQLite state.
	for (const seed of seeds) {
		const sessionKey = formatDurableSessionKey(seed.cwd, seed.sessionId);
		const dbPath = join(dbDir, durableDatabaseName(seed.cwd));
		const nowIso = new Date().toISOString();
		const summary: DurableSessionSummary = {
			sessionKey,
			sessionId: seed.sessionId,
			cwd: seed.cwd,
			dbPath,
			name: seed.name,
			origin: "migrated-jsonl",
			sourceSessionFile: seed.sourceSessionFile,
			parentSessionKey: null,
			forkFromEntryId: null,
			model: seed.model,
			thinkingLevel: seed.thinkingLevel ?? "off",
			createdAt: nowIso,
			updatedAt: nowIso,
			entryCount: 0,
			messageCount: 0,
		};
		const record: InternalSessionRecord = {
			summary,
			entries: [],
			messages: [],
			turnCount: 0,
			aborted: false,
			steers: [],
			followUps: [],
		};
		for (const rawEntry of seed.entries ?? []) {
			record.entries.push({
				...rawEntry,
				sessionKey,
			});
		}
		for (const rawMsg of seed.messages ?? []) {
			const entry = appendEntryInternal(record, {
				type: "message",
				kind: "ai.turn",
			});
			const msg: DurableTranscriptMessage = {
				...rawMsg,
				entryId: entry.id,
			};
			entry.message = msg;
			record.messages.push(msg);
		}
		summary.entryCount = record.entries.length;
		summary.messageCount = record.messages.length;
		sessions.set(sessionKey, record);
		bySessionFile.set(seed.sourceSessionFile, sessionKey);
		if (!activeSessionKey) activeSessionKey = sessionKey;
	}

	const requireSession = (sessionKey?: string): InternalSessionRecord => {
		const key = sessionKey ?? activeSessionKey;
		const found = sessions.get(key);
		if (!found) {
			throw new Error(`Durable session not found: ${key || "<empty>"}`);
		}
		return found;
	};

	const port: DurableSessionPort = {
		extensionBridge: bridge,

		async create(createOptions: DurableCreateSessionOptions = {}): Promise<DurableSessionSummary> {
			const cwd = createOptions.cwd ?? defaultCwd;
			const sessionId = createOptions.sessionId ?? nextId("session");
			const sessionKey = formatDurableSessionKey(cwd, sessionId);
			const dbPath = join(dbDir, durableDatabaseName(cwd));
			const nowIso = new Date().toISOString();
			const summary: DurableSessionSummary = {
				sessionKey,
				sessionId,
				cwd,
				dbPath,
				name: createOptions.name,
				origin: "durable-native",
				sourceSessionFile: null,
				parentSessionKey: null,
				forkFromEntryId: null,
				model: createOptions.model,
				thinkingLevel: createOptions.thinkingLevel ?? createOptions.model?.thinkingLevel ?? "off",
				createdAt: nowIso,
				updatedAt: nowIso,
				entryCount: 0,
				messageCount: 0,
			};
			const record: InternalSessionRecord = {
				summary,
				entries: [],
				messages: [],
				turnCount: 0,
				aborted: false,
				steers: [],
				followUps: [],
			};
			appendEntryInternal(record, {
				type: "session_init",
				kind: "ai.session_init",
				data: {
					cwd,
					systemPrompt: createOptions.systemPrompt ?? "",
					model: createOptions.model ?? null,
					thinkingLevel: summary.thinkingLevel,
				},
			});
			sessions.set(sessionKey, record);
			if (createOptions.activate !== false || !activeSessionKey) {
				activeSessionKey = sessionKey;
			}
			return { ...record.summary };
		},

		async open(target: DurableOpenSessionTarget | string): Promise<DurableSessionSummary> {
			const lookup = await port.lookupSession(
				typeof target === "string" ? { sessionKey: target, sessionId: target, sessionFile: target } : target,
			);
			if (!lookup.found || !lookup.sessionKey) {
				throw new Error(
					`Unable to open durable session: ${typeof target === "string" ? target : JSON.stringify(target)}`,
				);
			}
			const record = requireSession(lookup.sessionKey);
			if (typeof target === "string" || target.activate !== false) {
				activeSessionKey = record.summary.sessionKey;
			}
			return { ...record.summary };
		},

		async list(filter: DurableListSessionsFilter = {}): Promise<DurableSessionSummary[]> {
			let items = [...sessions.values()].map((rec) => ({ ...rec.summary }));
			if (filter.cwd) {
				items = items.filter((item) => item.cwd === filter.cwd);
			}
			if (filter.origin) {
				items = items.filter((item) => item.origin === filter.origin);
			}
			if (filter.query) {
				const q = filter.query.toLowerCase();
				items = items.filter(
					(item) =>
						item.sessionKey.toLowerCase().includes(q) ||
						item.sessionId.toLowerCase().includes(q) ||
						(item.name?.toLowerCase().includes(q) ?? false),
				);
			}
			if (filter.limit !== undefined && filter.limit >= 0) {
				items = items.slice(0, filter.limit);
			}
			return items;
		},

		async delete(sessionKey: string): Promise<boolean> {
			const record = sessions.get(sessionKey);
			if (!record) return false;
			if (record.summary.sourceSessionFile) {
				bySessionFile.delete(record.summary.sourceSessionFile);
			}
			sessions.delete(sessionKey);
			listeners.delete(sessionKey);
			if (activeSessionKey === sessionKey) {
				activeSessionKey = sessions.keys().next().value ?? "";
			}
			return true;
		},

		async fork(forkOptions: DurableForkSessionOptions): Promise<DurableSessionSummary> {
			const source = requireSession(forkOptions.sourceSessionKey);
			const cwd = forkOptions.cwd ?? source.summary.cwd;
			const newSessionId = forkOptions.newSessionId ?? nextId("fork");
			const sessionKey = formatDurableSessionKey(cwd, newSessionId);
			const dbPath = join(dbDir, durableDatabaseName(cwd));
			const nowIso = new Date().toISOString();

			let cutoffIndex = source.entries.length;
			if (forkOptions.fromEntryId) {
				const foundIdx = source.entries.findIndex((entry) => entry.id === forkOptions.fromEntryId);
				if (foundIdx < 0) {
					throw new Error(`Fork entry not found in source session: ${forkOptions.fromEntryId}`);
				}
				cutoffIndex = foundIdx + 1;
			}

			const copiedEntries = source.entries.slice(0, cutoffIndex).map((entry) => ({
				...structuredClone(entry),
				sessionKey,
			}));
			const allowedEntryIds = new Set(copiedEntries.map((entry) => entry.id));
			const copiedMessages = source.messages
				.filter((msg) => allowedEntryIds.has(msg.entryId))
				.map((msg) => structuredClone(msg));

			const summary: DurableSessionSummary = {
				sessionKey,
				sessionId: newSessionId,
				cwd,
				dbPath,
				name: forkOptions.name ?? source.summary.name,
				origin: "durable-native",
				sourceSessionFile: null,
				parentSessionKey: source.summary.sessionKey,
				forkFromEntryId: forkOptions.fromEntryId ?? source.entries.at(-1)?.id ?? null,
				model: source.summary.model ? { ...source.summary.model } : undefined,
				thinkingLevel: source.summary.thinkingLevel,
				createdAt: nowIso,
				updatedAt: nowIso,
				entryCount: copiedEntries.length,
				messageCount: copiedMessages.length,
			};

			const forkedRecord: InternalSessionRecord = {
				summary,
				entries: copiedEntries,
				messages: copiedMessages,
				turnCount: source.turnCount,
				aborted: false,
				steers: [],
				followUps: [],
			};
			sessions.set(sessionKey, forkedRecord);
			if (forkOptions.activate !== false) {
				activeSessionKey = sessionKey;
			}
			return { ...forkedRecord.summary };
		},

		async switchModel(model: DurableModelSpec, switchOptions: DurableSwitchModelOptions = {}): Promise<void> {
			const record = requireSession(switchOptions.sessionKey);
			record.summary.model = { ...model };
			if (model.thinkingLevel) {
				record.summary.thinkingLevel = model.thinkingLevel;
			}
			if (switchOptions.persist !== false) {
				appendEntryInternal(record, {
					type: "model_change",
					kind: "ai.model_change",
					data: { provider: model.provider, id: model.id },
				});
			}
			emit({
				type: "model_changed",
				sessionKey: record.summary.sessionKey,
				timestamp: Date.now(),
				model: { ...model },
			});
		},

		async setThinkingLevel(
			level: DurableThinkingLevel,
			thinkingOptions: DurableSetThinkingOptions = {},
		): Promise<void> {
			const record = requireSession(thinkingOptions.sessionKey);
			record.summary.thinkingLevel = level;
			if (record.summary.model) {
				record.summary.model = { ...record.summary.model, thinkingLevel: level };
			}
			if (thinkingOptions.persist !== false) {
				appendEntryInternal(record, {
					type: "thinking_level_change",
					kind: "ai.thinking_level_change",
					data: { thinkingLevel: level },
				});
			}
			emit({
				type: "thinking_level_changed",
				sessionKey: record.summary.sessionKey,
				timestamp: Date.now(),
				thinkingLevel: level,
			});
		},

		async prompt(text: string, promptOptions: DurablePromptOptions = {}): Promise<DurableTurnResult> {
			const record = requireSession(promptOptions.sessionKey);
			const sessionKey = record.summary.sessionKey;
			record.aborted = false;
			const beforeEntryCount = record.entries.length;

			const beforeStart = await bridge.before_agent_start({
				prompt: text,
				systemPrompt: promptOptions.systemPrompt,
				selectedTools: promptOptions.selectedTools,
				sessionKey,
			});

			for (const customDraft of beforeStart.customMessages ?? []) {
				const customMsgId = nextId("msg");
				const customEntry = appendEntryInternal(record, {
					type: "custom_message",
					kind: "app.pi.extension_message",
					customType: customDraft.customType,
					data: customDraft,
				});
				const transcriptCustom: DurableTranscriptMessage = {
					id: customMsgId,
					entryId: customEntry.id,
					role: "custom",
					customType: customDraft.customType,
					content: customDraft.content,
					display: customDraft.display,
					details: customDraft.details,
					timestamp: Date.now(),
				};
				customEntry.message = transcriptCustom;
				record.messages.push(transcriptCustom);
				record.summary.messageCount = record.messages.length;
			}

			if (beforeStart.handled) {
				return {
					sessionKey,
					turnIndex: record.turnCount,
					outcome: "handled",
					prompt: beforeStart.prompt ?? text,
					toolResults: [],
					appendedEntries: record.entries.slice(beforeEntryCount),
				};
			}

			const effectivePrompt = beforeStart.prompt ?? text;
			const turnIndex = record.turnCount;
			record.turnCount += 1;

			emit({
				type: "agent_start",
				sessionKey,
				turnIndex,
				timestamp: Date.now(),
			});

			await bridge.turn_start({
				turnIndex,
				timestamp: Date.now(),
				sessionKey,
			});
			emit({
				type: "turn_start",
				sessionKey,
				turnIndex,
				timestamp: Date.now(),
			});

			const userEntry = appendEntryInternal(record, {
				type: "message",
				kind: "ai.turn",
			});
			const userMessage: DurableTranscriptMessage = {
				id: nextId("msg"),
				entryId: userEntry.id,
				role: "user",
				content: effectivePrompt,
				timestamp: Date.now(),
			};
			userEntry.message = userMessage;
			record.messages.push(userMessage);
			record.summary.messageCount = record.messages.length;
			emit({
				type: "message_end",
				sessionKey,
				turnIndex,
				timestamp: Date.now(),
				message: userMessage,
				entry: userEntry,
			});

			// Run context / transformContext hook before generating / running tools.
			await bridge.transformContext(record.messages, sessionKey);

			const toolResults: DurableTranscriptMessage[] = [];
			for (const simTool of promptOptions.toolCalls ?? []) {
				const callDecision = await bridge.tool_call({
					toolCallId: simTool.toolCallId,
					toolName: simTool.toolName,
					input: simTool.input,
					sessionKey,
				});
				const effectiveArgs = callDecision.input ?? simTool.input;
				emit({
					type: "tool_execution_start",
					sessionKey,
					turnIndex,
					timestamp: Date.now(),
					toolCallId: simTool.toolCallId,
					toolName: simTool.toolName,
					toolArgs: effectiveArgs,
				});

				let rawResult: { content: unknown[]; details?: unknown; isError: boolean };
				if (callDecision.block) {
					rawResult = {
						content: [{ type: "text", text: callDecision.reason ?? "Blocked" }],
						isError: true,
					};
				} else if (simTool.execute) {
					const execOut = await simTool.execute(effectiveArgs);
					rawResult = {
						content: execOut.content,
						details: execOut.details,
						isError: Boolean(execOut.isError),
					};
				} else {
					rawResult = {
						content: [{ type: "text", text: `ok:${simTool.toolName}` }],
						isError: false,
					};
				}

				const patched = await bridge.tool_result({
					toolCallId: simTool.toolCallId,
					toolName: simTool.toolName,
					input: effectiveArgs,
					content: rawResult.content,
					details: rawResult.details,
					isError: rawResult.isError,
					sessionKey,
				});

				const finalResult = {
					content: patched.content ?? rawResult.content,
					details: patched.details !== undefined ? patched.details : rawResult.details,
					isError: patched.isError ?? rawResult.isError,
				};

				const toolEntry = appendEntryInternal(record, {
					type: "message",
					kind: "ai.tool_call",
					data: finalResult.details,
				});
				const toolMsg: DurableTranscriptMessage = {
					id: nextId("msg"),
					entryId: toolEntry.id,
					role: "toolResult",
					toolCallId: simTool.toolCallId,
					toolName: simTool.toolName,
					content: finalResult.content,
					details: finalResult.details,
					isError: finalResult.isError,
					timestamp: Date.now(),
				};
				toolEntry.message = toolMsg;
				record.messages.push(toolMsg);
				record.summary.messageCount = record.messages.length;
				toolResults.push(toolMsg);

				emit({
					type: "tool_execution_end",
					sessionKey,
					turnIndex,
					timestamp: Date.now(),
					toolCallId: simTool.toolCallId,
					toolName: simTool.toolName,
					toolResult: finalResult,
					message: toolMsg,
					entry: toolEntry,
				});
			}

			if (promptOptions.signal?.aborted || record.aborted) {
				await bridge.turn_end({
					turnIndex,
					toolResults,
					outcome: "aborted",
					sessionKey,
				});
				emit({
					type: "turn_end",
					sessionKey,
					turnIndex,
					timestamp: Date.now(),
				});
				return {
					sessionKey,
					turnIndex,
					outcome: "aborted",
					prompt: effectivePrompt,
					toolResults,
					appendedEntries: record.entries.slice(beforeEntryCount),
				};
			}

			const assistantEntry = appendEntryInternal(record, {
				type: "message",
				kind: "ai.turn",
			});
			const assistantMessage: DurableTranscriptMessage = {
				id: nextId("msg"),
				entryId: assistantEntry.id,
				role: "assistant",
				content: promptOptions.assistantResponse ?? `ack:${effectivePrompt}`,
				timestamp: Date.now(),
			};
			assistantEntry.message = assistantMessage;
			record.messages.push(assistantMessage);
			record.summary.messageCount = record.messages.length;

			emit({
				type: "message_end",
				sessionKey,
				turnIndex,
				timestamp: Date.now(),
				message: assistantMessage,
				entry: assistantEntry,
			});

			await bridge.turn_end({
				turnIndex,
				message: assistantMessage,
				toolResults,
				outcome: "completed",
				sessionKey,
			});

			emit({
				type: "turn_end",
				sessionKey,
				turnIndex,
				timestamp: Date.now(),
				message: assistantMessage,
			});
			emit({
				type: "agent_end",
				sessionKey,
				turnIndex,
				timestamp: Date.now(),
				message: assistantMessage,
			});

			return {
				sessionKey,
				turnIndex,
				outcome: "completed",
				prompt: effectivePrompt,
				assistantMessage,
				toolResults,
				appendedEntries: record.entries.slice(beforeEntryCount),
			};
		},

		async steer(text: string, steerOptions: DurableSteerOptions = {}): Promise<DurableSteerDisposition> {
			const record = requireSession(steerOptions.sessionKey);
			record.steers.push(text);
			appendEntryInternal(record, {
				type: "custom_message",
				kind: "ai.steer",
				data: { text, source: steerOptions.source ?? "user" },
			});
			return "delivered";
		},

		async followUp(text: string, followUpOptions: DurableFollowUpOptions = {}): Promise<DurableFollowUpDisposition> {
			const record = requireSession(followUpOptions.sessionKey);
			record.followUps.push(text);
			appendEntryInternal(record, {
				type: "custom_message",
				kind: "ai.follow_up",
				data: { text, source: followUpOptions.source ?? "user" },
			});
			return "queued";
		},

		async abort(sessionKey?: string): Promise<void> {
			const record = requireSession(sessionKey);
			record.aborted = true;
			emit({
				type: "session_aborted",
				sessionKey: record.summary.sessionKey,
				timestamp: Date.now(),
			});
		},

		subscribe(listener: DurableSessionEventListener, sessionKey?: string): () => void {
			if (!sessionKey) {
				wildcardListeners.add(listener);
				return () => {
					wildcardListeners.delete(listener);
				};
			}
			let set = listeners.get(sessionKey);
			if (!set) {
				set = new Set();
				listeners.set(sessionKey, set);
			}
			set.add(listener);
			return () => {
				set?.delete(listener);
			};
		},

		getMessages(sessionKey?: string): DurableTranscriptMessage[] {
			const record = requireSession(sessionKey);
			return record.messages.map((msg) => structuredClone(msg));
		},

		getEntries(sessionKey?: string): DurableSessionEntry[] {
			const record = requireSession(sessionKey);
			return record.entries.map((entry) => structuredClone(entry));
		},

		async appendCustomEntry<T = unknown>(
			customType: string,
			data: T,
			entryOptions: DurableAppendCustomEntryOptions = {},
		): Promise<DurableCustomEntryRecord<T>> {
			const record = requireSession(entryOptions.sessionKey);
			const persisted = await bridge.appendEntry(customType, data, {
				sessionKey: record.summary.sessionKey,
				parentId: entryOptions.parentId,
				timestamp: entryOptions.timestamp,
			});
			return {
				id: persisted.id,
				parentId: persisted.parentId,
				sessionKey: persisted.sessionKey,
				type: "custom",
				kind: persisted.kind,
				customType: persisted.customType,
				data: persisted.data,
				timestamp: persisted.timestamp,
			};
		},

		getSessionKey(): string {
			return activeSessionKey;
		},

		getStorageMode(): DurableStorageModeState {
			return { ...storageMode };
		},

		lookupSession(queryInput: DurableSessionLookupQuery | string): DurableSessionLookupResult {
			const query: DurableSessionLookupQuery =
				typeof queryInput === "string"
					? { sessionKey: queryInput, sessionId: queryInput, sessionFile: queryInput }
					: queryInput;

			if (query.sessionKey && sessions.has(query.sessionKey)) {
				const found = sessions.get(query.sessionKey)!;
				return {
					found: true,
					origin: found.summary.origin,
					sessionKey: found.summary.sessionKey,
					sessionId: found.summary.sessionId,
					cwd: found.summary.cwd,
					dbPath: found.summary.dbPath,
					sourceSessionFile: found.summary.sourceSessionFile ?? null,
				};
			}

			if (query.sessionFile && bySessionFile.has(query.sessionFile)) {
				const mappedKey = bySessionFile.get(query.sessionFile)!;
				const found = sessions.get(mappedKey)!;
				return {
					found: true,
					origin: found.summary.origin,
					sessionKey: found.summary.sessionKey,
					sessionId: found.summary.sessionId,
					cwd: found.summary.cwd,
					dbPath: found.summary.dbPath,
					sourceSessionFile: found.summary.sourceSessionFile ?? null,
				};
			}

			if (query.sessionId) {
				if (query.cwd) {
					const candidateKey = formatDurableSessionKey(query.cwd, query.sessionId);
					const direct = sessions.get(candidateKey);
					if (direct) {
						return {
							found: true,
							origin: direct.summary.origin,
							sessionKey: direct.summary.sessionKey,
							sessionId: direct.summary.sessionId,
							cwd: direct.summary.cwd,
							dbPath: direct.summary.dbPath,
							sourceSessionFile: direct.summary.sourceSessionFile ?? null,
						};
					}
				}
				for (const rec of sessions.values()) {
					if (rec.summary.sessionId === query.sessionId) {
						return {
							found: true,
							origin: rec.summary.origin,
							sessionKey: rec.summary.sessionKey,
							sessionId: rec.summary.sessionId,
							cwd: rec.summary.cwd,
							dbPath: rec.summary.dbPath,
							sourceSessionFile: rec.summary.sourceSessionFile ?? null,
						};
					}
				}
			}

			return {
				found: false,
				origin: "not-found",
				sessionKey: null,
				sessionId: null,
				cwd: null,
				dbPath: null,
				sourceSessionFile: null,
			};
		},
	};

	return port;
}
