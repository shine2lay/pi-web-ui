/** The supplied Roles design, backed ONLY by the existing closed presentations.
 * No RTPI records are made here: a reported status is not an execution receipt.
 * Raw feed values and chat targets never become template attributes or HTML.
 */
import { projectRolePanel, type RolePanel } from "./roles-panel-model";
import { projectUsefulRoles, type NeedsYou, type SourceState, type UsefulRole } from "./roles-useful-model";

export interface ExactRole {
	row: UsefulRole;
	panel: RolePanel | null;
}
export interface ExactRoles {
	roles: ExactRole[];
	needs: NeedsYou;
	source: SourceState;
	roster: "reported" | "unavailable";
	lastReceived: boolean;
	omitted: boolean;
	now: number;
}

export function projectExactRoles(state: unknown, connection: unknown, now: number): ExactRoles {
	const model = projectUsefulRoles(state, connection, now);
	return {
		roles: model.roles.map((row) => ({ row, panel: projectRolePanel(state, row.roleId) })),
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
		title: "Waiting for a fresh check",
		body: "Last received information is shown, but a current check is unavailable.",
		label: "Last received",
	},
	stale: {
		title: "Role status may be out of date",
		body: "No recent update has arrived. Everything below is the last received state.",
		label: "Out of date",
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
		label: "Reported status",
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
