/**
 * OpenViking Memory Dashboard — read-only HTTP transport to the `:1933` daemon.
 *
 * Every call is a GET with its own 2000 ms deadline. A transport failure (refused, timed out,
 * aborted) is `OpenVikingDaemonUnreachableError`; an answer that is not `{status: "ok"}` is
 * `OpenVikingDaemonRequestError` carrying the upstream error code.
 */
import { OpenVikingDashboardError } from "./types.js";

export class OpenVikingDaemonUnreachableError extends OpenVikingDashboardError {
	constructor(daemonUrl: string, path: string, cause: unknown) {
		const reason = cause instanceof Error ? cause.message : String(cause);
		super(`OpenViking daemon ${daemonUrl} is unreachable (${path}): ${reason}`, 503, "DAEMON_UNREACHABLE", { path });
		this.name = "OpenVikingDaemonUnreachableError";
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
	constructor(
		readonly daemonUrl: string,
		readonly timeoutMs: number,
		private readonly fetchImpl: typeof fetch,
	) {}

	private async envelope(path: string, params: Record<string, string>, headers: Record<string, string>) {
		const query = new URLSearchParams(params).toString();
		const url = `${this.daemonUrl}${path}${query ? `?${query}` : ""}`;
		let res: Response;
		let body: DaemonEnvelope;
		try {
			res = await this.fetchImpl(url, { method: "GET", headers, signal: AbortSignal.timeout(this.timeoutMs) });
		} catch (err) {
			throw new OpenVikingDaemonUnreachableError(this.daemonUrl, path, err);
		}
		try {
			body = (await res.json()) as DaemonEnvelope;
		} catch (err) {
			if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
				throw new OpenVikingDaemonUnreachableError(this.daemonUrl, path, err);
			}
			throw new OpenVikingDaemonRequestError(path, res.status, "INVALID_JSON", "response body is not JSON");
		}
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
			return body.healthy !== false;
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
