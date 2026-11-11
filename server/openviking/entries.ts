/**
 * OpenViking Memory Dashboard — `GET /api/openviking/entries`: the Memory Explorer list and the
 * L0/L1/L2 reader. Content (`/api/v1/content/*`) is read only for Layer 1 shared URIs; every
 * personal role entry is metadata only (R-ISOLATION-1), and asking for its content is a 403.
 *
 * Reachability is `/health`'s alone (spec-states.md §4, Backend #147). One listing fans out over ~1700 reads;
 * below that gate a read the daemon will not answer leaves its own piece unread — its row still comes back,
 * with that piece null — and the response declares the shortfall with `entries_partial` + `unread_count`. A
 * missed deadline on one read never reports the store unreachable and never empties the panel (#151, row 39).
 */
import { auditActionOf, guardVerdictOf } from "./activity.js";
import { mapWithLimit, type OpenVikingDaemonHttp } from "./daemon-http.js";
import {
	listDir,
	readDir,
	readMemoryTree,
	RESOURCES_ROOT_URI,
	roleTreeReadFiles,
	roleTreeUnreadListings,
	SHARED_MEMORIES_ROOT_URI,
	walkRoleTrees,
	type OpenVikingDirReading,
	type OpenVikingLsItem,
	type OpenVikingMemoryFile,
	type OpenVikingRoleTree,
	type OpenVikingTreeReading,
} from "./memory-tree.js";
import { panelHealth, pendingSyncCause } from "./overview.js";
import { readChangelogRecords, readRolloutState, type OpenVikingStatePaths } from "./state-files.js";
import {
	ENTRIES_CADENCE_MS,
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
 * Fills each shared entry's missing L0 from `/api/v1/content/abstract`, and counts the reads the daemon would
 * not answer — rejected or past both deadlines. Their row keeps `l0_abstract: null` (unmeasured): one stalled
 * piece costs its own abstract, never the listing and never the panel (#151).
 */
async function fillSharedAbstracts(http: OpenVikingDaemonHttp, entries: OpenVikingExplorerEntry[]): Promise<number> {
	const missing = entries.filter((e) => e.layer === "layer1_shared" && e.l0_abstract === null);
	const unread = await mapWithLimit(missing, ABSTRACT_CALLS_IN_FLIGHT, async (e): Promise<number> => {
		try {
			e.l0_abstract = (await readContentTier(http, e.canonical_uri, "L0")).content;
			return 0;
		} catch (err) {
			if (!(err instanceof OpenVikingDashboardError)) throw err;
			return 1;
		}
	});
	return unread.reduce((a, b) => a + b, 0);
}

/** How far one listing got: the rows it produced, and the reads that did not answer. */
interface EntriesReading {
	entries: OpenVikingExplorerEntry[];
	/** Listings the daemon would not answer; each may hide rows the list never shows. */
	unreadListings: number;
	/** Pieces (L0 abstracts) it would not answer; each leaves its own row's abstract null. */
	unreadPieces: number;
}

const NO_DIR: OpenVikingDirReading = { items: [], unread: [] };
const NO_TREE: OpenVikingTreeReading = { files: [], unread: [] };

async function listEntries(
	http: OpenVikingDaemonHttp,
	req: EntriesRequest,
	provenance: Map<string, OpenVikingEntryProvenance>,
): Promise<EntriesReading> {
	const want = (s: "resources" | "user" | "agent") => req.scope === "all" || req.scope === s;
	const shared = rewriteVikingUri(RESOURCES_ROOT_URI).headers;
	const [repos, memories, roleTrees] = await Promise.all([
		want("resources") ? readDir(http, RESOURCES_ROOT_URI, shared) : NO_DIR,
		want("user") ? readMemoryTree(http, SHARED_MEMORIES_ROOT_URI, shared) : NO_TREE,
		want("agent")
			? walkRoleTrees(http, req.role ? [req.role] : OPENVIKING_ROLES)
			: new Map<string, OpenVikingRoleTree>(),
	]);
	const fileEntry = (f: OpenVikingMemoryFile, role?: string) =>
		toEntry(f, f.category, rewriteVikingUri(f.uri, role), provenance);
	const trees = [...roleTrees];
	const entries = [
		...repos.items.filter((r) => r.isDir).map((r) => toEntry(r, "repository", rewriteVikingUri(r.uri), provenance)),
		...memories.files.map((f) => fileEntry(f)),
		...trees.flatMap(([role, tree]) => roleTreeReadFiles(tree).map((f) => fileEntry(f, role))),
	];
	return {
		entries,
		unreadListings:
			repos.unread.length + memories.unread.length + trees.reduce((n, [, t]) => n + roleTreeUnreadListings(t), 0),
		unreadPieces: await fillSharedAbstracts(http, entries),
	};
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
 * The one invariant of a short list (#151 (f)): a response built from reads that did not all answer declares
 * both the flag and the count, and a complete one declares neither. A mismatch is a bug in this file — a
 * listing nobody can tell is short — so it fails loudly instead of shipping.
 */
function assertShortListSaysSo(res: OpenVikingEntriesResponse, unread: number): void {
	const declared = res.entries_partial === true && res.unread_count === unread;
	const silent = res.entries_partial === undefined && res.unread_count === undefined;
	if (unread > 0 ? !declared : !silent) {
		throw new OpenVikingDashboardError(
			`OpenViking entries left ${unread} read(s) unread without declaring it.`,
			500,
			"INTERNAL",
			{ unread_count: unread },
		);
	}
}

export async function buildEntries(
	http: OpenVikingDaemonHttp,
	paths: OpenVikingStatePaths,
	query: OpenVikingEntriesQuery,
	nowMs: number,
): Promise<OpenVikingEntriesResponse> {
	const req = parseEntriesQuery(query);
	const panel_updated_at = new Date(nowMs).toISOString();
	const [provenance, rollout] = await Promise.all([provenanceByUri(paths), readRolloutState(paths)]);
	// The listing comes from `:1933` inside this request, so it has no age of its own: inside its `15m` cadence by
	// construction, stale only while a `wt land` sync waits, and never a false `"> 15m"` (ruling rm-b5272a3e).
	const health = (rows: number) =>
		panelHealth(rows, nowMs, nowMs, ENTRIES_CADENCE_MS, "> 15m" as const, pendingSyncCause(rollout));
	if (req.uri !== undefined) {
		const entry = await readOneEntry(http, { ...req, uri: req.uri }, provenance);
		return { panel_updated_at, ...health(1), entries: [entry] };
	}
	// The one reachability verdict: `/health`. Nothing below it may turn the panel unreachable (§4, #147, #151).
	if (!(await http.isHealthy(rewriteVikingUri(RESOURCES_ROOT_URI).headers))) {
		return { panel_updated_at, health_state: "server-unreachable", stale_badge: null, entries: [] };
	}
	const reading = await listEntries(http, req, provenance);
	const unread = reading.unreadListings + reading.unreadPieces;
	const res: OpenVikingEntriesResponse = {
		panel_updated_at,
		...health(reading.entries.length),
		entries: reading.entries,
		// A listing that read everything carries neither field: the shape every reader already knows (#151 (d)).
		...(unread > 0 ? { entries_partial: true as const, unread_count: unread } : {}),
	};
	assertShortListSaysSo(res, unread);
	return res;
}
