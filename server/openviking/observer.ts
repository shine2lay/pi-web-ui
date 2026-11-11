/**
 * OpenViking Memory Dashboard — one live snapshot of the `:1933` daemon: reachability, queue and
 * retrieval figures, roles online and the two-layer store counts. When the daemon is down every
 * figure is null (`— (Unreachable)`), never 0.
 */
import {
	OpenVikingDaemonRequestError,
	OpenVikingDaemonUnreachableError,
	type OpenVikingDaemonHttp,
} from "./daemon-http.js";
import {
	listDir,
	RESOURCES_ROOT_URI,
	SHARED_MEMORIES_ROOT_URI,
	walkMemoryTree,
	walkRoleTrees,
	type OpenVikingMemoryFile,
} from "./memory-tree.js";
import { OPENVIKING_ROLES, type OpenVikingStoreCounts } from "./types.js";
import { resolveRequestHeaders } from "./uri.js";

export interface OpenVikingObserverSnapshot {
	reachable: boolean;
	queue_depth: number | null;
	retrieval_latency_avg_ms: number | null;
	retrieval_hit_rate_pct: number | null;
	roles_online_count: number | null;
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

const strictInt = (s: string | undefined) => (s !== undefined && /^\d+$/.test(s) ? Number(s) : null);

/**
 * G1: `Pending + In Progress` of the `TOTAL` row of `/api/v1/observer/queue` `result.status`.
 * Anchored on the exact header names; any drift in the table (renamed column, missing TOTAL row,
 * non-integer cell) yields null, never a guessed 0.
 */
export function parseQueueDepth(status: unknown): number | null {
	const rows = parseAsciiTable(status);
	if (!rows || rows[0][0] !== "Queue") return null;
	const pending = rows[0].indexOf("Pending");
	const inProgress = rows[0].indexOf("In Progress");
	const total = rows.find((r) => r[0] === "TOTAL");
	if (pending < 0 || inProgress < 0 || !total) return null;
	const p = strictInt(total[pending]);
	const i = strictInt(total[inProgress]);
	return p === null || i === null ? null : p + i;
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

const UNREACHABLE: OpenVikingObserverSnapshot = {
	reachable: false,
	queue_depth: null,
	retrieval_latency_avg_ms: null,
	retrieval_hit_rate_pct: null,
	roles_online_count: null,
	store_counts: {
		layer1_shared: {
			repo_trees_count: null,
			craft_preference_domains_count: null,
			entities_count: null,
			events_count: null,
			total_count: null,
		},
		layer2_personal: {
			roles_count: null,
			preferences_count: null,
			cases_count: null,
			experiences_count: null,
			total_count: null,
		},
	},
};

/** A failed request leaves its figure null; an unreachable daemon still fails the whole snapshot. */
async function orNull<T>(p: Promise<T>): Promise<T | null> {
	try {
		return await p;
	} catch (err) {
		if (err instanceof OpenVikingDaemonRequestError) return null;
		throw err;
	}
}

const sumOrNull = (vals: (number | null)[]) =>
	vals.every((v): v is number => v !== null) ? vals.reduce((a, b) => a + b, 0) : null;

function storeCounts(
	resourceDirs: number | null,
	shared: OpenVikingMemoryFile[] | null,
	roleTrees: Map<string, OpenVikingMemoryFile[] | null>,
): OpenVikingStoreCounts {
	const inShared = (category: string) => (shared ? shared.filter((f) => f.category === category).length : null);
	const craft = inShared("preferences");
	const entities = inShared("entities");
	const events = inShared("events");
	const online = [...roleTrees.values()].filter((t): t is OpenVikingMemoryFile[] => t !== null);
	const inRoles = (category: string) => online.reduce((n, t) => n + t.filter((f) => f.category === category).length, 0);
	const preferences = online.filter((t) => t.some((f) => f.relPath === "instructions/preferences.md")).length;
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
			roles_count: online.length,
			preferences_count: preferences,
			cases_count: cases,
			experiences_count: experiences,
			total_count: preferences + cases + experiences,
		},
	};
}

export async function readObserverSnapshot(http: OpenVikingDaemonHttp): Promise<OpenVikingObserverSnapshot> {
	const headers = resolveRequestHeaders("user");
	if (!(await http.isHealthy(headers))) return UNREACHABLE;
	try {
		const [system, queue, resources, shared, roleTrees] = await Promise.all([
			orNull(http.result("/api/v1/observer/system", {}, headers)),
			orNull(http.result("/api/v1/observer/queue", {}, headers)),
			orNull(listDir(http, RESOURCES_ROOT_URI, headers)),
			orNull(walkMemoryTree(http, SHARED_MEMORIES_ROOT_URI, headers)),
			walkRoleTrees(http, OPENVIKING_ROLES),
		]);
		const queueStatus = (queue as { status?: unknown } | null)?.status ?? componentStatus(system, "queue");
		const retrieval = parseRetrievalStats(componentStatus(system, "retrieval"));
		const counts = storeCounts(resources ? resources.filter((i) => i.isDir).length : null, shared, roleTrees);
		return {
			reachable: true,
			queue_depth: parseQueueDepth(queueStatus),
			retrieval_latency_avg_ms: retrieval.avgLatencyMs,
			retrieval_hit_rate_pct: retrieval.hitRatePct,
			roles_online_count: counts.layer2_personal.roles_count,
			store_counts: counts,
		};
	} catch (err) {
		if (err instanceof OpenVikingDaemonUnreachableError) return UNREACHABLE;
		throw err;
	}
}
