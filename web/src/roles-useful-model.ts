/** Closed presentation only. The inherited full wire/store is NOT a confidentiality boundary.
 * No native identity, completeness, freshness or execution claim can be derived from this feed.
 * Each call constructs a fresh projection of one received snapshot; nothing is retained or joined.
 */
export const ROLE_LIMIT = 64;
export const RECORD_LIMIT = 20;
export const LABEL_LIMIT = 120;

const STATUSES = ["ready", "working", "asking", "stuck", "waiting", "blocked", "done"] as const;
const STOP_REASONS = ["user", "stopped", "error", "restart", "finished"] as const;
export type ReportedStatus = (typeof STATUSES)[number];
export type StopReason = (typeof STOP_REASONS)[number];
export type PauseMarker = "reported-paused" | "not-reported" | "unknown";
export type ReplayCount = number | "not-established" | "unavailable";
export type SourceState =
	| "awaiting"
	| "error"
	| "cached-error"
	| "disconnected"
	| "cached"
	| "partial"
	| "unknown"
	| "connected-source-unverified";

export interface UsefulRecord {
	taskId: number;
	reportedStatus: ReportedStatus | null;
	pause: PauseMarker;
}
export interface UsefulRecords {
	available: boolean;
	omitted: boolean;
	notAllShown: boolean;
	records: UsefulRecord[];
}
export interface UsefulRole {
	roleId: string;
	roleLabel: string;
	labelTruncated: boolean;
	partial: boolean;
	queueEnabled: boolean | null;
	stopReason: StopReason | null;
	hold: PauseMarker;
	counts: { active: ReplayCount; queued: ReplayCount; done: ReplayCount };
	active: UsefulRecords;
	queued: UsefulRecords;
}
export interface UsefulRoles {
	source: SourceState;
	roster: "reported" | "unavailable";
	omitted: boolean;
	roles: UsefulRole[];
}

type Fields = Record<string, unknown>;
function object(value: unknown): Fields | null {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Fields) : null;
}
function roleId(value: unknown): value is string {
	// JavaScript `$` also matches before a final newline; require the entire matched value.
	return typeof value === "string" && /^[a-z][a-z0-9-]{0,31}$/.exec(value)?.[0] === value;
}
function taskId(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function status(value: unknown): ReportedStatus | null {
	return STATUSES.find((candidate) => candidate === value) ?? null;
}
function stop(value: unknown): StopReason | null {
	return STOP_REASONS.find((candidate) => candidate === value) ?? null;
}
function marker(record: Fields | null, key: string): PauseMarker {
	if (!record) return "unknown";
	if (!Object.hasOwn(record, key)) return "not-reported";
	const value = object(record[key]);
	return value &&
		typeof value.at === "number" &&
		Number.isFinite(value.at) &&
		typeof value.why === "string" &&
		value.why.trim().length > 0
		? "reported-paused"
		: "unknown";
}
function count(value: unknown, problem: boolean): ReplayCount {
	if (problem || typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return "unavailable";
	return value === 0 ? "not-established" : value;
}
function problem(value: unknown): boolean {
	// Only absence or an empty well-shaped problem list means no reported problem.
	return value !== undefined && (!Array.isArray(value) || value.length > 0);
}
function label(value: unknown, id: string): { text: string; truncated: boolean } {
	if (typeof value !== "string" || !value.trim()) return { text: id, truncated: false };
	// Reject malformed UTF-16, controls (including bidi controls); never hide an unsafe full label.
	const points = Array.from(value);
	if (points.some((point) => /[\p{Cc}\p{Cs}\p{Cf}]/u.test(point))) return { text: id, truncated: false };
	return points.length > LABEL_LIMIT
		? { text: points.slice(0, LABEL_LIMIT - 1).join("") + "…", truncated: true }
		: { text: value, truncated: false };
}
function idFrequencies(
	rows: unknown[],
	getId: (value: unknown) => string | number | null,
): Map<string | number, number> {
	const seen = new Map<string | number, number>();
	for (const row of rows) {
		const id = getId(row);
		if (id !== null) seen.set(id, (seen.get(id) ?? 0) + 1);
	}
	return seen;
}
function records(value: unknown, seen: Map<string | number, number>, reported: ReplayCount): UsefulRecords {
	const result: UsefulRecords = {
		available: Array.isArray(value),
		omitted: false,
		notAllShown: typeof reported === "number" && reported > 0,
		records: [],
	};
	if (!Array.isArray(value)) return result;
	for (const raw of value) {
		const row = object(raw);
		if (!row || !taskId(row.id) || seen.get(row.id) !== 1 || result.records.length >= RECORD_LIMIT) {
			result.omitted = true;
			continue;
		}
		result.records.push({ taskId: row.id, reportedStatus: status(row.status), pause: marker(row, "paused") });
	}
	result.notAllShown = typeof reported === "number" && reported > result.records.length;
	return result;
}
function projectRole(row: Fields, id: string): UsefulRole {
	const name = label(row.title, id);
	const queue = object(row.queue);
	const hasProblem = problem(row.problems);
	const rawCounts = object(queue?.counts);
	const counts = {
		active: count(rawCounts?.active, hasProblem),
		queued: count(rawCounts?.queued, hasProblem),
		done: count(rawCounts?.done, hasProblem),
	};
	// Ambiguity is role-local and spans both received lists, even beyond the display cap.
	const taskRows: unknown[] = [];
	if (Array.isArray(queue?.active)) for (const row of queue.active) taskRows.push(row);
	if (Array.isArray(queue?.queued)) for (const row of queue.queued) taskRows.push(row);
	const seen = idFrequencies(taskRows, (raw) => {
		const candidate = object(raw)?.id;
		return taskId(candidate) ? candidate : null;
	});
	const active = records(queue?.active, seen, counts.active);
	const queued = records(queue?.queued, seen, counts.queued);
	return {
		roleId: id,
		roleLabel: name.text,
		labelTruncated: name.truncated,
		partial: hasProblem || !queue || !active.available || !queued.available,
		queueEnabled: typeof queue?.running === "boolean" ? queue.running : null,
		stopReason: stop(queue?.pausedReason),
		hold: marker(queue, "hold"),
		counts,
		active,
		queued,
	};
}

/** Input deliberately unknown: validate at the actual store/consumer boundary, not only by DTO types. */
export function projectUsefulRoles(state: unknown, connection: unknown): UsefulRoles {
	const input = object(state);
	const overview = object(input?.overview);
	const rows = Array.isArray(overview?.roles) ? overview.roles : [];
	const seen = idFrequencies(rows, (raw) => {
		const candidate = object(raw)?.id;
		return roleId(candidate) ? candidate : null;
	});
	const roles: UsefulRole[] = [];
	let omitted = false;
	for (const raw of rows) {
		const row = object(raw);
		if (!row || !roleId(row.id) || seen.get(row.id) !== 1 || roles.length >= ROLE_LIMIT) {
			omitted = true;
			continue;
		}
		roles.push(projectRole(row, row.id));
	}
	const cached = overview !== null;
	const error =
		input?.status === "error" || (input !== null && Object.hasOwn(input, "error") && input.error !== undefined);
	let source: SourceState;
	if (connection === "closed" || connection === "connecting") source = cached ? "cached" : "disconnected";
	else if (error) source = cached ? "cached-error" : "error";
	else if (!cached && (input?.status === "idle" || input?.status === "loading")) source = "awaiting";
	else if (connection !== "open" || !cached) source = "unknown";
	else if (!roles.length || omitted || roles.some((row) => row.partial)) source = "partial";
	else source = "connected-source-unverified";
	return { source, roster: roles.length ? "reported" : "unavailable", omitted, roles };
}
