/**
 * stall-watch (Ops #283, docs/stall-watch.md): finds the active projects and initiatives of the work registry
 * that have stalled, from the records alone (no model), and works out whom to wake, in what order.
 *
 * - "empty": no open task under it for emptyHours (an initiative: no active project and no open task filed
 *   straight under it); "silent": open tasks but nothing recorded for silentHours.
 * - Quiet, never flagged: an active wait (pi-queue's wait action, Ops #282), every open task paused by the owner,
 *   or an open task waiting on the owner.
 * - The rules are pure functions of (page, extra, now, settings). StallWatch runs them every everyMin minutes and
 *   hands the findings to an injectable act(findings, now); the default act only logs (the dry run). Waking the
 *   leads is Ops #284's, built on StallFinding, stallFindings, StallSettings, stallSettings and StallWatch as
 *   they are here.
 */
import { existsSync, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { UiWorkPage, UiWorkPageRecord, UiWorkPageTask, UiWorkWait } from "./protocol.js";
import { resolveDataDir } from "./uploads.js";

// ---------------------------------------------------------------------------------------------------------------
// The contract (Ops #284 builds on it: keep it exactly)
// ---------------------------------------------------------------------------------------------------------------

export interface StallFinding {
	kind: "project" | "initiative";
	id: string;
	name: string;
	rule: "empty" | "silent";
	since: number;
	stretch: string;
	chain: string[];
	initiative?: string;
	lastDone?: { queue: string; task: number; title: string; summary?: string; at: number };
	open: { queue: string; task: number; title: string; status: string; waitsOn?: string }[];
}

export interface StallSettings {
	mode: "off" | "dry" | "on";
	emptyHours: number;
	silentHours: number;
	gapHours: number;
	everyMin: number;
}

/** What one round hands on: the findings and the time it looked. */
export type StallAct = (findings: StallFinding[], now: number) => void | Promise<void>;

// ---------------------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------------------

export const STALL_FILE = "stall-watch.json";
export const STALL_DEFAULTS: Readonly<StallSettings> = {
	mode: "dry",
	emptyHours: 2,
	silentHours: 24,
	gapHours: 2,
	everyMin: 10,
};
/** A wait never counts for longer than this after it was recorded (pi-queue's own cap, Ops #282). */
export const STALL_WAIT_MAX_MS = 14 * 24 * 3_600_000;
/** The first round comes this long after the start, so a restart's cold first overview is out of the way. */
export const STALL_FIRST_MS = 60_000;
/** Rounds are never closer together than this, whatever the settings say. */
const STALL_MIN_EVERY_MS = 200;
const HOUR = 3_600_000;
const WAITS_ON_MAX = 300;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const MODES: readonly string[] = ["off", "dry", "on"];

/** The settings from the file's JSON; each field on its own, a bad or missing one falls back to its default. */
export function parseStallSettings(raw: unknown): StallSettings {
	const o = isObject(raw) ? raw : {};
	const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d);
	return {
		mode: typeof o.mode === "string" && MODES.includes(o.mode) ? (o.mode as StallSettings["mode"]) : "dry",
		emptyHours: num(o.emptyHours, STALL_DEFAULTS.emptyHours),
		silentHours: num(o.silentHours, STALL_DEFAULTS.silentHours),
		gapHours: num(o.gapHours, STALL_DEFAULTS.gapHours),
		everyMin: num(o.everyMin, STALL_DEFAULTS.everyMin),
	};
}

/** Where the settings are: PI_WEB_STALL_FILE (tests), else the given file, else the server's data folder. */
export function stallSettingsFile(file?: string, env: NodeJS.ProcessEnv = process.env): string {
	return env.PI_WEB_STALL_FILE || file || join(resolveDataDir(), STALL_FILE);
}

/**
 * ~/.pi-web-ui/stall-watch.json (the server's data folder), read each time it is asked. Missing or unreadable:
 * the defaults (mode "dry"). Tests override single fields with PI_WEB_STALL_MODE, PI_WEB_STALL_EMPTY_HOURS,
 * PI_WEB_STALL_SILENT_HOURS, PI_WEB_STALL_GAP_HOURS and PI_WEB_STALL_EVERY_MIN.
 */
export function stallSettings(file?: string, env: NodeJS.ProcessEnv = process.env): StallSettings {
	const path = stallSettingsFile(file, env);
	let raw: unknown = {};
	try {
		if (existsSync(path)) raw = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		raw = {};
	}
	const o: Record<string, unknown> = isObject(raw) ? { ...raw } : {};
	const fromEnv = (name: string, key: keyof StallSettings) => {
		const v = env[name];
		if (v === undefined || v === "") return;
		o[key] = key === "mode" ? v : Number(v);
	};
	fromEnv("PI_WEB_STALL_MODE", "mode");
	fromEnv("PI_WEB_STALL_EMPTY_HOURS", "emptyHours");
	fromEnv("PI_WEB_STALL_SILENT_HOURS", "silentHours");
	fromEnv("PI_WEB_STALL_GAP_HOURS", "gapHours");
	fromEnv("PI_WEB_STALL_EVERY_MIN", "everyMin");
	return parseStallSettings(o);
}

// ---------------------------------------------------------------------------------------------------------------
// What the page lacks: times from the registry's own text, and the lead updates
// ---------------------------------------------------------------------------------------------------------------

/** One item's times the page doesn't carry (ms). */
export interface StallTimes {
	/** Its last status or lead change. */
	statusAt?: number;
	/** The newest registry event about it or its tasks (a project's also count for its initiative). */
	eventAt?: number;
	/** An open task under it last closed or moved away; an initiative's also when an active project of it did. */
	leftAt?: number;
	/** Its last wait was ended early by a resume. */
	resumedAt?: number;
}

export interface StallExtra {
	/** By `${kind}:${id}`. */
	times: ReadonlyMap<string, StallTimes>;
	/** Each initiative's newest lead update in the progress feed (ms). */
	leadUpdates: ReadonlyMap<string, number>;
}

export const itemKey = (kind: "project" | "initiative", id: string) => `${kind}:${id}`;

const OPEN_STATES: ReadonlySet<string> = new Set(["ready", "working", "asking", "stuck", "waiting", "blocked"]);
/** Open: ready, working, asking, stuck, waiting or blocked; a link with no status recorded yet counts as open. */
export const isOpenState = (state: string | undefined): boolean => state === undefined || OPEN_STATES.has(state);

/** The lead updates, newest per initiative (at or before upTo). */
export function leadUpdatesOf(
	updates: readonly { initiative: string; at: number }[],
	upTo = Number.POSITIVE_INFINITY,
): Map<string, number> {
	const out = new Map<string, number>();
	for (const u of updates) {
		if (!u.initiative || !isTime(u.at) || u.at > upTo) continue;
		if (!((out.get(u.initiative) ?? -1) >= u.at)) out.set(u.initiative, u.at);
	}
	return out;
}

/**
 * The extra times from the registry's text (pi-work-management's events.jsonl), in one pass. Only lines at or
 * before upTo count (the backtest). A half-written last line and lines that aren't changes are left out.
 */
export function stallExtraFrom(
	log: string,
	updates: readonly { initiative: string; at: number }[] = [],
	upTo = Number.POSITIVE_INFINITY,
): StallExtra {
	return { times: stallTimesFrom(log, upTo), leadUpdates: leadUpdatesOf(updates, upTo) };
}

export function stallTimesFrom(log: string, upTo = Number.POSITIVE_INFINITY): Map<string, StallTimes> {
	const times = new Map<string, StallTimes>();
	const bump = (key: string, field: keyof StallTimes, at: number) => {
		let t = times.get(key);
		if (!t) times.set(key, (t = {}));
		if (!((t[field] ?? -1) >= at)) t[field] = at;
	};
	/** Each project's initiative and status as the log says now. */
	const projects = new Map<string, { initiative: string | null; status: string }>();
	/** Each link (queue, task, added): where it is and whether it is open. */
	const links = new Map<string, { parent: string | undefined; open: boolean }>();
	const parentKey = (p: unknown): string | undefined => {
		if (!isObject(p)) return undefined;
		if (typeof p.project === "string") return itemKey("project", p.project);
		if (typeof p.initiative === "string") return itemKey("initiative", p.initiative);
		return undefined;
	};
	/** Something happened about an item: a project's count for its initiative too. */
	const touch = (key: string | undefined, at: number) => {
		if (!key) return;
		bump(key, "eventAt", at);
		if (key.startsWith("project:")) {
			const ini = projects.get(key.slice("project:".length))?.initiative;
			if (ini) bump(itemKey("initiative", ini), "eventAt", at);
		}
	};
	const lines = log.split("\n");
	lines.pop();
	for (const line of lines) {
		if (!line.trim()) continue;
		let e: unknown;
		try {
			e = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isObject(e) || e.v !== 1 || typeof e.op !== "string" || !isTime(e.ts) || e.ts > upTo) continue;
		const at = e.ts;
		const [kind, act] = e.op.split(".");
		if (kind === "initiative" || kind === "project") {
			if (typeof e.id !== "string") continue;
			const key = itemKey(kind, e.id);
			if (kind === "project" && act === "create") {
				projects.set(e.id, { initiative: typeof e.initiative === "string" ? e.initiative : null, status: "active" });
			}
			touch(key, at);
			if (act === "change" && isObject(e.changes)) {
				const ch = e.changes;
				if (ch.status !== undefined || ch.lead !== undefined) bump(key, "statusAt", at);
				const was = kind === "project" ? projects.get(e.id) : undefined;
				if (was) {
					const initiative =
						ch.initiative === undefined ? was.initiative : typeof ch.initiative === "string" ? ch.initiative : null;
					const status = typeof ch.status === "string" ? ch.status : was.status;
					// An active project closing or moving away leaves its initiative.
					if (was.initiative && was.status === "active" && (status !== "active" || initiative !== was.initiative)) {
						bump(itemKey("initiative", was.initiative), "leftAt", at);
					}
					projects.set(e.id, { initiative, status });
				}
			}
			if (act === "resume") bump(key, "resumedAt", at);
			continue;
		}
		if (e.op !== "task.link" && e.op !== "task.state") continue;
		const link = `${String(e.queue)}\u0000${String(e.task)}\u0000${String(e.added)}`;
		const was = links.get(link);
		if (e.op === "task.link") {
			const parent = parentKey(e.parent);
			const open = was ? was.open : true;
			if (was?.parent && was.parent !== parent) {
				touch(was.parent, at);
				if (was.open) bump(was.parent, "leftAt", at);
			}
			links.set(link, { parent, open });
			touch(parent, at);
			continue;
		}
		if (!was) continue;
		const open = isOpenState(typeof e.status === "string" ? e.status : undefined);
		touch(was.parent, at);
		if (was.parent && was.open && !open) bump(was.parent, "leftAt", at);
		links.set(link, { ...was, open });
	}
	return times;
}

// ---------------------------------------------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------------------------------------------

/** One active item as the last round saw it. */
export interface StallItem {
	kind: "project" | "initiative";
	id: string;
	name: string;
	lead: string;
	/** flagged: a finding; quiet: never flagged now (why says why); pending: empty, not for long enough yet;
	 *  covered: an initiative with an active project; fine: open tasks and something recorded lately. */
	state: "flagged" | "quiet" | "pending" | "covered" | "fine";
	why: string;
	rule?: "empty" | "silent";
	since?: number;
	/** Its open tasks. */
	open: number;
}

export interface StallReview {
	findings: StallFinding[];
	/** Every active project and initiative, in the page's order (initiatives first). */
	items: StallItem[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Oct 20 01:03", the server's local time. */
export function stallTime(at: number): string {
	const d = new Date(at);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${MONTHS[d.getMonth()]} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const maxOf = (...xs: (number | undefined)[]): number => {
	let m = Number.NEGATIVE_INFINITY;
	for (const x of xs) if (x !== undefined && x > m) m = x;
	return m;
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** How people call a task's queue: its role id or chat title, else its chat file. */
const queueOf = (t: UiWorkPageTask) => t.queueName || t.queue;
const taskName = (t: UiWorkPageTask) => `${queueOf(t)} #${t.task}`;

function waitsOnOf(t: UiWorkPageTask): string | undefined {
	const b = t.block;
	if (!b) return undefined;
	const parts: string[] = [];
	if (b.on?.length) parts.push(b.on.join(", "));
	if (b.need) parts.push(b.need);
	if (b.lead) parts.push(b.owes ? `${b.lead} owes ${b.owes}` : `lead ${b.lead}`);
	return parts.length ? clip(parts.join("; "), WAITS_ON_MAX) : undefined;
}

/** Its wait now: still on (active), or when it ended (it ran out). A wait counts for at most 14 days. */
export function stallWaitOf(wait: UiWorkWait | undefined, now: number): { active?: UiWorkWait; endedAt?: number } {
	if (!wait || !isTime(wait.until) || !isTime(wait.at)) return {};
	const end = Math.min(wait.until, wait.at + STALL_WAIT_MAX_MS);
	return now < end ? { active: wait } : { endedAt: end };
}

/** Whom to wake, in turn: its lead, its initiative's lead (a project), then the owner; each role once. */
export function stallChain(kind: "project" | "initiative", r: UiWorkPageRecord, initiativeLead?: string): string[] {
	if (r.lead === "owner") return ["owner"];
	const chain = [r.lead];
	if (kind === "project" && initiativeLead) chain.push(initiativeLead);
	chain.push("owner");
	return [...new Set(chain.filter((x) => !!x))];
}

/** Every active project and initiative, with the findings (see docs/stall-watch.md for the rules). */
export function stallReview(page: UiWorkPage, extra: StallExtra, now: number, s: StallSettings): StallReview {
	const tasksOf = new Map<string, UiWorkPageTask[]>();
	for (const t of page.tasks) {
		const p = t.parent;
		const key = "project" in p ? itemKey("project", p.project) : "initiative" in p ? itemKey("initiative", p.initiative) : "";
		if (!key) continue;
		const list = tasksOf.get(key);
		if (list) list.push(t);
		else tasksOf.set(key, [t]);
	}
	const initiatives = new Map(page.initiatives.map((r) => [r.id, r] as const));
	const projectsOf = new Map<string, UiWorkPageRecord[]>();
	for (const p of page.projects) {
		if (!p.initiative) continue;
		const list = projectsOf.get(p.initiative);
		if (list) list.push(p);
		else projectsOf.set(p.initiative, [p]);
	}
	const findings: StallFinding[] = [];
	const items: StallItem[] = [];
	const emptyMs = s.emptyHours * HOUR;
	const silentMs = s.silentHours * HOUR;

	const look = (kind: "project" | "initiative", r: UiWorkPageRecord) => {
		if (r.status !== "active") return;
		const key = itemKey(kind, r.id);
		const own = tasksOf.get(key) ?? [];
		const open = own.filter((t) => isOpenState(t.state));
		const item = (state: StallItem["state"], why: string, more: Partial<StallItem> = {}) =>
			items.push({ kind, id: r.id, name: r.name, lead: r.lead, state, why, open: open.length, ...more });
		const activeProjects =
			kind === "initiative" ? (projectsOf.get(r.id) ?? []).filter((p) => p.status === "active") : [];
		if (activeProjects.length) {
			item("covered", `covered by its active projects: ${activeProjects.map((p) => p.id).join(", ")}`);
			return;
		}
		const wait = stallWaitOf(r.wait, now);
		if (wait.active) {
			item("quiet", `waits until ${stallTime(wait.active.until)}: ${wait.active.why}`);
			return;
		}
		const x = extra.times.get(key) ?? {};
		// A wait that ran out was the lead's own grace: the item is due at once if it was already stalled before
		// (since = its end; due = the later of the usual time and its end). A resume is like a status change: a
		// fresh start, with the full grace.
		const waitEnd = wait.endedAt ?? Number.NEGATIVE_INFINITY;
		const stretch = (base: number, graceMs: number) => ({
			since: Math.max(base, waitEnd),
			due: Math.max(base + graceMs, waitEnd),
		});
		const finding = (rule: StallFinding["rule"], since: number): StallFinding => {
			const ini = kind === "project" && r.initiative ? initiatives.get(r.initiative) : undefined;
			const done = [
				...own,
				...(kind === "initiative"
					? (projectsOf.get(r.id) ?? []).flatMap((p) => tasksOf.get(itemKey("project", p.id)) ?? [])
					: []),
			].filter((t) => t.state === "done");
			let last: UiWorkPageTask | undefined;
			for (const t of done) if (!last || (t.stateAt ?? t.added) > (last.stateAt ?? last.added)) last = t;
			return {
				kind,
				id: r.id,
				name: r.name,
				rule,
				since,
				stretch: `${kind}:${r.id}:${rule}:${since}`,
				chain: stallChain(kind, r, ini?.lead),
				...(kind === "project" && r.initiative ? { initiative: r.initiative } : {}),
				...(last
					? {
							lastDone: {
								queue: queueOf(last),
								task: last.task,
								title: last.title,
								...(last.doneSummary ? { summary: last.doneSummary } : {}),
								at: last.stateAt ?? last.added,
							},
						}
					: {}),
				open: [...open].sort((a, b) => a.added - b.added).map((t) => {
					const waitsOn = t.state === "blocked" ? waitsOnOf(t) : undefined;
					return {
						queue: queueOf(t),
						task: t.task,
						title: t.title,
						status: t.state ?? "ready",
						...(waitsOn ? { waitsOn } : {}),
					};
				}),
			};
		};
		if (!open.length) {
			// The registry's own times; only when they say nothing about it, the page's closed tasks' times.
			const fromPage = x.leftAt === undefined && x.eventAt === undefined;
			const closed = fromPage ? own.map((t) => t.stateAt) : [];
			const { since, due } = stretch(maxOf(r.createdAt, x.statusAt, x.leftAt, x.resumedAt, ...closed), emptyMs);
			if (now >= due) {
				const f = finding("empty", since);
				findings.push(f);
				item("flagged", `no open task since ${stallTime(since)}`, { rule: "empty", since });
			} else {
				item("pending", `no open task since ${stallTime(since)}; flagged from ${stallTime(due)}`, {
					rule: "empty",
					since,
				});
			}
			return;
		}
		const owner = open.find((t) => t.needsYou);
		if (owner) {
			item("quiet", `waits on the owner: ${taskName(owner)}`);
			return;
		}
		if (open.every((t) => t.paused)) {
			item("quiet", `every open task is paused by the owner: ${open.map(taskName).join(", ")}`);
			return;
		}
		const last = maxOf(
			r.updatedAt,
			x.eventAt,
			x.resumedAt,
			r.wait?.at,
			kind === "initiative" ? extra.leadUpdates.get(r.id) : undefined,
			...own.map((t) => t.stateAt),
			...open.map((t) => t.progress?.at),
		);
		const { since, due } = stretch(last, silentMs);
		if (now >= due) {
			findings.push(finding("silent", since));
			item("flagged", `${open.length} open, nothing recorded since ${stallTime(since)}`, { rule: "silent", since });
			return;
		}
		item("fine", `${open.length} open, last recorded ${stallTime(since)}`, { since });
	};
	for (const r of page.initiatives) look("initiative", r);
	for (const r of page.projects) look("project", r);
	return { findings, items };
}

/** The findings alone (the contract): every stalled active project and initiative, with whom to wake. */
export function stallFindings(page: UiWorkPage, extra: StallExtra, now: number, s: StallSettings): StallFinding[] {
	return stallReview(page, extra, now, s).findings;
}

// ---------------------------------------------------------------------------------------------------------------
// The dry run's act: logs whom it would wake, each step of the chain as it comes due
// ---------------------------------------------------------------------------------------------------------------

/** The line for one step of a finding's chain. */
export function stallWakeLine(f: StallFinding, step: number): string {
	return `stall: would wake ${f.chain[step - 1]} about ${f.kind} ${f.id} (${f.rule} since ${stallTime(f.since)}, step ${step} of ${f.chain.length})`;
}

/**
 * The dry act: a new stretch logs step 1 of its chain; each later step is logged once gapHours have passed since
 * the step before (as Ops #284 would send them). Kept in memory only: after a restart a stretch starts again.
 */
export class StallDryLog {
	private readonly seen = new Map<string, { firstAt: number; step: number }>();

	constructor(
		private readonly log: (line: string) => void,
		private readonly settings: () => StallSettings,
	) {}

	readonly act: StallAct = (findings, now) => {
		const gapMs = Math.max(1, this.settings().gapHours * HOUR);
		const keep = new Set<string>();
		for (const f of findings) {
			keep.add(f.stretch);
			let s = this.seen.get(f.stretch);
			if (!s) this.seen.set(f.stretch, (s = { firstAt: now, step: 0 }));
			const due = Math.min(f.chain.length, 1 + Math.floor((now - s.firstAt) / gapMs));
			while (s.step < due) {
				s.step++;
				this.log(stallWakeLine(f, s.step));
			}
		}
		for (const k of this.seen.keys()) if (!keep.has(k)) this.seen.delete(k);
	};
}

// ---------------------------------------------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------------------------------------------

export interface StallInputs {
	page: UiWorkPage;
	extra: StallExtra;
}

export interface StallWatchOptions {
	/** The round's inputs: the work page (with the queues' facts) and the extra times. */
	read: () => Promise<StallInputs> | StallInputs;
	/** What a round's findings go to; default: the dry run's log (StallDryLog). */
	act?: StallAct;
	settings?: () => StallSettings;
	now?: () => number;
	log?: (line: string) => void;
	/** The first round this long after start (default STALL_FIRST_MS). */
	firstMs?: number;
}

/** What `stall_list` answers. */
export interface StallList {
	mode: StallSettings["mode"];
	settings: StallSettings;
	running: boolean;
	rounds: number;
	/** The last round's time (ms) and how long it took. */
	at?: number;
	tookMs?: number;
	/** Why the last round was skipped, if it was. */
	skipped?: string;
	findings: StallFinding[];
	items: StallItem[];
}

/** One round every everyMin minutes: reads, works out the findings, hands them to act. Never sends or writes. */
export class StallWatch {
	private timer: ReturnType<typeof setTimeout> | undefined;
	private on = false;
	private busy = false;
	private rounds = 0;
	private last: { at: number; tookMs: number; review: StallReview } | undefined;
	private skipped: string | undefined;
	private readonly dry: StallDryLog;

	constructor(private readonly opts: StallWatchOptions) {
		this.dry = new StallDryLog(
			(line) => this.log(line),
			() => this.settings(),
		);
	}

	private settings(): StallSettings {
		return this.opts.settings ? this.opts.settings() : stallSettings();
	}

	private now(): number {
		return this.opts.now ? this.opts.now() : Date.now();
	}

	private log(line: string): void {
		(this.opts.log ?? ((l: string) => console.log(l)))(line);
	}

	/** Starts the rounds, unless mode is "off" (then nothing runs until a restart). */
	start(): void {
		if (this.on) return;
		if (this.settings().mode === "off") {
			this.log("stall: off (stall-watch.json mode off); not started");
			return;
		}
		this.on = true;
		this.schedule(this.opts.firstMs ?? STALL_FIRST_MS);
	}

	stop(): void {
		this.on = false;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	get running(): boolean {
		return this.on;
	}

	private schedule(ms: number): void {
		if (!this.on) return;
		this.timer = setTimeout(() => {
			void this.tick().finally(() =>
				this.schedule(Math.max(STALL_MIN_EVERY_MS, this.settings().everyMin * 60_000)),
			);
		}, ms);
		this.timer.unref?.();
	}

	/** One round now (a round already running: skipped). Returns the review, or undefined when none was made. */
	async tick(): Promise<StallReview | undefined> {
		if (this.busy) return undefined;
		this.busy = true;
		try {
			const s = this.settings();
			if (s.mode === "off") {
				this.log("stall: off (stall-watch.json mode off); stopped");
				this.last = undefined;
				this.stop();
				return undefined;
			}
			const started = performance.now();
			const { page, extra } = await this.opts.read();
			const now = this.now();
			if (page.problem === "unreadable" || page.problem === "too-big") {
				const why = `the registry is ${page.problem === "too-big" ? "bigger than is read" : "unreadable"}`;
				if (this.skipped !== why) this.log(`stall: round skipped (${why}); last findings kept`);
				this.skipped = why;
				return undefined;
			}
			this.skipped = undefined;
			const review = stallReview(page, extra, now, s);
			const before = this.last?.review.findings ?? [];
			const stretches = new Set(review.findings.map((f) => f.stretch));
			for (const f of before) {
				if (!stretches.has(f.stretch)) this.log(`stall: ${f.id} cleared (${clearedWhy(f, page, review)})`);
			}
			this.last = { at: now, tookMs: Math.round(performance.now() - started), review };
			this.rounds++;
			try {
				await (this.opts.act ?? this.dry.act)(review.findings, now);
			} catch (err) {
				this.log(`stall: act failed: ${(err as Error)?.message || String(err)}`);
			}
			return review;
		} catch (err) {
			this.log(`stall: round failed: ${(err as Error)?.message || String(err)}`);
			return undefined;
		} finally {
			this.busy = false;
		}
	}

	/** The control socket's stall_list: the last round's findings and every active item's state. */
	list(): StallList {
		const settings = this.settings();
		return {
			mode: settings.mode,
			settings,
			running: this.on,
			rounds: this.rounds,
			...(this.last ? { at: this.last.at, tookMs: this.last.tookMs } : {}),
			...(this.skipped ? { skipped: this.skipped } : {}),
			findings: this.last?.review.findings ?? [],
			items: this.last?.review.items ?? [],
		};
	}
}

/** Why a stretch the last round had is over now. */
function clearedWhy(f: StallFinding, page: UiWorkPage, review: StallReview): string {
	const item = review.items.find((i) => i.kind === f.kind && i.id === f.id);
	if (!item) {
		const rec = (f.kind === "project" ? page.projects : page.initiatives).find((r) => r.id === f.id);
		return rec ? `status ${rec.status}` : "no longer in the registry";
	}
	if (item.state === "flagged") return `a new stretch: ${item.rule} since ${stallTime(item.since ?? 0)}`;
	return item.why;
}

// ---------------------------------------------------------------------------------------------------------------
// The live inputs' extra times, read again only when the registry changed
// ---------------------------------------------------------------------------------------------------------------

/** The registry's extra times (stallTimesFrom), kept while the file's size and time are unchanged. */
export class StallTimesFile {
	private seen: { mtimeMs: number; size: number; times: Map<string, StallTimes> } | undefined;

	constructor(private readonly file: () => string) {}

	async get(): Promise<Map<string, StallTimes>> {
		const path = this.file();
		let st: { mtimeMs: number; size: number };
		try {
			st = await stat(path);
		} catch {
			this.seen = undefined;
			return new Map();
		}
		if (this.seen && this.seen.mtimeMs === st.mtimeMs && this.seen.size === st.size) return this.seen.times;
		const times = stallTimesFrom(await readFile(path, "utf8"));
		this.seen = { mtimeMs: st.mtimeMs, size: st.size, times };
		return times;
	}
}
