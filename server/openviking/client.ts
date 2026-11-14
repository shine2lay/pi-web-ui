/**
 * OpenViking memory — the client behind `/overview` and `/audit` and the Memory Explorer routes: one `:1933`
 * transport (2000 ms deadline) and the `<HOME>/.pi/openviking/` state files.
 */
import { buildAudit } from "./audit.js";
import { OpenVikingDaemonHttp } from "./daemon-http.js";
import { buildOverview } from "./overview.js";
import { defaultOpenVikingStateDir, resolveOpenVikingStatePaths, type OpenVikingStatePaths } from "./state-files.js";
import {
	DEFAULT_OPENVIKING_DAEMON_URL,
	DEFAULT_OPENVIKING_TIMEOUT_MS,
	type OpenVikingAuditQuery,
	type OpenVikingAuditResponse,
	type OpenVikingDashboardOptions,
	type OpenVikingEntryScope,
	type OpenVikingOverviewResponse,
	type OpenVikingOwnerEvents,
	type RewrittenVikingUri,
} from "./types.js";
import { resolveRequestHeaders, rewriteVikingUri } from "./uri.js";

export { resolveOpenVikingStatePaths, type OpenVikingStatePaths } from "./state-files.js";

export class OpenVikingDaemonClient {
	readonly daemonUrl: string;
	readonly stateDir: string;
	readonly statePaths: OpenVikingStatePaths;
	readonly timeoutMs: number;
	readonly fetchImpl: typeof fetch;
	readonly now: () => number;
	/** The one `:1933` transport of this server process; the Memory Explorer routes read through it too. */
	readonly http: OpenVikingDaemonHttp;

	constructor(options: OpenVikingDashboardOptions = {}) {
		this.daemonUrl = (options.daemonUrl ?? DEFAULT_OPENVIKING_DAEMON_URL).replace(/\/+$/, "");
		this.stateDir = options.stateDir ?? defaultOpenVikingStateDir();
		this.statePaths = resolveOpenVikingStatePaths(this.stateDir);
		this.timeoutMs = options.timeoutMs ?? DEFAULT_OPENVIKING_TIMEOUT_MS;
		if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
			throw new RangeError(`OpenViking timeoutMs must be a positive integer, got ${String(options.timeoutMs)}`);
		}
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
		this.now = options.now ?? (() => Date.now());
		this.http = new OpenVikingDaemonHttp(this.daemonUrl, this.timeoutMs, this.fetchImpl, this.now);
	}

	/**
	 * R-URI-REWRITE-1 for OpenViking 0.5.4 URIs and headers:
	 * - Layer 1 shared resources (`viking://resources/<repo>/...`): Account `default`, User `default`
	 * - Layer 1 shared memories (`viking://user/memories/...` -> `viking://user/default/memories/...`):
	 *   Account `default`, User `default`
	 * - Layer 2 personal role memories (`viking://agent/memories/...` -> `viking://user/<role>/memories/...`):
	 *   Account `default`, User `<role>`, Agent `<role>`
	 */
	rewriteVikingUri(uri: string, role?: string): RewrittenVikingUri {
		return rewriteVikingUri(uri, role);
	}

	/** R-URI-REWRITE-1 outbound headers for a scope and role. */
	resolveRequestHeaders(scope: OpenVikingEntryScope, role?: string): Record<string, string> {
		return resolveRequestHeaders(scope, role);
	}

	/** `GET /api/openviking/overview`. */
	async getOverview(): Promise<OpenVikingOverviewResponse> {
		return buildOverview(this.http, this.statePaths, this.now());
	}

	/** `GET /api/openviking/audit`; owner events only when `ownerEvents` is `included` (R-AUDIT-OWNER-1). */
	async getAudit(
		query: OpenVikingAuditQuery = {},
		ownerEvents: OpenVikingOwnerEvents = "withheld",
	): Promise<OpenVikingAuditResponse> {
		return buildAudit(this.statePaths, query, this.now(), ownerEvents);
	}
}

export function createOpenVikingClient(options: OpenVikingDashboardOptions = {}): OpenVikingDaemonClient {
	return new OpenVikingDaemonClient(options);
}
