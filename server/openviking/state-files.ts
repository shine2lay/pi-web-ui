/**
 * OpenViking Memory Dashboard — the one canonical reader per state file in `/home/shinelay/.pi/openviking/`.
 *
 * History lines are never rewritten, so each reader accepts the contract names (Ops #808-#810)
 * first and the older live names second (G2, G4, G5, G6, G7). Read-only: nothing here writes.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_OPENVIKING_STATE_DIR, type OpenVikingPendingWtLandSync } from "./types.js";
import { isSessionUri } from "./uri.js";

export interface OpenVikingStatePaths {
	readonly stateDir: string;
	readonly metricsJsonlPath: string;
	readonly changelogJsonlPath: string;
	readonly rolloutStateJsonPath: string;
	readonly resourceSyncStateJsonPath: string;
	readonly migrationVerificationJsonPath: string;
	readonly seenRoleMessagesJsonPath: string;
}

export function resolveOpenVikingStatePaths(stateDir = DEFAULT_OPENVIKING_STATE_DIR): OpenVikingStatePaths {
	return {
		stateDir,
		metricsJsonlPath: join(stateDir, "metrics.jsonl"),
		changelogJsonlPath: join(stateDir, "memory-changelog.jsonl"),
		rolloutStateJsonPath: join(stateDir, "rollout-state.json"),
		resourceSyncStateJsonPath: join(stateDir, "resource-sync-state.json"),
		migrationVerificationJsonPath: join(stateDir, "migration-verification.json"),
		seenRoleMessagesJsonPath: join(stateDir, "seen-role-messages.json"),
	};
}

type JsonObject = Record<string, unknown>;

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const firstNum = (...vals: unknown[]): number | null => vals.map(num).find((v) => v !== null) ?? null;
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

async function readJsonObject(path: string): Promise<JsonObject | null> {
	const text = await readOptional(path);
	if (text === null) return null;
	const parsed: unknown = JSON.parse(text);
	if (!isObject(parsed)) throw new Error(`${path} is not a JSON object`);
	return parsed;
}

interface JsonlLine {
	line: number;
	ts: string;
	tsMs: number;
	obj: JsonObject;
}

/** Parsed lines with a valid `timestamp` (or contract `ts`); a torn or foreign line is skipped. */
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
		const ts = firstStr(obj.timestamp, obj.ts);
		const tsMs = ts === null ? Number.NaN : Date.parse(ts);
		if (ts !== null && Number.isFinite(tsMs)) out.push({ line: idx + 1, ts, tsMs, obj });
	});
	return out;
}

// ---- metrics.jsonl (G2, G3) ----

export type OpenVikingInjectionMode = "lead" | "worker";

export interface OpenVikingSlotSample {
	slot: number;
	state: string | null;
	l0HitCount: number | null;
	injectedTokensEst: number | null;
}

export interface OpenVikingInjection {
	mode: OpenVikingInjectionMode | null;
	l0HitCount: number | null;
	l1ExpandedCount: number | null;
	injectedTokensEst: number | null;
	slots: OpenVikingSlotSample[] | null;
}

export interface OpenVikingMetricsRecord {
	line: number;
	ts: string;
	tsMs: number;
	event: string;
	role: string | null;
	taskId: string | number | null;
	injection: OpenVikingInjection | null;
	extractedCount: number | null;
	dedupSkippedCount: number | null;
	evictedTokens: number | null;
	degradedFallback: boolean;
}

/** `worker_prefetch_inject` is the contract event (#809); `turn_start` is the spec's older name. */
const INJECTION_EVENTS = new Set(["worker_prefetch_inject", "turn_start"]);
const MODE_ALIASES: Record<string, OpenVikingInjectionMode> = {
	lead: "lead",
	lead_l0: "lead",
	worker: "worker",
	worker_turn1: "worker",
};

function slotSamples(v: unknown): OpenVikingSlotSample[] | null {
	if (!Array.isArray(v)) return null;
	return v.filter(isObject).flatMap((s) => {
		const slot = num(s.slot) ?? num(s.slot_id);
		if (slot === null) return [];
		return [
			{
				slot,
				state: str(s.state),
				l0HitCount: firstNum(s.l0_hit_count, s.l0_hits),
				injectedTokensEst: firstNum(s.injected_tokens_est, s.tokens_est),
			},
		];
	});
}

function injectionOf(event: string, o: JsonObject): OpenVikingInjection | null {
	if (!INJECTION_EVENTS.has(event)) return null;
	const modeKey = firstStr(o.mode, o.chat_mode);
	return {
		mode: (modeKey ? MODE_ALIASES[modeKey] : undefined) ?? (event === "worker_prefetch_inject" ? "worker" : null),
		l0HitCount: firstNum(o.l0_hit_count, o.l0_hits),
		l1ExpandedCount: firstNum(o.l1_expanded_count, o.l1_reads),
		injectedTokensEst: firstNum(o.injected_tokens_est, o.tokens_est),
		slots: slotSamples(o.slots),
	};
}

export async function readMetricsRecords(paths: OpenVikingStatePaths): Promise<OpenVikingMetricsRecord[]> {
	return (await readJsonl(paths.metricsJsonlPath)).map(({ line, ts, tsMs, obj }) => {
		const event = str(obj.event) ?? "unknown";
		return {
			line,
			ts,
			tsMs,
			event,
			role: str(obj.role),
			taskId: taskIdOf(obj),
			injection: injectionOf(event, obj),
			extractedCount: firstNum(obj.extracted_count, obj.extracted),
			dedupSkippedCount: firstNum(obj.dedup_skipped_count, obj.rm_dedup_skipped_count, obj.dedup_skipped),
			evictedTokens: num(obj.evictedTokens),
			degradedFallback: obj.degradedFallback === true || obj.lead_200k_acp_fallback === true,
		};
	});
}

// ---- memory-changelog.jsonl (G4) ----

/** Contract write actions (#809), plus `sync_failed`, which is not a memory write. */
export type OpenVikingChangelogAction =
	"add" | "update" | "delete" | "reject_preference_candidate" | "promote_preference_candidate" | "sync_failed";

const CHANGELOG_ACTIONS: Record<string, OpenVikingChangelogAction> = {
	add: "add",
	update: "update",
	delete: "delete",
	reject_preference_candidate: "reject_preference_candidate",
	promote_preference_candidate: "promote_preference_candidate",
	added: "add",
	updated: "update",
	deleted: "delete",
	sync_resource: "update",
	sync_resource_failed: "sync_failed",
	session_commit: "add",
	preference_write: "update",
	resource_sync: "update",
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

/** A memory write: a known action other than a failed resource sync, which wrote nothing (Ops #810). */
export const isMemoryWrite = (r: OpenVikingChangelogRecord): boolean => r.action !== null && r.action !== "sync_failed";

export interface OpenVikingChangelogRecord {
	line: number;
	ts: string;
	tsMs: number;
	rawAction: string;
	/** null for an action no writer is known to emit; such lines are kept out of every count. */
	action: OpenVikingChangelogAction | null;
	/** A session commit (spec "Session Commits"), the only kind `session_commits_24h` and `last_commit_at` count. */
	sessionCommit: boolean;
	source: string;
	role: string | null;
	taskId: string | number | null;
	uri: string;
	summary: string;
}

export async function readChangelogRecords(paths: OpenVikingStatePaths): Promise<OpenVikingChangelogRecord[]> {
	return (await readJsonl(paths.changelogJsonlPath)).map(({ line, ts, tsMs, obj }) => {
		const rawAction = str(obj.action) ?? "unknown";
		const record = {
			line,
			ts,
			tsMs,
			rawAction,
			action: CHANGELOG_ACTIONS[rawAction] ?? null,
			source: firstStr(obj.source, obj.trigger) ?? "unknown",
			role: str(obj.role),
			taskId: taskIdOf(obj),
			uri: str(obj.uri) ?? "",
			summary: str(obj.summary) ?? "",
		};
		return { ...record, sessionCommit: isSessionCommit(record) };
	});
}

// ---- rollout-state.json (G5) ----

export interface OpenVikingRolloutState {
	stage: string | null;
	phase: string | null;
	notebook_retired: boolean | null;
	fallback_roles: string[];
	cutover_ts: string | null;
	updated_at: string | null;
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

export async function readRolloutState(paths: OpenVikingStatePaths): Promise<OpenVikingRolloutState> {
	const o = (await readJsonObject(paths.rolloutStateJsonPath)) ?? {};
	const cutover = str(o.cutover_ts);
	return {
		stage: str(o.stage),
		phase: str(o.phase),
		notebook_retired: typeof o.notebook_retired === "boolean" ? o.notebook_retired : null,
		fallback_roles: Array.isArray(o.fallback_roles)
			? o.fallback_roles.filter((r): r is string => typeof r === "string")
			: [],
		cutover_ts: cutover,
		updated_at: str(o.updated_at) ?? cutover,
		pending_wt_land_syncs: Array.isArray(o.pending_wt_land_syncs) ? o.pending_wt_land_syncs.flatMap(pendingSync) : [],
	};
}

// ---- resource-sync-state.json ----

export interface OpenVikingResourceSyncState {
	present: boolean;
	synced_at: string | null;
	repos_synced: number | null;
	status: string | null;
}

export async function readResourceSyncState(paths: OpenVikingStatePaths): Promise<OpenVikingResourceSyncState> {
	const o = await readJsonObject(paths.resourceSyncStateJsonPath);
	if (o === null) return { present: false, synced_at: null, repos_synced: null, status: null };
	const repos = o.repos;
	const repoCount = Array.isArray(repos) ? repos.length : isObject(repos) ? Object.keys(repos).length : null;
	return {
		present: true,
		synced_at: firstStr(o.synced_at, o.syncedAt, o.updated_at),
		repos_synced: firstNum(o.repos_synced, o.reposSynced) ?? repoCount,
		status: str(o.status),
	};
}

// ---- migration-verification.json (G6) ----

export interface OpenVikingMigrationState {
	verified_at: string | null;
	status: string | null;
	roles_passed: number | null;
	total_roles: number | null;
	repos_passed: number | null;
	total_repos: number | null;
	total_checked: number | null;
}

export async function readMigrationState(paths: OpenVikingStatePaths): Promise<OpenVikingMigrationState | null> {
	const o = await readJsonObject(paths.migrationVerificationJsonPath);
	if (o === null) return null;
	const totalRoles = num(o.total_roles);
	const totalRepos = num(o.total_repos);
	const derived = totalRoles !== null && totalRepos !== null ? totalRoles + totalRepos : null;
	return {
		verified_at: firstStr(o.verified_at, o.checked_at),
		status: str(o.status),
		roles_passed: num(o.roles_passed),
		total_roles: totalRoles,
		repos_passed: num(o.repos_passed),
		total_repos: totalRepos,
		total_checked: num(o.total_checked) ?? (Array.isArray(o.source_files) ? o.source_files.length : derived),
	};
}

// ---- seen-role-messages.json (G7) ----

const SEEN_META_KEYS = new Set(["schema_version", "version", "updated_at", "updatedAt", "entries", "seen"]);

export async function readSeenRoleMessages(
	paths: OpenVikingStatePaths,
): Promise<{ seen_count: number; updated_at: string | null } | null> {
	const o = await readJsonObject(paths.seenRoleMessagesJsonPath);
	if (o === null) return null;
	const map = isObject(o.entries) ? o.entries : isObject(o.seen) ? o.seen : null;
	const seenCount = map ? Object.keys(map).length : Object.keys(o).filter((k) => !SEEN_META_KEYS.has(k)).length;
	return { seen_count: seenCount, updated_at: firstStr(o.updated_at, o.updatedAt) };
}
