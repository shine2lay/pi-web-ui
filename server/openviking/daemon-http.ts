/**
 * OpenViking Memory Dashboard — read-only HTTP transport to the `:1933` daemon.
 *
 * Every call is a GET with its own 2000 ms deadline. A missed deadline is retried once with a
 * fresh deadline: pi-web-ui's own event loop can stall for ~2 s, and the timer then fires before
 * an answer that already arrived is read. A transport failure (refused, or timed out twice) is
 * `OpenVikingDaemonUnreachableError`; an answer that is not `{status: "ok"}` is
 * `OpenVikingDaemonRequestError` carrying the upstream error code.
 *
 * The transport also holds the time of the last `/health` that answered ok (spec 895b0cb1
 * `observer.last_reachable_at`): in memory only, written only by `isHealthy`, held while the daemon is down.
 * There is one transport per server process (one client per `registerOpenVikingRoutes`).
 */
import { OpenVikingDashboardError } from "./types.js";

const DEADLINE_ATTEMPTS = 2;

const isDeadlineMiss = (err: unknown): boolean =>
	err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");

export class OpenVikingDaemonUnreachableError extends OpenVikingDashboardError {
	readonly deadlineMiss: boolean;

	constructor(daemonUrl: string, path: string, cause: unknown) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		super(`OpenViking daemon ${daemonUrl} is unreachable (${path}): ${reason}`, 503, "DAEMON_UNREACHABLE", { path });
		this.name = "OpenVikingDaemonUnreachableError";
		this.deadlineMiss = isDeadlineMiss(cause);
	}
}

export class OpenVikingDaemonRequestError extends OpenVikingDashboardError {
	constructor(
		path: string,
		readonly httpStatus: number,
		readonly upstreamCode: string,
		upstreamMessage: string,
	) {
		super(`OpenViking daemon rejected ${path} (${upstreamCode}): ${upstreamMessage}`, 502, "DAEMON_REQUEST_FAILED", {
			path,
			upstream_status: httpStatus,
			upstream_code: upstreamCode,
		});
		this.name = "OpenVikingDaemonRequestError";
	}
}

interface DaemonEnvelope {
	status?: unknown;
	healthy?: unknown;
	result?: unknown;
	error?: { code?: unknown; message?: unknown } | null;
}

export class OpenVikingDaemonHttp {
	/** Epoch ms of the last ok `/health`; null until the first one since this transport was made. */
	private lastHealthyMs: number | null = null;

	constructor(
		readonly daemonUrl: string,
		readonly timeoutMs: number,
		private readonly fetchImpl: typeof fetch,
		private readonly now: () => number,
	) {}

	/** ISO time of the last ok `/health`, held while the daemon is down; null before the first ok. Gates nothing. */
	get lastReachableAt(): string | null {
		return this.lastHealthyMs === null ? null : new Date(this.lastHealthyMs).toISOString();
	}

	/** One GET under its own deadline, body read included. */
	private async attempt(path: string, url: string, headers: Record<string, string>) {
		let res: Response;
		try {
			res = await this.fetchImpl(url, { method: "GET", headers, signal: AbortSignal.timeout(this.timeoutMs) });
		} catch (err) {
			throw new OpenVikingDaemonUnreachableError(this.daemonUrl, path, err);
		}
		try {
			return { res, body: (await res.json()) as DaemonEnvelope };
		} catch (err) {
			if (isDeadlineMiss(err)) throw new OpenVikingDaemonUnreachableError(this.daemonUrl, path, err);
			throw new OpenVikingDaemonRequestError(path, res.status, "INVALID_JSON", "response body is not JSON");
		}
	}

	/** `attempt`, repeated once when only the deadline was missed; a refused connection is final. */
	private async send(path: string, url: string, headers: Record<string, string>) {
		for (let attempt = 1; ; attempt++) {
			try {
				return await this.attempt(path, url, headers);
			} catch (err) {
				const retry = err instanceof OpenVikingDaemonUnreachableError && err.deadlineMiss;
				if (!retry || attempt >= DEADLINE_ATTEMPTS) throw err;
			}
		}
	}

	private async envelope(path: string, params: Record<string, string>, headers: Record<string, string>) {
		const query = new URLSearchParams(params).toString();
		const url = `${this.daemonUrl}${path}${query ? `?${query}` : ""}`;
		const { res, body } = await this.send(path, url, headers);
		if (!res.ok || body === null || typeof body !== "object" || body.status !== "ok") {
			const code = typeof body?.error?.code === "string" ? body.error.code : `HTTP_${res.status}`;
			const message = typeof body?.error?.message === "string" ? body.error.message : "request failed";
			throw new OpenVikingDaemonRequestError(path, res.status, code, message);
		}
		return body;
	}

	/** The `result` of a `{status: "ok"}` answer. */
	async result(
		path: string,
		params: Record<string, string> = {},
		headers: Record<string, string> = {},
	): Promise<unknown> {
		return (await this.envelope(path, params, headers)).result;
	}

	/** `/health` answers `{status: "ok", healthy: true}`; anything else counts as down. */
	async isHealthy(headers: Record<string, string>): Promise<boolean> {
		try {
			const body = await this.envelope("/health", {}, headers);
			const healthy = body.healthy !== false;
			if (healthy) this.lastHealthyMs = this.now();
			return healthy;
		} catch (err) {
			if (err instanceof OpenVikingDashboardError) return false;
			throw err;
		}
	}
}

/** Runs `fn` over `items` with at most `limit` calls in flight; keeps input order. */
export async function mapWithLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}
