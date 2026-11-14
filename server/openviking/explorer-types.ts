/**
 * Memory Explorer — the one contract both build slices use (backend #161, rule 18 Task 1): request and response
 * shapes of G2-G7 exactly as `.temper/features/openviking-dashboard/spec-explorer{,-writes}.md` (architecture #541)
 * tables them, every refusal code with its HTTP status, the changelog line of contract §7.4b R-CHANGELOG-1e, and the
 * dependencies a route gets (owner gate OI-1, clock, shutdown hook). Errors use the existing body
 * `{ error: { code, message, details? } }` through `OpenVikingDashboardError` (`explorerRefusal`, explorer-rules.ts).
 */
import type { OpenVikingOwnerGate } from "./owner-gate.js";
import type { OpenVikingHealthState, OpenVikingRoleId } from "./types.js";

// ---- refusals ----

/** Every refusal an explorer route answers, with its HTTP status (spec-explorer.md, spec-explorer-writes.md). */
export const OPENVIKING_EXPLORER_REFUSAL_STATUS = {
	URI_INVALID: 400,
	URI_OUTSIDE_ROOTS: 400,
	SETUP_FILE_LOCKED: 403,
	OWNER_ONLY: 403,
	NOT_A_FOLDER: 400,
	NOT_A_FILE: 400,
	LEVEL_INVALID: 400,
	ROOT_UNKNOWN: 400,
	SEARCH_INVALID: 400,
	CONTENT_TOO_LARGE: 413,
	EDIT_INVALID: 400,
	NOTE_CHANGED: 409,
	MEMORY_WRITE_FAILED: 502,
	FOLDER_DELETE_REFUSED: 400,
	DELETE_PENDING: 409,
	UNDO_REFUSED: 409,
	UNDO_WINDOW_CLOSED: 410,
	OPERATION_UNKNOWN: 404,
	NOT_FOUND: 404,
	MEMORY_UNREACHABLE: 503,
	MEMORY_ERROR: 502,
} as const;

export type OpenVikingExplorerRefusalCode = keyof typeof OPENVIKING_EXPLORER_REFUSAL_STATUS;
export const OPENVIKING_EXPLORER_REFUSAL_CODES = Object.keys(
	OPENVIKING_EXPLORER_REFUSAL_STATUS,
) as OpenVikingExplorerRefusalCode[];

/** `error.details` the spec names for a refusal; other refusals carry none or free-form context. */
export interface OpenVikingExplorerRefusalDetails {
	/** `NOTE_CHANGED`, `UNDO_REFUSED`: the store's mod_time now (ISO, ms). */
	current_mod_time?: string;
	/** `UNDO_WINDOW_CLOSED`: the operation's state when the undo came. */
	state?: OpenVikingOperationState;
	/** `DELETE_PENDING`: the delete that holds the uri. */
	operation_id?: string;
}

// ---- limits (spec numbers, one place) ----

export const EXPLORER_URI_MAX_CHARS = 1024;
/** R-EXPLORER-LOCK-1 (G8): last segments refused on read, edit and delete, case-insensitive. */
export const EXPLORER_SETUP_FILE_NAMES = ["identity.md", "soul.md"] as const;
/** G2 roots walk: `/api/v1/fs/tree` params; a walk returning `node_limit` nodes is unread (truncated). */
export const EXPLORER_ROOT_WALK = { include_abstract: false, level_limit: 32, node_limit: 20_000 } as const;
/** `mapWithLimit` width for per-root daemon calls (roots walk, exact search). */
export const EXPLORER_ROOTS_IN_FLIGHT = 4;
export const EXPLORER_RECENT_COUNT = 12;
export const EXPLORER_FOLDER_LIMIT = { min: 1, max: 200, default: 30 } as const;
export const EXPLORER_SEARCH_LIMIT = { min: 1, max: 200, defaultMeaning: 12, defaultExact: 50 } as const;
export const EXPLORER_QUERY_CHARS = { min: 1, max: 500 } as const;
/** G5: `content` up to 1 MiB (UTF-8 bytes), else `413 CONTENT_TOO_LARGE`. */
export const EXPLORER_CONTENT_MAX_BYTES = 1024 * 1024;
/** Undo window, from registering the operation, on the server's clock. */
export const EXPLORER_UNDO_WINDOW_MS = 10_000;

// ---- roots and kinds ----

export type OpenVikingExplorerRootGroup = "projects" | "shared" | "department";

/** One of the 17 roots (R-EXPLORER-ROOTS-1); the list is `OPENVIKING_EXPLORER_ROOTS` in memory-tree.ts. */
export interface OpenVikingExplorerRoot {
	uri: string;
	group: OpenVikingExplorerRootGroup;
	/** The owning role for a `department` root, else null. */
	role: OpenVikingRoleId | null;
}

/** A uri that passed R-EXPLORER-URI-1: canonical form plus the root it lies under. */
export interface OpenVikingExplorerUri {
	uri: string;
	root: OpenVikingExplorerRoot;
}

export type OpenVikingExplorerKind = "rule" | "case" | "fact" | "event" | "document" | "other";
export type OpenVikingExplorerKindCounts = Record<OpenVikingExplorerKind, number>;

/** Why a text field is null: never placeholder text. */
export type OpenVikingAbstractReason = "not_ready" | "none" | "locked";

// ---- G2 tree ----

export interface OpenVikingTreeRootRow {
	uri: string;
	group: OpenVikingExplorerRootGroup;
	role: OpenVikingRoleId | null;
	/** false: the root did not answer (or its walk was truncated); its counts are null and the row is kept. */
	read: boolean;
	notes: number | null;
	folders: number | null;
	kinds: OpenVikingExplorerKindCounts | null;
}

export interface OpenVikingRecentNote {
	uri: string;
	root: string;
	kind: OpenVikingExplorerKind;
	size: number;
	mod_time: string;
	locked: boolean;
}

/** `GET /api/openviking/tree/roots`. */
export interface OpenVikingTreeRootsResponse {
	checked_at: string;
	health_state: OpenVikingHealthState;
	/** Sum of `roots[].notes`; null when any root is unread (R-EXPLORER-COUNT-1), never 0 for unmeasured. */
	notes_total: number | null;
	unread_count: number;
	/** `unread_count > 0`. */
	roots_partial: boolean;
	/** All 17, constant order. */
	roots: OpenVikingTreeRootRow[];
	/** 12 newest files over read roots. */
	recent: OpenVikingRecentNote[];
}

export interface OpenVikingTreeFolderQuery {
	uri?: unknown;
	offset?: unknown;
	limit?: unknown;
}

export interface OpenVikingTreeChild {
	uri: string;
	name: string;
	is_folder: boolean;
	kind: OpenVikingExplorerKind;
	size: number | null;
	mod_time: string | null;
	/** Folders: notes below (null when the parent's count walk was truncated); files: null. */
	notes: number | null;
	abstract: string | null;
	abstract_reason: OpenVikingAbstractReason | null;
	locked: boolean;
}

/** `GET /api/openviking/tree?uri=<folder>&offset=&limit=`: one folder level, children newest first. */
export interface OpenVikingTreeFolderResponse {
	uri: string;
	root: string;
	/** null when `counts_reason` is "truncated": never a short count. */
	notes: number | null;
	folders: number | null;
	/** "truncated": the count walk returned `node_limit` nodes, so the level is served without counts; else null. */
	counts_reason: "truncated" | null;
	last_change: string | null;
	abstract: string | null;
	abstract_reason: OpenVikingAbstractReason | null;
	total: number;
	children: OpenVikingTreeChild[];
}

// ---- G3 note ----

export const OPENVIKING_NOTE_LEVELS = ["abstract", "overview", "full"] as const;
export type OpenVikingNoteLevel = (typeof OPENVIKING_NOTE_LEVELS)[number];

export interface OpenVikingNoteQuery {
	uri?: unknown;
	level?: unknown;
}

/** Newest changelog line for the uri, via `readChangelogRecords`. */
export interface OpenVikingNoteLastWrite {
	role: string | null;
	source: string;
	task_id: string | number | null;
	ts: string;
}

/** `GET /api/openviking/note?uri=&level=`. */
export interface OpenVikingNoteResponse {
	uri: string;
	root: string;
	kind: OpenVikingExplorerKind;
	is_folder: boolean;
	size: number | null;
	/** From `fs/stat`; what G5's `opened_mod_time` sends back. */
	mod_time: string;
	level: OpenVikingNoteLevel;
	/** Full text never cut. */
	text: string | null;
	text_reason: Exclude<OpenVikingAbstractReason, "locked"> | null;
	/** Whose text it is: a file's abstract/overview is its folder's (gap D1). */
	text_of: string;
	last_write: OpenVikingNoteLastWrite | null;
}

// ---- G4 search ----

export type OpenVikingSearchMode = "meaning" | "exact";

/** `POST /api/openviking/search` body as received (validated by the route). */
export interface OpenVikingSearchRequest {
	mode?: unknown;
	query?: unknown;
	roots?: unknown;
	limit?: unknown;
}

export interface OpenVikingSearchHit {
	uri: string;
	root: string;
	kind: OpenVikingExplorerKind;
	/** Raw daemon score (meaning); null (exact). */
	score: number | null;
	/** `score / max(score)` in this response, computed once server-side; null (exact). */
	relative: number | null;
	/** The hit's own abstract (meaning), else null. */
	abstract: string | null;
	line_number: number | null;
	line_text: string | null;
	/** From `fs/stat` per unique uri; null if that read fails. */
	size: number | null;
	mod_time: string | null;
}

export interface OpenVikingSearchResponse {
	mode: OpenVikingSearchMode;
	query: string;
	checked_at: string;
	total: number;
	truncated: boolean;
	results_partial: boolean;
	unread_count: number;
	unread_roots: string[];
	locked_hidden_count: number;
	hits: OpenVikingSearchHit[];
}

// ---- G5-G6 writes, undo ----

/** `PUT /api/openviking/note` body as received. */
export interface OpenVikingNoteEditRequest {
	uri?: unknown;
	content?: unknown;
	opened_mod_time?: unknown;
}

export interface OpenVikingNoteEditApplied {
	operation_id: string;
	uri: string;
	changed: true;
	mod_time: string;
	undo_until: string;
	before_sha256: string;
	after_sha256: string;
	audit_recorded: boolean;
}

/** Same sha as the store: a no-op, nothing written, no line. */
export interface OpenVikingNoteEditUnchanged {
	changed: false;
}

export type OpenVikingNoteEditResponse = OpenVikingNoteEditApplied | OpenVikingNoteEditUnchanged;

/** `DELETE /api/openviking/note?uri=` answers `202` with this. */
export interface OpenVikingNoteDeleteResponse {
	operation_id: string;
	uri: string;
	state: "pending";
	applies_at: string;
}

/** `POST /api/openviking/undo` body as received. */
export interface OpenVikingUndoRequest {
	operation_id?: unknown;
}

export type OpenVikingUndoResponse =
	{ operation_id: string; state: "cancelled" } | { operation_id: string; state: "undone"; mod_time: string };

/**
 * Operation states (spec-explorer-writes.md "Operation States"); in memory only. `undo_pending`: a held delete
 * whose undo was asked for (R-OWNER-UNDO-1); it never runs from there.
 */
export type OpenVikingOperationState =
	| "pending"
	| "undo_pending"
	| "applied"
	| "failed"
	| "cancelled"
	| "not_applied_restart"
	| "edited"
	| "undone"
	| "undo_refused"
	| "closed";

// ---- G7 change record (contract §7.4b R-CHANGELOG-1e) ----

export const OWNER_EXPLORER_SOURCE = "owner_explorer";
export const OWNER_EXPLORER_ROLE = "owner";
export const OWNER_EXPLORER_ACTIONS = ["owner_edit", "owner_delete", "owner_undo"] as const;
export type OwnerExplorerAction = (typeof OWNER_EXPLORER_ACTIONS)[number];
/** `unconfirmed`: an `owner_undo` whose confirmation was asked for and never given (R-OWNER-UNDO-1). */
export type OwnerExplorerOutcome =
	"applied" | "cancelled" | "not_applied_restart" | "failed" | "refused" | "unconfirmed";

/** One line of `memory-changelog.jsonl` written by the explorer: hashes and sizes, never the text. */
export interface OwnerExplorerChangelogLine {
	timestamp: string;
	role: typeof OWNER_EXPLORER_ROLE;
	source: typeof OWNER_EXPLORER_SOURCE;
	action: OwnerExplorerAction;
	operation_id: string;
	uri: string;
	outcome: OwnerExplorerOutcome;
	undo_of: "edit" | "delete" | null;
	before_sha256: string | null;
	after_sha256: string | null;
	summary: string;
	diff: null;
	task_id: null;
	session_id: null;
}

/** `/api/openviking/audit` `events[].action` values the owner's lines add (`owner_undo` lines are not events). */
export const OPENVIKING_OWNER_AUDIT_ACTIONS = ["owner_edit", "owner_delete"] as const;

/** Fields G7 adds to every audit event; null on non-owner events. `undone` is derived, never stored. */
export interface OpenVikingOwnerAuditFields {
	operation_id: string | null;
	outcome: OwnerExplorerOutcome | null;
	undone: boolean | null;
}

// ---- route dependencies ----

/**
 * The server's clock for the undo window and the held delete. Production: `systemExplorerClock`
 * (explorer-clock.ts); tests inject a manual clock that fires due timers when advanced.
 */
export interface OpenVikingExplorerClock {
	now(): number;
	setTimer(ms: number, fn: () => void): unknown;
	clearTimer(handle: unknown): void;
}

/** What the explorer routes are given (no env or fixture branch decides any of it, rule 29). */
export interface OpenVikingExplorerOptions {
	/** OI-1; production passes `ownerCheckPending` (R-OWNER-INTERIM-1) until the owner session (#165) deploys. */
	ownerGate: OpenVikingOwnerGate;
	clock: OpenVikingExplorerClock;
	/** Receives the hook that ends every pending delete as `not_applied_restart` when the server stops. */
	onShutdown: (hook: () => Promise<void>) => void;
}
