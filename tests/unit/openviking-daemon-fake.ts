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
 * /health deadline, `unhealthy` answers /health with `{status: "ok", healthy: false}`.
 */
export type DaemonMode = "up" | "down" | "hang" | "stall-once" | "unhealthy";

const ok = (result: unknown, healthy = true) =>
	new Response(JSON.stringify({ status: "ok", healthy, result }), {
		headers: { "Content-Type": "application/json" },
	});
const item = (uri: string, isDir: boolean, abstract = "") => ({
	uri,
	isDir,
	size: 1,
	modTime: minutesAgo(3),
	abstract,
});

function lsResult(uri: string): unknown[] {
	if (uri === "viking://resources") return [item("viking://resources/pi-web-ui", true, "pi-web-ui L0 abstract")];
	if (uri === "viking://user/default/memories") return [item(`${uri}/preferences`, true)];
	if (uri === "viking://user/default/memories/preferences") return [item(`${uri}/backend_code.md`, false)];
	const role = /^viking:\/\/user\/([a-z]+)\/memories(\/cases)?$/.exec(uri);
	if (role && !role[2]) return [item(`${uri}/cases`, true)];
	if (role) return [item(`${uri}/c1.md`, false)];
	return [];
}

export function daemon(initial: DaemonMode = "up") {
	const calls: DaemonCall[] = [];
	const state = { mode: initial };
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
		if (url.pathname === "/health") return ok(undefined, mode !== "unhealthy");
		if (url.pathname === "/api/v1/observer/queue") return ok({ status: QUEUE });
		if (url.pathname === "/api/v1/observer/system") return ok({ components: {} });
		if (url.pathname === "/api/v1/fs/ls") return ok(lsResult(url.searchParams.get("uri") ?? ""));
		if (url.pathname.startsWith("/api/v1/content/")) return ok(`${url.pathname} of ${url.searchParams.get("uri")}`);
		return new Response(JSON.stringify({ status: "error", error: { code: "NOT_FOUND" } }), { status: 404 });
	};
	return { fetchImpl, calls, state };
}
