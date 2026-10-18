/**
 * roles-config-history (Ops #209): what changed in each role's settings, and when (the Roles page's Config tab).
 *
 * The Roles overview only reads (roles-overview.ts); this recorder is the only writer. AgentService runs it after
 * the restart's carry-on and every 5 minutes (an unref'd timer). Each run gets the settings the Roles page shows
 * for every role (RolesOverviewReader.configSettings: identity.json's title, work mode, goals and home chat, the
 * about page's Focus line, its queue's lanes, Auto approve, Auto start, default model, thinking and speed and the
 * owner's pause, and its home chat's model), compares them with the last run's snapshot
 * (<dataDir>/roles-config-snapshot.json) and appends one line per changed setting to
 * <dataDir>/roles-config-history.jsonl: {"v":1,"at":ms,"role":id,"field":name,"from":old,"to":new}.
 *
 * - A role's first snapshot is its baseline: its time is the "since" the page shows, never a change.
 * - A setting that can't be read in a run (home chat unreadable, model unknown, no Focus line) keeps its last
 *   value: no line. A setting seen for the first time joins the baseline quietly.
 * - Setting values only, never message text or prompts; cut at 200 characters in the history.
 * - Lines older than 90 days are dropped. Both files are 0600; the snapshot is replaced atomically.
 * - Who changed a setting isn't known (identity.json and the queue are changed by hand and by add-ons), so nothing
 *   here guesses it.
 */
import { appendFileSync, chmodSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { UiRoleConfigChange, UiRoleConfigHistory, UiTaskQueue } from "./protocol.js";
import { TASK_QUEUE_DEFAULT_LANES } from "./task-queue.js";

/** How often AgentService runs the recorder. */
export const ROLES_CONFIG_EVERY_MS = 5 * 60_000;
/** History lines older than this are dropped. */
export const ROLES_CONFIG_KEEP_MS = 90 * 86_400_000;
/** A value in the history is cut at this many characters. */
export const ROLES_CONFIG_VALUE_MAX = 200;
/** The newest changes the page gets per role. */
export const ROLES_CONFIG_SHOWN = 20;
/** The snapshot keeps whole values (so a change past 200 characters still counts), up to this. */
const SNAPSHOT_VALUE_MAX = 4000;
/** Files bigger than this aren't read (they never get near it: changes are rare and kept 90 days). */
const FILE_MAX = 8 << 20;

/** The settings recorded, in the order the page lists a run's changes. */
export const ROLE_CONFIG_FIELDS = [
	"title",
	"focus",
	"workMode",
	"goals",
	"homeChat",
	"lanesAtOnce",
	"autoApprove",
	"autoStart",
	"queueModel",
	"queueThinking",
	"queueSpeed",
	"queuePaused",
	"model",
] as const;
export type RoleConfigField = (typeof ROLE_CONFIG_FIELDS)[number];
/** A role's settings as text; a setting that couldn't be read now is left out. */
export type RoleSettings = Partial<Record<RoleConfigField, string>>;

const FIELDS: ReadonlySet<string> = new Set(ROLE_CONFIG_FIELDS);

/** A role's settings as the recorder compares them (setting values only). */
export function roleSettingsOf(input: {
	title: string;
	/** The about page's Focus line; undefined: none could be read. */
	focus?: string;
	workMode: string;
	/** Its goals as identity.json (or the rules) list them, ended ones too: an ending isn't a settings change. */
	goals: readonly { name: string; scope: string }[];
	homeChat: string | null;
	/** Its home chat's queue; undefined: not read now. */
	queue?: UiTaskQueue;
	/** Its home chat's model as the page names it; undefined: not known now. */
	model?: string;
}): RoleSettings {
	const goals = [...input.goals].sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope));
	const out: RoleSettings = {
		title: input.title,
		workMode: input.workMode,
		goals: goals.length ? goals.map((g) => `${g.name} (${g.scope})`).join("; ") : "none",
		homeChat: input.homeChat ? basename(input.homeChat) : "none",
	};
	if (input.focus) out.focus = input.focus;
	const q = input.queue;
	if (q) {
		out.lanesAtOnce = String(q.lanesAtOnce ?? TASK_QUEUE_DEFAULT_LANES);
		out.autoApprove = q.autoApprove ? "on" : "off";
		out.autoStart = q.autoStart ? "on" : "off";
		out.queueModel = q.profile?.model || "not set";
		out.queueThinking = q.profile?.thinking || "not set";
		out.queueSpeed = q.profile?.speed || "not set";
		out.queuePaused = q.hold ? "yes" : "no";
	}
	if (input.model) out.model = input.model;
	return out;
}

/** One line of roles-config-history.jsonl. */
export interface RoleConfigLine extends UiRoleConfigChange {
	v: 1;
	role: string;
}

interface Snapshot {
	v: 1;
	at: number;
	roles: Record<string, { since: number; values: RoleSettings }>;
}

function cut(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function readSmall(file: string): string | null {
	try {
		if (statSync(file).size > FILE_MAX) return null;
		return readFileSync(file, "utf8");
	} catch {
		return null;
	}
}

function isTime(v: unknown): v is number {
	return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}

/** The last snapshot, or null when there is none or it can't be trusted (then the next run is a new baseline). */
function readSnapshot(file: string): Snapshot | null {
	const text = readSmall(file);
	if (text === null) return null;
	try {
		const raw = JSON.parse(text) as { v?: unknown; at?: unknown; roles?: unknown };
		if (raw?.v !== 1 || !isTime(raw.at) || !raw.roles || typeof raw.roles !== "object") return null;
		const roles: Snapshot["roles"] = {};
		for (const [id, r] of Object.entries(raw.roles as Record<string, { since?: unknown; values?: unknown }>)) {
			if (!r || !isTime(r.since) || !r.values || typeof r.values !== "object") continue;
			const values: RoleSettings = {};
			for (const [k, v] of Object.entries(r.values as Record<string, unknown>)) {
				if (FIELDS.has(k) && typeof v === "string") values[k as RoleConfigField] = v;
			}
			roles[id] = { since: r.since, values };
		}
		return { v: 1, at: raw.at, roles };
	} catch {
		return null;
	}
}

function readLines(file: string): RoleConfigLine[] {
	const text = readSmall(file);
	if (!text) return [];
	const out: RoleConfigLine[] = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		try {
			const l = JSON.parse(line) as Partial<RoleConfigLine>;
			if (
				l.v === 1 &&
				isTime(l.at) &&
				typeof l.role === "string" &&
				typeof l.field === "string" &&
				FIELDS.has(l.field) &&
				typeof l.from === "string" &&
				typeof l.to === "string"
			) {
				out.push({ v: 1, at: l.at, role: l.role, field: l.field, from: l.from, to: l.to });
			}
		} catch {
			// a torn line: skipped
		}
	}
	return out;
}

/** Replaces `file` whole: a temporary file next to it (0600), then a rename. */
function writeAtomic(file: string, text: string): void {
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, file);
}

/** The recorder: compares each run's settings with the last snapshot and keeps the changes (see the file comment). */
export class RolesConfigHistory {
	readonly snapshotFile: string;
	readonly historyFile: string;
	private loaded = false;
	private snapshot: Snapshot | null = null;
	private lines: RoleConfigLine[] = [];

	constructor(dataDir: string) {
		this.snapshotFile = join(dataDir, "roles-config-snapshot.json");
		this.historyFile = join(dataDir, "roles-config-history.jsonl");
	}

	private load(): void {
		if (this.loaded) return;
		this.loaded = true;
		this.snapshot = readSnapshot(this.snapshotFile);
		this.lines = readLines(this.historyFile);
	}

	/** One run: `settings` is each role's settings now. Returns the lines it added (none on a baseline). */
	record(settings: ReadonlyMap<string, RoleSettings>, at: number): RoleConfigLine[] {
		this.load();
		const snap: Snapshot = this.snapshot ?? { v: 1, at, roles: {} };
		let dirty = !this.snapshot;
		const added: RoleConfigLine[] = [];
		for (const [role, values] of settings) {
			const prev = snap.roles[role];
			if (!prev) {
				// Its baseline: shown as the "since" time, never as changes.
				const base: RoleSettings = {};
				for (const field of ROLE_CONFIG_FIELDS) {
					const v = values[field];
					if (v !== undefined) base[field] = cut(v, SNAPSHOT_VALUE_MAX);
				}
				snap.roles[role] = { since: at, values: base };
				dirty = true;
				continue;
			}
			for (const field of ROLE_CONFIG_FIELDS) {
				const now = values[field];
				if (now === undefined) continue; // not read now: its last value stays
				const to = cut(now, SNAPSHOT_VALUE_MAX);
				const from = prev.values[field];
				if (from === to) continue;
				prev.values[field] = to;
				dirty = true;
				if (from === undefined) continue; // first seen: part of the baseline
				added.push({
					v: 1,
					at,
					role,
					field,
					from: cut(from, ROLES_CONFIG_VALUE_MAX),
					to: cut(to, ROLES_CONFIG_VALUE_MAX),
				});
			}
		}
		snap.at = at;
		this.snapshot = snap;
		// The history first: a run cut off before the snapshot is written records the change again, never loses it.
		const kept = this.lines.filter((l) => l.at >= at - ROLES_CONFIG_KEEP_MS);
		const dropped = kept.length !== this.lines.length;
		this.lines = [...kept, ...added];
		if (dropped) writeAtomic(this.historyFile, this.lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
		else if (added.length)
			appendFileSync(this.historyFile, added.map((l) => `${JSON.stringify(l)}\n`).join(""), { mode: 0o600 });
		if (dirty) writeAtomic(this.snapshotFile, JSON.stringify(snap));
		return added;
	}

	/** A role's changes for the Config tab (newest first); undefined before its baseline. */
	view(role: string): UiRoleConfigHistory | undefined {
		this.load();
		const base = this.snapshot?.roles[role];
		if (!base) return undefined;
		const changes: UiRoleConfigChange[] = [];
		for (let i = this.lines.length - 1; i >= 0 && changes.length < ROLES_CONFIG_SHOWN; i--) {
			const l = this.lines[i];
			if (l.role === role) changes.push({ at: l.at, field: l.field, from: l.from, to: l.to });
		}
		return { since: base.since, changes };
	}
}
