/**
 * OpenViking Memory Dashboard — one live snapshot of the `:1933` daemon: reachability, retrieval
 * figures, role memory folders found and the two-layer store counts. When the daemon is down every figure is null
 * (`— (Unreachable)`), never 0. Queue depth is not read at all (R-QUEUE-DEPTH-1, spec G1).
 *
 * Reachability is `/health`'s alone (spec-states.md §4, `error` = `/health` fails). Every other read stands on
 * its own: one that fails or misses its deadline leaves the fields it feeds null (unmeasured) and says nothing
 * about the server being up (Backend #147, blind verify #144 row 33).
 */
import type { OpenVikingDaemonHttp } from "./daemon-http.js";
import type { OpenVikingMemoryFile } from "./memory-tree.js";
import type { OpenVikingMemoryTree, OpenVikingMemoryTreeCache } from "./memory-tree-cache.js";
import { OpenVikingDashboardError, type OpenVikingStoreCounts } from "./types.js";
import { resolveRequestHeaders } from "./uri.js";

export interface OpenVikingObserverSnapshot {
	reachable: boolean;
	retrieval_latency_avg_ms: number | null;
	retrieval_hit_rate_pct: number | null;
	/** Canonical `viking://user/<role>/memories` folders found (spec 2677060e); not role liveness. */
	role_memory_folder_count: number | null;
	store_counts: OpenVikingStoreCounts;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Rows of a `| a | b |` ASCII table (header first), or null when the shape is not a table. */
export function parseAsciiTable(text: unknown): string[][] | null {
	if (typeof text !== "string") return null;
	const rows = text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 1 && l.startsWith("|") && l.endsWith("|"))
		.map((l) =>
			l
				.slice(1, -1)
				.split("|")
				.map((c) => c.trim()),
		);
	if (rows.length < 2 || rows.some((r) => r.length !== rows[0].length)) return null;
	return rows;
}

/** `Avg Latency (ms)` and `100 - Zero-Result Rate` from the retrieval component's metric table. */
export function parseRetrievalStats(status: unknown): { avgLatencyMs: number | null; hitRatePct: number | null } {
	const rows = parseAsciiTable(status);
	if (!rows || rows[0][0] !== "Metric" || rows[0][1] !== "Value") return { avgLatencyMs: null, hitRatePct: null };
	const value = (metric: string) => rows.find((r) => r[0] === metric)?.[1] ?? "";
	const latency = /^\d+(?:\.\d+)?$/.test(value("Avg Latency (ms)")) ? Number(value("Avg Latency (ms)")) : null;
	const zero = /^(\d+(?:\.\d+)?)%$/.exec(value("Zero-Result Rate"));
	return { avgLatencyMs: latency, hitRatePct: zero ? round1(100 - Number(zero[1])) : null };
}

function componentStatus(system: unknown, name: string): unknown {
	const components = (system as { components?: Record<string, { status?: unknown }> } | null)?.components;
	return components?.[name]?.status;
}

/** `/health` failed (R-FAIL-1..3): every `:1933` figure is null, never 0 (§4). */
const unreachableSnapshot = (): OpenVikingObserverSnapshot => ({
	reachable: false,
	retrieval_latency_avg_ms: null,
	retrieval_hit_rate_pct: null,
	role_memory_folder_count: null,
	store_counts: storeCounts(null),
});

/** A read the daemon failed — rejected or past its deadline — leaves its own figure null and nothing else. */
async function orNull<T>(p: Promise<T>): Promise<T | null> {
	try {
		return await p;
	} catch (err) {
		if (err instanceof OpenVikingDashboardError) return null;
		throw err;
	}
}

const sumOrNull = (vals: (number | null)[]) =>
	vals.every((v): v is number => v !== null) ? vals.reduce((a, b) => a + b, 0) : null;

/** The counts a walked tree gives; an unmeasured piece — or no servable tree at all — is null, never 0. */
function storeCounts(tree: OpenVikingMemoryTree | null): OpenVikingStoreCounts {
	const resourceDirs = tree?.resource_dir_count ?? null;
	const shared = tree?.shared ?? null;
	const inShared = (category: string) => (shared ? shared.filter((f) => f.category === category).length : null);
	const craft = inShared("preferences");
	const entities = inShared("entities");
	const events = inShared("events");
	const roleTrees = tree?.role_trees ?? null;
	const readings = roleTrees === null ? null : [...roleTrees.values()];
	// One role the daemon would not list makes the whole personal layer unmeasured (Backend #149, #148 row 37):
	// a sum over the roles that did answer, shown as a figure, reads as a healthy count of a store never seen.
	// A role the daemon says has no folder is a measured absence: it counts as 0 of a whole that is still a figure.
	const found =
		readings === null || readings.some((r) => r.state === "unmeasured")
			? null
			: readings.flatMap((r) => (r.state === "measured" ? [r.files] : []));
	const inRoles = (category: string) =>
		found === null ? null : found.reduce((n, t) => n + t.filter((f) => f.category === category).length, 0);
	const preferences =
		found === null ? null : found.filter((t) => t.some((f) => f.relPath === "instructions/preferences.md")).length;
	const cases = inRoles("cases");
	const experiences = inRoles("experiences");
	return {
		layer1_shared: {
			repo_trees_count: resourceDirs,
			craft_preference_domains_count: craft,
			entities_count: entities,
			events_count: events,
			total_count: sumOrNull([resourceDirs, craft, entities, events]),
		},
		layer2_personal: {
			roles_count: found === null ? null : found.length,
			preferences_count: preferences,
			cases_count: cases,
			experiences_count: experiences,
			total_count: sumOrNull([preferences, cases, experiences]),
		},
	};
}

export async function readObserverSnapshot(
	http: OpenVikingDaemonHttp,
	tree: OpenVikingMemoryTreeCache,
	nowMs: number,
): Promise<OpenVikingObserverSnapshot> {
	const headers = resolveRequestHeaders("user");
	// The one reachability verdict: `/health`. Nothing below may turn the snapshot unreachable (§4, #147).
	if (!(await http.isHealthy(headers))) return unreachableSnapshot();
	const [system, walked] = await Promise.all([
		orNull(http.result("/api/v1/observer/system", {}, headers)),
		orNull(tree.read(http, nowMs)),
	]);
	const retrieval = parseRetrievalStats(componentStatus(system, "retrieval"));
	const counts = storeCounts(walked);
	return {
		reachable: true,
		retrieval_latency_avg_ms: retrieval.avgLatencyMs,
		retrieval_hit_rate_pct: retrieval.hitRatePct,
		role_memory_folder_count: counts.layer2_personal.roles_count,
		store_counts: counts,
	};
}
