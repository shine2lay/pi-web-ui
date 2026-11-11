/**
 * OpenViking Memory Dashboard — canonical daemon client & state-file reader seam.
 *
 * Task 1 (#131) defines the shared TypeScript contract and module seam;
 * Task 2 (#132) implements the live HTTP and JSONL/JSON readers behind this seam.
 */
import { join } from "node:path";
import {
	DEFAULT_OPENVIKING_DAEMON_BIND,
	DEFAULT_OPENVIKING_DAEMON_URL,
	DEFAULT_OPENVIKING_STATE_DIR,
	DEFAULT_OPENVIKING_TIMEOUT_MS,
	OpenVikingNotImplementedError,
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

export interface OpenVikingStatePaths {
	readonly stateDir: string;
	readonly metricsJsonlPath: string;
	readonly changelogJsonlPath: string;
	readonly rolloutStateJsonPath: string;
	readonly resourceSyncStateJsonPath: string;
	readonly migrationVerificationJsonPath: string;
	readonly seenRoleMessagesJsonPath: string;
}

export function resolveOpenVikingStatePaths(stateDir = DEFAULT_OPENVIKING_STATE_DIR): OpenVikingStatePaths {
	return {
		stateDir,
		metricsJsonlPath: join(stateDir, "metrics.jsonl"),
		changelogJsonlPath: join(stateDir, "memory-changelog.jsonl"),
		rolloutStateJsonPath: join(stateDir, "rollout-state.json"),
		resourceSyncStateJsonPath: join(stateDir, "resource-sync-state.json"),
		migrationVerificationJsonPath: join(stateDir, "migration-verification.json"),
		seenRoleMessagesJsonPath: join(stateDir, "seen-role-messages.json"),
	};
}

export class OpenVikingDaemonClient {
	readonly daemonUrl: string;
	readonly daemonBind: string;
	readonly stateDir: string;
	readonly statePaths: OpenVikingStatePaths;
	readonly timeoutMs: number;
	readonly fetchImpl: typeof fetch;
	readonly now: () => number;

	constructor(options: OpenVikingDashboardOptions = {}) {
		this.daemonUrl = (options.daemonUrl ?? DEFAULT_OPENVIKING_DAEMON_URL).replace(/\/+$/, "");
		this.daemonBind = options.daemonBind ?? DEFAULT_OPENVIKING_DAEMON_BIND;
		this.stateDir = options.stateDir ?? DEFAULT_OPENVIKING_STATE_DIR;
		this.statePaths = resolveOpenVikingStatePaths(this.stateDir);
		this.timeoutMs = options.timeoutMs ?? DEFAULT_OPENVIKING_TIMEOUT_MS;
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
		this.now = options.now ?? (() => Date.now());
	}

	/**
	 * Enforces R-URI-REWRITE-1 and R-ISOLATION-1 for OpenViking 0.5.4 URIs and headers:
	 * - Layer 1 Shared resources (`viking://resources/<repo>/...`):
	 *   `X-OpenViking-Account: default`, `X-OpenViking-User: default`
	 * - Layer 1 Shared memories (`viking://user/memories/...` -> `viking://user/default/memories/...`):
	 *   `X-OpenViking-Account: default`, `X-OpenViking-User: default`
	 * - Layer 2 Personal role memories (`viking://agent/memories/...` -> `viking://user/<role>/memories/...`):
	 *   `X-OpenViking-Account: default`, `X-OpenViking-User: <role>`, `X-OpenViking-Agent: <role>`
	 */
	rewriteVikingUri(_uri: string, _role?: string): RewrittenVikingUri {
		throw new OpenVikingNotImplementedError("rewriteVikingUri");
	}

	/**
	 * Resolves R-URI-REWRITE-1 outbound headers for a given scope and role.
	 */
	resolveRequestHeaders(_scope: OpenVikingEntryScope, _role?: string): Record<string, string> {
		throw new OpenVikingNotImplementedError("resolveRequestHeaders");
	}

	/**
	 * Reads L0 (`abstract`), L1 (`overview`), or L2 (`read`) content tier from `:1933`
	 * while enforcing `R-URI-REWRITE-1` headers and `R-ISOLATION-1` cross-role isolation.
	 */
	async readContentTier(
		_uri: string,
		_tier: OpenVikingDisclosureTier,
		_options?: { role?: string },
	): Promise<OpenVikingContentTierResult> {
		throw new OpenVikingNotImplementedError("readContentTier");
	}

	/**
	 * Builds the `GET /api/openviking/overview` payload from `:1933` health/observer endpoints
	 * and `/home/shinelay/.pi/openviking/` JSONL/JSON state files.
	 */
	async getOverview(): Promise<OpenVikingOverviewResponse> {
		throw new OpenVikingNotImplementedError("getOverview");
	}

	/**
	 * Builds the `GET /api/openviking/entries` payload with `R-URI-REWRITE-1` headers,
	 * `R-ISOLATION-1` cross-role redaction, and `L0 / L1 / L2` progressive disclosure.
	 */
	async getEntries(_query: OpenVikingEntriesQuery = {}): Promise<OpenVikingEntriesResponse> {
		throw new OpenVikingNotImplementedError("getEntries");
	}

	/**
	 * Builds the `GET /api/openviking/audit` payload from `memory-changelog.jsonl` and
	 * `metrics.jsonl`, mapping actions and `R-PREF-WRITE-GUARD-1` verdicts and redacting
	 * cross-role `agent` memory summaries (`R-ISOLATION-1`).
	 */
	async getAudit(_query: OpenVikingAuditQuery = {}): Promise<OpenVikingAuditResponse> {
		throw new OpenVikingNotImplementedError("getAudit");
	}
}

export function createOpenVikingClient(options: OpenVikingDashboardOptions = {}): OpenVikingDaemonClient {
	return new OpenVikingDaemonClient(options);
}
