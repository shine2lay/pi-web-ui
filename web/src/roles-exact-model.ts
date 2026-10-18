/** The supplied Roles design, backed ONLY by the existing closed presentations.
 * No RTPI records are made here: a reported status is not an execution receipt.
 * Raw feed values and chat targets never become template attributes or HTML.
 */
import { projectRolePanel, type RolePanel } from "./roles-panel-model";
import {
	CLOCK_SKEW_MS,
	object,
	projectUsefulRoles,
	time,
	type NeedsYou,
	type SourceState,
	type UsefulRole,
} from "./roles-useful-model";

export interface ExactSpend {
	reported: boolean;
	amount: string | null;
	budget: string | null;
	ratio: number | null;
	stale: boolean;
	over: boolean;
	note: string;
}

/** Read only the existing own-work tally. Never infer a total or a zero from missing data. */
function projectSpend(value: unknown): ExactSpend {
	const input = object(value);
	const absent = (note: string): ExactSpend => ({
		reported: false,
		amount: null,
		budget: null,
		ratio: null,
		stale: false,
		over: false,
		note,
	});
	if (input?.state === "none") return absent("No own-work budget recorded. This does not mean no spending.");
	if (input?.state === "old-week") return absent("No own-work tally for this week yet.");
	if (!input || typeof input.state !== "string" || !["ok", "stale", "over"].includes(input.state))
		return absent("Own-work spending is unavailable.");
	const dollars = (v: unknown): number | null => {
		if (typeof v !== "string" || v.length > 24 || !/^\$(?:0|[1-9]\d{0,2}(?:,\d{3})*|[1-9]\d*)(?:\.\d{2})?$/.test(v))
			return null;
		const n = Number(v.slice(1).replaceAll(",", ""));
		return Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER / 100 ? n : null;
	};
	const spent = dollars(input.spent),
		budget = dollars(input.budget);
	if (spent === null || budget === null || budget <= 0 || (input.state !== "over" && spent >= budget))
		return absent("Own-work spending is unreadable.");
	const age =
		typeof input.age === "string" && /^(?:just now|\d{1,6} (?:min|h|d) ago)$/.test(input.age) ? input.age : null;
	return {
		reported: true,
		amount: String(input.spent),
		budget: String(input.budget),
		ratio: Math.min(1, spent / budget),
		stale: input.state === "stale",
		over: input.state === "over",
		note: `Role’s own tally${input.state === "stale" ? " · stale" : ""}${input.state === "over" ? " · budget used or own work stopped" : ""}${age ? ` · updated ${age}` : ""}. Requested work is not included.`,
	};
}

export interface ExactRole {
	row: UsefulRole;
	panel: RolePanel | null;
	spend: ExactSpend;
}
export interface ExactRoles {
	roles: ExactRole[];
	needs: NeedsYou;
	source: SourceState;
	roster: "reported" | "unavailable";
	lastReceived: boolean;
	omitted: boolean;
	now: number;
	receivedAt: number | null;
}

export function projectExactRoles(state: unknown, connection: unknown, now: number): ExactRoles {
	const model = projectUsefulRoles(state, connection, now);
	const input = object(state);
	const rawRoles = object(input?.overview)?.roles;
	const rows: unknown[] = Array.isArray(rawRoles) ? rawRoles : [];
	const heard = time(input?.heardAt);
	return {
		roles: model.roles.map((row) => ({
			row,
			panel: projectRolePanel(state, row.roleId),
			spend: projectSpend(object(rows.find((raw) => object(raw)?.id === row.roleId))?.spend),
		})),
		receivedAt:
			heard !== null && heard <= now + CLOCK_SKEW_MS && Number.isFinite(new Date(heard).getTime()) ? heard : null,
		needs: model.needsYou,
		source: model.source,
		roster: model.roster,
		lastReceived: model.lastReceived,
		omitted: model.omitted,
		now,
	};
}

/** Fixed words only: an error string from the server must never reach the view. */
export const EXACT_SOURCE: Record<SourceState, { title: string; body: string; label: string }> = {
	awaiting: {
		title: "Loading role status",
		body: "Nothing is shown as Idle, Finished or All clear until each role’s status is confirmed.",
		label: "Loading…",
	},
	error: {
		title: "Couldn’t load role status",
		body: "No current role status is available. Try loading the page’s data again.",
		label: "Unavailable",
	},
	"cached-error": {
		title: "Couldn’t update role status",
		body: "Everything below is the last received state, not a current confirmation.",
		label: "Update failed",
	},
	disconnected: {
		title: "Disconnected from the Roles service",
		body: "Everything below is the last received state. Reconnecting does not confirm it until a new check arrives.",
		label: "Disconnected",
	},
	cached: {
		title: "Disconnected from the Roles service",
		body: "Connection is unavailable. Last received information is shown, not a current confirmation.",
		label: "Disconnected",
	},
	stale: {
		title: "Role status may be out of date",
		body: "No recent update has arrived. Everything below is the last received state.",
		label: "Stale",
	},
	partial: {
		title: "Some role information is unavailable",
		body: "The parts we received are shown below. Missing information is not an all-clear.",
		label: "Partial data",
	},
	unknown: {
		title: "Current role status is unknown",
		body: "The available information is not enough to confirm the current state.",
		label: "Unknown",
	},
	"connected-source-unverified": {
		title: "",
		body: "",
		label: "Live",
	},
};

export function exactAge(since: number | null, now: number): string {
	if (since === null) return "time unknown";
	const minutes = Math.floor(Math.max(0, now - since) / 60_000);
	if (minutes < 1) return "under a minute";
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.floor(minutes / 60);
	return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} days`;
}

export function exactClock(at: number | null): string {
	if (at === null) return "Not recorded";
	const d = new Date(at);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
