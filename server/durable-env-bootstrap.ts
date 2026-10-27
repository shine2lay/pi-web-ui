/**
 * Wave 3.3 (#603): Clean-environment durable bootstrap.
 *
 * Initializes a brand-new environment directly on `@earendil-works/pi-durable`
 * SQLite WAL (`~/.pi-web-ui/durable-sessions.db`, schema v2) with zero `.jsonl`
 * session files:
 *   1. Creates and migrates `~/.pi-web-ui/durable-sessions.db` (SQLite WAL, schema v2).
 *   2. Generates `$HOME`-portable `~/.pi/agent/settings.json` (replacing hardcoded
 *      `/home/shinelay/...` or user home paths with `$HOME/...`).
 *   3. Initializes `~/.pi/agent/work/events.jsonl` and `~/.pi-web-ui/board.json`
 *      (plus `role-board.json`) if absent.
 *   4. Scans `~/.pi/agent/memory/identities/*\/identity.json`, creates a fresh
 *      durable `homeChat` session in `durable-sessions.db` for each role, writes
 *      its `durable:<sessionId>` key into `identity.json` (moving any prior
 *      `homeChat` into `pastHomeChats`), and records the initial
 *      `customType: "identity"` entry.
 */

import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	formatDurableSessionKey,
	parseDurableSessionKey,
	resolveDurableStorageMode,
} from "./durable-session-port.js";

export { formatDurableSessionKey, parseDurableSessionKey, resolveDurableStorageMode };

export const DURABLE_SESSION_KEY_PREFIX = "durable:";
export const DEFAULT_DURABLE_DB_FILE = "durable-sessions.db";

export interface DurableBootstrapOptions {
	/** Root `$HOME` directory to bootstrap (defaults to `process.env.HOME` / `os.homedir()`). */
	homeDir?: string;
	/** Target `.pi-web-ui` data directory (defaults to `<homeDir>/.pi-web-ui`). */
	dataDir?: string;
	/** Target `.pi/agent` directory (defaults to `<homeDir>/.pi/agent`). */
	agentDir?: string;
	/** Explicit SQLite database path (defaults to `<dataDir>/durable-sessions.db`). */
	dbPath?: string;
	/** Optional template `settings.json` path to sanitize into `$HOME`-portable paths. */
	templateSettingsPath?: string;
	/** Optional role IDs to seed if `identities/` is empty. */
	seedRoleIds?: string[];
	/** Default working directory recorded on bootstrapped role homeChat sessions. */
	cwd?: string;
	/** Optional explicit source home directory whose paths should be rewritten to `$HOME`. */
	sourceHomeDir?: string;
}

export interface DurableBootstrapRoleResult {
	roleId: string;
	identityPath: string;
	durableHomeChatKey: string;
	previousHomeChat?: string;
}

export interface DurableBootstrapResult {
	homeDir: string;
	dataDir: string;
	agentDir: string;
	dbPath: string;
	settingsPath: string;
	eventsPath: string;
	boardPath: string;
	bootstrappedRoles: DurableBootstrapRoleResult[];
	jsonlFilesCreated: number;
}

/**
 * Returns true if `value` is a durable session reference (`durable:<sessionId>`
 * or `<dbName>.db:<sessionId>`).
 */
export function isDurableSessionRef(value: string | null | undefined): boolean {
	if (typeof value !== "string") return false;
	const trimmed = value.trim();
	if (!trimmed) return false;
	if (trimmed.startsWith(DURABLE_SESSION_KEY_PREFIX)) {
		return trimmed.slice(DURABLE_SESSION_KEY_PREFIX.length).trim().length > 0;
	}
	return /^[A-Za-z0-9_.-]+\.db:[A-Za-z0-9_.-]+$/.test(trimmed);
}

/**
 * Normalize a session ID or `durable:<sessionId>` into `durable:<sessionId>`.
 */
export function toDurableSessionKey(sessionIdOrKey: string): string {
	const trimmed = sessionIdOrKey.trim();
	if (trimmed.startsWith(DURABLE_SESSION_KEY_PREFIX)) {
		return trimmed;
	}
	return `${DURABLE_SESSION_KEY_PREFIX}${trimmed}`;
}

/**
 * Extract the raw `sessionId` from `durable:<sessionId>` (or `<dbName>.db:<sessionId>`).
 */
export function fromDurableSessionKey(sessionIdOrKey: string): string {
	const trimmed = sessionIdOrKey.trim();
	if (trimmed.startsWith(DURABLE_SESSION_KEY_PREFIX)) {
		return trimmed.slice(DURABLE_SESSION_KEY_PREFIX.length);
	}
	const colonIdx = trimmed.indexOf(":");
	if (colonIdx > 0 && trimmed.slice(0, colonIdx).endsWith(".db")) {
		return trimmed.slice(colonIdx + 1);
	}
	return trimmed;
}

/**
 * Resolve the path to `durable-sessions.db` inside `dataDir` unless an explicit `dbPath` is given.
 */
export function resolveDurableDbPath(dataDir: string, dbPath?: string): string {
	if (dbPath && dbPath.trim()) {
		return resolve(dbPath.trim());
	}
	return resolve(join(dataDir, DEFAULT_DURABLE_DB_FILE));
}

export const CURRENT_DURABLE_SCHEMA_VERSION = 2;

export const DEFAULT_PORTABLE_SETTINGS: Record<string, unknown> = {
	defaultProvider: "anthropic",
	defaultModel: "claude-opus-4-6",
	defaultThinkingLevel: "high",
	quietStartup: true,
	packages: [
		"$HOME/.pi/agent/npm/node_modules/pi-mcp-adapter",
		"$HOME/projects/pi-multi-pass",
		"$HOME/.pi/agent/npm/node_modules/pi-AskUserQuestion",
		"$HOME/.pi/agent/npm/node_modules/pi-subagents",
		"$HOME/projects/pi-image-trim",
		"$HOME/.pi/agent/npm/node_modules/pi-bash-guard",
		"$HOME/projects/pi-worktree",
		"$HOME/.pi/agent/npm/node_modules/pi-control-chrome",
		"$HOME/.pi/agent/npm/node_modules/pi-safety",
		"$HOME/projects/pi-queue",
		"$HOME/projects/pi-tldr",
		"$HOME/projects/pi-identity",
	],
	compaction: {
		enabled: false,
	},
};

export type ExtendedDurableBootstrapOptions = DurableBootstrapOptions;

function sha256Hex(input: string): string {
	return createHash("sha256").update(input, "utf8").digest("hex");
}

function writeFileAtomicSync(filePath: string, content: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmpPath, content, "utf8");
	renameSync(tmpPath, filePath);
}

/**
 * Replace hardcoded user home paths (such as `/home/shinelay/...` or `sourceHomeDir/...`)
 * with `$HOME/...` so `settings.json` is portable across environments.
 */
export function rewritePathToPortableHome(value: string, sourceHomeDir?: string): string {
	let result = value;
	if (sourceHomeDir) {
		const normalizedSource = sourceHomeDir.replace(/\/+$/, "");
		if (normalizedSource.length > 1) {
			if (result === normalizedSource) {
				result = "$HOME";
			} else if (result.startsWith(`${normalizedSource}/`)) {
				result = `$HOME/${result.slice(normalizedSource.length + 1)}`;
			}
		}
	}
	result = result.replace(/^\/home\/[^/]+(?=\/|$)/, "$HOME");
	result = result.replace(/^\/Users\/[^/]+(?=\/|$)/, "$HOME");
	return result;
}

/**
 * Recursively convert hardcoded home directory paths inside a `settings.json` object
 * into `$HOME`-portable paths.
 */
export function makeSettingsPortable<T>(value: T, sourceHomeDir?: string): T {
	if (typeof value === "string") {
		return rewritePathToPortableHome(value, sourceHomeDir) as T;
	}
	if (Array.isArray(value)) {
		return value.map((item) => makeSettingsPortable(item, sourceHomeDir)) as T;
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = makeSettingsPortable(v, sourceHomeDir);
		}
		return out as T;
	}
	return value;
}

/**
 * Initialize SQLite WAL schema v2 on `durable-sessions.db`.
 *
 * Sets up:
 *   1. `@earendil-works/pi-durable` schema v2 tables (`durable_schema` at version 2,
 *      `durable_metadata`, `record_ids`, `conversations`, `entries`, `tasks`,
 *      `submissions`, `documents`, `document_revisions`).
 *   2. `DurableStorageDriver` tables (`durable_meta`, `durable_sessions`,
 *      `durable_entries`, `durable_branches`, `durable_Idempotency`,
 *      `durable_drafts`, `durable_checkpoints`).
 *   3. Session-port v2 tables (`durable_schema_version`, `session_metadata`,
 *      `session_entries`, `session_compaction_state`, `session_leaf_checkpoints`,
 *      `session_turns`).
 */
export function initializeDurableDatabaseSchema(db: DatabaseSync): void {
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec("PRAGMA busy_timeout = 5000");
	db.exec(`PRAGMA user_version = ${CURRENT_DURABLE_SCHEMA_VERSION}`);

	db.exec(`
		-- 1. @earendil-works/pi-durable SQLite storage schema v2
		CREATE TABLE IF NOT EXISTS durable_schema (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			version INTEGER NOT NULL CHECK (version >= 0)
		) STRICT;

		INSERT OR REPLACE INTO durable_schema (singleton, version)
		VALUES (1, ${CURRENT_DURABLE_SCHEMA_VERSION});

		CREATE TABLE IF NOT EXISTS durable_metadata (
			singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
			next_id TEXT NOT NULL,
			next_seq INTEGER NOT NULL
		) STRICT;

		INSERT OR IGNORE INTO durable_metadata (singleton, next_id, next_seq)
		VALUES (1, '2', 1);

		CREATE TABLE IF NOT EXISTS record_ids (
			id INTEGER PRIMARY KEY,
			record_type TEXT NOT NULL CHECK (record_type IN ('conversation', 'entry', 'task', 'submission', 'document'))
		) STRICT;

		CREATE TABLE IF NOT EXISTS conversations (
			id INTEGER PRIMARY KEY,
			owner_conversation_id INTEGER,
			owner_task_id INTEGER,
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT;

		CREATE INDEX IF NOT EXISTS conversations_by_owner_conversation
			ON conversations (owner_conversation_id, id);
		CREATE INDEX IF NOT EXISTS conversations_by_owner_task
			ON conversations (owner_task_id, id);

		CREATE TABLE IF NOT EXISTS entries (
			id INTEGER PRIMARY KEY,
			conversation_id INTEGER NOT NULL,
			head INTEGER,
			commit_seq INTEGER NOT NULL,
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT;

		CREATE INDEX IF NOT EXISTS entries_by_conversation
			ON entries (conversation_id, id DESC);
		CREATE INDEX IF NOT EXISTS entry_heads_by_conversation
			ON entries (conversation_id, id DESC) WHERE head IS NOT NULL;

		CREATE TABLE IF NOT EXISTS tasks (
			id INTEGER PRIMARY KEY,
			conversation_id INTEGER NOT NULL,
			kind TEXT NOT NULL,
			status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'waiting', 'sleeping', 'completing', 'terminal')),
			abort_requested INTEGER NOT NULL CHECK (abort_requested IN (0, 1)),
			background INTEGER NOT NULL CHECK (background IN (0, 1)),
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT;

		CREATE INDEX IF NOT EXISTS tasks_by_status ON tasks (status, id);
		CREATE INDEX IF NOT EXISTS tasks_by_conversation ON tasks (conversation_id, id);
		CREATE INDEX IF NOT EXISTS tasks_by_kind ON tasks (kind, id);
		CREATE INDEX IF NOT EXISTS tasks_by_abort_requested ON tasks (abort_requested, id);
		CREATE INDEX IF NOT EXISTS tasks_by_background ON tasks (background, id);

		CREATE TABLE IF NOT EXISTS submissions (
			id INTEGER PRIMARY KEY,
			conversation_id INTEGER NOT NULL,
			request_id TEXT,
			status TEXT NOT NULL CHECK (status IN ('queued', 'placed', 'done', 'unanswered')),
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT;

		CREATE INDEX IF NOT EXISTS submissions_by_request ON submissions (conversation_id, request_id);
		CREATE INDEX IF NOT EXISTS submissions_by_conversation ON submissions (conversation_id, id);
		CREATE INDEX IF NOT EXISTS submissions_by_status ON submissions (status, id);

		CREATE TABLE IF NOT EXISTS documents (
			id INTEGER PRIMARY KEY,
			kind TEXT NOT NULL,
			family INTEGER NOT NULL CHECK (family IN (0, 1)),
			key_value TEXT NOT NULL,
			scope_kind TEXT NOT NULL CHECK (scope_kind IN ('session', 'conversation', 'task')),
			owner_id INTEGER NOT NULL,
			created_at INTEGER NOT NULL,
			retired_at INTEGER,
			record TEXT NOT NULL CHECK (json_valid(record))
		) STRICT;

		CREATE INDEX IF NOT EXISTS documents_by_address
			ON documents (kind, scope_kind, owner_id, family, key_value, created_at DESC, retired_at);
		CREATE INDEX IF NOT EXISTS documents_by_scope
			ON documents (scope_kind, owner_id, id);
		CREATE INDEX IF NOT EXISTS documents_by_scope_kind
			ON documents (scope_kind, owner_id, kind, id);

		CREATE TABLE IF NOT EXISTS document_revisions (
			document_id INTEGER NOT NULL,
			seq INTEGER NOT NULL,
			kind TEXT NOT NULL CHECK (kind IN ('base', 'delta')),
			version INTEGER NOT NULL,
			content TEXT NOT NULL CHECK (json_valid(content)),
			PRIMARY KEY (document_id, seq)
		) STRICT;

		CREATE INDEX IF NOT EXISTS document_revisions_by_kind
			ON document_revisions (document_id, kind, seq DESC);

		-- 2. DurableStorageDriver tables
		CREATE TABLE IF NOT EXISTS durable_meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);

		INSERT OR REPLACE INTO durable_meta (key, value)
		VALUES ('schema_version', '${CURRENT_DURABLE_SCHEMA_VERSION}'),
		       ('engine', '@earendil-works/pi-durable');

		CREATE TABLE IF NOT EXISTS durable_sessions (
			session_id TEXT PRIMARY KEY,
			file_path TEXT NOT NULL UNIQUE,
			cwd TEXT NOT NULL,
			name TEXT,
			model_provider TEXT,
			model_id TEXT,
			thinking_level TEXT,
			parent_session TEXT,
			active_branch TEXT NOT NULL DEFAULT 'main',
			leaf_entry_id TEXT,
			entry_count INTEGER NOT NULL DEFAULT 0,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);

		CREATE INDEX IF NOT EXISTS idx_durable_sessions_updated
			ON durable_sessions(updated_at DESC);
		CREATE INDEX IF NOT EXISTS idx_durable_sessions_file
			ON durable_sessions(file_path);

		CREATE TABLE IF NOT EXISTS durable_entries (
			session_id TEXT NOT NULL,
			seq INTEGER NOT NULL,
			entry_id TEXT NOT NULL,
			parent_id TEXT,
			branch_name TEXT NOT NULL DEFAULT 'main',
			entry_type TEXT NOT NULL,
			custom_type TEXT,
			role TEXT,
			timestamp TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			content_hash TEXT NOT NULL,
			PRIMARY KEY (session_id, seq),
			UNIQUE (session_id, entry_id),
			FOREIGN KEY (session_id) REFERENCES durable_sessions(session_id) ON DELETE CASCADE
		);

		CREATE INDEX IF NOT EXISTS idx_durable_entries_parent
			ON durable_entries(session_id, parent_id);
		CREATE INDEX IF NOT EXISTS idx_durable_entries_type
			ON durable_entries(session_id, entry_type, custom_type);

		CREATE TABLE IF NOT EXISTS durable_branches (
			session_id TEXT NOT NULL,
			branch_name TEXT NOT NULL,
			head_entry_id TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			PRIMARY KEY (session_id, branch_name),
			FOREIGN KEY (session_id) REFERENCES durable_sessions(session_id) ON DELETE CASCADE
		);

		CREATE TABLE IF NOT EXISTS durable_Idempotency (
			scope TEXT NOT NULL,
			idempotency_key TEXT NOT NULL,
			session_id TEXT,
			entry_id TEXT,
			result_json TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (scope, idempotency_key)
		);

		CREATE TABLE IF NOT EXISTS durable_drafts (
			draft_key TEXT PRIMARY KEY,
			session_id TEXT,
			kind TEXT NOT NULL,
			payload_json TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		);

		CREATE TABLE IF NOT EXISTS durable_checkpoints (
			session_id TEXT NOT NULL,
			checkpoint_id TEXT NOT NULL,
			leaf_entry_id TEXT,
			state_json TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			PRIMARY KEY (session_id, checkpoint_id),
			FOREIGN KEY (session_id) REFERENCES durable_sessions(session_id) ON DELETE CASCADE
		);

		-- 3. Session-port v2 tables
		CREATE TABLE IF NOT EXISTS durable_schema_version (
			version INTEGER NOT NULL
		);

		DELETE FROM durable_schema_version;
		INSERT INTO durable_schema_version (version) VALUES (${CURRENT_DURABLE_SCHEMA_VERSION});

		CREATE TABLE IF NOT EXISTS session_metadata (
			session_id TEXT PRIMARY KEY,
			version INTEGER NOT NULL DEFAULT 3,
			created_at TEXT NOT NULL,
			cwd TEXT NOT NULL,
			parent_session TEXT
		);

		CREATE TABLE IF NOT EXISTS session_entries (
			rowid INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			parent_id TEXT,
			entry_type TEXT NOT NULL,
			timestamp TEXT NOT NULL,
			data_json TEXT NOT NULL,
			UNIQUE(session_id, entry_id)
		);

		CREATE INDEX IF NOT EXISTS idx_session_entries_session
			ON session_entries(session_id, rowid);
		CREATE INDEX IF NOT EXISTS idx_session_entries_parent
			ON session_entries(session_id, parent_id);

		CREATE TABLE IF NOT EXISTS session_compaction_state (
			session_id TEXT PRIMARY KEY,
			state_json TEXT NOT NULL,
			updated_at TEXT NOT NULL
		);

		CREATE TABLE IF NOT EXISTS session_leaf_checkpoints (
			session_id TEXT NOT NULL,
			leaf_id TEXT NOT NULL,
			summary_text TEXT NOT NULL,
			entry_rowid INTEGER NOT NULL,
			created_at TEXT NOT NULL,
			PRIMARY KEY (session_id, leaf_id)
		);

		CREATE TABLE IF NOT EXISTS session_turns (
			turn_id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL,
			status TEXT NOT NULL,
			prompt_text TEXT NOT NULL,
			started_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			completed_at TEXT,
			leaf_before TEXT,
			leaf_after TEXT,
			turn_index INTEGER NOT NULL DEFAULT 0,
			pid INTEGER NOT NULL,
			error_detail TEXT
		);
	`);
}

/**
 * Allocate the next `@earendil-works/pi-durable` numeric record ID and commit sequence
 * from `durable_metadata`.
 */
export function allocatePiDurableIdAndSeq(db: DatabaseSync, countIds = 1): { firstId: number; commitSeq: number } {
	const row = db
		.prepare("SELECT next_id, next_seq FROM durable_metadata WHERE singleton = 1")
		.get() as { next_id: string; next_seq: number } | undefined;
	const firstId = row ? Number(row.next_id) : 2;
	const commitSeq = row ? Number(row.next_seq) : 1;
	db.prepare("UPDATE durable_metadata SET next_id = ?, next_seq = ? WHERE singleton = 1").run(
		String(firstId + countIds),
		commitSeq + 1,
	);
	return { firstId, commitSeq };
}

/**
 * Create a durable session and its initial `customType: "identity"` entry inside
 * `durable-sessions.db`.
 */
function createRoleDurableHomeChatSession(
	db: DatabaseSync,
	params: {
		roleId: string;
		roleTitle: string;
		sessionId: string;
		durableKey: string;
		cwd: string;
		nowIso: string;
		nowMs: number;
	},
): void {
	const { roleId, roleTitle, sessionId, durableKey, cwd, nowIso, nowMs } = params;
	const entryId = `id-${roleId}-${randomUUID().slice(0, 8)}`;
	const identityEntryObj = {
		type: "custom",
		customType: "identity",
		id: entryId,
		parentId: null,
		timestamp: nowIso,
		data: {
			id: roleId,
			name: roleId,
			title: roleTitle,
			via: "durable-bootstrap",
		},
	};
	const payloadJson = JSON.stringify(identityEntryObj);
	const contentHash = sha256Hex(payloadJson);

	db.exec("BEGIN IMMEDIATE");
	try {
		// 1. DurableStorageDriver tables
		db.prepare(
			`INSERT OR REPLACE INTO durable_sessions (
				session_id, file_path, cwd, name, model_provider, model_id, thinking_level,
				parent_session, active_branch, leaf_entry_id, entry_count, created_at, updated_at
			) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, 'main', ?, 1, ?, ?)`,
		).run(sessionId, durableKey, cwd, `${roleTitle} home`, entryId, nowMs, nowMs);

		db.prepare(
			`INSERT OR REPLACE INTO durable_branches (
				session_id, branch_name, head_entry_id, created_at, updated_at
			) VALUES (?, 'main', ?, ?, ?)`,
		).run(sessionId, entryId, nowMs, nowMs);

		db.prepare(
			`INSERT OR REPLACE INTO durable_entries (
				session_id, seq, entry_id, parent_id, branch_name, entry_type,
				custom_type, role, timestamp, payload_json, content_hash
			) VALUES (?, 1, ?, NULL, 'main', 'custom', 'identity', NULL, ?, ?, ?)`,
		).run(sessionId, entryId, nowIso, payloadJson, contentHash);

		// 2. Session-port v2 tables
		db.prepare(
			`INSERT OR REPLACE INTO session_metadata (
				session_id, version, created_at, cwd, parent_session
			) VALUES (?, 3, ?, ?, NULL)`,
		).run(sessionId, nowIso, cwd);

		db.prepare(
			`INSERT OR REPLACE INTO session_entries (
				session_id, entry_id, parent_id, entry_type, timestamp, data_json
			) VALUES (?, ?, NULL, 'custom', ?, ?)`,
		).run(sessionId, entryId, nowIso, payloadJson);

		// 3. @earendil-works/pi-durable tables (conversations + entries)
		const { firstId, commitSeq } = allocatePiDurableIdAndSeq(db, 2);
		const convNumericId = firstId;
		const entryNumericId = firstId + 1;

		db.prepare("INSERT OR IGNORE INTO record_ids (id, record_type) VALUES (?, 'conversation')").run(convNumericId);
		db.prepare(
			"INSERT INTO conversations (id, owner_conversation_id, owner_task_id, record) VALUES (?, NULL, NULL, ?)",
		).run(
			convNumericId,
			JSON.stringify({
				id: convNumericId,
			}),
		);

		db.prepare("INSERT OR IGNORE INTO record_ids (id, record_type) VALUES (?, 'entry')").run(entryNumericId);
		db.prepare(
			"INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, ?, NULL, ?, ?)",
		).run(
			entryNumericId,
			convNumericId,
			commitSeq,
			JSON.stringify({
				id: entryNumericId,
				conversationId: convNumericId,
				kind: "pi-web-ui.custom",
				data: {
					sessionId,
					durableKey,
					entry: identityEntryObj,
				},
			}),
		);

		db.exec("COMMIT");
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

function countJsonlFilesRecursive(dirPath: string): number {
	if (!existsSync(dirPath)) return 0;
	let count = 0;
	for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
		const fullPath = join(dirPath, entry.name);
		if (entry.isDirectory()) {
			count += countJsonlFilesRecursive(fullPath);
		} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			count += 1;
		}
	}
	return count;
}

/**
 * Synchronously bootstrap a clean durable environment in `homeDir` (or explicit `dataDir`/`agentDir`).
 */
export function bootstrapDurableEnvironmentSync(
	options: ExtendedDurableBootstrapOptions = {},
): DurableBootstrapResult {
	const homeDir = resolve(options.homeDir ?? process.env.HOME ?? homedir());
	const dataDir = resolve(options.dataDir ?? join(homeDir, ".pi-web-ui"));
	const agentDir = resolve(options.agentDir ?? join(homeDir, ".pi", "agent"));
	const dbPath = resolveDurableDbPath(dataDir, options.dbPath);
	const settingsPath = join(agentDir, "settings.json");
	const eventsPath = join(agentDir, "work", "events.jsonl");
	const boardPath = join(dataDir, "board.json");
	const roleBoardPath = join(dataDir, "role-board.json");
	const identitiesRoot = join(agentDir, "memory", "identities");
	const defaultCwd = options.cwd ?? join(homeDir, "projects");

	mkdirSync(dataDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(dirname(eventsPath), { recursive: true });
	mkdirSync(identitiesRoot, { recursive: true });
	mkdirSync(dirname(dbPath), { recursive: true });

	// 1. Generate $HOME-portable settings.json
	let rawSettings: Record<string, unknown> = DEFAULT_PORTABLE_SETTINGS;
	if (options.templateSettingsPath && existsSync(options.templateSettingsPath)) {
		rawSettings = JSON.parse(readFileSync(options.templateSettingsPath, "utf8")) as Record<string, unknown>;
	} else if (existsSync(settingsPath)) {
		rawSettings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
	}
	const portableSettings = makeSettingsPortable(rawSettings, options.sourceHomeDir);
	writeFileAtomicSync(settingsPath, `${JSON.stringify(portableSettings, null, 2)}\n`);

	// 2. Initialize ~/.pi/agent/work/events.jsonl and ~/.pi-web-ui/board.json (plus role-board.json) if absent
	if (!existsSync(eventsPath)) {
		writeFileAtomicSync(eventsPath, "");
	}
	const emptyBoardJson = `${JSON.stringify({ version: 1, posts: [] }, null, 2)}\n`;
	if (!existsSync(boardPath)) {
		writeFileAtomicSync(boardPath, emptyBoardJson);
	}
	if (!existsSync(roleBoardPath)) {
		writeFileAtomicSync(roleBoardPath, emptyBoardJson);
	}

	// 3. Seed optional role directories if requested
	if (Array.isArray(options.seedRoleIds)) {
		for (const rawRoleId of options.seedRoleIds) {
			const roleId = rawRoleId.trim();
			if (!roleId) continue;
			const roleDir = join(identitiesRoot, roleId);
			const idFile = join(roleDir, "identity.json");
			if (!existsSync(idFile)) {
				mkdirSync(roleDir, { recursive: true });
				writeFileAtomicSync(
					idFile,
					`${JSON.stringify({ id: roleId, title: roleId, description: "" }, null, 2)}\n`,
				);
			}
		}
	}

	// 4. Initialize SQLite WAL durable-sessions.db (schema v2) and bootstrap role homeChat sessions
	const db = new DatabaseSync(dbPath);
	const bootstrappedRoles: DurableBootstrapResult["bootstrappedRoles"] = [];
	try {
		initializeDurableDatabaseSchema(db);

		const roleDirs = existsSync(identitiesRoot)
			? readdirSync(identitiesRoot)
					.sort()
					.map((name) => join(identitiesRoot, name))
					.filter((fullPath) => {
						try {
							return statSync(fullPath).isDirectory() && existsSync(join(fullPath, "identity.json"));
						} catch {
							return false;
						}
					})
			: [];

		for (const roleDir of roleDirs) {
			const identityPath = join(roleDir, "identity.json");
			const rawObj = JSON.parse(readFileSync(identityPath, "utf8")) as Record<string, unknown>;
			const folderId = basename(roleDir);
			const roleId = typeof rawObj.id === "string" && rawObj.id.trim() ? rawObj.id.trim() : folderId;
			const roleTitle = typeof rawObj.title === "string" && rawObj.title.trim() ? rawObj.title.trim() : roleId;
			const previousHomeChat =
				typeof rawObj.homeChat === "string" && rawObj.homeChat.trim() ? rawObj.homeChat.trim() : undefined;

			const existingPastHomeChats = Array.isArray(rawObj.pastHomeChats)
				? rawObj.pastHomeChats.filter(
						(item): item is string => typeof item === "string" && item.trim().length > 0,
					)
				: [];

			let sessionId: string;
			let durableHomeChatKey: string;
			if (previousHomeChat && isDurableSessionRef(previousHomeChat)) {
				sessionId = fromDurableSessionKey(previousHomeChat);
				durableHomeChatKey = toDurableSessionKey(sessionId);
			} else {
				sessionId = `home-${roleId}-${randomUUID().slice(0, 8)}`;
				durableHomeChatKey = toDurableSessionKey(sessionId);
			}

			const nextPastHomeChats = [...existingPastHomeChats];
			if (
				previousHomeChat &&
				previousHomeChat !== durableHomeChatKey &&
				!nextPastHomeChats.includes(previousHomeChat)
			) {
				nextPastHomeChats.push(previousHomeChat);
			}

			const nowMs = Date.now();
			const nowIso = new Date(nowMs).toISOString();

			createRoleDurableHomeChatSession(db, {
				roleId,
				roleTitle,
				sessionId,
				durableKey: durableHomeChatKey,
				cwd: defaultCwd,
				nowIso,
				nowMs,
			});

			const updatedIdentity: Record<string, unknown> = {
				...rawObj,
				id: roleId,
				title: roleTitle,
				description: typeof rawObj.description === "string" ? rawObj.description : "",
				homeChat: durableHomeChatKey,
			};
			if (nextPastHomeChats.length > 0) {
				updatedIdentity.pastHomeChats = nextPastHomeChats;
			} else {
				delete updatedIdentity.pastHomeChats;
			}
			writeFileAtomicSync(identityPath, `${JSON.stringify(updatedIdentity, null, 2)}\n`);

			bootstrappedRoles.push({
				roleId,
				identityPath,
				durableHomeChatKey,
				...(previousHomeChat && previousHomeChat !== durableHomeChatKey ? { previousHomeChat } : {}),
			});
		}

		db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
	} finally {
		db.close();
	}

	const sessionsDir = join(agentDir, "sessions");
	const jsonlFilesCreated = countJsonlFilesRecursive(sessionsDir);

	return {
		homeDir,
		dataDir,
		agentDir,
		dbPath,
		settingsPath,
		eventsPath,
		boardPath,
		bootstrappedRoles,
		jsonlFilesCreated,
	};
}

/**
 * Async entry point matching `DurableBootstrapOptions` -> `Promise<DurableBootstrapResult>`.
 */
export async function bootstrapDurableEnvironment(
	options: ExtendedDurableBootstrapOptions = {},
): Promise<DurableBootstrapResult> {
	return bootstrapDurableEnvironmentSync(options);
}
