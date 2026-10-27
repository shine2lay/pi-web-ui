/**
 * Wave 3.2: Extension hook and custom-entry bridge for the `pi-durable` SQLite engine.
 *
 * Implements `ExtensionHookBridge` from `./durable-extension-port.js` so Pi extensions
 * (`pi-identity`, `pi-queue`, `pi-worktree`, `pi-multi-pass`, `pi-tldr`, and
 * `@earendil-works/pi-context` ACP) run their lifecycle hooks and persist/replay
 * custom entries (`queue`, `identity`, `tldr`, `todo`, `acp`, `multi-pass`)
 * natively inside `pi-durable` SQLite sessions with zero `.jsonl` files.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	createExtensionRuntime,
	ExtensionRunner,
	type Extension,
	type ExtensionFactory,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	createExtensionHookBridge,
	createInMemorySqliteEntryStore,
	type BeforeAgentStartHookHandler,
	type BeforeAgentStartHookResult,
	type ContextHookEvent,
	type ContextHookHandler,
	type ContextHookResult,
	type DurableExtensionMessage,
	type ExtensionAppendEntryOptions,
	type ExtensionCustomMessageDraft,
	type ExtensionHookBridge,
	type ExtensionHookHandlerMap,
	type ExtensionHookName,
	type ExtensionPersistedEntryRecord,
	type ExtensionSqliteEntryStore,
	type SessionBeforeCompactHookEvent,
	type SessionBeforeCompactHookHandler,
	type ToolCallHookDecision,
	type ToolCallHookEvent,
	type ToolCallHookHandler,
	type ToolResultHookEvent,
	type ToolResultHookHandler,
	type ToolResultHookPatch,
	type TurnEndHookEvent,
	type TurnEndHookHandler,
	type TurnEndHookResult,
	type TurnStartHookHandler,
} from "./durable-extension-port.js";
import {
	formatDurableSessionKey,
	parseDurableSessionKey,
	type DurableSessionEntry,
	type DurableSessionPort,
} from "./durable-session-port.js";

export * from "./durable-extension-port.js";

export const NOTEBOOK_REMINDER_TEXT =
	"Notebook: if this task turned up a finding, lesson, decision + reason, or incident + fix worth keeping, record it with the notebook tool before finishing.";

const NOTEBOOK_WRITE_ACTIONS = new Set([
	"record",
	"edit",
	"add",
	"update",
	"remove",
	"outdated",
	"delete",
	"distill",
	"move",
]);

const MUTATING_BASH_RE =
	/\b(git\s+(commit|add|rm|mv|reset|checkout\s+-[bB]|merge|rebase|cherry-pick|stash\s+(pop|apply|drop))|rm\s+|mv\s+|cp\s+|touch\s+|mkdir\s+|tee\s+|sed\s+-i|npm\s+(install|i|ci|uninstall|update)|pnpm\s+(add|install|remove)|yarn\s+add)\b|(?:^|[^<])>{1,2}\s*\S/;

export interface IdentityCustomEntryData {
	name: string | null;
	setAt: number;
	rulesSummary?: string;
}

export type QueueTaskStatus = "waiting" | "in_progress" | "done" | "stuck" | "waiting_check" | "blocked" | "dropped";

export interface QueueTaskItem {
	id: number;
	text: string;
	status: QueueTaskStatus;
	createdAt: number;
	startedAt?: number;
	completedAt?: number;
	summary?: string;
	after?: number[];
	touches?: string[];
	paused?: { at: number; why: string };
	question?: string;
	choices?: string[];
	why?: string;
}

export interface QueueCustomEntryData {
	version: 2;
	autoRun: boolean;
	lanes?: number;
	paused?: { at: number; why: string };
	nextId: number;
	items: QueueTaskItem[];
}

export interface TldrCustomEntryData {
	messageId: string;
	summary: string;
	bullets?: string[];
	createdAt: number;
}

export interface TodoCustomEntryData {
	id: number;
	subject: string;
	status: "pending" | "in_progress" | "completed" | "deleted";
	blocks?: number[];
	updatedAt: number;
}

export interface AcpCompressedBlockData {
	blockId: string;
	startId: string;
	endId: string;
	topic?: string;
	summary: string;
	tier?: 1 | 2 | 3;
	createdAt: number;
}

export interface MultiPassAccountEntry {
	id: string;
	provider: string;
	apiKey?: string;
	cooldownUntil?: number;
	exhausted?: boolean;
	failoverCount?: number;
}

export interface MultiPassCustomEntryData {
	provider: string;
	previousAccountId: string | null;
	selectedAccountId: string;
	reason: string;
	timestamp: number;
}

/**
 * Pi `SessionManager`-compatible view over durable SQLite entries.
 * Exposes `getEntries()`, `getBranch()`, `appendCustomEntry()`, `getSessionFile()`,
 * and `getSessionId()` without touching any `.jsonl` file on disk.
 */
export interface DurableSessionManagerView {
	getCwd(): string;
	getSessionDir(): string;
	getSessionId(): string;
	getSessionKey(): string;
	/** Always returns `undefined` in clean durable-only mode (zero `.jsonl` files). */
	getSessionFile(): string | undefined;
	getLeafId(): string | null;
	getLeafEntry(): SessionEntry | undefined;
	getEntry(id: string): SessionEntry | undefined;
	getEntries(): SessionEntry[];
	getBranch(fromId?: string): SessionEntry[];
	appendCustomEntry<T = unknown>(customType: string, data?: T): string;
	getCustomEntries<T = unknown>(customType?: string): ExtensionPersistedEntryRecord<T>[];
}

export interface DurableIdentityHookConfig {
	enabled?: boolean;
	identitiesDir?: string;
	initialRole?: string | null;
}

export interface DurableQueueHookConfig {
	enabled?: boolean;
	/** Automatically inject the next ready `waiting` task on `before_agent_start` when requested. */
	handoffOnBeforeAgentStart?: boolean;
	/** Automatically advance to the next eligible `waiting` task on `turn_end`. */
	dispatchNextOnTurnEnd?: boolean;
	onTaskDispatched?: (task: QueueTaskItem, sessionKey: string) => void | Promise<void>;
}

export interface DurableWorktreeHookConfig {
	enabled?: boolean;
	identitiesDir?: string;
	/** Map of role name -> allowed folder paths (overrides parsing `about.md` when provided). */
	roleAllowedFolders?: Record<string, readonly string[]>;
	/** Additional main checkout roots protected by the worktree guard even without `.wt/wt.yaml`. */
	protectedMainCheckouts?: readonly string[];
}

export interface DurableMultiPassHookConfig {
	enabled?: boolean;
	accounts?: readonly MultiPassAccountEntry[];
	cooldownMs?: number;
	/** Custom predicate for detecting failover/continuation triggers on `turn_end`. */
	shouldFailover?: (event: TurnEndHookEvent) => { failover: boolean; reason?: string; provider?: string };
}

export interface DurableAcpHookConfig {
	enabled?: boolean;
	/** Inject `<acp>` message ref tags when missing on context messages. */
	injectMessageRefs?: boolean;
}

export interface SqliteWalEntryStore extends ExtensionSqliteEntryStore {
	readonly dbPath: string;
	close(): void;
}

export interface DurableExtensionBridgeOptions {
	defaultSessionKey?: string;
	cwd?: string;
	dbDir?: string;
	dbPath?: string;
	sourceSessionFile?: string;
	entryStore?: ExtensionSqliteEntryStore;
	sessionPort?: DurableSessionPort;
	/** Optional Pi `ExtensionRunner` or inline `ExtensionFactory` modules to bind. */
	extensionRunner?: ExtensionRunner;
	extensionFactories?: readonly ExtensionFactory[];
	extensions?: readonly Extension[];
	identity?: DurableIdentityHookConfig;
	queue?: DurableQueueHookConfig;
	worktree?: DurableWorktreeHookConfig;
	multiPass?: DurableMultiPassHookConfig;
	acp?: DurableAcpHookConfig;
}

export interface DurableExtensionBridge extends ExtensionHookBridge {
	readonly sessionManager: DurableSessionManagerView;
	getSessionManager(sessionKey?: string): DurableSessionManagerView;
	bindExtensionFactories(factories: readonly ExtensionFactory[]): Promise<ExtensionRunner>;
	getExtensionRunner(): ExtensionRunner | undefined;

	// High-level custom-entry helpers (backed by SQLite `appendEntry` + replay)
	setIdentity(
		roleName: string | null,
		options?: { sessionKey?: string; rulesSummary?: string },
	): Promise<ExtensionPersistedEntryRecord<IdentityCustomEntryData>>;
	getActiveIdentity(sessionKey?: string): IdentityCustomEntryData | null;
	markExternalRulesChanged(roleName?: string, sessionKey?: string): void;

	getQueueState(sessionKey?: string): QueueCustomEntryData;
	setQueueState(
		state: QueueCustomEntryData,
		sessionKey?: string,
	): Promise<ExtensionPersistedEntryRecord<QueueCustomEntryData>>;
	enqueueTask(
		task: { text: string; after?: number[]; touches?: string[]; paused?: { at: number; why: string } },
		sessionKey?: string,
	): Promise<{ task: QueueTaskItem; entry: ExtensionPersistedEntryRecord<QueueCustomEntryData> }>;
	completeTask(
		taskId: number,
		summary: string,
		sessionKey?: string,
	): Promise<ExtensionPersistedEntryRecord<QueueCustomEntryData>>;

	appendTldrEntry(
		entry: Omit<TldrCustomEntryData, "createdAt"> & { createdAt?: number },
		sessionKey?: string,
	): Promise<ExtensionPersistedEntryRecord<TldrCustomEntryData>>;
	getTldrEntries(sessionKey?: string): Map<string, TldrCustomEntryData>;

	appendTodoEntry(
		entry: Omit<TodoCustomEntryData, "updatedAt"> & { updatedAt?: number },
		sessionKey?: string,
	): Promise<ExtensionPersistedEntryRecord<TodoCustomEntryData>>;
	getTodoEntries(sessionKey?: string): TodoCustomEntryData[];

	appendAcpBlock(
		block: Omit<AcpCompressedBlockData, "createdAt"> & { createdAt?: number },
		sessionKey?: string,
	): Promise<ExtensionPersistedEntryRecord<AcpCompressedBlockData>>;
	getAcpBlocks(sessionKey?: string): AcpCompressedBlockData[];

	getMultiPassPool(provider?: string): MultiPassAccountEntry[];
	getActiveMultiPassAccount(provider: string): MultiPassAccountEntry | undefined;
	bindSessionPort?(sessionPort: DurableSessionPort): void;
}

/**
 * Create an `ExtensionSqliteEntryStore` backed directly by a SQLite WAL database (`node:sqlite`).
 * Persists `custom.<customType>` rows in `durable_extension_entries` and replays them in order.
 */
export function createSqliteWalEntryStore(dbPath: string, defaultSessionKey = "default:session"): SqliteWalEntryStore {
	mkdirSync(dirname(resolve(dbPath)), { recursive: true });
	const db = new DatabaseSync(resolve(dbPath));
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA synchronous = NORMAL;");
	db.exec(`
		CREATE TABLE IF NOT EXISTS durable_extension_entries (
			seq INTEGER PRIMARY KEY AUTOINCREMENT,
			id TEXT NOT NULL UNIQUE,
			parent_id TEXT,
			session_key TEXT NOT NULL,
			kind TEXT NOT NULL,
			custom_type TEXT NOT NULL,
			data_json TEXT NOT NULL,
			timestamp TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_durable_ext_entries_session
			ON durable_extension_entries(session_key, seq);
	`);

	const insertStmt = db.prepare(`
		INSERT INTO durable_extension_entries (id, parent_id, session_key, kind, custom_type, data_json, timestamp)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`);
	const selectBySessionStmt = db.prepare(`
		SELECT id, parent_id, session_key, kind, custom_type, data_json, timestamp
		FROM durable_extension_entries
		WHERE session_key = ?
		ORDER BY seq ASC
	`);
	const selectAllStmt = db.prepare(`
		SELECT id, parent_id, session_key, kind, custom_type, data_json, timestamp
		FROM durable_extension_entries
		ORDER BY seq ASC
	`);
	const maxSeqStmt = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS max_seq FROM durable_extension_entries`);

	let closed = false;

	const mapRow = <T = unknown>(row: Record<string, unknown>): ExtensionPersistedEntryRecord<T> => ({
		id: String(row.id),
		parentId: row.parent_id === null || row.parent_id === undefined ? null : String(row.parent_id),
		sessionKey: String(row.session_key),
		kind: String(row.kind),
		customType: String(row.custom_type),
		data: JSON.parse(String(row.data_json)) as T,
		timestamp: String(row.timestamp),
	});

	return {
		dbPath: resolve(dbPath),
		appendEntry<T = unknown>(
			customType: string,
			data: T,
			options?: ExtensionAppendEntryOptions,
		): ExtensionPersistedEntryRecord<T> {
			const trimmed = customType.trim();
			if (!trimmed) {
				throw new Error("ExtensionHookBridge.appendEntry requires a non-empty customType");
			}
			const sessionKey = options?.sessionKey ?? defaultSessionKey;
			const existingRows = selectBySessionStmt.all(sessionKey) as Record<string, unknown>[];
			const parentId =
				options?.parentId !== undefined
					? options.parentId
					: existingRows.length > 0
						? String(existingRows.at(-1)!.id)
						: null;
			const maxRow = maxSeqStmt.get() as { max_seq?: number } | undefined;
			const nextSeq = Number(maxRow?.max_seq ?? 0) + 1;
			const id = `ext-entry-${nextSeq}`;
			const kind = `custom.${trimmed}`;
			const timestamp = options?.timestamp ?? new Date().toISOString();
			const serialized = JSON.stringify(data ?? null);

			insertStmt.run(id, parentId, sessionKey, kind, trimmed, serialized, timestamp);
			return {
				id,
				parentId,
				sessionKey,
				kind,
				customType: trimmed,
				data: JSON.parse(serialized) as T,
				timestamp,
			};
		},
		getEntries(sessionKey?: string): readonly ExtensionPersistedEntryRecord[] {
			const rows = (sessionKey ? selectBySessionStmt.all(sessionKey) : selectAllStmt.all()) as Record<
				string,
				unknown
			>[];
			return rows.map((row) => mapRow(row));
		},
		async flush(): Promise<void> {
			// DatabaseSync commits synchronously to SQLite WAL.
		},
		close(): void {
			if (!closed) {
				closed = true;
				db.close();
			}
		},
	};
}

/**
 * Create an `ExtensionSqliteEntryStore` backed by a `DurableSessionPort`.
 */
export function createSessionPortEntryStore(
	port: DurableSessionPort,
	defaultSessionKey?: string,
): ExtensionSqliteEntryStore {
	const resolveKey = (sessionKey?: string): string => {
		const candidate = sessionKey ?? defaultSessionKey ?? port.getSessionKey();
		if (!candidate) {
			throw new Error("DurableSessionPort has no active sessionKey for appendEntry");
		}
		return candidate;
	};

	let appendingToPort = false;

	return {
		async appendEntry<T = unknown>(
			customType: string,
			data: T,
			options?: ExtensionAppendEntryOptions,
		): Promise<ExtensionPersistedEntryRecord<T>> {
			const sessionKey = resolveKey(options?.sessionKey);
			if (appendingToPort) {
				return {
					id: `reentrant:${customType}:${Date.now()}`,
					parentId: options?.parentId ?? null,
					sessionKey,
					kind: `custom.${customType}`,
					customType,
					data,
					timestamp: options?.timestamp ?? new Date().toISOString(),
				};
			}
			appendingToPort = true;
			try {
				const rec = await port.appendCustomEntry(customType, data, {
					sessionKey,
					parentId: options?.parentId,
					timestamp: options?.timestamp,
				});
				return {
					id: rec.id,
					parentId: rec.parentId,
					sessionKey: rec.sessionKey,
					kind: rec.kind,
					customType: rec.customType,
					data: rec.data,
					timestamp: rec.timestamp,
				};
			} finally {
				appendingToPort = false;
			}
		},
		getEntries(sessionKey?: string): readonly ExtensionPersistedEntryRecord[] {
			const resolved = sessionKey ?? defaultSessionKey ?? (port.getSessionKey() || undefined);
			if (!resolved) return [];
			let entries: DurableSessionEntry[] = [];
			try {
				entries = port.getEntries(resolved);
			} catch {
				return [];
			}
			const out: ExtensionPersistedEntryRecord[] = [];
			for (const entry of entries) {
				if (entry.type === "custom" && entry.customType) {
					out.push({
						id: entry.id,
						parentId: entry.parentId,
						sessionKey: entry.sessionKey,
						kind: entry.kind,
						customType: entry.customType,
						data: entry.data,
						timestamp: entry.timestamp,
					});
				}
			}
			return out;
		},
		async flush(): Promise<void> {
			await port.extensionBridge?.flush();
		},
	};
}

function toPiSessionEntry(record: ExtensionPersistedEntryRecord): SessionEntry {
	return {
		type: "custom",
		id: record.id,
		parentId: record.parentId,
		timestamp: record.timestamp,
		customType: record.customType,
		data: record.data,
	};
}

function portEntryToPiSessionEntry(entry: DurableSessionEntry): SessionEntry | null {
	if (entry.type === "custom" && entry.customType) {
		return {
			type: "custom",
			id: entry.id,
			parentId: entry.parentId,
			timestamp: entry.timestamp,
			customType: entry.customType,
			data: entry.data,
		};
	}
	if (entry.type === "message" && entry.message) {
		return {
			type: "message",
			id: entry.id,
			parentId: entry.parentId,
			timestamp: entry.timestamp,
			message: entry.message as unknown as Extract<SessionEntry, { type: "message" }>["message"],
		};
	}
	if (entry.type === "custom_message") {
		const draft = (entry.data ?? {}) as Partial<ExtensionCustomMessageDraft>;
		return {
			type: "custom_message",
			id: entry.id,
			parentId: entry.parentId,
			timestamp: entry.timestamp,
			customType: entry.customType ?? draft.customType ?? "custom",
			content: (draft.content ?? entry.message?.content ?? "") as Extract<
				SessionEntry,
				{ type: "custom_message" }
			>["content"],
			display: draft.display ?? true,
			details: draft.details,
		};
	}
	if (entry.type === "model_change") {
		const data = (entry.data ?? {}) as { provider?: string; id?: string; modelId?: string };
		return {
			type: "model_change",
			id: entry.id,
			parentId: entry.parentId,
			timestamp: entry.timestamp,
			provider: data.provider ?? "unknown",
			modelId: data.modelId ?? data.id ?? "unknown",
		};
	}
	if (entry.type === "thinking_level_change") {
		const data = (entry.data ?? {}) as { thinkingLevel?: string };
		return {
			type: "thinking_level_change",
			id: entry.id,
			parentId: entry.parentId,
			timestamp: entry.timestamp,
			thinkingLevel: (data.thinkingLevel ?? "off") as Extract<
				SessionEntry,
				{ type: "thinking_level_change" }
			>["thinkingLevel"],
		};
	}
	return null;
}

/**
 * Create a Pi `SessionManager`-compatible view over durable SQLite entries.
 */
export function createDurableSessionManagerView(options: {
	sessionKey: string;
	cwd: string;
	dbDir: string;
	sourceSessionFile?: string;
	entryStore: ExtensionSqliteEntryStore;
	sessionPort?: DurableSessionPort;
}): DurableSessionManagerView {
	const parseSessionId = (key: string): string => {
		try {
			return parseDurableSessionKey(key).sessionId;
		} catch {
			return key;
		}
	};

	const buildEntries = (): SessionEntry[] => {
		const key = options.sessionKey;
		if (options.sessionPort) {
			try {
				const rawPortEntries = options.sessionPort.getEntries(key);
				const portCustomIds = new Set<string>();
				const mapped: SessionEntry[] = [];
				for (const item of rawPortEntries) {
					const converted = portEntryToPiSessionEntry(item);
					if (converted) {
						mapped.push(converted);
						if (converted.type === "custom") portCustomIds.add(converted.id);
					}
				}
				for (const custom of options.entryStore.getEntries(key)) {
					if (!portCustomIds.has(custom.id)) {
						mapped.push(toPiSessionEntry(custom));
					}
				}
				return mapped;
			} catch {
				// Fall through to entryStore when session is not yet registered in port.
			}
		}
		return options.entryStore.getEntries(key).map(toPiSessionEntry);
	};

	const view: DurableSessionManagerView = {
		getCwd(): string {
			return options.cwd;
		},
		getSessionDir(): string {
			return options.dbDir;
		},
		getSessionId(): string {
			return parseSessionId(options.sessionKey);
		},
		getSessionKey(): string {
			return options.sessionKey;
		},
		getSessionFile(): string | undefined {
			return options.sourceSessionFile;
		},
		getLeafId(): string | null {
			const entries = buildEntries();
			return entries.at(-1)?.id ?? null;
		},
		getLeafEntry(): SessionEntry | undefined {
			const entries = buildEntries();
			return entries.at(-1);
		},
		getEntry(id: string): SessionEntry | undefined {
			return buildEntries().find((entry) => entry.id === id);
		},
		getEntries(): SessionEntry[] {
			return buildEntries();
		},
		getBranch(fromId?: string): SessionEntry[] {
			const entries = buildEntries();
			if (entries.length === 0) return [];
			const byId = new Map<string, SessionEntry>();
			for (const entry of entries) {
				byId.set(entry.id, entry);
			}
			const startId = fromId ?? entries.at(-1)!.id;
			const start = byId.get(startId);
			if (!start) return entries;

			const path: SessionEntry[] = [];
			const visited = new Set<string>();
			let current: SessionEntry | undefined = start;
			while (current && !visited.has(current.id)) {
				visited.add(current.id);
				path.unshift(current);
				current = current.parentId ? byId.get(current.parentId) : undefined;
			}
			// If parentId links were not populated across all entries, preserve chronological order up to startId.
			if (path.length <= 1 && entries.length > 1) {
				const idx = entries.findIndex((entry) => entry.id === startId);
				return idx >= 0 ? entries.slice(0, idx + 1) : entries;
			}
			return path;
		},
		appendCustomEntry<T = unknown>(customType: string, data?: T): string {
			const res = options.entryStore.appendEntry(customType, data as T, {
				sessionKey: options.sessionKey,
			});
			if (res instanceof Promise) {
				return `pending:${customType}:${Date.now()}`;
			}
			return res.id;
		},
		getCustomEntries<T = unknown>(customType?: string): ExtensionPersistedEntryRecord<T>[] {
			const all = options.entryStore.getEntries(options.sessionKey) as ExtensionPersistedEntryRecord<T>[];
			if (!customType) return [...all];
			return all.filter((entry) => entry.customType === customType);
		},
	};

	return view;
}

function expandHomePath(raw: string): string {
	const home = process.env.HOME ?? "/home/shinelay";
	if (raw === "~") return home;
	if (raw.startsWith("~/")) return join(home, raw.slice(2));
	return raw;
}

function isWithinFolder(targetPath: string, folderPath: string): boolean {
	const resolvedTarget = resolve(expandHomePath(targetPath));
	const resolvedFolder = resolve(expandHomePath(folderPath));
	return resolvedTarget === resolvedFolder || resolvedTarget.startsWith(`${resolvedFolder}/`);
}

function parseRoleAllowedFolders(identitiesDir: string, roleName: string): string[] {
	const aboutPath = join(identitiesDir, roleName, "about.md");
	if (!existsSync(aboutPath)) return [];
	const text = readFileSync(aboutPath, "utf8");
	const folders = new Set<string>();
	for (const match of text.matchAll(/(~\/[A-Za-z0-9._/-]+|\/home\/[A-Za-z0-9._/-]+)/g)) {
		const cleaned = match[1].replace(/[.,;:)+]+$/, "");
		if (cleaned) folders.add(resolve(expandHomePath(cleaned)));
	}
	folders.add(resolve(identitiesDir, roleName));
	return [...folders];
}

function loadIdentityRoleSystemBlock(
	identitiesDir: string,
	roleName: string,
): {
	systemBlock: string;
	rulesText: string;
	rulesMtimeMs: number | null;
} | null {
	const roleDir = join(identitiesDir, roleName);
	if (!existsSync(roleDir)) {
		return {
			systemBlock: `## Identity: ${roleName}`,
			rulesText: "",
			rulesMtimeMs: null,
		};
	}
	const parts: string[] = [`## Identity: ${roleName}`];
	const identityJsonPath = join(roleDir, "identity.json");
	if (existsSync(identityJsonPath)) {
		try {
			const meta = JSON.parse(readFileSync(identityJsonPath, "utf8")) as {
				description?: string;
				title?: string;
				rolePrompt?: string;
			};
			const label = meta.description ?? meta.title;
			if (label) parts[0] = `## Identity: ${label} (${roleName})`;
			if (meta.rolePrompt) parts.push(meta.rolePrompt.trim());
		} catch {
			// Ignore malformed identity.json.
		}
	}
	const aboutPath = join(roleDir, "about.md");
	if (existsSync(aboutPath)) {
		parts.push(`### About (${aboutPath})\n${readFileSync(aboutPath, "utf8").trim()}`);
	}
	const notebookPath = join(roleDir, "notebook.md");
	let rulesText = "";
	let rulesMtimeMs: number | null = null;
	if (existsSync(notebookPath)) {
		rulesText = readFileSync(notebookPath, "utf8").trim();
		rulesMtimeMs = statSync(notebookPath).mtimeMs;
		parts.push(`### Rules (${notebookPath})\n${rulesText}`);
	}
	const notesDir = join(roleDir, "notes");
	if (existsSync(notesDir)) {
		const noteFiles = readdirSync(notesDir)
			.filter((file) => file.endsWith(".md"))
			.sort();
		parts.push(`### Notes index (${notesDir}, ${noteFiles.length} notes)`);
	}
	return {
		systemBlock: parts.join("\n\n"),
		rulesText,
		rulesMtimeMs,
	};
}

function detectGitMainWorktreeCheckout(
	targetPath: string,
	protectedMainCheckouts: readonly string[] = [],
): { blocked: boolean; repoRoot?: string; reason?: string } {
	const resolvedTarget = resolve(expandHomePath(targetPath));

	for (const mainRoot of protectedMainCheckouts) {
		const resolvedMain = resolve(expandHomePath(mainRoot));
		if (isWithinFolder(resolvedTarget, resolvedMain)) {
			return {
				blocked: true,
				repoRoot: resolvedMain,
				reason: `Refusing to modify main checkout ${resolvedMain} directly (rule 12). Run 'wt new <branch-name>' first and edit inside the worktree.`,
			};
		}
	}

	let current =
		existsSync(resolvedTarget) && statSync(resolvedTarget).isDirectory() ? resolvedTarget : dirname(resolvedTarget);

	while (current && current !== dirname(current)) {
		const dotGit = join(current, ".git");
		if (existsSync(dotGit)) {
			const isMainCheckout = statSync(dotGit).isDirectory();
			const hasWtConfig = existsSync(join(current, ".wt", "wt.yaml"));
			if (isMainCheckout && hasWtConfig) {
				return {
					blocked: true,
					repoRoot: current,
					reason: `Refusing to modify main checkout ${current} directly (rule 12). Run 'wt new <branch-name>' first and edit inside the worktree.`,
				};
			}
			return { blocked: false, repoRoot: current };
		}
		current = dirname(current);
	}
	return { blocked: false };
}

function defaultQueueState(): QueueCustomEntryData {
	return {
		version: 2,
		autoRun: true,
		lanes: 1,
		nextId: 1,
		items: [],
	};
}

function extractMessageText(msg?: DurableExtensionMessage): string {
	if (!msg) return "";
	if (typeof msg.content === "string") return msg.content;
	if (Array.isArray(msg.content)) {
		return msg.content
			.map((part) => {
				if (typeof part === "string") return part;
				if (
					part &&
					typeof part === "object" &&
					"text" in part &&
					typeof (part as { text?: unknown }).text === "string"
				) {
					return (part as { text: string }).text;
				}
				return "";
			})
			.join("\n");
	}
	if (typeof msg.errorMessage === "string") return msg.errorMessage;
	return "";
}

function defaultFailoverDetector(event: TurnEndHookEvent): {
	failover: boolean;
	reason?: string;
	provider?: string;
} {
	const msg = event.message;
	const text = extractMessageText(msg);
	const errorText = typeof msg?.errorMessage === "string" ? msg.errorMessage : text;
	const provider = typeof msg?.provider === "string" ? msg.provider : "anthropic";

	if (
		event.outcome === "error" ||
		msg?.isError === true ||
		msg?.stopReason === "error" ||
		/\b(429|rate[_ -]?limit|quota|too many tokens|overloaded|credit balance|authentication_error)\b/i.test(errorText)
	) {
		return {
			failover: true,
			reason: errorText || "provider_turn_error",
			provider,
		};
	}
	return { failover: false, provider };
}

/**
 * Create the Wave 3.2 `DurableExtensionBridge` implementing `ExtensionHookBridge`
 * over durable SQLite entries (`queue`, `identity`, `tldr`, `todo`, `acp`, `multi-pass`)
 * and adapting Pi's `ExtensionRunner` + `SessionManager` with zero `.jsonl` files.
 */
export function createDurableExtensionBridge(options: DurableExtensionBridgeOptions = {}): DurableExtensionBridge {
	const cwd = resolve(options.cwd ?? process.cwd());
	const dbDir = resolve(options.dbDir ?? join(cwd, ".pi-durable"));
	const defaultSessionKey =
		options.defaultSessionKey ?? options.sessionPort?.getSessionKey() ?? formatDurableSessionKey(cwd, "default");

	let boundSessionPort: DurableSessionPort | undefined = options.sessionPort;
	const fallbackInMemoryStore = createInMemorySqliteEntryStore(defaultSessionKey);
	let activePortStore: ExtensionSqliteEntryStore | undefined = boundSessionPort
		? createSessionPortEntryStore(boundSessionPort, defaultSessionKey)
		: undefined;
	const fixedEntryStore: ExtensionSqliteEntryStore | undefined =
		options.entryStore ?? (options.dbPath ? createSqliteWalEntryStore(options.dbPath, defaultSessionKey) : undefined);

	const entryStore: ExtensionSqliteEntryStore = fixedEntryStore ?? {
		appendEntry<T = unknown>(customType: string, data: T, appendOpts?: ExtensionAppendEntryOptions) {
			if (activePortStore) {
				return activePortStore.appendEntry(customType, data, appendOpts);
			}
			return fallbackInMemoryStore.appendEntry(customType, data, appendOpts);
		},
		getEntries(sessionKey?: string) {
			if (activePortStore) {
				const portEntries = activePortStore.getEntries(sessionKey);
				const memEntries = fallbackInMemoryStore.getEntries(sessionKey);
				if (memEntries.length === 0) return portEntries;
				const seenIds = new Set(portEntries.map((e) => e.id));
				return [...memEntries.filter((e) => !seenIds.has(e.id)), ...portEntries];
			}
			return fallbackInMemoryStore.getEntries(sessionKey);
		},
		async flush() {
			if (activePortStore) {
				await activePortStore.flush?.();
			} else {
				await fallbackInMemoryStore.flush?.();
			}
		},
	};

	const baseBridge = createExtensionHookBridge({
		defaultSessionKey,
		entryStore,
	});

	const identitiesDir =
		options.identity?.identitiesDir ??
		options.worktree?.identitiesDir ??
		join(process.env.HOME ?? "/home/shinelay", ".pi", "agent", "memory", "identities");

	// Per-session runtime state for external rules reload & notebook-written tracking
	const loadedRulesMtimeBySession = new Map<string, number>();
	const externalRulesDirtySessions = new Set<string>();
	const notebookWrittenBySession = new Map<string, boolean>();

	// Multi-pass pool state
	const multiPassCooldownMs = options.multiPass?.cooldownMs ?? 60_000;
	const multiPassPools = new Map<string, MultiPassAccountEntry[]>();
	const activeMultiPassAccountByProvider = new Map<string, string>();
	for (const acct of options.multiPass?.accounts ?? []) {
		const list = multiPassPools.get(acct.provider) ?? [];
		list.push({ ...acct, failoverCount: acct.failoverCount ?? 0 });
		multiPassPools.set(acct.provider, list);
		if (!activeMultiPassAccountByProvider.has(acct.provider)) {
			activeMultiPassAccountByProvider.set(acct.provider, acct.id);
		}
	}

	let boundRunner: ExtensionRunner | undefined = options.extensionRunner;

	const resolveSessionKey = (sessionKey?: string): string => {
		return sessionKey ?? boundSessionPort?.getSessionKey() ?? defaultSessionKey;
	};

	const getSessionManager = (sessionKey?: string): DurableSessionManagerView => {
		const resolvedKey = resolveSessionKey(sessionKey);
		return createDurableSessionManagerView({
			sessionKey: resolvedKey,
			cwd,
			dbDir,
			sourceSessionFile: options.sourceSessionFile,
			entryStore,
			sessionPort: boundSessionPort,
		});
	};

	// 0. Optional `before_agent_start` / `turn_end` custom handlers remain ordered with built-ins

	const getActiveIdentity = (sessionKey?: string): IdentityCustomEntryData | null => {
		const key = resolveSessionKey(sessionKey);
		const entries = entryStore.getEntries(key).filter((entry) => entry.customType === "identity");
		if (entries.length > 0) {
			const latest = entries.at(-1)!.data as (IdentityCustomEntryData & { id?: string; roleId?: string }) | undefined;
			if (!latest) return null;
			const roleName = latest.name ?? latest.id ?? latest.roleId ?? null;
			if (!roleName) return null;
			return {
				...structuredClone(latest),
				name: roleName,
				setAt: typeof latest.setAt === "number" ? latest.setAt : Date.now(),
			};
		}
		if (options.identity?.initialRole) {
			return {
				name: options.identity.initialRole,
				setAt: Date.now(),
			};
		}
		return null;
	};

	const getQueueState = (sessionKey?: string): QueueCustomEntryData => {
		const key = resolveSessionKey(sessionKey);
		const entries = entryStore.getEntries(key).filter((entry) => entry.customType === "queue");
		if (entries.length === 0) return defaultQueueState();
		const latest = entries.at(-1)!.data as QueueCustomEntryData | undefined;
		if (!latest || !Array.isArray(latest.items)) return defaultQueueState();
		return structuredClone(latest);
	};

	const setQueueState = async (
		state: QueueCustomEntryData,
		sessionKey?: string,
	): Promise<ExtensionPersistedEntryRecord<QueueCustomEntryData>> => {
		const key = resolveSessionKey(sessionKey);
		return baseBridge.appendEntry("queue", structuredClone(state), { sessionKey: key });
	};

	const getTldrEntries = (sessionKey?: string): Map<string, TldrCustomEntryData> => {
		const key = resolveSessionKey(sessionKey);
		const map = new Map<string, TldrCustomEntryData>();
		for (const entry of entryStore.getEntries(key)) {
			if (entry.customType === "tldr" && entry.data && typeof entry.data === "object") {
				const tldr = entry.data as TldrCustomEntryData;
				if (tldr.messageId) {
					map.set(tldr.messageId, structuredClone(tldr));
				}
			}
		}
		return map;
	};

	const getTodoEntries = (sessionKey?: string): TodoCustomEntryData[] => {
		const key = resolveSessionKey(sessionKey);
		const byId = new Map<number, TodoCustomEntryData>();
		for (const entry of entryStore.getEntries(key)) {
			if (entry.customType === "todo" && entry.data && typeof entry.data === "object") {
				const todo = entry.data as TodoCustomEntryData;
				if (typeof todo.id === "number") {
					byId.set(todo.id, structuredClone(todo));
				}
			}
		}
		return [...byId.values()].filter((item) => item.status !== "deleted");
	};

	const getAcpBlocks = (sessionKey?: string): AcpCompressedBlockData[] => {
		const key = resolveSessionKey(sessionKey);
		const blocks: AcpCompressedBlockData[] = [];
		for (const entry of entryStore.getEntries(key)) {
			if (
				(entry.customType === "acp" || entry.customType === "acp-block") &&
				entry.data &&
				typeof entry.data === "object"
			) {
				const block = entry.data as AcpCompressedBlockData;
				if (block.blockId && block.startId && block.endId) {
					blocks.push(structuredClone(block));
				}
			}
		}
		return blocks;
	};

	// 1. Built-in `before_agent_start`: `pi-identity` systemPrompt + rules reload, `pi-queue` task handoff
	if (options.identity?.enabled !== false) {
		baseBridge.onBeforeAgentStart(async (event): Promise<BeforeAgentStartHookResult | undefined> => {
			const key = resolveSessionKey(event.sessionKey);
			const activeIdentity = getActiveIdentity(key);
			if (!activeIdentity?.name) return undefined;

			const roleBlock = loadIdentityRoleSystemBlock(identitiesDir, activeIdentity.name);
			if (!roleBlock) return undefined;

			const baseSystem = event.systemPrompt ?? "";
			const nextSystemPrompt = baseSystem.includes(`## Identity:`)
				? baseSystem
				: baseSystem
					? `${baseSystem}\n\n${roleBlock.systemBlock}`
					: roleBlock.systemBlock;

			const customMessages: ExtensionCustomMessageDraft[] = [];
			const prevMtime = loadedRulesMtimeBySession.get(key);
			const mtimeChanged =
				prevMtime !== undefined && roleBlock.rulesMtimeMs !== null && roleBlock.rulesMtimeMs > prevMtime;

			if (externalRulesDirtySessions.has(key) || mtimeChanged) {
				externalRulesDirtySessions.delete(key);
				if (roleBlock.rulesText) {
					customMessages.push({
						customType: "identity-rules",
						content: `[Identity rules updated outside this chat — current rules for ${activeIdentity.name}]\n${roleBlock.rulesText}`,
						display: false,
					});
				}
			}
			if (roleBlock.rulesMtimeMs !== null) {
				loadedRulesMtimeBySession.set(key, roleBlock.rulesMtimeMs);
			}

			return {
				systemPrompt: nextSystemPrompt,
				...(customMessages.length > 0 ? { customMessages } : {}),
			};
		});
	}

	if (options.queue?.enabled !== false) {
		baseBridge.onBeforeAgentStart(async (event): Promise<BeforeAgentStartHookResult | undefined> => {
			const key = resolveSessionKey(event.sessionKey);
			const queueState = getQueueState(key);
			if (queueState.paused) return undefined;

			const shouldHandoff =
				options.queue?.handoffOnBeforeAgentStart === true ||
				event.prompt.trim() === "__queue_handoff__" ||
				event.prompt.startsWith("[Queue] Start next task");

			if (!shouldHandoff) return undefined;

			const doneIds = new Set(queueState.items.filter((i) => i.status === "done").map((i) => i.id));
			const inProgressCount = queueState.items.filter((i) => i.status === "in_progress").length;
			const maxLanes = Math.max(1, queueState.lanes ?? 1);
			if (inProgressCount >= maxLanes) return undefined;

			const nextTask = queueState.items.find(
				(item) => item.status === "waiting" && !item.paused && (item.after ?? []).every((depId) => doneIds.has(depId)),
			);
			if (!nextTask) return undefined;

			nextTask.status = "in_progress";
			nextTask.startedAt = Date.now();
			notebookWrittenBySession.set(key, false);
			await setQueueState(queueState, key);

			const handoffText = `[Queue] Task #${nextTask.id}: ${nextTask.text}`;
			return {
				prompt:
					event.prompt && event.prompt !== "__queue_handoff__" ? `${handoffText}\n\n${event.prompt}` : handoffText,
				customMessages: [
					{
						customType: "queue-task-handoff",
						content: handoffText,
						display: true,
						details: { taskId: nextTask.id, status: "in_progress" },
					},
				],
			};
		});
	}

	// 2. Built-in `context` (`transformContext`): `@earendil-works/pi-context` ACP block folding
	if (options.acp?.enabled !== false) {
		baseBridge.onContext(async (event: ContextHookEvent): Promise<ContextHookResult> => {
			const key = resolveSessionKey(event.sessionKey);
			const blocks = getAcpBlocks(key);
			const messages = event.messages.map((msg, idx) => {
				const clone = { ...msg };
				if (options.acp?.injectMessageRefs && typeof clone.id !== "string") {
					clone.id = `m${String(idx + 1).padStart(5, "0")}`;
				}
				return clone;
			});

			if (blocks.length === 0) {
				return { messages };
			}

			let current = messages;
			for (const block of blocks) {
				const startIdx = current.findIndex(
					(msg) => (msg as { id?: string }).id === block.startId || (msg as { ref?: string }).ref === block.startId,
				);
				const endIdx = current.findIndex(
					(msg) => (msg as { id?: string }).id === block.endId || (msg as { ref?: string }).ref === block.endId,
				);
				if (startIdx >= 0 && endIdx >= startIdx) {
					const summaryMessage: DurableExtensionMessage = {
						id: block.blockId,
						role: "custom",
						customType: "acp-summary",
						content: `<acp-block id="${block.blockId}" range="${block.startId}..${block.endId}"${block.topic ? ` topic="${block.topic}"` : ""}>${block.summary}</acp-block>`,
						details: block,
						timestamp: block.createdAt,
					};
					current = [...current.slice(0, startIdx), summaryMessage, ...current.slice(endIdx + 1)];
				}
			}
			return { messages: current };
		});
	}

	// 3. Built-in `tool_call`: `pi-worktree` role-folder & worktree guard + notebook write tracking
	baseBridge.onToolCall(async (event: ToolCallHookEvent): Promise<ToolCallHookDecision | undefined> => {
		const key = resolveSessionKey(event.sessionKey);

		if (event.toolName === "notebook") {
			const action = typeof event.input.action === "string" ? event.input.action : "";
			if (NOTEBOOK_WRITE_ACTIONS.has(action)) {
				notebookWrittenBySession.set(key, true);
			}
		}

		if (options.worktree?.enabled === false) {
			return undefined;
		}

		const isFileWriteOrEdit = event.toolName === "write" || event.toolName === "edit" || event.toolName === "patch";
		const isMutatingBash =
			event.toolName === "bash" &&
			typeof event.input.command === "string" &&
			MUTATING_BASH_RE.test(event.input.command);

		if (!isFileWriteOrEdit && !isMutatingBash) {
			return undefined;
		}

		const rawPath =
			typeof event.input.path === "string"
				? event.input.path
				: typeof event.input.file_path === "string"
					? event.input.file_path
					: cwd;
		const targetPath = resolve(cwd, expandHomePath(rawPath));

		// (a) Worktree main-checkout guard (Rule 12)
		const wtDecision = detectGitMainWorktreeCheckout(targetPath, options.worktree?.protectedMainCheckouts ?? []);
		if (wtDecision.blocked) {
			return {
				block: true,
				reason: wtDecision.reason,
			};
		}

		// (b) Role-folder guard when an identity is active and no queue task has started in this session
		const activeIdentity = getActiveIdentity(key);
		if (activeIdentity?.name) {
			const queueState = getQueueState(key);
			const hasStartedQueueTask = queueState.items.some(
				(item) => item.status === "in_progress" || item.status === "done" || item.status === "stuck",
			);
			if (!hasStartedQueueTask) {
				const configuredFolders = options.worktree?.roleAllowedFolders?.[activeIdentity.name];
				const allowedFolders = configuredFolders
					? configuredFolders.map((folder) => resolve(expandHomePath(folder)))
					: parseRoleAllowedFolders(identitiesDir, activeIdentity.name);

				if (allowedFolders.length > 0) {
					const allowed = allowedFolders.some((folder) => isWithinFolder(targetPath, folder));
					if (!allowed) {
						return {
							block: true,
							reason: `Role "${activeIdentity.name}" cannot modify ${targetPath} outside its allowed folders (${allowedFolders.join(", ")}) without an active queued task.`,
						};
					}
				}
			}
		}

		return undefined;
	});

	// 4. Built-in `tool_result`: `pi-identity` notebook reminder on `queue_done`
	if (options.identity?.enabled !== false) {
		baseBridge.onToolResult(async (event: ToolResultHookEvent): Promise<ToolResultHookPatch | undefined> => {
			if (event.toolName !== "queue_done" || event.isError) {
				return undefined;
			}
			const key = resolveSessionKey(event.sessionKey);
			const activeIdentity = getActiveIdentity(key);
			if (!activeIdentity?.name) {
				return undefined;
			}
			if (notebookWrittenBySession.get(key)) {
				return undefined;
			}
			const nextContent = [...event.content, { type: "text", text: NOTEBOOK_REMINDER_TEXT }];
			return {
				content: nextContent,
			};
		});
	}

	// 5. Built-in `turn_end`: `pi-multi-pass` failover/continuation & `pi-queue` next-task dispatch
	baseBridge.onTurnEnd(async (event: TurnEndHookEvent): Promise<TurnEndHookResult | undefined> => {
		const key = resolveSessionKey(event.sessionKey);
		const appendedEntries: ExtensionPersistedEntryRecord[] = [];
		let shouldContinue = false;

		// (a) `pi-multi-pass` failover / continuation
		if (options.multiPass?.enabled !== false) {
			const detector = options.multiPass?.shouldFailover ?? defaultFailoverDetector;
			const detection = detector(event);
			if (detection.failover) {
				const provider = detection.provider ?? "anthropic";
				const pool = multiPassPools.get(provider) ?? [];
				const now = Date.now();
				const currentId = activeMultiPassAccountByProvider.get(provider) ?? null;
				if (currentId) {
					const currentAcct = pool.find((acct) => acct.id === currentId);
					if (currentAcct) {
						currentAcct.cooldownUntil = now + multiPassCooldownMs;
						currentAcct.failoverCount = (currentAcct.failoverCount ?? 0) + 1;
					}
				}
				const candidate = pool.find(
					(acct) => acct.id !== currentId && !acct.exhausted && (!acct.cooldownUntil || acct.cooldownUntil <= now),
				);
				if (candidate) {
					activeMultiPassAccountByProvider.set(provider, candidate.id);
					const persisted = await baseBridge.appendEntry<MultiPassCustomEntryData>(
						"multi-pass",
						{
							provider,
							previousAccountId: currentId,
							selectedAccountId: candidate.id,
							reason: detection.reason ?? "rate_limit_failover",
							timestamp: now,
						},
						{ sessionKey: key },
					);
					appendedEntries.push(persisted);
					shouldContinue = true;
				}
			}
		}

		// (b) `pi-queue` next-task dispatch
		if (options.queue?.enabled !== false && options.queue?.dispatchNextOnTurnEnd !== false) {
			const queueState = getQueueState(key);
			if (queueState.autoRun && !queueState.paused) {
				const doneIds = new Set(queueState.items.filter((i) => i.status === "done").map((i) => i.id));
				const inProgressCount = queueState.items.filter((i) => i.status === "in_progress").length;
				const maxLanes = Math.max(1, queueState.lanes ?? 1);

				if (inProgressCount < maxLanes) {
					const nextTask = queueState.items.find(
						(item) =>
							item.status === "waiting" && !item.paused && (item.after ?? []).every((depId) => doneIds.has(depId)),
					);
					if (nextTask) {
						nextTask.status = "in_progress";
						nextTask.startedAt = Date.now();
						notebookWrittenBySession.set(key, false);
						const persisted = await setQueueState(queueState, key);
						appendedEntries.push(persisted);
						await options.queue?.onTaskDispatched?.(structuredClone(nextTask), key);
						shouldContinue = true;
					}
				}
			}
		}

		if (!shouldContinue && appendedEntries.length === 0) {
			return undefined;
		}
		return {
			continue: shouldContinue,
			appendedEntries,
		};
	});

	// Adapter for wiring an `ExtensionRunner` from `@earendil-works/pi-coding-agent`
	const wireExtensionRunner = (runner: ExtensionRunner): void => {
		baseBridge.onBeforeAgentStart(async (event) => {
			if (!runner.hasHandlers("before_agent_start")) return undefined;
			const res = await runner.emitBeforeAgentStart(event.prompt, undefined, {
				cwd,
				selectedTools: event.selectedTools ? [...event.selectedTools] : [],
				forceSystemPrompt: event.systemPrompt ?? "",
			});
			if (!res) return undefined;
			return {
				systemPrompt: res.systemPromptOptions?.forceSystemPrompt ?? event.systemPrompt,
				selectedTools: res.systemPromptOptions?.selectedTools,
				customMessages: res.messages?.map((msg) => ({
					customType: msg.customType,
					content: msg.content,
					display: msg.display,
					details: msg.details,
				})),
			};
		});

		baseBridge.onContext(async (event) => {
			if (!runner.hasHandlers("context")) return undefined;
			const transformed = await runner.emitContext(
				event.messages as unknown as Parameters<ExtensionRunner["emitContext"]>[0],
			);
			return {
				messages: transformed as unknown as DurableExtensionMessage[],
			};
		});

		baseBridge.onTurnStart(async (event) => {
			if (!runner.hasHandlers("turn_start")) return;
			await runner.emit({
				type: "turn_start",
				turnIndex: event.turnIndex,
				timestamp: event.timestamp,
			});
		});

		baseBridge.onTurnEnd(async (event) => {
			if (!runner.hasHandlers("turn_end")) return undefined;
			const boundaryRes = await runner.emitBoundary(
				{
					type: "turn_end",
					turnIndex: event.turnIndex,
					message: (event.message ?? {
						role: "assistant",
						content: "",
						timestamp: Date.now(),
					}) as unknown as Extract<Parameters<ExtensionRunner["emitBoundary"]>[0], { type: "turn_end" }>["message"],
					toolResults: (event.toolResults ?? []) as unknown as Extract<
						Parameters<ExtensionRunner["emitBoundary"]>[0],
						{ type: "turn_end" }
					>["toolResults"],
					messageEntryId: "durable-turn-msg",
					toolResultEntryIds: [],
					outcome: event.outcome === "aborted" ? "aborted" : "completed",
				},
				() => ({
					contextEntries: [],
					contextMessages: [],
					llmMessages: [],
					pendingMessages: [],
					canContinue: true,
				}),
			);
			return {
				continue: boundaryRes.continue,
			};
		});

		baseBridge.onToolCall(async (event) => {
			if (!runner.hasHandlers("tool_call")) return undefined;
			const res = await runner.emitToolCall({
				type: "tool_call",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				input: event.input,
			} as unknown as Parameters<ExtensionRunner["emitToolCall"]>[0]);
			if (!res) return undefined;
			return {
				block: res.block,
				reason: res.reason,
			};
		});

		baseBridge.onToolResult(async (event) => {
			if (!runner.hasHandlers("tool_result")) return undefined;
			const res = await runner.emitToolResult({
				type: "tool_result",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				input: event.input,
				content: event.content as unknown as Extract<
					Parameters<ExtensionRunner["emitToolResult"]>[0],
					{ type: "tool_result" }
				>["content"],
				details: event.details,
				isError: event.isError,
			});
			if (!res) return undefined;
			return {
				content: res.content as unknown[] | undefined,
				details: res.details,
				isError: res.isError,
			};
		});
	};

	if (boundRunner) {
		wireExtensionRunner(boundRunner);
	}

	const bindExtensionFactories = async (factories: readonly ExtensionFactory[]): Promise<ExtensionRunner> => {
		const runtime = createExtensionRuntime();
		const loadedExtensions: Extension[] = [...(options.extensions ?? [])];

		for (let i = 0; i < factories.length; i += 1) {
			const extPath = `<durable-extension-${i + 1}>`;
			const ext: Extension = {
				path: extPath,
				resolvedPath: extPath,
				sourceInfo: {
					path: extPath,
					source: "local",
					scope: "temporary",
					origin: "top-level",
				},
				handlers: new Map(),
				tools: new Map(),
				messageRenderers: new Map(),
				entryRenderers: new Map(),
				commands: new Map(),
				flags: new Map(),
				shortcuts: new Map(),
			};

			type RegisteredHandler = NonNullable<ReturnType<Extension["handlers"]["get"]>>[number];
			const api = {
				on(eventName: string, handler: RegisteredHandler) {
					const list = ext.handlers.get(eventName) ?? [];
					list.push(handler);
					ext.handlers.set(eventName, list);
					return () => {
						const current = ext.handlers.get(eventName);
						if (!current) return;
						const idx = current.indexOf(handler);
						if (idx >= 0) current.splice(idx, 1);
					};
				},
				registerTool(tool: { name: string }) {
					ext.tools.set(tool.name, {
						definition: tool as never,
						sourceInfo: ext.sourceInfo,
					});
				},
				registerCommand(name: string, cmdOptions: { handler: (...args: unknown[]) => unknown; description?: string }) {
					ext.commands.set(name, {
						name,
						sourceInfo: ext.sourceInfo,
						...cmdOptions,
					} as never);
				},
				registerShortcut() {},
				registerFlag() {},
				getFlag() {
					return undefined;
				},
				registerMessageRenderer() {},
				registerEntryRenderer() {},
				sendMessage(message: ExtensionCustomMessageDraft) {
					void baseBridge.appendEntry(message.customType, message, { sessionKey: resolveSessionKey() });
				},
				sendUserMessage(content: string) {
					if (options.sessionPort) {
						void options.sessionPort.followUp(content, {
							sessionKey: resolveSessionKey(),
							source: "extension",
						});
					}
				},
				appendEntry(customType: string, data?: unknown) {
					void baseBridge.appendEntry(customType, data, { sessionKey: resolveSessionKey() });
				},
				setSessionName() {},
				getSessionName() {
					return undefined;
				},
				setLabel() {},
				exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
				getActiveTools: () => [],
				getAllTools: () => [],
				setActiveTools() {},
				getCommands: () => [],
				getSettings: () => ({}),
				setModel: async () => false,
				getThinkingLevel: () => "off" as const,
				setThinkingLevel() {},
				registerProvider() {},
				registerNativeProvider() {},
				unregisterProvider() {},
				registerVirtualModel() {},
				unregisterVirtualModel() {},
				mcp: {
					register() {},
					unregister() {},
					list: () => [],
				},
				events: {
					on: () => () => {},
					emit() {},
				},
			};

			await factories[i](api as unknown as Parameters<ExtensionFactory>[0]);
			loadedExtensions.push(ext);
		}

		const smView = getSessionManager();
		const runner = new ExtensionRunner(
			loadedExtensions,
			runtime,
			cwd,
			smView as unknown as ConstructorParameters<typeof ExtensionRunner>[3],
			{} as unknown as ConstructorParameters<typeof ExtensionRunner>[4],
		);
		runner.bindCore(
			{
				appendEntry: (customType: string, data?: unknown) => {
					void baseBridge.appendEntry(customType, data, { sessionKey: resolveSessionKey() });
				},
				sendMessage: (message) => {
					void baseBridge.appendEntry(message.customType, message, { sessionKey: resolveSessionKey() });
				},
				sendUserMessage: (content) => {
					if (typeof content === "string" && options.sessionPort) {
						void options.sessionPort.followUp(content, {
							sessionKey: resolveSessionKey(),
							source: "extension",
						});
					}
				},
				setSessionName: () => {},
				getSessionName: () => undefined,
				setLabel: () => {},
				getActiveTools: () => [],
				getAllTools: () => [],
				getSettings: () => ({}),
				setActiveTools: () => {},
				refreshTools: () => {},
				getCommands: () => [],
				setModel: async () => false,
				getThinkingLevel: () => "off",
				setThinkingLevel: () => {},
			},
			{
				getModel: () => undefined,
				getScopedModels: () => [],
				isIdle: () => true,
				isProjectTrusted: () => true,
				getSignal: () => undefined,
				abort: () => {},
				hasPendingMessages: () => false,
				shutdown: () => {},
				getContextUsage: () => undefined,
				compact: () => {},
				getSystemPrompt: () => "",
				getSystemPromptOptions: () => ({ cwd, selectedTools: [], forceSystemPrompt: "" }),
			},
		);

		boundRunner = runner;
		wireExtensionRunner(runner);
		await runner.emit({ type: "session_start", reason: "startup" });
		return runner;
	};

	const bridge: DurableExtensionBridge = {
		get sessionManager(): DurableSessionManagerView {
			return getSessionManager();
		},
		getSessionManager,
		bindExtensionFactories,
		getExtensionRunner: () => boundRunner,

		on: <K extends ExtensionHookName>(hookName: K, handler: ExtensionHookHandlerMap[K]) =>
			baseBridge.on(hookName, handler),
		onBeforeAgentStart: (handler: BeforeAgentStartHookHandler) => baseBridge.onBeforeAgentStart(handler),
		onContext: (handler: ContextHookHandler) => baseBridge.onContext(handler),
		onTurnStart: (handler: TurnStartHookHandler) => baseBridge.onTurnStart(handler),
		onTurnEnd: (handler: TurnEndHookHandler) => baseBridge.onTurnEnd(handler),
		onToolCall: (handler: ToolCallHookHandler) => baseBridge.onToolCall(handler),
		onToolResult: (handler: ToolResultHookHandler) => baseBridge.onToolResult(handler),
		onSessionBeforeCompact: (handler: SessionBeforeCompactHookHandler) => baseBridge.onSessionBeforeCompact(handler),

		before_agent_start: (input) => baseBridge.before_agent_start(input),
		context: (input) => baseBridge.context(input),
		transformContext: (messages, sessionKey) => baseBridge.transformContext(messages, sessionKey),
		turn_start: (input) => baseBridge.turn_start(input),
		turn_end: (input) => baseBridge.turn_end(input),
		tool_call: (input) => baseBridge.tool_call(input),
		tool_result: (input) => baseBridge.tool_result(input),
		session_before_compact: (
			input: Omit<SessionBeforeCompactHookEvent, "type"> & { type?: "session_before_compact" },
		) => baseBridge.session_before_compact(input),

		appendEntry: <T = unknown>(customType: string, data: T, entryOptions?: ExtensionAppendEntryOptions) =>
			baseBridge.appendEntry(customType, data, {
				...entryOptions,
				sessionKey: resolveSessionKey(entryOptions?.sessionKey),
			}),
		getPersistedEntries: (sessionKey?: string) =>
			baseBridge.getPersistedEntries(sessionKey ? resolveSessionKey(sessionKey) : undefined),
		flush: () => baseBridge.flush(),

		async setIdentity(roleName, setOptions): Promise<ExtensionPersistedEntryRecord<IdentityCustomEntryData>> {
			const key = resolveSessionKey(setOptions?.sessionKey);
			const payload: IdentityCustomEntryData = {
				name: roleName,
				setAt: Date.now(),
				...(setOptions?.rulesSummary ? { rulesSummary: setOptions.rulesSummary } : {}),
			};
			if (roleName) {
				const loaded = loadIdentityRoleSystemBlock(identitiesDir, roleName);
				if (loaded?.rulesMtimeMs !== null && loaded?.rulesMtimeMs !== undefined) {
					loadedRulesMtimeBySession.set(key, loaded.rulesMtimeMs);
				}
			}
			return baseBridge.appendEntry("identity", payload, { sessionKey: key });
		},
		getActiveIdentity,
		markExternalRulesChanged(_roleName?: string, sessionKey?: string): void {
			externalRulesDirtySessions.add(resolveSessionKey(sessionKey));
		},

		getQueueState,
		setQueueState,
		async enqueueTask(taskInput, sessionKey) {
			const key = resolveSessionKey(sessionKey);
			const state = getQueueState(key);
			const item: QueueTaskItem = {
				id: state.nextId,
				text: taskInput.text,
				status: "waiting",
				createdAt: Date.now(),
				...(taskInput.after?.length ? { after: [...taskInput.after] } : {}),
				...(taskInput.touches?.length ? { touches: [...taskInput.touches] } : {}),
				...(taskInput.paused ? { paused: { ...taskInput.paused } } : {}),
			};
			state.nextId += 1;
			state.items.push(item);
			const entry = await setQueueState(state, key);
			return { task: item, entry };
		},
		async completeTask(taskId, summary, sessionKey) {
			const key = resolveSessionKey(sessionKey);
			const state = getQueueState(key);
			const found = state.items.find((item) => item.id === taskId);
			if (!found) {
				throw new Error(`Queue task #${taskId} not found in durable session ${key}`);
			}
			found.status = "done";
			found.completedAt = Date.now();
			found.summary = summary;
			return setQueueState(state, key);
		},

		async appendTldrEntry(entryInput, sessionKey) {
			const key = resolveSessionKey(sessionKey);
			const payload: TldrCustomEntryData = {
				messageId: entryInput.messageId,
				summary: entryInput.summary,
				...(entryInput.bullets ? { bullets: [...entryInput.bullets] } : {}),
				createdAt: entryInput.createdAt ?? Date.now(),
			};
			return baseBridge.appendEntry("tldr", payload, { sessionKey: key });
		},
		getTldrEntries,

		async appendTodoEntry(entryInput, sessionKey) {
			const key = resolveSessionKey(sessionKey);
			const payload: TodoCustomEntryData = {
				id: entryInput.id,
				subject: entryInput.subject,
				status: entryInput.status,
				...(entryInput.blocks ? { blocks: [...entryInput.blocks] } : {}),
				updatedAt: entryInput.updatedAt ?? Date.now(),
			};
			return baseBridge.appendEntry("todo", payload, { sessionKey: key });
		},
		getTodoEntries,

		async appendAcpBlock(blockInput, sessionKey) {
			const key = resolveSessionKey(sessionKey);
			const payload: AcpCompressedBlockData = {
				blockId: blockInput.blockId,
				startId: blockInput.startId,
				endId: blockInput.endId,
				...(blockInput.topic ? { topic: blockInput.topic } : {}),
				summary: blockInput.summary,
				tier: blockInput.tier ?? 1,
				createdAt: blockInput.createdAt ?? Date.now(),
			};
			return baseBridge.appendEntry("acp", payload, { sessionKey: key });
		},
		getAcpBlocks,

		getMultiPassPool(provider = "anthropic"): MultiPassAccountEntry[] {
			return (multiPassPools.get(provider) ?? []).map((acct) => ({ ...acct }));
		},
		getActiveMultiPassAccount(provider = "anthropic"): MultiPassAccountEntry | undefined {
			const activeId = activeMultiPassAccountByProvider.get(provider);
			if (!activeId) return undefined;
			const found = (multiPassPools.get(provider) ?? []).find((acct) => acct.id === activeId);
			return found ? { ...found } : undefined;
		},
		bindSessionPort(sessionPort: DurableSessionPort): void {
			boundSessionPort = sessionPort;
			if (!fixedEntryStore) {
				activePortStore = createSessionPortEntryStore(sessionPort, defaultSessionKey);
			}
		},
	};

	if (options.extensionFactories?.length) {
		void bindExtensionFactories(options.extensionFactories);
	}

	return bridge;
}
