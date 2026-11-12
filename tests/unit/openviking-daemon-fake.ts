/**
 * The one `:1933` daemon stand-in and clock pin for the OpenViking dashboard tests (Backend #132, #140). It records
 * every request; `state.mode` can change between requests so one client (one server process) can see the daemon
 * come and go.
 */

export const NOW = Date.parse("2026-11-11T08:30:00.000Z");
export const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const QUEUE = ["| Queue | Pending | In Progress | Processed |", "| TOTAL | 4 | 1 | 99 |"].join("\n");

export interface DaemonCall {
	url: URL;
	method: string;
	headers: Record<string, string>;
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

export function daemon(initial: DaemonMode = "up") {
	const calls: DaemonCall[] = [];
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
	};
	const matches = (uri: string, needle: string | null) => needle !== null && uri.includes(needle);
	const fetchImpl: typeof fetch = async (input, init) => {
		const url = new URL(String(input));
		calls.push({ url, method: init?.method ?? "GET", headers: { ...(init?.headers as Record<string, string>) } });
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
		if (url.pathname === "/api/v1/observer/queue") return ok({ status: QUEUE });
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
		if (url.pathname.startsWith("/api/v1/content/")) {
			if (matches(askedUri, state.errorContentMatching)) {
				return daemonError(503, "UNAVAILABLE", `daemon busy: ${askedUri}`);
			}
			return ok(`${url.pathname} of ${askedUri}`);
		}
		return new Response(JSON.stringify({ status: "error", error: { code: "NOT_FOUND" } }), { status: 404 });
	};
	return { fetchImpl, calls, state };
}
