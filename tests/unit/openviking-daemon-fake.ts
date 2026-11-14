/**
 * The one `:1933` daemon stand-in and clock pin for the OpenViking dashboard tests (Backend #132, #140). It records
 * every request; `state.mode` can change between requests so one client (one server process) can see the daemon
 * come and go.
 */

import {
	OPENVIKING_EXPLORER_ROOTS,
	OPENVIKING_ROLES,
	type OpenVikingExplorerClock,
} from "../../server/openviking/index.js";

export const NOW = Date.parse("2026-11-11T08:30:00.000Z");
export const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

export interface DaemonCall {
	url: URL;
	method: string;
	headers: Record<string, string>;
	/** The parsed JSON body of a POST, else undefined. */
	body: unknown;
}

/**
 * `down` refuses the connection, `hang` never answers (past every deadline), `stall-once` misses only the first
 * /health deadline, `unhealthy` answers /health with `{status: "ok", healthy: false}`. `state.hangLsMatching` is
 * orthogonal: a healthy daemon whose `fs/ls` for URIs containing that string never answers (Backend #147).
 *
 * Backend #149 adds the two answers a healthy daemon gives about a folder, which must never be conflated:
 * `state.errorLsRoles` are roles whose listings answer `503 UNAVAILABLE` (a read that failed; the folder is
 * there), `state.absentRoles` are roles whose listings answer `404 NOT_FOUND` (the daemon says there is no
 * such folder), and `state.failAllLs` makes every `fs/ls` answer `503` (a whole refresh that failed).
 *
 * Backend #151 adds the pieces of one listing: `state.hangContentMatching` is a healthy daemon whose
 * `/api/v1/content/*` reads for URIs containing that string never answer (past both deadlines, as the one
 * stalled L0 abstract of row 39), `state.errorContentMatching` has them answer `503`, and
 * `state.errorLsMatching` has the listings of URIs containing that string answer `503`.
 *
 * Backend #153 (spec 2500874d §3a read units) adds `state.absentLsMatching` — any listing whose URI contains
 * that string answers `404 NOT_FOUND`, so a root the daemon says is not there can be told from one it would
 * not read — and `state.extraSharedDirs` / `state.extraRoleDirs`, which widen the shared and role trees so one
 * walk can have more than one sub-listing fail (an all-or-nothing read unit is still one unit).
 *
 * Backend #161 (Memory Explorer seam) adds, behind `daemon(mode, { explorer: true })`, the calls of
 * spec-explorer-build.md's table over an in-memory store (`store`, `explorerStore`): `fs/tree`, `fs/stat`
 * (whole-second `modTime`, folders `count`), `content/{abstract,overview,read,write}`, `search/{find,grep}`,
 * `DELETE /api/v1/fs`, in the daemon's envelope `{ status, result, error }`. `state.failures` makes one call
 * answer an error, `state.findHits` is what `find` knows, and `clock` (a `manualClock`) is the server's clock for
 * the 10 s window and the store's `modTime`. Every call is recorded with its parsed body.
 */
export type DaemonMode = "up" | "down" | "hang" | "stall-once" | "unhealthy";

const ok = (result: unknown, healthy = true) =>
	new Response(JSON.stringify({ status: "ok", healthy, result }), {
		headers: { "Content-Type": "application/json" },
	});
/** The daemon's own error envelope, as `:1933` 0.5.4 answers it (`NOT_FOUND` on a folder that is not there). */
const daemonError = (status: number, code: string, message: string) =>
	new Response(JSON.stringify({ status: "error", result: null, error: { code, message } }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
/** `viking://user/<role>/memories...` belongs to `role`. */
const lsRole = (uri: string): string | null => /^viking:\/\/user\/([a-z0-9_-]+)\/memories(\/|$)/.exec(uri)?.[1] ?? null;
const item = (uri: string, isDir: boolean, abstract = "") => ({
	uri,
	isDir,
	size: 1,
	modTime: minutesAgo(3),
	abstract,
});

function lsResult(uri: string, extraSharedDirs: string[], extraRoleDirs: string[]): unknown[] {
	if (uri === "viking://resources") return [item("viking://resources/pi-web-ui", true, "pi-web-ui L0 abstract")];
	if (uri === "viking://user/default/memories") {
		return [item(`${uri}/preferences`, true), ...extraSharedDirs.map((d) => item(`${uri}/${d}`, true))];
	}
	if (uri === "viking://user/default/memories/preferences") return [item(`${uri}/backend_code.md`, false)];
	if (uri.startsWith("viking://user/default/memories/")) return [item(`${uri}/note.md`, false)];
	const role = /^viking:\/\/user\/([a-z]+)\/memories(\/[a-z0-9_-]+)?$/.exec(uri);
	if (role && !role[2]) return [item(`${uri}/cases`, true), ...extraRoleDirs.map((d) => item(`${uri}/${d}`, true))];
	if (role) return [item(`${uri}/c1.md`, false)];
	return [];
}

export function daemon(initial: DaemonMode = "up", options: { explorer?: boolean; clock?: ManualClock } = {}) {
	const clock = options.clock ?? manualClock();
	const calls: DaemonCall[] = [];
	const store = explorerStore();
	const state = {
		mode: initial,
		hangLsMatching: null as string | null,
		errorLsMatching: null as string | null,
		hangContentMatching: null as string | null,
		errorContentMatching: null as string | null,
		errorLsRoles: [] as string[],
		absentRoles: [] as string[],
		absentLsMatching: null as string | null,
		extraSharedDirs: [] as string[],
		extraRoleDirs: [] as string[],
		failAllLs: false,
		/** Explorer calls answering an error (first match wins); see `FakeFailure`. */
		failures: [] as FakeFailure[],
		/** `search/find` answers these, filtered to its targets, best score first. */
		findHits: [] as FakeFindHit[],
	};
	const matches = (uri: string, needle: string | null) => needle !== null && uri.includes(needle);
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
		const method = init?.method ?? "GET";
		calls.push({ url, method, headers: { ...(init?.headers as Record<string, string>) }, body });
		const { mode } = state;
		if (mode === "down") throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:1933");
		const firstHealth = url.pathname === "/health" && calls.filter((c) => c.url.pathname === "/health").length === 1;
		if (mode === "hang" || (mode === "stall-once" && firstHealth)) {
			return new Promise<Response>((_, reject) =>
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
			);
		}
		const askedUri = url.searchParams.get("uri") ?? "";
		const hungLs = url.pathname === "/api/v1/fs/ls" && matches(askedUri, state.hangLsMatching);
		const hungContent = url.pathname.startsWith("/api/v1/content/") && matches(askedUri, state.hangContentMatching);
		if (hungLs || hungContent) {
			return new Promise<Response>((_, reject) =>
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
			);
		}
		if (url.pathname === "/health") return ok(undefined, mode !== "unhealthy");
		if (url.pathname === "/api/v1/observer/system") return ok({ components: {} });
		if (url.pathname === "/api/v1/fs/ls") {
			const uri = url.searchParams.get("uri") ?? "";
			const role = lsRole(uri);
			if (state.failAllLs || matches(uri, state.errorLsMatching)) {
				return daemonError(503, "UNAVAILABLE", `daemon busy: ${uri}`);
			}
			if (role !== null && state.errorLsRoles.includes(role)) {
				return daemonError(503, "UNAVAILABLE", `daemon busy: ${uri}`);
			}
			if ((role !== null && state.absentRoles.includes(role)) || matches(uri, state.absentLsMatching)) {
				return daemonError(404, "NOT_FOUND", `Directory not found: ${uri}`);
			}
			return ok(lsResult(uri, state.extraSharedDirs, state.extraRoleDirs));
		}
		if (options.explorer && EXPLORER_PATHS.has(url.pathname)) {
			return explorerAnswer({ url, method, body, store, clock, failures: state.failures, findHits: state.findHits });
		}
		if (url.pathname.startsWith("/api/v1/content/")) {
			if (matches(askedUri, state.errorContentMatching)) {
				return daemonError(503, "UNAVAILABLE", `daemon busy: ${askedUri}`);
			}
			return ok(`${url.pathname} of ${askedUri}`);
		}
		return new Response(JSON.stringify({ status: "error", error: { code: "NOT_FOUND" } }), { status: 404 });
	};
	return { fetchImpl, calls, state, store, clock };
}

// ---- Memory Explorer (backend #161): the daemon calls of spec-explorer-build.md's table, over an in-memory store ----

/** The server's clock in a test: `advance` moves it and fires every timer that came due, in order. */
export interface ManualClock extends OpenVikingExplorerClock {
	advance(ms: number): void;
	/** Timers set and not yet fired or cleared. */
	pendingTimers(): number;
}

export function manualClock(start = NOW): ManualClock {
	let now = start;
	let nextId = 0;
	const timers: { id: number; at: number; fn: () => void }[] = [];
	return {
		now: () => now,
		setTimer: (ms, fn) => {
			timers.push({ id: ++nextId, at: now + ms, fn });
			return nextId;
		},
		clearTimer: (handle) => {
			const i = timers.findIndex((t) => t.id === handle);
			if (i >= 0) timers.splice(i, 1);
		},
		advance: (ms) => {
			const until = now + ms;
			for (;;) {
				const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at || a.id - b.id)[0];
				if (!due) break;
				timers.splice(timers.indexOf(due), 1);
				now = due.at;
				due.fn();
			}
			now = until;
		},
		pendingTimers: () => timers.length,
	};
}

export interface FakeNode {
	isDir: boolean;
	/** File text; "" for a folder. */
	content: string;
	modTimeMs: number;
	/** Folder abstract; null = not ready (`# <uri> [Directory abstract is not ready]`). */
	abstract: string | null;
	/** Folder overview; null = "". */
	overview: string | null;
}

/** An explorer call that answers an error: `path` exact, `method` and `uri` (query or body `uri`) when given. */
export interface FakeFailure {
	path: string;
	method?: string;
	uri?: string;
	status: number;
	code: string;
	message?: string;
}

export interface FakeFindHit {
	uri: string;
	score: number;
	abstract: string;
}

const EXPLORER_PATHS = new Set([
	"/api/v1/fs/tree",
	"/api/v1/fs/stat",
	"/api/v1/fs",
	"/api/v1/content/abstract",
	"/api/v1/content/overview",
	"/api/v1/content/read",
	"/api/v1/content/write",
	"/api/v1/search/find",
	"/api/v1/search/grep",
]);
const WRITE_FIELDS = new Set(["uri", "content", "mode", "wait", "edit_source"]);
const notReady = (uri: string) => `# ${uri} [Directory abstract is not ready]`;
/** `fs/tree` writes `…:57.000Z`, `fs/stat` `…:57Z`: whole seconds either way (gap D2). */
const wholeSeconds = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString();
const statTime = (ms: number) => wholeSeconds(ms).replace(".000Z", "Z");
const parentOf = (uri: string) => uri.slice(0, uri.lastIndexOf("/"));
const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/**
 * The store behind the explorer calls: every root of the 17 is a folder; `put` adds a file (and its folders),
 * `folder` sets a folder's abstract/overview. Default seed: one note per root, a not-ready shared folder, and
 * backend's two setup files.
 */
export function explorerStore() {
	const nodes = new Map<string, FakeNode>();
	const folder = (
		uri: string,
		abstract: string | null = null,
		overview: string | null = null,
		modTimeMs = NOW - 600_000,
	) => {
		nodes.set(uri, { isDir: true, content: "", modTimeMs, abstract, overview });
	};
	const put = (uri: string, content: string, modTimeMs = NOW - 300_000) => {
		for (let p = parentOf(uri); p.length > "viking://".length && !nodes.has(p); p = parentOf(p)) folder(p);
		nodes.set(uri, { isDir: false, content, modTimeMs, abstract: null, overview: null });
	};
	const under = (uri: string) => [...nodes.keys()].filter((k) => k.startsWith(`${uri}/`)).sort();
	for (const root of OPENVIKING_EXPLORER_ROOTS) folder(root.uri, `${root.uri} abstract`, `${root.uri} overview`);
	folder("viking://resources/pi-web-ui", "pi-web-ui L0 abstract", "pi-web-ui L1 overview");
	put("viking://resources/pi-web-ui/README.md", "# pi-web-ui\nA fork of the pi web UI.\n");
	folder("viking://user/default/memories/preferences");
	put("viking://user/default/memories/preferences/backend_code.md", "Money in integer minor units.\n");
	put("viking://user/default/memories/entities/pi-web-ui.md", "pi-web-ui is the owner's chat app.\n");
	for (const role of OPENVIKING_ROLES) put(`viking://user/${role}/memories/cases/c1.md`, `${role} case one\n`);
	put("viking://user/backend/memories/identity.md", "backend identity\n");
	put("viking://user/backend/memories/Soul.MD", "backend soul\n");
	return { nodes, folder, put, under, remove: (uri: string) => nodes.delete(uri) };
}

export type ExplorerStore = ReturnType<typeof explorerStore>;

interface ExplorerCall {
	url: URL;
	method: string;
	body: unknown;
	store: ExplorerStore;
	clock: ManualClock;
	failures: FakeFailure[];
	findHits: FakeFindHit[];
}

function explorerAnswer({ url, method, body, store, clock, failures, findHits }: ExplorerCall): Response {
	const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
	const uri = url.searchParams.get("uri") ?? (typeof b.uri === "string" ? b.uri : "");
	const failure = failures.find(
		(f) => f.path === url.pathname && (f.method ?? method) === method && (f.uri === undefined || f.uri === uri),
	);
	if (failure) return daemonError(failure.status, failure.code, failure.message ?? `fake failure: ${uri}`);
	const node = store.nodes.get(uri);
	const q = (k: string) => url.searchParams.get(k);
	switch (`${method} ${url.pathname}`) {
		case "GET /api/v1/fs/tree": {
			if (!node) return daemonError(404, "NOT_FOUND", `File not found: ${uri}`);
			const levels = Number(q("level_limit") ?? 3);
			const cap = Number(q("node_limit") ?? 1000);
			const withAbstract = q("include_abstract") === "true";
			const rows = store.under(uri).filter((k) => k.slice(uri.length + 1).split("/").length <= levels);
			return ok(
				rows.slice(0, cap).map((k) => {
					const n = store.nodes.get(k) as FakeNode;
					const abstract = n.isDir && withAbstract ? (n.abstract ?? notReady(k)) : "";
					const size = bytes(n.content);
					return {
						uri: k,
						size,
						isDir: n.isDir,
						modTime: wholeSeconds(n.modTimeMs),
						rel_path: k.slice(uri.length + 1),
						abstract,
					};
				}),
			);
		}
		case "GET /api/v1/fs/stat": {
			if (!node) return daemonError(404, "NOT_FOUND", `File not found: ${uri}`);
			const stat = {
				name: uri.slice(uri.lastIndexOf("/") + 1),
				size: bytes(node.content),
				mode: node.isDir ? 493 : 420,
				modTime: statTime(node.modTimeMs),
				isDir: node.isDir,
				uri,
				isLocked: false,
				id: uri,
			};
			return ok(
				node.isDir
					? { ...stat, count: store.under(uri).filter((k) => !k.slice(uri.length + 1).includes("/")).length }
					: stat,
			);
		}
		case "GET /api/v1/content/abstract":
		case "GET /api/v1/content/overview": {
			if (!node) return daemonError(404, "NOT_FOUND", "Resource not found");
			// Gap D1: a file answers its folder's text.
			const ofUri = node.isDir ? uri : parentOf(uri);
			const of = store.nodes.get(ofUri) as FakeNode;
			return url.pathname.endsWith("/abstract") ? ok(of.abstract ?? notReady(ofUri)) : ok(of.overview ?? "");
		}
		case "GET /api/v1/content/read":
			if (!node) return daemonError(404, "NOT_FOUND", "Resource not found");
			if (node.isDir) return daemonError(400, "INVALID_ARGUMENT", "Directory URI is not readable as a file");
			return ok(node.content);
		case "POST /api/v1/content/write": {
			const extra = Object.keys(b).filter((k) => !WRITE_FIELDS.has(k));
			if (extra.length > 0 || typeof b.content !== "string") {
				return daemonError(400, "INVALID_ARGUMENT", `bad write body: ${extra.join(",") || "content"}`);
			}
			if (!node) return daemonError(404, "NOT_FOUND", `File not found: ${uri}`);
			if (node.isDir) return daemonError(400, "INVALID_ARGUMENT", "Directory URI is not writable");
			store.nodes.set(uri, { ...node, content: b.content, modTimeMs: clock.now() });
			return ok({ uri, written_bytes: bytes(b.content) });
		}
		case "DELETE /api/v1/fs":
			if (!node) return daemonError(404, "NOT_FOUND", `File not found: ${uri}`);
			if (node.isDir && q("recursive") !== "true" && store.under(uri).length > 0) {
				return daemonError(400, "INVALID_ARGUMENT", "Directory not empty");
			}
			store.remove(uri);
			return ok({ uri, estimated_deleted_count: 1 });
		case "POST /api/v1/search/find": {
			const targets = ([] as unknown[]).concat(b.target_uri).filter((t): t is string => typeof t === "string");
			const hits = findHits
				.filter((h) => targets.some((t) => h.uri === t || h.uri.startsWith(`${t}/`)))
				.sort((x, y) => y.score - x.score)
				.slice(0, typeof b.limit === "number" ? b.limit : 10);
			const row = (h: FakeFindHit, context_type: string) => ({
				context_type,
				uri: h.uri,
				level: 2,
				score: h.score,
				abstract: h.abstract,
				tags: [],
			});
			const isResource = (h: FakeFindHit) => h.uri.startsWith("viking://resources/");
			return ok({
				memories: hits.filter((h) => !isResource(h)).map((h) => row(h, "memory")),
				resources: hits.filter(isResource).map((h) => row(h, "resource")),
				skills: [],
				total: hits.length,
			});
		}
		case "POST /api/v1/search/grep": {
			if (!node) return daemonError(404, "NOT_FOUND", `File not found: ${uri}`);
			let re: RegExp;
			try {
				re = new RegExp(String(b.pattern), b.case_insensitive === true ? "i" : "");
			} catch {
				return daemonError(400, "INVALID_ARGUMENT", "Invalid regex pattern");
			}
			const files = store.under(uri).filter((k) => !store.nodes.get(k)?.isDir);
			const matches = files.flatMap((k) =>
				(store.nodes.get(k) as FakeNode).content
					.split("\n")
					.flatMap((content, i) => (re.test(content) ? [{ line: i + 1, uri: k, content }] : [])),
			);
			const shown = matches.slice(0, typeof b.node_limit === "number" ? b.node_limit : 256);
			return ok({ matches: shown, count: shown.length, match_count: matches.length, files_scanned: files.length });
		}
		default:
			return daemonError(405, "METHOD_NOT_ALLOWED", `${method} ${url.pathname}`);
	}
}
