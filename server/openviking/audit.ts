/**
 * OpenViking Memory Dashboard — `GET /api/openviking/audit`: the Audit Trail of memory writes and
 * guard verdicts from `memory-changelog.jsonl` + `metrics.jsonl`, newest first, with personal
 * summaries redacted (R-ISOLATION-1). Reads state files only; never calls `:1933`.
 */
import { buildAuditEvents } from "./activity.js";
import { panelHealth, pendingSyncCause } from "./overview.js";
import {
	readChangelogRecords,
	readMetricsRecords,
	readRolloutState,
	type OpenVikingStatePaths,
} from "./state-files.js";
import {
	AUDIT_CADENCE_MS,
	OPENVIKING_AUDIT_ACTIONS,
	OPENVIKING_ROLES,
	OpenVikingDashboardError,
	WINDOW_24H_MS,
	type OpenVikingAuditAction,
	type OpenVikingAuditQuery,
	type OpenVikingAuditResponse,
} from "./types.js";

export const DEFAULT_AUDIT_LIMIT = 50;
export const MAX_AUDIT_LIMIT = 500;

function invalid(field: string, value: unknown, expected: string): OpenVikingDashboardError {
	return new OpenVikingDashboardError(
		`Invalid ${field} "${String(value)}": expected ${expected}.`,
		400,
		"INVALID_ARGUMENT",
		{
			[field]: value,
		},
	);
}

export interface AuditRequest {
	limit: number;
	action: OpenVikingAuditAction | undefined;
	role: string | undefined;
}

export function parseAuditQuery(query: OpenVikingAuditQuery): AuditRequest {
	const { limit, action, role } = query;
	let n = DEFAULT_AUDIT_LIMIT;
	if (limit !== undefined && limit !== "") {
		if (typeof limit !== "string" || !/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > MAX_AUDIT_LIMIT) {
			throw invalid("limit", limit, `an integer from 1 to ${MAX_AUDIT_LIMIT}`);
		}
		n = Number(limit);
	}
	if (action !== undefined && action !== "" && !OPENVIKING_AUDIT_ACTIONS.includes(action as OpenVikingAuditAction)) {
		throw invalid("action", action, OPENVIKING_AUDIT_ACTIONS.join("|"));
	}
	if (role !== undefined && role !== "" && !(OPENVIKING_ROLES as readonly unknown[]).includes(role)) {
		throw invalid("role", role, "one of the 15 role ids");
	}
	return {
		limit: n,
		action: action ? (action as OpenVikingAuditAction) : undefined,
		role: role ? (role as string) : undefined,
	};
}

export async function buildAudit(
	paths: OpenVikingStatePaths,
	query: OpenVikingAuditQuery,
	nowMs: number,
): Promise<OpenVikingAuditResponse> {
	const req = parseAuditQuery(query);
	const [changelog, metrics, rollout] = await Promise.all([
		readChangelogRecords(paths),
		readMetricsRecords(paths),
		readRolloutState(paths),
	]);
	const all = buildAuditEvents(changelog, metrics);
	const lastMs = all.length ? Date.parse(all[0].ts) : Number.NaN;
	const in24h = all.filter((e) => nowMs - Date.parse(e.ts) <= WINDOW_24H_MS).length;
	const events = all
		.filter((e) => (req.action ? e.action === req.action : true) && (req.role ? e.role === req.role : true))
		.slice(0, req.limit);
	return {
		panel_updated_at: new Date(nowMs).toISOString(),
		// Past the cadence the badge is the age; inside it, a waiting `wt land` sync (ruling rm-b5272a3e).
		...panelHealth(in24h, lastMs, nowMs, AUDIT_CADENCE_MS, "> 15m" as const, pendingSyncCause(rollout)),
		events,
	};
}
