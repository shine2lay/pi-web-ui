/**
 * OpenViking Memory Dashboard — the client behind the three read-only endpoints: one `:1933`
 * transport (GET only, 2000 ms deadline) and the `/home/shinelay/.pi/openviking/` state files.
 */
import { buildAudit } from "./audit.js";
import { OpenVikingDaemonHttp } from "./daemon-http.js";
import { buildEntries, readContentTier } from "./entries.js";
import { OpenVikingMemoryTreeCache } from "./memory-tree-cache.js";
import { buildOverview } from "./overview.js";
import { resolveOpenVikingStatePaths, type OpenVikingStatePaths } from "./state-files.js";
import {
	DEFAULT_OPENVIKING_DAEMON_BIND,
	DEFAULT_OPENVIKING_DAEMON_URL,
	DEFAULT_OPENVIKING_STATE_DIR,
	DEFAULT_OPENVIKING_TIMEOUT_MS,
	type OpenVikingAuditQuery,
	type OpenVikingAuditResponse,
	type OpenVikingContentTierResult,
	type OpenVikingDashboardOptions,
	type OpenVikingDisclosureTier,
	type OpenVikingEntriesQuery,
	type OpenVikingEntriesResponse,
	type OpenVikingEntryScope,
	type OpenVikingOverviewResponse,
	type RewrittenVikingUri,
} from "./types.js";
import { resolveRequestHeaders, rewriteVikingUri } from "./uri.js";

export { resolveOpenVikingStatePaths, type OpenVikingStatePaths } from "./state-files.js";

export class OpenVikingDaemonClient {
	readonly daemonUrl: string;
	readonly daemonBind: string;
	readonly stateDir: string;
	readonly statePaths: OpenVikingStatePaths;
	readonly timeoutMs: number;
	readonly fetchImpl: typeof fetch;
	readonly now: () => number;
	private readonly http: OpenVikingDaemonHttp;
	/** One held store-count walk per server process, refreshed at the observer cadence (#147). */
	private readonly tree = new OpenVikingMemoryTreeCache();

	constructor(options: OpenVikingDashboardOptions = {}) {
		this.daemonUrl = (options.daemonUrl ?? DEFAULT_OPENVIKING_DAEMON_URL).replace(/\/+$/, "");
		this.daemonBind = options.daemonBind ?? DEFAULT_OPENVIKING_DAEMON_BIND;
		this.stateDir = options.stateDir ?? DEFAULT_OPENVIKING_STATE_DIR;
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

	/** One L0/L1/L2 tier of a Layer 1 shared URI; a personal role URI is a 403 (R-ISOLATION-1). */
	async readContentTier(
		uri: string,
		tier: OpenVikingDisclosureTier,
		options: { role?: string } = {},
	): Promise<OpenVikingContentTierResult> {
		return readContentTier(this.http, uri, tier, options.role);
	}

	/** `GET /api/openviking/overview`. */
	async getOverview(): Promise<OpenVikingOverviewResponse> {
		return buildOverview(this.http, this.tree, this.statePaths, this.now(), this.daemonBind);
	}

	/** `GET /api/openviking/entries`. */
	async getEntries(query: OpenVikingEntriesQuery = {}): Promise<OpenVikingEntriesResponse> {
		return buildEntries(this.http, this.statePaths, query, this.now());
	}

	/** `GET /api/openviking/audit`. */
	async getAudit(query: OpenVikingAuditQuery = {}): Promise<OpenVikingAuditResponse> {
		return buildAudit(this.statePaths, query, this.now());
	}
}

export function createOpenVikingClient(options: OpenVikingDashboardOptions = {}): OpenVikingDaemonClient {
	return new OpenVikingDaemonClient(options);
}
