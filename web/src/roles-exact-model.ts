/** The supplied Roles design, backed ONLY by the existing closed presentations.
 * No RTPI records are made here: a reported status is not an execution receipt.
 * Raw feed values and chat targets never become template attributes or HTML.
 */
import { projectConfigHistory, type ExactConfigHistory } from "./roles-config-history";
import { projectRolePanel, type RolePanel } from "./roles-panel-model";
import {
	CLOCK_SKEW_MS,
	object,
	plain,
	projectUsefulRoles,
	roleId,
	TEXT_LIMIT,
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

/** roles-instructions (Ops #208): what its home chat loaded, against the files now; names and times only. */
export interface ExactInstructions {
	state: "current" | "outdated" | "none";
	loadedAt: number | null;
	changed: string[];
}

const INSTRUCTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Anything not exactly as the server sends it reads as not recorded; never a guessed state. */
export function projectInstructions(value: unknown, now: number): ExactInstructions {
	const none: ExactInstructions = { state: "none", loadedAt: null, changed: [] };
	const input = object(value);
	if (input?.state !== "current" && input?.state !== "outdated") return none;
	const at = time(input.loadedAt);
	if (at === null || !Number.isSafeInteger(at) || at <= 0 || at > now + CLOCK_SKEW_MS) return none;
	if (input.state === "current") return { state: "current", loadedAt: at, changed: [] };
	const changed = input.changed;
	if (
		!Array.isArray(changed) ||
		!changed.length ||
		changed.length > 8 ||
		changed.some((n) => typeof n !== "string" || !INSTRUCTION_NAME.test(n))
	)
		return none;
	return { state: "outdated", loadedAt: at, changed: [...new Set(changed as string[])] };
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
		if (typeof v !== "string" || v.length > 24) return null;
		if (/^\$(?:0|[1-9]\d{0,2}(?:,\d{3})*|[1-9]\d*)(?:\.\d{2})?$/.exec(v)?.[0] !== v) return null;
		const n = Number(v.slice(1).replaceAll(",", ""));
		return Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER / 100 ? n : null;
	};
	const spent = dollars(input.spent),
		budget = dollars(input.budget);
	if (spent === null || budget === null || budget <= 0 || (input.state !== "over" && spent >= budget))
		return absent("Own-work spending is unreadable.");
	const age =
		typeof input.age === "string" && /^(?:just now|\d{1,6} (?:min|h|d) ago)$/.exec(input.age)?.[0] === input.age
			? input.age
			: null;
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

/** owner-contacts (Roles D3): one of the owner's messages to a role's home chat. null = not recorded. */
export interface ExactContact {
	id: string;
	role: string;
	channel: "browser" | "telegram";
	askedAt: number;
	text: string | null;
	takenAt: number | null;
	settledAt: number | null;
	outcome: "text" | "noText" | "error" | null;
	reply: string | null;
	sentAt: number | null;
	sendFailedAt: number | null;
}

const CONTACT_ID = /^(?:ri|rs)-[a-f0-9-]{8,64}$/u;
const CONTACT_ROLE = /^[a-z0-9][a-z0-9-]{0,39}$/u;
const CONTACTS_MAX = 200;
const contactTime = (v: unknown): number | null =>
	typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
const contactText = (v: unknown, max: number): string | null =>
	typeof v === "string" && v.trim() !== "" && Array.from(v).length <= max ? v : null;

/** The server's contact list, field by field; a bad item is dropped. Not an array: not connected (null). */
export function projectContacts(raw: unknown): ExactContact[] | null {
	if (!Array.isArray(raw)) return null;
	const out: ExactContact[] = [];
	for (const item of raw.slice(0, CONTACTS_MAX)) {
		const c = object(item);
		if (!c || typeof c.id !== "string" || !CONTACT_ID.test(c.id)) continue;
		if (typeof c.role !== "string" || !CONTACT_ROLE.test(c.role)) continue;
		if (c.channel !== "browser" && c.channel !== "telegram") continue;
		const askedAt = contactTime(c.askedAt);
		if (askedAt === null) continue;
		const settledAt = contactTime(c.settledAt);
		const outcome =
			settledAt !== null && (c.outcome === "text" || c.outcome === "noText" || c.outcome === "error")
				? c.outcome
				: null;
		const telegram = c.channel === "telegram";
		out.push({
			id: c.id,
			role: c.role,
			channel: c.channel,
			askedAt,
			text: contactText(c.text, 280),
			takenAt: contactTime(c.takenAt),
			settledAt: outcome ? settledAt : null,
			outcome,
			reply: outcome === "text" ? contactText(c.reply, 1_200) : null,
			sentAt: telegram ? contactTime(c.sentAt) : null,
			sendFailedAt: telegram ? contactTime(c.sendFailedAt) : null,
		});
	}
	return out;
}

/** roles-sent: one sender → receiver pair of roles on the page with open requests or questions. */
export interface ExactPair {
	from: string;
	to: string;
	count: number;
	/** The newest one's time; null = not recorded. */
	at: number | null;
}
const PAIRS_MAX = 200;

/**
 * The server's open pairs, field by field: both ends must be roles shown, never the same one; a bad or
 * repeated pair is dropped. Not an array: not connected (null).
 */
export function projectPairs(raw: unknown, shown: ReadonlySet<string>): ExactPair[] | null {
	if (!Array.isArray(raw)) return null;
	const out: ExactPair[] = [];
	const seen = new Set<string>();
	for (const item of raw.slice(0, PAIRS_MAX)) {
		const p = object(item);
		if (!p || !roleId(p.from) || !roleId(p.to) || p.from === p.to) continue;
		if (!shown.has(p.from) || !shown.has(p.to)) continue;
		if (typeof p.count !== "number" || !Number.isSafeInteger(p.count) || p.count < 1) continue;
		const key = `${p.from}>${p.to}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ from: p.from, to: p.to, count: p.count, at: time(p.at) });
	}
	return out;
}

/** ladder-alarm: the approval step for long role-message chains is off this run. */
export interface ExactApprovalsOff {
	/** Why, as its start logged it; null = not recorded, or unsafe. */
	reason: string | null;
	/** When this server started (ms); null = not recorded. */
	since: number | null;
}

/** The server's approvals field: only an explicit on: false is "off"; on, absent or anything else -> null
 *  (nothing shown). The reason is plain bounded text (an unsafe character drops all of it). */
export function projectApprovalsOff(raw: unknown, now: number): ExactApprovalsOff | null {
	const a = object(raw);
	if (!a || a.on !== false) return null;
	const since = a.since;
	return {
		reason: plain(a.reason, TEXT_LIMIT)?.text ?? null,
		since:
			typeof since === "number" && Number.isSafeInteger(since) && since > 0 && since <= now + CLOCK_SKEW_MS
				? since
				: null,
	};
}

export interface ExactRole {
	row: UsefulRole;
	panel: RolePanel | null;
	spend: ExactSpend;
	instructions: ExactInstructions;
	/** roles-config-history (Ops #209): its recorded settings changes; null: none sent. */
	configHistory: ExactConfigHistory | null;
}
export interface ExactRoles {
	roles: ExactRole[];
	needs: NeedsYou;
	source: SourceState;
	roster: "reported" | "unavailable";
	lastReceived: boolean;
	omitted: boolean;
	now: number;
	hasOverview: boolean;
	receivedAt: number | null;
	/** owner-contacts: null = this server doesn't report them (not connected). */
	contacts: ExactContact[] | null;
	/** roles-sent: open sender → receiver pairs; null = this server doesn't report them. */
	pairs: ExactPair[] | null;
	/** ladder-alarm: set only while the approval step is off; null = on, starting or not reported. */
	approvalsOff: ExactApprovalsOff | null;
}

export function projectExactRoles(state: unknown, connection: unknown, now: number): ExactRoles {
	const model = projectUsefulRoles(state, connection, now);
	const input = object(state);
	const overview = object(input?.overview);
	const rawRoles = overview?.roles;
	const rows: unknown[] = Array.isArray(rawRoles) ? rawRoles : [];
	const received = time(input?.overviewReceivedAt);
	return {
		roles: model.roles.map((row) => ({
			row,
			panel: projectRolePanel(state, row.roleId),
			spend: projectSpend(object(rows.find((raw) => object(raw)?.id === row.roleId))?.spend),
			instructions: projectInstructions(object(rows.find((raw) => object(raw)?.id === row.roleId))?.instructions, now),
			configHistory: projectConfigHistory(
				object(rows.find((raw) => object(raw)?.id === row.roleId))?.configHistory,
				now,
			),
		})),
		hasOverview: overview !== null,
		contacts: overview !== null ? projectContacts(overview.contacts) : null,
		pairs: overview !== null ? projectPairs(overview.openPairs, new Set(model.roles.map((r) => r.roleId))) : null,
		approvalsOff: overview !== null ? projectApprovalsOff(overview.approvals, now) : null,
		receivedAt:
			overview !== null &&
			received !== null &&
			Number.isSafeInteger(received) &&
			received <= now + CLOCK_SKEW_MS &&
			Number.isFinite(new Date(received).getTime())
				? received
				: null,
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

/** A time with its day when it isn't today: "21:04" or "Oct 17, 21:04". */
export function exactWhen(at: number | null, now: number): string {
	if (at === null) return "Not recorded";
	const d = new Date(at);
	const day = d.toDateString() === new Date(now).toDateString();
	return day
		? exactClock(at)
		: `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${exactClock(at)}`;
}

export function exactClock(at: number | null): string {
	if (at === null) return "Not recorded";
	const d = new Date(at);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
