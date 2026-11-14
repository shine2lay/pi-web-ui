/**
 * OpenViking Memory Dashboard — `GET /api/openviking/audit`: the Audit Trail of memory writes and
 * guard verdicts from `memory-changelog.jsonl` + `metrics.jsonl`, newest first, with personal
 * summaries redacted (R-ISOLATION-1). Reads state files only; never calls `:1933`. `?owner_only=true` keeps only the
 * owner's own changes (G7), filtered before `limit` so other writes never push them out. Owner events are served
 * only when the route's owner check for reads passed (`included`, R-AUDIT-OWNER-1); else they are left out before
 * `limit` (`withheld`) and `?owner_only=true` answers `403 OWNER_ONLY`.
 */
import { buildAuditEvents } from "./activity.js";
import { explorerRefusal } from "./explorer-rules.js";
import { OPENVIKING_OWNER_AUDIT_ACTIONS } from "./explorer-types.js";
import { OWNER_ONLY_BODY } from "./owner-session-types.js";
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
	type OpenVikingAuditEventAction,
	type OpenVikingAuditQuery,
	type OpenVikingAuditResponse,
	type OpenVikingOwnerEvents,
} from "./types.js";

const OWNER_EVENT_ACTIONS: ReadonlySet<string> = new Set(OPENVIKING_OWNER_AUDIT_ACTIONS);
/** `?action=` values: the panel's actions and the owner's (G7). */
const FILTER_ACTIONS: readonly OpenVikingAuditEventAction[] = [
	...OPENVIKING_AUDIT_ACTIONS,
	...OPENVIKING_OWNER_AUDIT_ACTIONS,
];

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
	action: OpenVikingAuditEventAction | undefined;
	role: string | undefined;
	ownerOnly: boolean;
}

export function parseAuditQuery(query: OpenVikingAuditQuery): AuditRequest {
	const { limit, action, role, owner_only: ownerOnly } = query;
	let n = DEFAULT_AUDIT_LIMIT;
	if (limit !== undefined && limit !== "") {
		if (typeof limit !== "string" || !/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > MAX_AUDIT_LIMIT) {
			throw invalid("limit", limit, `an integer from 1 to ${MAX_AUDIT_LIMIT}`);
		}
		n = Number(limit);
	}
	if (action !== undefined && action !== "" && !FILTER_ACTIONS.includes(action as OpenVikingAuditEventAction)) {
		throw invalid("action", action, FILTER_ACTIONS.join("|"));
	}
	if (role !== undefined && role !== "" && !(OPENVIKING_ROLES as readonly unknown[]).includes(role)) {
		throw invalid("role", role, "one of the 15 role ids");
	}
	if (ownerOnly !== undefined && ownerOnly !== "" && ownerOnly !== "true" && ownerOnly !== "false") {
		throw invalid("owner_only", ownerOnly, "true|false");
	}
	return {
		limit: n,
		action: action ? (action as OpenVikingAuditEventAction) : undefined,
		role: role ? (role as string) : undefined,
		ownerOnly: ownerOnly === "true",
	};
}

export async function buildAudit(
	paths: OpenVikingStatePaths,
	query: OpenVikingAuditQuery,
	nowMs: number,
	ownerEvents: OpenVikingOwnerEvents,
): Promise<OpenVikingAuditResponse> {
	const withheld = ownerEvents === "withheld";
	// R-OWNER-REFUSE-1: the owner routes' one refusal body.
	if (withheld && query.owner_only === "true") throw explorerRefusal("OWNER_ONLY", OWNER_ONLY_BODY.error.message);
	const req = parseAuditQuery(query);
	const [changelog, metrics, rollout] = await Promise.all([
		readChangelogRecords(paths),
		readMetricsRecords(paths),
		readRolloutState(paths),
	]);
	// Withheld: owner events are left out before anything is counted, filtered or limited, health included.
	const all = buildAuditEvents(changelog, metrics).filter((e) => !withheld || !OWNER_EVENT_ACTIONS.has(e.action));
	const lastMs = all.length ? Date.parse(all[0].ts) : Number.NaN;
	const in24h = all.filter((e) => nowMs - Date.parse(e.ts) <= WINDOW_24H_MS).length;
	const events = all
		.filter((e) => (req.action ? e.action === req.action : true) && (req.role ? e.role === req.role : true))
		.filter((e) => !req.ownerOnly || OWNER_EVENT_ACTIONS.has(e.action))
		.slice(0, req.limit);
	return {
		panel_updated_at: new Date(nowMs).toISOString(),
		owner_events: ownerEvents,
		// Past the cadence the badge is the age; inside it, a waiting `wt land` sync (ruling rm-b5272a3e).
		...panelHealth(in24h, lastMs, nowMs, AUDIT_CADENCE_MS, "> 15m" as const, pendingSyncCause(rollout)),
		events,
	};
}
