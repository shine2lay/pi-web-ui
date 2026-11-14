/**
 * OpenViking memory — the one canonical reader per state file in `<HOME>/.pi/openviking/` that a route reads.
 *
 * History lines are never rewritten, so each reader accepts the contract names (Ops #808-#810)
 * first and the older live names second (G2, G4, G5). JSONL envelopes are read by the contract's key names
 * only (Architecture #523, rm-0964900e): `timestamp`, and on changelog lines `action`/`role`/`uri`/`source`.
 * Nothing here writes; the Memory Explorer's owner lines are appended by changelog-append.ts and read back here.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { OWNER_EXPLORER_SOURCE, type OwnerExplorerAction, type OwnerExplorerOutcome } from "./explorer-types.js";
import type { OpenVikingPendingWtLandSync } from "./types.js";
import { isSessionUri } from "./uri.js";

export interface OpenVikingStatePaths {
	readonly stateDir: string;
	readonly metricsJsonlPath: string;
	readonly changelogJsonlPath: string;
	readonly rolloutStateJsonPath: string;
}

/** `<HOME>/.pi/openviking`, read when asked (ops #871): a sealed run's temp HOME points it into the sandbox. */
export function defaultOpenVikingStateDir(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.HOME || homedir(), ".pi", "openviking");
}

export function resolveOpenVikingStatePaths(stateDir = defaultOpenVikingStateDir()): OpenVikingStatePaths {
	return {
		stateDir,
		metricsJsonlPath: join(stateDir, "metrics.jsonl"),
		changelogJsonlPath: join(stateDir, "memory-changelog.jsonl"),
		rolloutStateJsonPath: join(stateDir, "rollout-state.json"),
	};
}

type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const firstStr = (...vals: unknown[]): string | null => vals.map(str).find((v) => v !== null) ?? null;
const taskIdOf = (o: JsonObject): string | number | null =>
	num(o.taskId) ?? num(o.task_id) ?? firstStr(o.taskId, o.task_id);

/** File text, or null when the file does not exist yet. Any other read error fails loud. */
async function readOptional(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

/** A JSON object file; gone, unreadable, bad JSON or not an object all read as `null` (nothing looked at). */
async function readJsonObjectOrNull(path: string): Promise<JsonObject | null> {
	try {
		const text = await readOptional(path);
		if (text === null) return null;
		const parsed: unknown = JSON.parse(text);
		return isObject(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

interface JsonlLine {
	line: number;
	ts: string;
	tsMs: number;
	obj: JsonObject;
}

/** Parsed lines with a valid `timestamp`; a torn or foreign line is skipped. */
async function readJsonl(path: string): Promise<JsonlLine[]> {
	const text = await readOptional(path);
	if (text === null) return [];
	const out: JsonlLine[] = [];
	text.split("\n").forEach((raw, idx) => {
		if (!raw.trim()) return;
		let obj: unknown;
		try {
			obj = JSON.parse(raw);
		} catch {
			return;
		}
		if (!isObject(obj)) return;
		const ts = str(obj.timestamp);
		const tsMs = ts === null ? Number.NaN : Date.parse(ts);
		if (ts !== null && Number.isFinite(tsMs)) out.push({ line: idx + 1, ts, tsMs, obj });
	});
	return out;
}

// ---- metrics.jsonl (G2) ----

export interface OpenVikingMetricsRecord {
	line: number;
	ts: string;
	tsMs: number;
	event: string;
	role: string | null;
	/** The line's `session_id` is a pi session uuid (or absent): only these lines are live samples (#828). */
	piSession: boolean;
	taskId: string | number | null;
	degradedFallback: boolean;
}

const PI_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * #828: a `session_id` that is not a pi session uuid is not a live sample. Two such lines sit in the live store
 * (`session_id: "worker-sess-803"`, 2026-11-11T09:54Z and 09:56Z); writing them stopped in pi-openviking 1a842ac,
 * but they stay on disk as evidence for the restore plan, and until 2026-11-11T17:43Z they were the only lines
 * with a project, so every slot 1-3 rate came from those two. A rate must never be read off them.
 * A line with no `session_id` at all counts as a pi session: it is an old line, not a foreign one.
 */
function isPiSessionId(sessionId: string | null): boolean {
	return sessionId === null || PI_SESSION_ID.test(sessionId);
}

export async function readMetricsRecords(paths: OpenVikingStatePaths): Promise<OpenVikingMetricsRecord[]> {
	return (await readJsonl(paths.metricsJsonlPath)).map(({ line, ts, tsMs, obj }) => {
		return {
			line,
			ts,
			tsMs,
			event: str(obj.event) ?? "unknown",
			role: str(obj.role),
			piSession: isPiSessionId(str(obj.session_id)),
			taskId: taskIdOf(obj),
			degradedFallback: obj.degradedFallback === true || obj.lead_200k_acp_fallback === true,
		};
	});
}

// ---- memory-changelog.jsonl (G4) ----

/**
 * Contract write actions (#809), plus agent-tools' per-`wt land` summary rows (R-CHANGELOG-1a): `sync_resource`, and
 * `sync_failed` (live `sync_resource_failed`), which is not a memory write.
 */
export type OpenVikingChangelogAction =
	| "add"
	| "update"
	| "delete"
	| "reject_preference_candidate"
	| "promote_preference_candidate"
	| "sync_resource"
	| "sync_failed"
	| OwnerExplorerAction;

const OWNER_ACTIONS: ReadonlySet<string> = new Set<OwnerExplorerAction>(["owner_edit", "owner_delete", "owner_undo"]);
const OWNER_OUTCOMES: ReadonlySet<string> = new Set<OwnerExplorerOutcome>([
	"applied",
	"cancelled",
	"not_applied_restart",
	"failed",
	"refused",
	"unconfirmed",
]);

/** Known raw actions; an owner action counts only on an `owner_explorer` line, which carries no other (R-CHANGELOG-1e). */
const CHANGELOG_ACTIONS: Record<string, OpenVikingChangelogAction> = {
	owner_edit: "owner_edit",
	owner_delete: "owner_delete",
	owner_undo: "owner_undo",
	add: "add",
	update: "update",
	delete: "delete",
	reject_preference_candidate: "reject_preference_candidate",
	promote_preference_candidate: "promote_preference_candidate",
	added: "add",
	updated: "update",
	deleted: "delete",
	sync_resource: "sync_resource",
	sync_resource_failed: "sync_failed",
	session_commit: "add",
	preference_write: "promote_preference_candidate",
	resource_sync: "sync_resource",
	preference_write_blocked: "reject_preference_candidate",
};

/** Writers whose `add` is a session commit: post-task `queue_done` and the 200K lead commit. */
const SESSION_COMMIT_SOURCES = new Set(["queue_done", "session_commit_200k"]);

/**
 * Spec "Session Commits" (rm-9724bae9, rm-84facfcf): a session committing its own work, classified by meaning
 * (URI + source) so no rename can re-include an excluded write. The pre-rename `session_commit` is one by itself;
 * otherwise an `add` (or old `added`) to the session's own URI from `queue_done` / `session_commit_200k`.
 * Migration, lead_direct and any other write, to any URI under any name, is not one.
 */
function isSessionCommit(r: Omit<OpenVikingChangelogRecord, "sessionCommit">): boolean {
	if (r.rawAction === "session_commit") return true;
	return r.action === "add" && SESSION_COMMIT_SOURCES.has(r.source) && isSessionUri(r.uri);
}

function changelogActionOf(rawAction: string, source: string): OpenVikingChangelogAction | null {
	if (!Object.hasOwn(CHANGELOG_ACTIONS, rawAction)) return null;
	return OWNER_ACTIONS.has(rawAction) === (source === OWNER_EXPLORER_SOURCE) ? CHANGELOG_ACTIONS[rawAction] : null;
}

/**
 * A memory write: a known action other than a failed resource sync, which wrote nothing (Ops #810). An owner line
 * only when its outcome is `applied`, and an `owner_undo` only when it wrote an edit back (R-CHANGELOG-1e).
 */
export function isMemoryWrite(r: OpenVikingChangelogRecord): boolean {
	if (r.action === null || r.action === "sync_failed") return false;
	if (r.owner === null) return true;
	return r.owner.outcome === "applied" && (r.action !== "owner_undo" || r.owner.undoOf === "edit");
}

/** What an `owner_explorer` line adds (G7); `undone` is derived by its readers, never stored. */
export interface OpenVikingOwnerChangelogFields {
	operationId: string | null;
	outcome: OwnerExplorerOutcome | null;
	undoOf: "edit" | "delete" | null;
}

function ownerFieldsOf(obj: Record<string, unknown>): OpenVikingOwnerChangelogFields {
	const outcome = str(obj.outcome);
	return {
		operationId: str(obj.operation_id),
		outcome: outcome !== null && OWNER_OUTCOMES.has(outcome) ? (outcome as OwnerExplorerOutcome) : null,
		undoOf: obj.undo_of === "edit" || obj.undo_of === "delete" ? obj.undo_of : null,
	};
}

export interface OpenVikingChangelogRecord {
	line: number;
	ts: string;
	tsMs: number;
	rawAction: string;
	/** null for an action no writer is known to emit; such lines are kept out of every count. */
	action: OpenVikingChangelogAction | null;
	/** A session commit (spec "Session Commits"), the only kind `last_commit_at` and the audit's `commit` count. */
	sessionCommit: boolean;
	source: string;
	role: string | null;
	taskId: string | number | null;
	uri: string;
	summary: string;
	/** Set on a classified owner line (`source: owner_explorer`), null on every other. */
	owner: OpenVikingOwnerChangelogFields | null;
}

export async function readChangelogRecords(paths: OpenVikingStatePaths): Promise<OpenVikingChangelogRecord[]> {
	return (await readJsonl(paths.changelogJsonlPath)).map(({ line, ts, tsMs, obj }) => {
		const rawAction = str(obj.action) ?? "unknown";
		const source = str(obj.source) ?? "unknown";
		const action = changelogActionOf(rawAction, source);
		const record = {
			line,
			ts,
			tsMs,
			rawAction,
			action,
			source,
			role: str(obj.role),
			taskId: taskIdOf(obj),
			uri: str(obj.uri) ?? "",
			summary: str(obj.summary) ?? "",
			owner: action !== null && OWNER_ACTIONS.has(action) ? ownerFieldsOf(obj) : null,
		};
		return { ...record, sessionCommit: isSessionCommit(record) };
	});
}

// ---- rollout-state.json (G5) ----

/** What a degraded verdict and a `pending sync` badge are read from (spec-states.md §4). */
export interface OpenVikingRolloutState {
	fallback_roles: string[];
	pending_wt_land_syncs: OpenVikingPendingWtLandSync[];
}

function pendingSync(v: unknown): OpenVikingPendingWtLandSync[] {
	if (!isObject(v)) return [];
	return [
		{
			project: str(v.project) ?? "unknown",
			repoRoot: str(v.repoRoot) ?? "",
			changedPaths: Array.isArray(v.changedPaths)
				? v.changedPaths.filter((p): p is string => typeof p === "string")
				: [],
			failedAt: str(v.failedAt) ?? "",
			error: str(v.error) ?? "",
		},
	];
}

/** An absent or unreadable file reads as nothing degraded and nothing pending. */
export async function readRolloutState(paths: OpenVikingStatePaths): Promise<OpenVikingRolloutState> {
	const o = (await readJsonObjectOrNull(paths.rolloutStateJsonPath)) ?? {};
	return {
		fallback_roles: Array.isArray(o.fallback_roles)
			? o.fallback_roles.filter((r): r is string => typeof r === "string")
			: [],
		pending_wt_land_syncs: Array.isArray(o.pending_wt_land_syncs) ? o.pending_wt_land_syncs.flatMap(pendingSync) : [],
	};
}
