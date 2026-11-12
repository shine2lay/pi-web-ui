/**
 * OpenViking Memory Dashboard — `GET /api/openviking/entries`: the Memory Explorer list and the
 * L0/L1/L2 reader. Content (`/api/v1/content/*`) is read only for Layer 1 shared URIs; every
 * personal role entry is metadata only (R-ISOLATION-1), and asking for its content is a 403.
 *
 * Reachability is `/health`'s alone (spec-states.md §4, Backend #147). One listing fans out over ~1700 reads;
 * below that gate a read the daemon will not answer leaves its own piece unread — its row still comes back,
 * with that piece null — and the response declares the shortfall with `entries_partial` + `unread_count`. A
 * missed deadline on one read never reports the store unreachable and never empties the panel (#151, row 39).
 *
 * What those two fields count is fixed by spec `2500874d` §3a and nothing else (#153): a **read unit** is one
 * all-or-nothing listing read — the `resources` root, the shared memories walk, one per role tree in scope —
 * and `unread_count` is how many of them did not answer, `entries_partial` exactly `unread_count > 0`. Both
 * are on every answer. A root answered `NOT_FOUND` is absent, not unread; a failed read inside a row that did
 * ship is not a unit, it nulls that one field.
 *
 * The listing is never read per request (#155, ruling rm-8e4a1631): `buildEntriesSnapshot` reads every scope and
 * role in the background (`entries-snapshot.ts`), and a request slices that snapshot by scope and role. Only
 * `/health` (reachability) and a `?uri=` detail read stay live, per request.
 */
import { auditActionOf, guardVerdictOf } from "./activity.js";
import { mapWithLimit, type OpenVikingDaemonHttp } from "./daemon-http.js";
import {
	listDir,
	readDir,
	readMemoryTree,
	RESOURCES_ROOT_URI,
	roleTreeIsUnread,
	roleTreeReadFiles,
	SHARED_MEMORIES_ROOT_URI,
	walkRoleTrees,
	type OpenVikingLsItem,
	type OpenVikingMemoryFile,
} from "./memory-tree.js";
import type { OpenVikingEntriesBuild, OpenVikingEntriesSnapshot } from "./entries-snapshot.js";
import { panelHealth, pendingSyncCause } from "./overview.js";
import { readChangelogRecords, readRolloutState, type OpenVikingStatePaths } from "./state-files.js";
import {
	ENTRIES_CADENCE_MS,
	ENTRIES_REBUILD_GRACE_MS,
	ISOLATED_AGENT_MEMORY_ABSTRACT,
	OPENVIKING_ROLES,
	OpenVikingDashboardError,
	type OpenVikingContentTierResult,
	type OpenVikingDisclosureTier,
	type OpenVikingEntriesQuery,
	type OpenVikingEntriesResponse,
	type OpenVikingEntryProvenance,
	type OpenVikingExplorerEntry,
	type RewrittenVikingUri,
} from "./types.js";
import { rewriteVikingUri, scopeOfUri } from "./uri.js";

const SCOPES = ["all", "resources", "user", "agent"] as const;
const TIERS: readonly OpenVikingDisclosureTier[] = ["L0", "L1", "L2"];
const TIER_PATH: Record<OpenVikingDisclosureTier, string> = {
	L0: "/api/v1/content/abstract",
	L1: "/api/v1/content/overview",
	L2: "/api/v1/content/read",
};
/** Shared entries whose listing carries no abstract need one L0 call each; a few at a time. */
const ABSTRACT_CALLS_IN_FLIGHT = 8;

function invalid(field: string, value: unknown, expected: string): OpenVikingDashboardError {
	return new OpenVikingDashboardError(
		`Invalid ${field} "${String(value)}": expected ${expected}.`,
		400,
		"INVALID_ARGUMENT",
		{
			[field]: value,
		},
	);
}

function oneOf<T extends string>(field: string, value: unknown, allowed: readonly T[]): T | undefined {
	if (value === undefined || value === "") return undefined;
	if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
	throw invalid(field, value, allowed.join("|"));
}

export interface EntriesRequest {
	scope: (typeof SCOPES)[number];
	role: string | undefined;
	uri: string | undefined;
	tier: OpenVikingDisclosureTier | undefined;
	includeContent: boolean;
}

export function parseEntriesQuery(query: OpenVikingEntriesQuery): EntriesRequest {
	const uri = query.uri;
	if (uri !== undefined && (typeof uri !== "string" || uri === "")) throw invalid("uri", uri, "one viking:// URI");
	return {
		scope: oneOf("scope", query.scope, SCOPES) ?? "all",
		role: oneOf("role", query.role, OPENVIKING_ROLES),
		uri,
		tier: oneOf("tier", query.tier, TIERS),
		includeContent: oneOf("include_content", query.include_content, ["true", "false"]) === "true",
	};
}

function isolationError(target: RewrittenVikingUri): OpenVikingDashboardError {
	return new OpenVikingDashboardError(
		`${target.logicalUri} is role "${target.role}"'s private memory: metadata only (R-ISOLATION-1).`,
		403,
		"ISOLATED_ROLE_MEMORY",
		{ uri: target.logicalUri, role: target.role },
	);
}

/** One content tier of a Layer 1 shared URI; a personal URI is refused before any call is made. */
export async function readContentTier(
	http: OpenVikingDaemonHttp,
	uri: string,
	tier: OpenVikingDisclosureTier,
	role?: string,
): Promise<OpenVikingContentTierResult> {
	const target = rewriteVikingUri(uri, role);
	if (target.layer !== "layer1_shared") throw isolationError(target);
	const content = await http.result(TIER_PATH[tier], { uri: target.canonicalUri }, target.headers);
	if (typeof content !== "string") {
		throw new OpenVikingDashboardError(`OpenViking ${tier} for ${uri} is not text.`, 502, "DAEMON_BAD_RESPONSE", {
			uri,
			tier,
		});
	}
	return { uri: target.logicalUri, canonical_uri: target.canonicalUri, tier, content };
}

/** Newest changelog line per canonical URI. */
async function provenanceByUri(paths: OpenVikingStatePaths): Promise<Map<string, OpenVikingEntryProvenance>> {
	const out = new Map<string, { tsMs: number; p: OpenVikingEntryProvenance }>();
	for (const r of await readChangelogRecords(paths)) {
		const action = auditActionOf(r);
		const canonical = scopeOfUri(r.uri, r.role)?.canonicalUri;
		if (!canonical || !action || (out.get(canonical)?.tsMs ?? -Infinity) > r.tsMs) continue;
		out.set(canonical, {
			tsMs: r.tsMs,
			p: {
				action: r.rawAction,
				source: r.source,
				role: r.role,
				task_id: r.taskId,
				guard_verdict: guardVerdictOf(action),
				updated_at: r.ts,
			},
		});
	}
	return new Map([...out].map(([k, v]) => [k, v.p]));
}

const lastSegment = (uri: string) => uri.slice(uri.lastIndexOf("/") + 1);

function toEntry(
	item: OpenVikingLsItem,
	category: string,
	target: RewrittenVikingUri,
	provenance: Map<string, OpenVikingEntryProvenance>,
): OpenVikingExplorerEntry {
	const shared = target.layer === "layer1_shared";
	const prov = provenance.get(target.canonicalUri) ?? null;
	return {
		uri: target.logicalUri,
		canonical_uri: target.canonicalUri,
		title: lastSegment(target.canonicalUri),
		category,
		scope: target.scope,
		layer: target.layer,
		role: target.role,
		layers: !shared ? [] : item.isDir ? ["L0", "L1"] : ["L0", "L1", "L2"],
		l0_abstract: shared ? item.abstract : ISOLATED_AGENT_MEMORY_ABSTRACT,
		l1_overview: null,
		l2_content: null,
		updated_at: item.modTime ?? prov?.updated_at ?? null,
		provenance: prov,
	};
}

/**
 * Fills each shared entry's missing L0 from `/api/v1/content/abstract`. A read the daemon would not answer —
 * rejected or past both deadlines — leaves that row's `l0_abstract: null` (unmeasured) and nothing else: it is
 * a read inside a row that shipped, not a read unit, so it never makes the list short (§3a, #153).
 */
async function fillSharedAbstracts(http: OpenVikingDaemonHttp, entries: OpenVikingExplorerEntry[]): Promise<void> {
	const missing = entries.filter((e) => e.layer === "layer1_shared" && e.l0_abstract === null);
	await mapWithLimit(missing, ABSTRACT_CALLS_IN_FLIGHT, async (e): Promise<void> => {
		try {
			e.l0_abstract = (await readContentTier(http, e.canonical_uri, "L0")).content;
		} catch (err) {
			if (!(err instanceof OpenVikingDashboardError)) throw err;
		}
	});
}

const wants = (req: EntriesRequest, s: "resources" | "user" | "agent") => req.scope === "all" || req.scope === s;
const agentUnit = (role: string) => `agent:${role}`;

/** Every read unit this scope covers: the `resources` root, the shared memories walk, each role tree (§3a). */
function unitsInScope(req: EntriesRequest): string[] {
	const roles = req.role ? [req.role] : OPENVIKING_ROLES;
	return [
		...(wants(req, "resources") ? ["resources"] : []),
		...(wants(req, "user") ? ["user"] : []),
		...(wants(req, "agent") ? roles.map(agentUnit) : []),
	];
}

/** One listing of every scope and role: the rows it produced, and the read units (§3a) that did not answer. */
async function listAllEntries(
	http: OpenVikingDaemonHttp,
	provenance: Map<string, OpenVikingEntryProvenance>,
): Promise<{ entries: OpenVikingExplorerEntry[]; unread: Set<string> }> {
	const shared = rewriteVikingUri(RESOURCES_ROOT_URI).headers;
	const [repos, memories, roleTrees] = await Promise.all([
		readDir(http, RESOURCES_ROOT_URI, shared),
		readMemoryTree(http, SHARED_MEMORIES_ROOT_URI, shared),
		walkRoleTrees(http, OPENVIKING_ROLES),
	]);
	const fileEntry = (f: OpenVikingMemoryFile, role?: string) =>
		toEntry(f, f.category, rewriteVikingUri(f.uri, role), provenance);
	const trees = [...roleTrees];
	const entries = [
		...repos.items.filter((r) => r.isDir).map((r) => toEntry(r, "repository", rewriteVikingUri(r.uri), provenance)),
		...memories.files.map((f) => fileEntry(f)),
		...trees.flatMap(([role, tree]) => roleTreeReadFiles(tree).map((f) => fileEntry(f, role))),
	];
	await fillSharedAbstracts(http, entries);
	// One unit per source, however many listings inside it failed: a walk is all-or-nothing (§3a).
	const unread = new Set([
		...(repos.unread.length > 0 ? ["resources"] : []),
		...(memories.unread.length > 0 ? ["user"] : []),
		...trees.filter(([, tree]) => roleTreeIsUnread(tree)).map(([role]) => agentUnit(role)),
	]);
	return { entries, unread };
}

/**
 * One background build of the whole listing (#155). `null` — a failed build, which keeps the last snapshot —
 * when `/health` refuses at build time; otherwise every row that read, and the units that did not (§3a).
 */
export async function buildEntriesSnapshot(
	http: OpenVikingDaemonHttp,
	paths: OpenVikingStatePaths,
	now: () => number,
): Promise<OpenVikingEntriesBuild | null> {
	if (!(await http.isHealthy(rewriteVikingUri(RESOURCES_ROOT_URI).headers))) return null;
	const { entries, unread } = await listAllEntries(http, await provenanceByUri(paths));
	return { entries, unread_units: unread, finished_at_ms: now() };
}

/** A request's scope and role cut out of the snapshot: its rows, and the unread units of that scope only. */
function sliceSnapshot(build: OpenVikingEntriesBuild, req: EntriesRequest) {
	const entries = build.entries.filter(
		(e) => wants(req, e.scope) && (e.scope !== "agent" || !req.role || e.role === req.role),
	);
	const unreadUnits = unitsInScope(req).filter((unit) => build.unread_units.has(unit)).length;
	return { entries, unreadUnits };
}

/** One URI: metadata from its parent listing, plus the asked-for tiers when it is shared. */
async function readOneEntry(
	http: OpenVikingDaemonHttp,
	req: EntriesRequest & { uri: string },
	provenance: Map<string, OpenVikingEntryProvenance>,
): Promise<OpenVikingExplorerEntry> {
	const target = rewriteVikingUri(req.uri, req.role);
	const wantsContent = req.includeContent || req.tier !== undefined;
	if (target.layer !== "layer1_shared" && wantsContent) throw isolationError(target);
	const parent = target.canonicalUri.slice(0, target.canonicalUri.lastIndexOf("/"));
	const item = (await listDir(http, parent, target.headers)).find((i) => i.uri === target.canonicalUri);
	if (!item) {
		throw new OpenVikingDashboardError(`${req.uri} was not found in OpenViking.`, 404, "NOT_FOUND", { uri: req.uri });
	}
	const relPath = target.canonicalUri.split("/memories/")[1] ?? "";
	const category = target.scope === "resources" ? "repository" : relPath.includes("/") ? relPath.split("/")[0] : "root";
	const entry = toEntry(item, category, target, provenance);
	if (target.layer !== "layer1_shared") return entry;
	const tiers = req.includeContent ? entry.layers : entry.layers.filter((t) => t === "L0" || t === req.tier);
	const read = await Promise.all(tiers.map((t) => readContentTier(http, target.canonicalUri, t)));
	for (const r of read) {
		if (r.tier === "L0") entry.l0_abstract = r.content;
		if (r.tier === "L1") entry.l1_overview = r.content;
		if (r.tier === "L2") entry.l2_content = r.content;
	}
	return entry;
}

/**
 * The one invariant of a short list (§3a, #151 (f)): every answer carries both fields, the count is the number
 * of read units that did not answer, and the flag is exactly `count > 0`. A mismatch is a bug in this file — a
 * listing nobody can tell is short — so it fails loudly instead of shipping.
 */
function assertShortListSaysSo(res: OpenVikingEntriesResponse, unread: number): void {
	if (res.unread_count === unread && res.entries_partial === unread > 0) return;
	throw new OpenVikingDashboardError(
		`OpenViking entries left ${unread} read unit(s) unread without declaring it.`,
		500,
		"INTERNAL",
		{ unread_count: unread, declared: res.unread_count, entries_partial: res.entries_partial },
	);
}

export async function buildEntries(
	http: OpenVikingDaemonHttp,
	snapshot: OpenVikingEntriesSnapshot,
	paths: OpenVikingStatePaths,
	query: OpenVikingEntriesQuery,
	now: () => number,
): Promise<OpenVikingEntriesResponse> {
	const req = parseEntriesQuery(query);
	const pendingSync = pendingSyncCause((await readRolloutState(paths)).state);
	if (req.uri !== undefined) {
		// `?uri=` is not a listing (§3a): one live entry or an HTTP error, so there is no unit and no short list.
		const entry = await readOneEntry(http, { ...req, uri: req.uri }, await provenanceByUri(paths));
		const nowMs = now();
		const health = panelHealth(1, nowMs, nowMs, ENTRIES_CADENCE_MS, "> 15m" as const, pendingSync);
		return {
			panel_updated_at: new Date(nowMs).toISOString(),
			...health,
			entries_partial: false,
			unread_count: 0,
			entries: [entry],
		};
	}
	// The one reachability verdict: `/health`, live on every request. Nothing below it may turn the panel
	// unreachable (§4, #147, #151), and no snapshot, however fresh, overrides it.
	if (!(await http.isHealthy(rewriteVikingUri(RESOURCES_ROOT_URI).headers))) {
		// Not one unit of this scope was read, so every one of them is unread (§3a).
		const unread = unitsInScope(req).length;
		return {
			panel_updated_at: new Date(now()).toISOString(),
			health_state: "server-unreachable",
			stale_badge: null,
			entries_partial: unread > 0,
			unread_count: unread,
			entries: [],
		};
	}
	const build = await snapshot.read();
	const nowMs = now();
	// No build has ever succeeded (each found `/health` refused): nothing of this scope has been read (§3a).
	const { entries, unreadUnits } = build
		? sliceSnapshot(build, req)
		: { entries: [], unreadUnits: unitsInScope(req).length };
	const builtAtMs = build?.finished_at_ms ?? nowMs;
	// The snapshot's age is its own: `"> 15m"` once past the cadence (failing builds keep the last good one), else
	// `"pending sync"` while a `wt land` sync waits (ruling rm-b5272a3e). R-SNAPSHOT-STALE-1 (architecture rm-3a23be76,
	// QA #136 F5): each build stamps its finish, so the held one passes the cadence while the next one runs; a build
	// in flight that started under 5m ago hides the age badge, a failed build (none running) or one past 5m shows it.
	const startedAtMs = snapshot.rebuildStartedAtMs();
	const youngRebuild = startedAtMs !== null && nowMs - startedAtMs < ENTRIES_REBUILD_GRACE_MS;
	const staleAfterMs = youngRebuild ? Number.POSITIVE_INFINITY : ENTRIES_CADENCE_MS;
	const res: OpenVikingEntriesResponse = {
		panel_updated_at: new Date(builtAtMs).toISOString(),
		...panelHealth(entries.length, builtAtMs, nowMs, staleAfterMs, "> 15m" as const, pendingSync),
		entries_partial: unreadUnits > 0,
		unread_count: unreadUnits,
		entries,
	};
	assertShortListSaysSo(res, unreadUnits);
	return res;
}
