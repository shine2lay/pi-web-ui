/**
 * Memory Explorer G4 (spec-explorer.md): `POST /api/openviking/search`. `meaning` is one `/api/v1/search/find` over
 * the chosen roots (a failed find names no root, gap D3: the whole answer fails); `exact` is one
 * `/api/v1/search/grep` per root with the query regex-escaped (gap D6), a failed root listed as unread while the rest
 * still ship. Locked setup files never appear (G8). `relative` is computed here once; size and mod_time come from
 * `fs/stat` per unique uri.
 */
import { mapWithLimit, OpenVikingDaemonRequestError, type OpenVikingDaemonHttp } from "./daemon-http.js";
import { statUri } from "./explorer-daemon.js";
import {
	escapeRegex,
	explorerKindOf,
	explorerRefusal,
	explorerRootHeaders,
	explorerRootNamed,
	isSetupFile,
} from "./explorer-rules.js";
import {
	EXPLORER_QUERY_CHARS,
	EXPLORER_ROOTS_IN_FLIGHT,
	EXPLORER_SEARCH_LIMIT,
	type OpenVikingExplorerRoot,
	type OpenVikingSearchHit,
	type OpenVikingSearchMode,
	type OpenVikingSearchRequest,
	type OpenVikingSearchResponse,
} from "./explorer-types.js";
import { OpenVikingDashboardError } from "./types.js";
import { resolveRequestHeaders } from "./uri.js";

/** A search body that passed the contract. */
export interface OpenVikingSearchPlan {
	mode: OpenVikingSearchMode;
	query: string;
	roots: OpenVikingExplorerRoot[];
	limit: number;
}

const invalid = (why: string) => explorerRefusal("SEARCH_INVALID", `Invalid search: ${why}.`);

/** `400 SEARCH_INVALID` for mode, query, roots or limit outside the contract; `400 ROOT_UNKNOWN` for a root not one of the 17. */
export function parseSearchRequest(body: OpenVikingSearchRequest | undefined): OpenVikingSearchPlan {
	const b = body ?? {};
	if (b.mode !== "meaning" && b.mode !== "exact") throw invalid('mode is "meaning" or "exact"');
	const query = typeof b.query === "string" ? b.query.trim() : "";
	if (query.length < EXPLORER_QUERY_CHARS.min || query.length > EXPLORER_QUERY_CHARS.max) {
		throw invalid(`query is ${EXPLORER_QUERY_CHARS.min}-${EXPLORER_QUERY_CHARS.max} characters`);
	}
	if (!Array.isArray(b.roots) || b.roots.length === 0) throw invalid("roots is a non-empty list");
	const roots: OpenVikingExplorerRoot[] = [];
	for (const raw of b.roots) {
		const root = explorerRootNamed(raw);
		if (root === null) {
			throw explorerRefusal("ROOT_UNKNOWN", "A search root is not one of the memory explorer's roots.", {
				root: typeof raw === "string" ? raw : null,
			});
		}
		if (!roots.includes(root)) roots.push(root);
	}
	const fallback = b.mode === "meaning" ? EXPLORER_SEARCH_LIMIT.defaultMeaning : EXPLORER_SEARCH_LIMIT.defaultExact;
	const limit = b.limit === undefined ? fallback : b.limit;
	if (
		typeof limit !== "number" ||
		!Number.isInteger(limit) ||
		limit < EXPLORER_SEARCH_LIMIT.min ||
		limit > EXPLORER_SEARCH_LIMIT.max
	) {
		throw invalid(`limit is an integer ${EXPLORER_SEARCH_LIMIT.min}-${EXPLORER_SEARCH_LIMIT.max}`);
	}
	return { mode: b.mode, query, roots, limit };
}

/** A hit before stat: where it is and what the daemon said about it. */
interface RawHit {
	uri: string;
	root: OpenVikingExplorerRoot;
	score: number | null;
	abstract: string | null;
	line_number: number | null;
	line_text: string | null;
}

interface Gathered {
	hits: RawHit[];
	/** Hits the daemon had beyond what this answer shows. */
	truncated: boolean;
	lockedHidden: number;
	unreadRoots: string[];
}

const record = (v: unknown): Record<string, unknown> =>
	typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(record) : []);

/** The requested root a hit lies under; a hit outside them is not shown (the gate passed only these). */
const rootOf = (uri: string, roots: readonly OpenVikingExplorerRoot[]) =>
	roots.find((r) => uri === r.uri || uri.startsWith(`${r.uri}/`)) ?? null;

async function meaning(http: OpenVikingDaemonHttp, plan: OpenVikingSearchPlan): Promise<Gathered> {
	const target_uri = plan.roots.map((r) => r.uri);
	const result = record(
		await http.searchResult(
			"/api/v1/search/find",
			{ query: plan.query, target_uri, limit: plan.limit },
			resolveRequestHeaders("user"),
		),
	);
	const answered = [...list(result.memories), ...list(result.resources)];
	const out: Gathered = { hits: [], truncated: answered.length >= plan.limit, lockedHidden: 0, unreadRoots: [] };
	for (const row of answered) {
		const uri = typeof row.uri === "string" ? row.uri : "";
		const root = rootOf(uri, plan.roots);
		if (root === null || typeof row.score !== "number") continue;
		if (isSetupFile(uri)) {
			out.lockedHidden++;
			continue;
		}
		const abstract = typeof row.abstract === "string" && row.abstract.trim() !== "" ? row.abstract : null;
		out.hits.push({ uri, root, score: row.score, abstract, line_number: null, line_text: null });
	}
	out.hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
	return out;
}

/** One root's grep: its matches, `null` when the daemon would not answer; `NOT_FOUND` is a root with no notes. */
async function grepRoot(http: OpenVikingDaemonHttp, root: OpenVikingExplorerRoot, plan: OpenVikingSearchPlan) {
	try {
		return record(
			await http.searchResult(
				"/api/v1/search/grep",
				{ uri: root.uri, pattern: escapeRegex(plan.query), case_insensitive: true, node_limit: plan.limit },
				explorerRootHeaders(root),
			),
		);
	} catch (err) {
		if (err instanceof OpenVikingDaemonRequestError && err.upstreamCode === "NOT_FOUND") return {};
		if (err instanceof OpenVikingDashboardError) return null;
		throw err;
	}
}

async function exact(http: OpenVikingDaemonHttp, plan: OpenVikingSearchPlan): Promise<Gathered> {
	const answers = await mapWithLimit(plan.roots, EXPLORER_ROOTS_IN_FLIGHT, (root) => grepRoot(http, root, plan));
	const out: Gathered = { hits: [], truncated: false, lockedHidden: 0, unreadRoots: [] };
	plan.roots.forEach((root, i) => {
		const answer = answers[i];
		if (answer === null) {
			out.unreadRoots.push(root.uri);
			return;
		}
		const matches = list(answer.matches);
		if (typeof answer.match_count === "number" && answer.match_count > matches.length) out.truncated = true;
		for (const m of matches) {
			const uri = typeof m.uri === "string" ? m.uri : "";
			if (rootOf(uri, [root]) === null) continue;
			if (isSetupFile(uri)) {
				out.lockedHidden++;
				continue;
			}
			const line_number = typeof m.line === "number" ? m.line : null;
			const line_text = typeof m.content === "string" ? m.content : null;
			out.hits.push({ uri, root, score: null, abstract: null, line_number, line_text });
		}
	});
	if (out.hits.length > plan.limit) {
		out.hits = out.hits.slice(0, plan.limit);
		out.truncated = true;
	}
	return out;
}

/** size and mod_time per unique uri from `fs/stat`; a stat that fails leaves both null for that uri. */
async function statHits(http: OpenVikingDaemonHttp, hits: readonly RawHit[]) {
	const unique = [...new Map(hits.map((h) => [h.uri, h.root])).entries()];
	const stats = await mapWithLimit(unique, EXPLORER_ROOTS_IN_FLIGHT, ([uri, root]) =>
		statUri(http, uri, explorerRootHeaders(root)).catch((err: unknown) => {
			if (err instanceof OpenVikingDashboardError) return null;
			throw err;
		}),
	);
	return new Map(unique.map(([uri], i) => [uri, stats[i]]));
}

/** The search answer for a plan whose roots the owner gate has passed. */
export async function runSearch(
	http: OpenVikingDaemonHttp,
	plan: OpenVikingSearchPlan,
	nowMs: number,
): Promise<OpenVikingSearchResponse> {
	// A failed find throws (the route answers 502 MEMORY_ERROR): it cannot name the root that failed (gap D3).
	const gathered = plan.mode === "meaning" ? await meaning(http, plan) : await exact(http, plan);
	const stats = await statHits(http, gathered.hits);
	const max = Math.max(0, ...gathered.hits.map((h) => h.score ?? 0));
	const hits: OpenVikingSearchHit[] = gathered.hits.map((h) => {
		const stat = stats.get(h.uri) ?? null;
		return {
			uri: h.uri,
			root: h.root.uri,
			kind: explorerKindOf(h.uri, h.root),
			score: h.score,
			relative: h.score === null || max <= 0 ? null : h.score / max,
			abstract: h.abstract,
			line_number: h.line_number,
			line_text: h.line_text,
			size: stat?.size ?? null,
			mod_time: stat?.modTime ?? null,
		};
	});
	return {
		mode: plan.mode,
		query: plan.query,
		checked_at: new Date(nowMs).toISOString(),
		total: hits.length,
		truncated: gathered.truncated,
		results_partial: gathered.unreadRoots.length > 0,
		unread_count: gathered.unreadRoots.length,
		unread_roots: gathered.unreadRoots,
		locked_hidden_count: gathered.lockedHidden,
		hits,
	};
}
