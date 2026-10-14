/**
 * progress-feed (task #85): one running progress feed per initiative, instead of one TL;DR per role.
 *
 * The initiative's lead (only the owner names one: on the Initiatives page, or by his own answer) reads what
 * the roles filed under the initiative (TL;DR lines, queue plans and done notes, role messages, Board posts,
 * the owner's answers, decisions and changes) with initiative_update new, and posts updates with
 * initiative_update post: what changed, what's next, what needs the owner, and the records each one
 * summarizes. An update never replaces its sources: they stay linked and one click away on the page.
 *
 * The second-hand check (feed-check.ts) reads every update against its linked records and flags each
 * sentence that says more than they hold: owner credit without his own words, and impacts, costs, options
 * or dates the records don't state. Flags show on the update and go back to the lead with its next ask; only
 * a new update clears them.
 *
 * The lead is asked for an update (a "poke": a role request from the Initiatives page, outside the role
 * message caps, a chain of its own) when a queued task filed under the initiative is done, when a decision
 * or change is filed under it, daily at dailyAt when anything is new, when an update has unsent flags, and
 * when the owner presses "Ask for an update". Automatic asks: at most one per pokeEveryHours, none when
 * nothing is new, none while one is unanswered. A one-time catch-up (control socket) asks it to cover the
 * past from a date until no decision or change is left unlinked.
 *
 * Only initiatives listed in the decisions settings' feedInitiatives have a feed: the rest show
 * "Progress: off", and nothing is collected, asked or read for them.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { DecisionModel } from "./decision-model.js";
import type { DecisionRecord, NewDecisionRecord, UpdateFields } from "./decision-records.js";
import { localDay, recordId } from "./decision-records.js";
import type {
	DecisionChange,
	DecisionEntry,
	DecisionSourceRef,
	DecisionStore,
	FeedSettings,
	Initiative,
	LeadSet,
} from "./decision-store.js";
import { decisionView, sourceView } from "./decision-view.js";
import { entryWho } from "./decision-who.js";
import {
	type CheckFlag,
	type CheckedSentence,
	type MaterialLookup,
	READER_VERSION,
	type UpdateCheck,
	buildMaterial,
	checkUpdate,
	codeCheck,
	isNotGiven,
	materialLookup,
	readerPass,
	splitSentences,
} from "./feed-check.js";

/** Reader calls that failed for one update are tried again at most this many times in all, this far apart. */
export const READER_TRIES = 3;
export const READER_RETRY_MS = 10 * 60_000;
import type {
	UiDecisionSource,
	UiFeedRow,
	UiProgress,
	UiProgressUpdate,
	UiRoleUpdate,
	UiUpdateDecision,
	UiUpdateLink,
	UiUpdateSentence,
} from "./protocol.js";
import type { RoleMessageSender } from "./role-messages.js";

export const FEED_STATE_FILE = "feed-state.json";
/** About 1,500 characters per field (the plan). */
export const UPDATE_FIELD_MAX = 1500;
export const UPDATE_SOURCES_MAX = 200;
export const NEW_RECORDS_PER_PAGE = 30;
export const NEW_GROUPS_PER_PAGE = 20;
/** An unanswered ask stops blocking automatic ones after a day (a catch-up round then counts as stalled). */
export const POKE_OPEN_MS = 24 * 3_600_000;
/** post waits this long for the reader, so the lead sees its flags in the same turn. */
export const POST_WAIT_MS = 90_000;
/** The owner's request behind every ask (COO rm-ba07e068, Telegram Oct 9; he picked "Lead + sources"). */
export const OWNER_REQUEST = {
	ref: "rm-ba07e068",
	words: "Similar to tldr but more unified, I want the updates to be more from a the initiative level",
	pick: "Lead + sources",
} as const;

const VIEW_UPDATES = 20;
const VIEW_LINKS = 40;
const VIEW_DECISIONS = 30;
const ROLE_UPDATES = 50;
const POKE_LINES = 6;
const CLOSED_KEEP = 20;

export type PokeWhy = "task-done" | "decision" | "daily" | "button" | "flag" | "catch-up";
export type PokeBy = "auto" | "owner" | "catch-up";
type PokeState = "waiting" | "delivered" | "replied" | "failed";

interface OpenPoke {
	/** The role message (rm-…). */
	id: string;
	at: number;
	why: PokeWhy[];
	by: PokeBy;
	/** The lead it went to. */
	to: string;
}

interface CatchUp {
	/** YYYY-MM-DD, local. */
	from: string;
	fromAt: number;
	at: number;
	rounds: number;
	/** Unlinked decisions + changes when its last round was asked. */
	lastUnlinked: number;
	done?: number;
	stalled?: number;
	why?: string;
}

export interface InitiativeFeedState {
	open?: OpenPoke;
	/** The last automatic ask. */
	lastAuto?: number;
	lastPoke?: number;
	/** The local day the daily ask last came round. */
	daily?: string;
	/** Triggers waiting for the throttle. */
	pending?: PokeWhy[];
	/** When the owner last looked at the initiative. */
	seen?: number;
	/** What the last tick saw: the store's next entry number and the time. */
	marks?: { next: number; scan: number };
	/** When each update's flags were sent back. Do not drop receipts: that would ask about them twice. */
	flagsSent?: Record<string, number>;
	/** Old state: only this one update's flags were sent. Read for compatibility, never write it. */
	flagAsked?: string;
	catchUp?: CatchUp;
	closed?: { id: string; at: number; how: "answered" | "expired" | "failed" | "replaced" }[];
}

export interface FeedStateFile {
	v: 1;
	initiatives: Record<string, InitiativeFeedState>;
	/** The second-hand check of each update, by its record id. */
	checks: Record<string, UpdateCheck>;
}

export interface FeedHost {
	store(): DecisionStore;
	/** Every kept record, oldest first. */
	records(): DecisionRecord[];
	append(rec: NewDecisionRecord): boolean;
	/** The roles the owner can pick as lead. */
	roles(): { id: string; name: string }[];
	/** Send an ask to the lead's home chat (role-messages.ts requestPoke). */
	poke(input: {
		role: string;
		initiative: string;
		name: string;
		text: string;
		why: PokeWhy[];
	}): { ok: true; id: string } | { ok: false; error: string };
	pokeState(id: string): PokeState | undefined;
	/** The role's home chat is in a turn. */
	leadBusy(role: string): boolean;
	/** The chat an update came from (its transcript's file name) is in a turn: a queued task answering an ask. */
	chatBusy?(file: string): boolean;
	/** The reader's model (the cheapest Claude model), when there is one. */
	model?(): DecisionModel | undefined;
	changed?(): void;
	log?(line: string): void;
	now?(): number;
}

/** What one call looks at: an initiative and what is filed under it. */
interface Ctx {
	ini: Initiative;
	settings: FeedSettings;
	byId: Map<string, DecisionRecord>;
	/** Records filed under it (not updates), oldest first. */
	filed: DecisionRecord[];
	/** Its updates, oldest first. */
	updates: DecisionRecord[];
	decisions: DecisionEntry[];
	changes: { decision: DecisionEntry; change: DecisionChange }[];
	/** Every id its updates link. */
	linked: Set<string>;
}

interface GroupEntry {
	id: string;
	kind: "decision" | "change";
	title: string;
	at: number;
	missing: string[];
	/** The decision's filled fields, as text (impact: "…"), so the lead can say them. */
	filled?: string;
}

interface Group {
	key: string;
	rec?: DecisionRecord;
	at: number;
	entries: GroupEntry[];
}

const short = (s: string, n: number): string => {
	const t = String(s ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const num = (n: number): string => n.toLocaleString("en-US");

/** "Oct 3 10:01", the server's local time. */
export function feedTime(at: number): string {
	const d = new Date(at);
	const month = d.toLocaleString("en-US", { month: "short" });
	return `${month} ${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "Oct 3", the server's local time. */
export function feedDay(at: number): string {
	const d = new Date(at);
	return `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()}`;
}

/** Local midnight of a YYYY-MM-DD day. */
export function localMidnight(day: string): number | undefined {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
	if (!m) return undefined;
	const at = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
	return Number.isFinite(at) ? at : undefined;
}

/** "HH:MM" -> minutes after midnight. */
function minutesOf(hhmm: string): number {
	const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
	return m ? Math.min(23, Number(m[1])) * 60 + Math.min(59, Number(m[2])) : 17 * 60;
}

const ENTRY_NUM = /^[dc](\d+)$/;

/**
 * Whether a flag counts: code's always; the reader's while its labels count (settings readerCheck), and only the
 * current reader's. An older reader's labels stay saved but count nowhere: page, asks, open count (H-READER-VERSION).
 */
export function flagCounts(f: CheckFlag, settings: Pick<FeedSettings, "readerCheck">): boolean {
	if (f.by === "code") return true;
	return settings.readerCheck && (f.v ?? 1) === READER_VERSION;
}

function linkedBy(id: string, sources: readonly DecisionSourceRef[], linked: ReadonlySet<string>): boolean {
	if (linked.has(id)) return true;
	return sources.some((s) => s.record && linked.has(s.record));
}

function filledOf(d: DecisionEntry): string {
	const out: string[] = [];
	if (d.impact?.text) out.push(`impact: "${short(d.impact.text, 160)}"`);
	if (d.options?.text) out.push(`options: "${short(d.options.text, 160)}"`);
	if (d.until?.text) out.push(`until: "${short(d.until.text, 80)}"`);
	return out.join("; ");
}

function missingOf(d: DecisionEntry): string[] {
	const out: string[] = [];
	if (!d.impact?.text) out.push("impact");
	if (!d.options?.text) out.push("options");
	if (!d.until?.text) out.push("until");
	return out;
}

/** What kind of record it is, in plain words. */
export function recordKind(r: DecisionRecord): string {
	switch (r.source) {
		case "tldr":
			return r.needsYou ? "TL;DR line (needs you)" : "TL;DR line";
		case "answer":
			return "the owner's answer";
		case "board":
			return r.ownerWords ? `Board ${r.kind ?? "post"} (the owner's words)` : `Board ${r.kind ?? "post"}`;
		case "message":
			return `role message${r.kind ? ` (${r.kind})` : ""}`;
		case "plan":
			if (r.op === "done") return `done note${typeof r.task === "number" ? ` (task #${r.task})` : ""}`;
			return `queue plan${typeof r.task === "number" ? ` (task #${r.task}${r.op ? `, ${r.op}` : ""})` : ""}`;
		case "update":
			return "progress update";
		default:
			return r.source;
	}
}

/** A record's gist, one line. */
export function recordGist(r: DecisionRecord): string {
	switch (r.source) {
		case "answer": {
			const q = r.questions ?? [];
			const parts = q.map((x) => {
				const picked = (x.picked ?? []).join(", ");
				return `${x.header || x.question}: ${picked || x.typed || "(no pick)"}${x.typed && picked ? ` (typed: ${x.typed})` : ""}`;
			});
			return parts.join("; ") || r.body || r.text || "";
		}
		case "board":
			return `${r.title ?? ""}${r.ownerWords ? ` (the owner's words: "${r.ownerWords}")` : ""}`;
		case "plan":
			if (r.op === "done") return r.summary || r.plan?.title || "";
			return [r.plan?.title, r.plan?.goal].filter(Boolean).join(": ");
		case "update":
			return r.update?.changed || r.update?.next || "";
		default:
			return r.text || r.title || "";
	}
}

/** One line for a record in the new list. */
function recordLine(r: DecisionRecord): string {
	return `${r.id} · ${recordKind(r)} · ${r.from} · ${feedTime(r.at)} · "${short(recordGist(r), 160)}"`;
}

function entriesText(entries: readonly GroupEntry[], max = 6): string {
	const shown = entries.slice(0, max).map((e) => {
		const has = e.filled ? ` (${e.filled})` : "";
		const miss = e.kind === "decision" && e.missing.length ? ` [no ${e.missing.join(", ")}]` : "";
		return `${e.id} "${short(e.title, 70)}"${has}${miss}`;
	});
	const more = entries.length > max ? `; and ${entries.length - max} more` : "";
	return `${shown.join("; ")}${more}`;
}

/** Items in a Needs you field: its lines (or bullets), else its sentences; "nothing" and friends count 0. */
export function needsYouCount(text: string | undefined): number {
	const t = String(text ?? "").trim();
	if (!t || isNotGiven(t)) return 0;
	const lines = t
		.split(/\n+/)
		.map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
		.filter((l) => l && !isNotGiven(l));
	if (lines.length > 1) return lines.length;
	return splitSentences(t).filter((s) => !isNotGiven(s)).length || 1;
}

const WHY_WORDS: Record<PokeWhy, string> = {
	"task-done": "a queued task filed under it is done",
	decision: "a decision or change was filed under it",
	daily: "it's the daily ask",
	button: "the owner pressed Ask for an update",
	flag: "an update of yours has flagged sentences",
	"catch-up": "the one-time catch-up",
};

export interface PokeTextInput {
	name: string;
	initiative: string;
	leadSet?: LeadSet;
	why: PokeWhy[];
	catchUp?: { from: string; round: number };
	lastUpdate?: { id: string; at: number };
	fresh: number;
	unlinked: { decisions: number; changes: number; records: number };
	missing: number;
	decisionsAll: number;
	lines: string[];
	flags: { update?: string; field: string; text: string; why: string }[];
	dailyAt: string;
}

/** The ask's text (stage-tested alone: AGENTS.md rule 16). */
export function pokeTextOf(p: PokeTextInput): string {
	const out: string[] = [];
	const named = p.leadSet
		? p.leadSet.source === "page"
			? `He set you as lead of ${p.name} on the Initiatives page (${feedDay(p.leadSet.at)}).`
			: `He named you lead of ${p.name} (${feedDay(p.leadSet.at)}).`
		: `You lead ${p.name}.`;
	out.push(
		`The owner asked for one running progress feed per initiative, written by its lead from the roles' own records and linked to them ("${OWNER_REQUEST.words}", ${OWNER_REQUEST.ref}; he picked "${OWNER_REQUEST.pick}"). ${named} So this is requested work under rule 14.`,
	);
	out.push("", `Asked now because ${p.why.map((w) => WHY_WORDS[w]).join("; ")}.`);
	if (p.catchUp) {
		out.push(
			"",
			`Catch-up (round ${p.catchUp.round}): cover ${p.name} from ${p.catchUp.from}, oldest first, with as many updates as it takes until no decision or change is unlinked. Linking a record links every decision and change it holds.`,
		);
	}
	const since = p.lastUpdate ? `since your last update (${p.lastUpdate.id}, ${feedTime(p.lastUpdate.at)})` : "so far";
	out.push(
		"",
		`What's new ${since}: ${num(p.fresh)} records filed; ${num(p.unlinked.decisions)} decisions and ${num(p.unlinked.changes)} changes no update links yet (from ${num(p.unlinked.records)} records).`,
	);
	if (p.lines.length) {
		out.push("The first ones:");
		for (const l of p.lines) out.push(`- ${l}`);
	}
	out.push(`Decisions missing impact, options or until: ${num(p.missing)} of ${num(p.decisionsAll)}.`);
	if (p.flags.length) {
		out.push(
			"",
			`Your updates have ${p.flags.length} flagged sentence${p.flags.length === 1 ? "" : "s"} not sent back yet; correct them in a new update:`,
		);
		let update: string | undefined;
		for (const f of p.flags.slice(0, 8)) {
			if (f.update && f.update !== update) {
				update = f.update;
				out.push(`Update ${update}:`);
			}
			out.push(`- ${f.field}: "${short(f.text, 160)}": ${f.why}`);
		}
		if (p.flags.length > 8) out.push(`- and ${p.flags.length - 8} more (initiative_update read).`);
	}
	out.push(
		"",
		"Post with initiative_update; say only what the linked records hold; fill impact/options/until with decision_log where known, else say not known.",
		`How: initiative_update new (initiative "${p.initiative}") lists what's new with ids, page by page. Then initiative_update post: changed, next, needs_you (impact, options, until where the records hold them), and sources = the ids of the records and decisions it summarizes. Never write that the owner decided unless a linked record holds his own words for it. Every sentence comes from a linked record: don't repeat this message's own counts, times or lists. Each field is plain text. Where a decision's impact, options or until is shown in the list, say it in those words; where none is, write just: not known. Each post's reply says what is still unlinked. Write nothing for the owner in this chat: he reads updates on the Initiatives page.`,
	);
	return out.join("\n");
}

export class ProgressFeed {
	private readonly file: string;
	private state: FeedStateFile;
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly checking = new Map<string, Promise<UpdateCheck>>();
	private ticking = false;

	constructor(
		private readonly host: FeedHost,
		dir: string,
	) {
		this.file = join(dir, FEED_STATE_FILE);
		this.state = this.load();
	}

	private now(): number {
		return this.host.now ? this.host.now() : Date.now();
	}

	private log(line: string): void {
		this.host.log?.(`[progress-feed] ${line}`);
	}

	// state ---------------------------------------------------------------------

	private load(): FeedStateFile {
		try {
			if (existsSync(this.file)) {
				const raw = JSON.parse(readFileSync(this.file, "utf8")) as Partial<FeedStateFile>;
				return {
					v: 1,
					initiatives: raw.initiatives && typeof raw.initiatives === "object" ? raw.initiatives : {},
					checks: raw.checks && typeof raw.checks === "object" ? raw.checks : {},
				};
			}
		} catch (err) {
			this.log(`couldn't read ${this.file}: ${(err as Error).message}`);
		}
		return { v: 1, initiatives: {}, checks: {} };
	}

	private save(): void {
		try {
			mkdirSync(join(this.file, ".."), { recursive: true });
			const tmp = `${this.file}.${process.pid}.tmp`;
			writeFileSync(tmp, JSON.stringify(this.state));
			renameSync(tmp, this.file);
		} catch (err) {
			this.log(`couldn't save ${this.file}: ${(err as Error).message}`);
		}
	}

	private stateOf(id: string): InitiativeFeedState {
		let s = this.state.initiatives[id];
		if (!s) {
			s = {};
			this.state.initiatives[id] = s;
		}
		return s;
	}

	/** For tests and the control socket. */
	snapshot(): FeedStateFile {
		return JSON.parse(JSON.stringify(this.state)) as FeedStateFile;
	}

	// what is filed -------------------------------------------------------------

	settings(): FeedSettings {
		return this.host.store().feedSettings();
	}

	isOn(initiative: string): boolean {
		return this.settings().initiatives.includes(initiative);
	}

	private ctx(initiative: string, recs = this.host.records()): Ctx | undefined {
		const store = this.host.store();
		const list = store.initiatives();
		const ini = list.find((i) => i.id === initiative);
		if (!ini) return undefined;
		const byId = new Map(recs.map((r) => [r.id, r] as const));
		const filed = store.inInitiatives(
			recs.filter((r) => r.source !== "update"),
			[ini.id],
			list,
		);
		const updates = recs.filter((r) => r.source === "update" && r.initiative === ini.id && r.update);
		const decisions = store.decisions().filter((d) => d.initiative === ini.id && !d.notDecision);
		const changes = decisions.flatMap((d) =>
			d.changes.filter((c) => !c.notDecision).map((change) => ({ decision: d, change })),
		);
		const linked = new Set<string>();
		for (const u of updates) for (const id of u.sources ?? []) linked.add(id);
		return { ini, settings: store.feedSettings(), byId, filed, updates, decisions, changes, linked };
	}

	private unlinkedOf(c: Ctx): {
		decisions: DecisionEntry[];
		changes: { decision: DecisionEntry; change: DecisionChange }[];
	} {
		return {
			decisions: c.decisions.filter((d) => !linkedBy(d.id, d.sources, c.linked)),
			changes: c.changes.filter((x) => !linkedBy(x.change.id, x.change.sources, c.linked)),
		};
	}

	/** Unlinked entries, grouped by the record they came from (its earliest kept one), oldest first. */
	private groupsOf(c: Ctx): Group[] {
		const un = this.unlinkedOf(c);
		const groups = new Map<string, Group>();
		const add = (key: string, rec: DecisionRecord | undefined, at: number, e: GroupEntry): void => {
			let g = groups.get(key);
			if (!g) {
				g = { key, ...(rec ? { rec } : {}), at, entries: [] };
				groups.set(key, g);
			}
			g.entries.push(e);
		};
		const headOf = (sources: readonly DecisionSourceRef[]): DecisionRecord | undefined => {
			let best: DecisionRecord | undefined;
			for (const s of sources) {
				const r = s.record ? c.byId.get(s.record) : undefined;
				if (r && (!best || r.at < best.at)) best = r;
			}
			return best;
		};
		for (const d of un.decisions) {
			const rec = headOf(d.sources);
			add(rec?.id ?? d.id, rec, rec?.at ?? d.at, {
				id: d.id,
				kind: "decision",
				title: d.title,
				at: d.at,
				missing: missingOf(d),
				filled: filledOf(d),
			});
		}
		for (const { decision, change } of un.changes) {
			const rec = headOf(change.sources);
			add(rec?.id ?? change.id, rec, rec?.at ?? change.at, {
				id: change.id,
				kind: "change",
				title: `change to ${decision.id}: ${change.what}`,
				at: change.at,
				missing: [],
			});
		}
		for (const g of groups.values()) g.entries.sort((a, b) => a.at - b.at);
		return [...groups.values()].sort((a, b) => a.at - b.at);
	}

	/**
	 * The chat the update came from is still in its turn. A lead may answer an ask from a queued task (work
	 * bigger than a quick answer goes to a task: Board order bp-94c7e08b): its first update doesn't answer
	 * the ask while that task is still posting, or a catch-up's next round would reach the home chat mid-task.
	 */
	private postingChatBusy(update: DecisionRecord): boolean {
		return !!update.file && !!this.host.chatBusy?.(update.file);
	}

	private lastUpdate(c: Ctx): DecisionRecord | undefined {
		return c.updates.length ? c.updates[c.updates.length - 1] : undefined;
	}

	private catchUpActive(s: InitiativeFeedState): boolean {
		return !!s.catchUp && !s.catchUp.done && !s.catchUp.stalled;
	}

	/**
	 * Records filed since the lead last looked, not linked yet, oldest first. Normally: kept after its last
	 * update. In a catch-up: from its start date, after the newest record the catch-up's updates linked.
	 */
	private freshOf(c: Ctx, s: InitiativeFeedState): { list: DecisionRecord[]; since?: { at: number; why: string } } {
		const last = this.lastUpdate(c);
		const unl = (r: DecisionRecord): boolean => !c.linked.has(r.id);
		if (this.catchUpActive(s) && s.catchUp) {
			const cu = s.catchUp;
			let frontier = cu.fromAt - 1;
			for (const u of c.updates) {
				if (u.at < cu.at) continue;
				for (const id of u.sources ?? []) {
					const r = c.byId.get(id);
					if (r && r.at > frontier) frontier = r.at;
				}
			}
			return { list: c.filed.filter((r) => r.at > frontier && unl(r)), since: { at: frontier, why: "catch-up" } };
		}
		if (last)
			return {
				list: c.filed.filter((r) => (r.seen > last.at || r.at > last.at) && unl(r)),
				since: { at: last.at, why: "update" },
			};
		const from = c.ini.leadSet?.at;
		if (from) return { list: c.filed.filter((r) => r.at > from && unl(r)), since: { at: from, why: "lead" } };
		return { list: c.filed.filter(unl) };
	}

	// initiative_update new -----------------------------------------------------

	/** What was filed since the lead's last update, unlinked entries, and missing fields: one line each. */
	newList(initiative: string, page = 1): { ok: true; text: string; pages: number } | { ok: false; error: string } {
		const c = this.ctx(initiative);
		if (!c) return { ok: false, error: `there's no initiative "${short(initiative, 40)}"` };
		if (!c.settings.initiatives.includes(c.ini.id)) return { ok: false, error: `Progress is off for ${c.ini.name}.` };
		const s = this.stateOf(c.ini.id);
		const fresh = this.freshOf(c, s);
		const groups = this.groupsOf(c);
		const freshIds = new Set(fresh.list.map((r) => r.id));
		const onFresh = new Map<string, Group>();
		const older: Group[] = [];
		for (const g of groups) {
			if (g.rec && freshIds.has(g.rec.id)) onFresh.set(g.rec.id, g);
			else older.push(g);
		}
		const un = this.unlinkedOf(c);
		const missing = c.decisions.filter((d) => missingOf(d).length).length;
		const pages = Math.max(
			1,
			Math.ceil(fresh.list.length / NEW_RECORDS_PER_PAGE),
			Math.ceil(older.length / NEW_GROUPS_PER_PAGE),
		);
		const p = Math.min(Math.max(1, Math.floor(page) || 1), pages);
		const last = this.lastUpdate(c);
		const lines: string[] = [];
		lines.push(`initiative_update new · ${c.ini.name} (${c.ini.id}) · page ${p} of ${pages}`);
		const sinceWords =
			fresh.since?.why === "catch-up"
				? `Catch-up from ${s.catchUp?.from}: after the newest record your catch-up updates linked (${feedTime(fresh.since.at)})`
				: last
					? `Since your last update (${last.id}, ${feedTime(last.at)})`
					: fresh.since
						? `Since you became lead (${feedTime(fresh.since.at)})`
						: "So far";
		lines.push(
			`${sinceWords}: ${num(fresh.list.length)} records filed and not linked. Not linked by any update: ${num(un.decisions.length)} decisions, ${num(un.changes.length)} changes (from ${num(groups.length)} records). Decisions missing impact, options or until: ${num(missing)} of ${num(c.decisions.length)}.`,
		);
		const freshPage = fresh.list.slice((p - 1) * NEW_RECORDS_PER_PAGE, p * NEW_RECORDS_PER_PAGE);
		if (freshPage.length) {
			lines.push(
				"",
				`Filed (oldest first; ${(p - 1) * NEW_RECORDS_PER_PAGE + 1}-${(p - 1) * NEW_RECORDS_PER_PAGE + freshPage.length} of ${num(fresh.list.length)}):`,
			);
			for (const r of freshPage) {
				const g = onFresh.get(r.id);
				lines.push(`- ${recordLine(r)}${g ? ` -> ${entriesText(g.entries)}` : ""}`);
			}
		}
		const olderPage = older.slice((p - 1) * NEW_GROUPS_PER_PAGE, p * NEW_GROUPS_PER_PAGE);
		if (olderPage.length) {
			lines.push(
				"",
				`Older, still not linked (oldest first; ${(p - 1) * NEW_GROUPS_PER_PAGE + 1}-${(p - 1) * NEW_GROUPS_PER_PAGE + olderPage.length} of ${num(older.length)} records):`,
			);
			for (const g of olderPage) {
				lines.push(`- ${g.rec ? recordLine(g.rec) : "(no kept record)"} -> ${entriesText(g.entries)}`);
			}
		}
		if (!freshPage.length && !olderPage.length) lines.push("", "Nothing new and nothing unlinked.");
		lines.push(
			"",
			"Link a record (dr-…) to cover every decision and change it holds, or link entries (d…, c…) one by one. Fill impact/options/until with decision_log fill where the records hold them; else write not known.",
		);
		if (p < pages) lines.push(`More: initiative_update new with page ${p + 1}.`);
		return { ok: true, text: lines.join("\n"), pages };
	}

	// initiative_update post ----------------------------------------------------

	async post(
		sender: RoleMessageSender,
		p: {
			initiative?: unknown;
			changed?: unknown;
			next?: unknown;
			needs_you?: unknown;
			impact?: unknown;
			options?: unknown;
			until?: unknown;
			sources?: unknown;
		},
		waitMs = POST_WAIT_MS,
	): Promise<{ ok: true; id: string; text: string } | { ok: false; error: string }> {
		const initiative = typeof p.initiative === "string" ? p.initiative.trim().toLowerCase() : "";
		const c = this.ctx(initiative);
		if (!c) return { ok: false, error: `there's no initiative "${short(initiative, 40)}"` };
		if (!c.settings.initiatives.includes(c.ini.id)) return { ok: false, error: `Progress is off for ${c.ini.name}.` };
		const lead = c.ini.lead;
		if (!lead)
			return { ok: false, error: `${c.ini.name} has no lead yet: only the owner names one, on the Initiatives page.` };
		if (sender.role !== lead)
			return { ok: false, error: `Only ${c.ini.name}'s lead posts its updates: the lead is ${lead}.` };
		const field = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
		// A field that isn't text is refused, never dropped quietly (stage test, poke run 1: objects per decision).
		for (const k of ["changed", "next", "needs_you", "impact", "options", "until"] as const) {
			const v = p[k];
			if (v !== undefined && v !== null && typeof v !== "string")
				return {
					ok: false,
					error: `${k} must be plain text (one string), not a list or an object; say which decision each part is about in the text.`,
				};
		}
		const fields: UpdateFields = {
			changed: field(p.changed),
			next: field(p.next),
			needsYou: field(p.needs_you),
		};
		const impact = field(p.impact);
		const options = field(p.options);
		const until = field(p.until);
		if (impact) fields.impact = impact;
		if (options) fields.options = options;
		if (until) fields.until = until;
		for (const [k, v] of Object.entries(fields)) {
			if (v.length > UPDATE_FIELD_MAX)
				return {
					ok: false,
					error: `${k === "needsYou" ? "needs_you" : k} is ${num(v.length)} characters; keep each field under ${num(UPDATE_FIELD_MAX)}.`,
				};
		}
		if (!fields.changed && !fields.next && !fields.needsYou)
			return { ok: false, error: "Say what changed, what's next or what needs the owner (changed, next, needs_you)." };
		const rawSources = Array.isArray(p.sources)
			? p.sources
			: typeof p.sources === "string"
				? p.sources.split(/[\s,]+/)
				: [];
		const sources = [
			...new Set(rawSources.map((x) => (typeof x === "string" ? x.trim().toLowerCase() : "")).filter(Boolean)),
		];
		if (!sources.length)
			return { ok: false, error: "Give sources: the ids of the records (dr-…) and decisions (d…, c…) it summarizes." };
		if (sources.length > UPDATE_SOURCES_MAX)
			return {
				ok: false,
				error: `${sources.length} sources; at most ${UPDATE_SOURCES_MAX} per update (post another for the rest).`,
			};
		const filedIds = new Set(c.filed.map((r) => r.id));
		const citedIds = new Set<string>();
		for (const d of c.decisions) {
			for (const s of d.sources) if (s.record) citedIds.add(s.record);
			for (const ch of d.changes) for (const s of ch.sources) if (s.record) citedIds.add(s.record);
		}
		const entryIds = new Set<string>([...c.decisions.map((d) => d.id), ...c.changes.map((x) => x.change.id)]);
		const bad: string[] = [];
		for (const id of sources) {
			if (id.startsWith("dr-")) {
				const r = c.byId.get(id);
				if (!r) bad.push(`${id} (no such record)`);
				else if (r.source === "update") bad.push(`${id} (an update: link what it linked instead)`);
				else if (!filedIds.has(id) && !citedIds.has(id)) bad.push(`${id} (not filed under ${c.ini.name})`);
			} else if (ENTRY_NUM.test(id)) {
				if (!entryIds.has(id)) bad.push(`${id} (not a decision or change of ${c.ini.name})`);
			} else bad.push(`${id} (not a record or entry id)`);
		}
		if (bad.length)
			return {
				ok: false,
				error: `Not posted. These sources don't work: ${bad.slice(0, 12).join("; ")}${bad.length > 12 ? `; and ${bad.length - 12} more` : ""}.`,
			};
		const at = this.now();
		const ref = `up-${randomBytes(4).toString("hex")}`;
		const rec: NewDecisionRecord = {
			source: "update",
			at,
			from: sender.role,
			initiative: c.ini.id,
			ref,
			chat: sender.chat,
			...(sender.file ? { file: basename(sender.file) } : {}),
			update: fields,
			sources,
		};
		if (!this.host.append(rec)) return { ok: false, error: "couldn't keep the update (try again)" };
		const id = recordId("update", ref);
		this.log(`${id} posted by ${sender.role} for ${c.ini.id}: ${sources.length} sources`);
		const kept = this.host.records().find((r) => r.id === id);
		const pending = kept ? this.runCheck(kept) : undefined;
		this.host.changed?.();
		let check: UpdateCheck | undefined;
		if (pending) {
			check = await Promise.race([
				pending,
				new Promise<undefined>((resolve) => {
					const t = setTimeout(() => resolve(undefined), waitMs);
					t.unref?.();
				}),
			]);
		}
		// What it links, and what is still unlinked after it.
		const after = this.ctx(c.ini.id);
		const linkedHere = after ? this.entriesLinkedBy(after, sources) : { decisions: [], changes: [] };
		const un = after ? this.unlinkedOf(after) : { decisions: [], changes: [] };
		const lines = [
			`Posted ${id} for ${c.ini.name}: links ${sources.length} source${sources.length === 1 ? "" : "s"}, covering ${num(linkedHere.decisions.length)} decisions and ${num(linkedHere.changes.length)} changes.`,
		];
		if (!check) {
			lines.push(
				"The check is still reading it; its flags show on the page and come back with your next ask (initiative_update read shows them).",
			);
		} else {
			const flags = this.countedFlags(check, c.settings);
			if (!flags.length) lines.push("Check: no sentence says more than its linked records hold.");
			else {
				lines.push(
					`Check: ${flags.length} flagged sentence${flags.length === 1 ? "" : "s"} (they stay on this update; correct them with a new one):`,
				);
				for (const f of flags.slice(0, 10)) lines.push(`- ${f.field}: "${short(f.text, 140)}": ${f.why} (${f.by})`);
			}
			if (check.reader?.error)
				lines.push(`The reader couldn't check it (${short(check.reader.error, 120)}); code's checks ran.`);
		}
		lines.push(
			un.decisions.length + un.changes.length
				? `Still not linked by any update: ${num(un.decisions.length)} decisions, ${num(un.changes.length)} changes (initiative_update new lists them).`
				: "Every decision and change is linked now.",
		);
		return { ok: true, id, text: lines.join("\n") };
	}

	/** The decisions and changes an update's sources cover (directly, or through a record they cite). */
	private entriesLinkedBy(
		c: Ctx,
		sources: readonly string[],
	): { decisions: DecisionEntry[]; changes: { decision: DecisionEntry; change: DecisionChange }[] } {
		const set = new Set(sources);
		return {
			decisions: c.decisions.filter((d) => linkedBy(d.id, d.sources, set)),
			changes: c.changes.filter((x) => linkedBy(x.change.id, x.change.sources, set)),
		};
	}

	// initiative_update read ----------------------------------------------------

	read(initiative: string, id?: string): { ok: true; text: string } | { ok: false; error: string } {
		const c = this.ctx(initiative.trim().toLowerCase());
		if (!c) return { ok: false, error: `there's no initiative "${short(initiative, 40)}"` };
		if (!c.settings.initiatives.includes(c.ini.id)) return { ok: false, error: `Progress is off for ${c.ini.name}.` };
		const list = id ? c.updates.filter((u) => u.id === id.trim().toLowerCase()) : c.updates.slice(-5).reverse();
		if (id && !list.length) return { ok: false, error: `no update ${short(id, 30)} under ${c.ini.name}` };
		if (!list.length) return { ok: true, text: `${c.ini.name} has no updates yet. Lead: ${c.ini.lead ?? "none"}.` };
		const out: string[] = [`${c.ini.name} · lead ${c.ini.lead ?? "none"} · ${c.updates.length} updates`];
		for (const u of list) {
			const f = u.update as UpdateFields;
			out.push(
				"",
				`${u.id} · ${u.from} · ${feedTime(u.at)} · ${u.sources?.length ?? 0} sources`,
				`changed: ${f.changed || "(empty)"}`,
				`next: ${f.next || "(empty)"}`,
				`needs you: ${f.needsYou || "(empty)"}`,
				`impact: ${f.impact || "not given"}`,
				`options: ${f.options || "not given"}`,
				`until: ${f.until || "not given"}`,
			);
			if (id) out.push(`sources: ${(u.sources ?? []).join(", ")}`);
			const check = this.state.checks[u.id];
			if (!check) out.push(this.checking.has(u.id) ? "check: still reading" : "check: not run yet");
			else {
				const flags = this.countedFlags(check, c.settings);
				out.push(flags.length ? `check: ${flags.length} flagged` : "check: nothing flagged");
				for (const fl of flags.slice(0, id ? 50 : 5))
					out.push(`- ${fl.field}: "${short(fl.text, 140)}": ${fl.why} (${fl.by})`);
			}
		}
		return { ok: true, text: out.join("\n") };
	}

	// the second-hand check -----------------------------------------------------

	/** Lookups for buildMaterial over the kept records and the store. */
	lookup(recs = this.host.records()): MaterialLookup {
		return materialLookup(recs, this.host.store().decisions());
	}

	/** Check one update (once; a running check is shared). Saved in the state, by the update's id. */
	runCheck(rec: DecisionRecord): Promise<UpdateCheck> {
		const running = this.checking.get(rec.id);
		if (running) return running;
		const settings = this.settings();
		const update = rec.update as UpdateFields;
		const material = buildMaterial(rec.sources ?? [], this.lookup());
		const p = checkUpdate(update, material, {
			model: this.host.model?.(),
			reader: settings.readerCheck,
			now: () => this.now(),
		})
			.catch((err): UpdateCheck => ({
				at: this.now(),
				sentences: codeCheck(update, material),
				reader: { at: this.now(), error: (err as Error).message },
			}))
			.then((check) => {
				this.state.checks[rec.id] = check;
				this.save();
				const n = this.countedFlags(check, settings).length;
				this.log(
					`${rec.id} checked: ${n} flagged${check.reader?.error ? ` (reader: ${short(check.reader.error, 80)})` : ""}`,
				);
				this.host.changed?.();
				return check;
			})
			.finally(() => this.checking.delete(rec.id));
		this.checking.set(rec.id, p);
		return p;
	}

	/**
	 * An update whose reader part is still owed: its reader call failed (fewer than READER_TRIES times, the last one
	 * READER_RETRY_MS ago or more), or it was checked while the reader was off or had no model. Only while the reader
	 * is on and a model is there. (Live catch-up, 2026-10-13: three reader calls failed on a signed-out account, and
	 * those updates were never read again.)
	 */
	needsReread(id: string, settings: FeedSettings, now: number): boolean {
		const r = this.state.checks[id]?.reader;
		if (!r || !settings.readerCheck || !this.host.model?.()) return false;
		if (r.skipped === "off" || r.skipped === "no model") return true;
		// Read by an older reader, whose labels no longer count (H-READER-VERSION).
		if (!r.error && !r.skipped) return (r.v ?? 1) < READER_VERSION;
		if (!r.error) return false;
		return (r.failed ?? 1) < READER_TRIES && now - r.at >= READER_RETRY_MS;
	}

	/**
	 * Read a checked update again with the reader (code's part stays as saved). It only adds the reader's flags to
	 * the saved sentences, never removes one: only a new update from the lead clears a flag.
	 */
	reread(rec: DecisionRecord): Promise<UpdateCheck> {
		const running = this.checking.get(rec.id);
		if (running) return running;
		const saved = this.state.checks[rec.id];
		if (!saved) return this.runCheck(rec);
		const settings = this.settings();
		const material = buildMaterial(rec.sources ?? [], this.lookup());
		const sentences = saved.sentences.map((s) => ({ ...s, flags: s.flags.map((f) => ({ ...f })) }));
		const failedBefore = saved.reader?.error ? (saved.reader.failed ?? 1) : 0;
		// The reader's labels from this pass are new as of now, even where an older reader raised the same one: an
		// older label counts nowhere, and it may never have gone back (live: u3's were raised while the reader was off
		// at its ask), so treating the new one as already sent would hide it.
		const p = readerPass(sentences, material, {
			model: this.host.model?.(),
			reader: settings.readerCheck,
			now: () => this.now(),
		})
			.catch((err): NonNullable<UpdateCheck["reader"]> => ({ at: this.now(), error: (err as Error).message }))
			.then((reader) => {
				const check: UpdateCheck = reader.error
					? { ...saved, reader: { ...reader, failed: failedBefore + 1 } }
					: { at: saved.at, sentences, reader };
				this.state.checks[rec.id] = check;
				this.save();
				const n = this.countedFlags(check, settings).length;
				this.log(`${rec.id} read again: ${n} flagged${reader.error ? ` (reader: ${short(reader.error, 80)})` : ""}`);
				this.host.changed?.();
				return check;
			})
			.finally(() => this.checking.delete(rec.id));
		this.checking.set(rec.id, p);
		return p;
	}

	/** The flags that count: code's always; the reader's while its labels count (settings readerCheck). */
	private countedFlags(
		check: UpdateCheck | undefined,
		settings: FeedSettings,
	): { field: string; text: string; kind: string; by: string; claim: string; why: string; at: number }[] {
		const out: { field: string; text: string; kind: string; by: string; claim: string; why: string; at: number }[] = [];
		for (const s of check?.sentences ?? []) {
			for (const f of s.flags) {
				if (!flagCounts(f, settings)) continue;
				out.push({
					at: f.at ?? check?.at ?? 0,
					field: s.field === "needsYou" ? "needs you" : s.field,
					text: s.text,
					kind: f.kind,
					by: f.by,
					claim: f.claim,
					why: f.why,
				});
			}
		}
		return out;
	}

	/** When an update's flags last went back to the lead (none: not yet). */
	private sentAt(s: InitiativeFeedState, u: DecisionRecord): number | undefined {
		return s.flagsSent?.[u.id] ?? (s.flagAsked === u.id ? (s.lastPoke ?? Number.POSITIVE_INFINITY) : undefined);
	}

	/**
	 * Every flag that has not gone back to the lead yet, on every checked update, not just the last one in a turn;
	 * that includes one a later read raised after the update's other flags went back.
	 */
	private flagsDue(c: Ctx, s: InitiativeFeedState): PokeTextInput["flags"] {
		return [...c.updates].reverse().flatMap((u) => {
			const sent = this.sentAt(s, u);
			return this.countedFlags(this.state.checks[u.id], c.settings)
				.filter((f) => sent === undefined || f.at > sent)
				.map(({ at: _at, ...f }) => ({ ...f, update: u.id }));
		});
	}

	/** A flag is open until it went back and a new lead update followed; a clean update posted before its ask does not clear it. */
	private openFlagCount(c: Ctx, s: InitiativeFeedState): number {
		const lastAt = this.lastUpdate(c)?.at ?? 0;
		return c.updates.reduce((n, u) => {
			const sent = this.sentAt(s, u);
			return (
				n +
				this.countedFlags(this.state.checks[u.id], c.settings).filter(
					(f) => sent === undefined || f.at > sent || lastAt <= sent,
				).length
			);
		}, 0);
	}

	// asks ----------------------------------------------------------------------

	private sendPoke(
		c: Ctx,
		s: InitiativeFeedState,
		why: PokeWhy[],
		by: PokeBy,
	): { ok: true; id: string } | { ok: false; error: string } {
		const lead = c.ini.lead;
		if (!lead) return { ok: false, error: `${c.ini.name} has no lead yet.` };
		const due = this.flagsDue(c, s);
		const text = this.pokeText(c, s, why);
		const res = this.host.poke({ role: lead, initiative: c.ini.id, name: c.ini.name, text, why });
		if (!res.ok) {
			this.log(`couldn't ask ${lead} for ${c.ini.id}: ${res.error}`);
			return res;
		}
		const now = this.now();
		if (s.open) this.closePoke(s, "replaced", now);
		s.open = { id: res.id, at: now, why, by, to: lead };
		s.lastPoke = now;
		if (by === "auto") s.lastAuto = now;
		// Only completed checks contribute flags. A check finishing after this ask remains due.
		if (due.length) {
			s.flagsSent ??= {};
			for (const f of due) if (f.update) s.flagsSent[f.update] = now;
		}
		this.log(`asked ${lead} for ${c.ini.id} (${by}: ${why.join(", ")}) as ${res.id}`);
		this.save();
		this.host.changed?.();
		return { ok: true, id: res.id };
	}

	private closePoke(s: InitiativeFeedState, how: "answered" | "expired" | "failed" | "replaced", at: number): void {
		if (!s.open) return;
		s.closed = [...(s.closed ?? []), { id: s.open.id, at, how }].slice(-CLOSED_KEEP);
		s.open = undefined;
	}

	/** The ask's text for this initiative now. */
	pokeText(c: Ctx, s: InitiativeFeedState, why: PokeWhy[]): string {
		const fresh = this.freshOf(c, s);
		const groups = this.groupsOf(c);
		const un = this.unlinkedOf(c);
		const freshIds = new Set(fresh.list.map((r) => r.id));
		const onFresh = new Map(
			groups.filter((g) => g.rec && freshIds.has(g.rec.id)).map((g) => [g.rec?.id ?? "", g] as const),
		);
		const lines: string[] = [];
		for (const r of fresh.list.slice(0, POKE_LINES)) {
			const g = onFresh.get(r.id);
			lines.push(`${recordLine(r)}${g ? ` -> ${entriesText(g.entries, 3)}` : ""}`);
		}
		if (lines.length < POKE_LINES) {
			for (const g of groups.filter((x) => !(x.rec && freshIds.has(x.rec.id))).slice(0, POKE_LINES - lines.length)) {
				lines.push(`${g.rec ? recordLine(g.rec) : "(no kept record)"} -> ${entriesText(g.entries, 3)}`);
			}
		}
		const last = this.lastUpdate(c);
		const flags = this.flagsDue(c, s);
		return pokeTextOf({
			name: c.ini.name,
			initiative: c.ini.id,
			...(c.ini.leadSet ? { leadSet: c.ini.leadSet } : {}),
			why,
			...(this.catchUpActive(s) && s.catchUp ? { catchUp: { from: s.catchUp.from, round: s.catchUp.rounds } } : {}),
			...(last ? { lastUpdate: { id: last.id, at: last.at } } : {}),
			fresh: fresh.list.length,
			unlinked: { decisions: un.decisions.length, changes: un.changes.length, records: groups.length },
			missing: c.decisions.filter((d) => missingOf(d).length).length,
			decisionsAll: c.decisions.length,
			lines,
			flags,
			dailyAt: c.settings.dailyAt,
		});
	}

	/** Anything new for the lead to do: new records, unlinked entries, or flags not sent back yet. */
	private somethingNew(c: Ctx, s: InitiativeFeedState): boolean {
		if (this.freshOf(c, s).list.length) return true;
		const un = this.unlinkedOf(c);
		if (un.decisions.length || un.changes.length) return true;
		return this.flagsDue(c, s).length > 0;
	}

	/** The owner's "Ask for an update" button. */
	ask(initiative: string): { ok: true; id: string; at: number } | { ok: false; error: string } {
		const c = this.ctx(initiative);
		if (!c) return { ok: false, error: `there's no initiative "${short(initiative, 40)}"` };
		if (!c.settings.initiatives.includes(c.ini.id)) return { ok: false, error: `Progress is off for ${c.ini.name}.` };
		if (!c.ini.lead) return { ok: false, error: `${c.ini.name} has no lead yet: pick one first.` };
		const s = this.stateOf(c.ini.id);
		if (s.open && this.host.pokeState(s.open.id) === "waiting")
			return { ok: false, error: `An ask is already on its way to ${s.open.to} (sent ${feedTime(s.open.at)}).` };
		const res = this.sendPoke(c, s, ["button"], "owner");
		return res.ok ? { ok: true, id: res.id, at: this.now() } : res;
	}

	/** The one-time catch-up: cover the initiative from a day, until nothing is unlinked. */
	catchUp(initiative: string, from: string): { ok: true; id: string; unlinked: number } | { ok: false; error: string } {
		const c = this.ctx(initiative);
		if (!c) return { ok: false, error: `there's no initiative "${short(initiative, 40)}"` };
		if (!c.settings.initiatives.includes(c.ini.id)) return { ok: false, error: `Progress is off for ${c.ini.name}.` };
		if (!c.ini.lead) return { ok: false, error: `${c.ini.name} has no lead yet.` };
		const fromAt = localMidnight(from);
		if (fromAt === undefined) return { ok: false, error: `from must be YYYY-MM-DD, not "${short(from, 20)}"` };
		const s = this.stateOf(c.ini.id);
		if (this.catchUpActive(s) && s.open)
			return { ok: false, error: `A catch-up is already going (round ${s.catchUp?.rounds}).` };
		const un = this.unlinkedOf(c);
		s.catchUp = { from, fromAt, at: this.now(), rounds: 1, lastUnlinked: un.decisions.length + un.changes.length };
		const res = this.sendPoke(c, s, ["catch-up"], "catch-up");
		if (!res.ok) {
			s.catchUp = undefined;
			this.save();
			return res;
		}
		return { ok: true, id: res.id, unlinked: un.decisions.length + un.changes.length };
	}

	/** The owner looked at the initiative (the page tells). */
	seen(initiative: string): void {
		if (!this.isOn(initiative)) return;
		const s = this.stateOf(initiative);
		s.seen = this.now();
		this.save();
	}

	/** The owner sets or clears the lead (the page; never a role). */
	setLead(initiative: string, lead: string | null): { ok: true } | { ok: false; error: string } {
		const want = lead === null || lead === "" ? null : String(lead).trim().toLowerCase();
		if (want && !this.host.roles().some((r) => r.id === want))
			return { ok: false, error: `there's no role "${short(want, 40)}"` };
		const store = this.host.store();
		const before = store.initiatives().find((i) => i.id === initiative);
		if (!before) return { ok: false, error: `there's no initiative "${short(initiative, 40)}"` };
		const res = store.setLead(initiative, want, "page", this.now());
		if (typeof res === "string") return { ok: false, error: res };
		const s = this.state.initiatives[initiative];
		if (s && before.lead !== want) {
			// The old lead's open ask and waiting triggers end with it.
			if (s.open) this.closePoke(s, "replaced", this.now());
			s.pending = [];
			if (s.catchUp && !s.catchUp.done) s.catchUp.stalled = this.now();
			this.save();
		}
		this.log(`lead of ${initiative}: ${before.lead ?? "none"} -> ${want ?? "none"} (the owner, on the page)`);
		this.host.changed?.();
		return { ok: true };
	}

	// the timer -----------------------------------------------------------------

	start(everyMs = 60_000): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.tick(), everyMs);
		this.timer.unref?.();
		setTimeout(() => void this.tick(), 5_000).unref?.();
	}

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}

	/** One round: close answered asks, note triggers, send what the throttle allows, check unchecked updates. */
	async tick(): Promise<void> {
		if (this.ticking) return;
		this.ticking = true;
		try {
			const settings = this.settings();
			if (!settings.initiatives.length) return;
			const recs = this.host.records();
			const store = this.host.store();
			const next = Number(store.load().next) || 1;
			const now = this.now();
			let dirty = false;
			for (const id of settings.initiatives) {
				const c = this.ctx(id, recs);
				if (!c) continue;
				const s = this.stateOf(id);
				const before = JSON.stringify(s);
				this.step(c, s, now, next);
				if (JSON.stringify(s) !== before) dirty = true;
				// Updates not checked yet (a restart cut a check off), one at a time.
				const unchecked = c.updates.find((u) => !this.state.checks[u.id] && !this.checking.has(u.id));
				if (unchecked && this.checking.size === 0) void this.runCheck(unchecked);
				else if (!unchecked && this.checking.size === 0) {
					// Then updates whose reader part is still owed, oldest first, one at a time.
					const owed = [...c.updates].sort((a, b) => a.at - b.at).find((u) => this.needsReread(u.id, settings, now));
					if (owed) void this.reread(owed);
				}
			}
			if (dirty) {
				this.save();
				this.host.changed?.();
			}
		} catch (err) {
			this.log(`tick failed: ${(err as Error).message}`);
		} finally {
			this.ticking = false;
		}
	}

	/** One initiative's round (exposed for tests with a fake clock). */
	step(c: Ctx, s: InitiativeFeedState, now: number, next: number): void {
		const lead = c.ini.lead;
		const settings = c.settings;
		const last = this.lastUpdate(c);
		// 1. Close the open ask: answered (an update after it, and the lead's turn is over), failed, or expired.
		if (s.open) {
			const open = s.open;
			const st = this.host.pokeState(open.id);
			let how: "answered" | "expired" | "failed" | undefined;
			if (!st || st === "failed") how = "failed";
			else if (last && last.at > open.at && !this.host.leadBusy(open.to) && !this.postingChatBusy(last))
				how = "answered";
			else if (now - open.at > POKE_OPEN_MS) how = "expired";
			if (how) {
				this.closePoke(s, how, now);
				if (open.by === "catch-up" && s.catchUp && !s.catchUp.done && !s.catchUp.stalled) {
					const un = this.unlinkedOf(c);
					const left = un.decisions.length + un.changes.length;
					if (left === 0) {
						s.catchUp.done = now;
						this.log(`catch-up for ${c.ini.id} done after ${s.catchUp.rounds} rounds`);
					} else if (how !== "failed" && left < s.catchUp.lastUnlinked) {
						s.catchUp.rounds += 1;
						s.catchUp.lastUnlinked = left;
						this.sendPoke(c, s, ["catch-up"], "catch-up");
					} else {
						s.catchUp.stalled = now;
						s.catchUp.why =
							how === "failed"
								? "the ask couldn't be delivered"
								: `${num(left)} still unlinked, no fewer than the round before`;
						this.log(`catch-up for ${c.ini.id} stalled: ${s.catchUp.why}`);
					}
				}
			}
		}
		// 2. Triggers since the last round.
		if (!s.marks) {
			s.marks = { next, scan: now };
			const d = new Date(now);
			if (d.getHours() * 60 + d.getMinutes() >= minutesOf(settings.dailyAt)) s.daily = localDay(now);
			return;
		}
		const pending = new Set<PokeWhy>(s.pending ?? []);
		const scan = s.marks.scan;
		if (c.filed.some((r) => r.source === "plan" && r.op === "done" && r.seen > scan)) pending.add("task-done");
		const fresh = (id: string): boolean => {
			const m = ENTRY_NUM.exec(id);
			return !!m && Number(m[1]) >= s.marks!.next;
		};
		if (c.decisions.some((d) => fresh(d.id)) || c.changes.some((x) => fresh(x.change.id))) pending.add("decision");
		if (this.flagsDue(c, s).length) pending.add("flag");
		const today = localDay(now);
		const d = new Date(now);
		if (s.daily !== today && d.getHours() * 60 + d.getMinutes() >= minutesOf(settings.dailyAt)) {
			s.daily = today;
			pending.add("daily");
		}
		s.marks = { next, scan: now };
		// 3. Send what the throttle allows.
		if (!lead || this.catchUpActive(s)) {
			s.pending = lead ? [...pending] : [];
			return;
		}
		if (!pending.size) {
			s.pending = [];
			return;
		}
		if (!this.somethingNew(c, s)) {
			s.pending = [];
			return;
		}
		if (s.open || (s.lastAuto !== undefined && now - s.lastAuto < settings.pokeEveryHours * 3_600_000)) {
			s.pending = [...pending];
			return;
		}
		const order: PokeWhy[] = ["task-done", "decision", "flag", "daily"];
		const why = order.filter((w) => pending.has(w));
		s.pending = [];
		const res = this.sendPoke(c, s, why, "auto");
		if (!res.ok) s.pending = why;
	}

	/** For tests: one initiative's round now. */
	stepNow(initiative: string): void {
		const c = this.ctx(initiative);
		if (!c) return;
		const s = this.stateOf(initiative);
		this.step(c, s, this.now(), Number(this.host.store().load().next) || 1);
		this.save();
	}

	// the page ------------------------------------------------------------------

	/** An initiative's feed in the list. */
	row(initiative: string, recs = this.host.records()): UiFeedRow {
		const on = this.isOn(initiative);
		if (!on) return { on: false, needsYou: 0, newSinceSeen: false };
		const updates = recs.filter((r) => r.source === "update" && r.initiative === initiative && r.update);
		const last = updates.length ? updates[updates.length - 1] : undefined;
		const s = this.state.initiatives[initiative];
		return {
			on: true,
			...(last ? { lastUpdateAt: last.at } : {}),
			needsYou: last ? needsYouCount(last.update?.needsYou) : 0,
			newSinceSeen: !!last && last.at > (s?.seen ?? 0),
			...(s?.open ? { askedAt: s.open.at } : {}),
		};
	}

	private sourceOf(rec: DecisionRecord, byId: Map<string, DecisionRecord>): UiDecisionSource {
		void byId;
		return sourceView({ record: rec.id, ref: rec.ref, at: rec.at, quotes: [], by: "update" }, rec);
	}

	private updateDecisions(c: Ctx, u: DecisionRecord, max: number): { list: UiUpdateDecision[]; total: number } {
		const linked = this.entriesLinkedBy(c, u.sources ?? []);
		const all: { at: number; make: () => UiUpdateDecision }[] = [
			...linked.decisions.map((d) => ({
				at: d.at,
				make: (): UiUpdateDecision => {
					const v = decisionView(d, c.byId);
					const head = v.sources[v.head] ?? v.sources[0];
					return {
						id: d.id,
						kind: "decision",
						title: d.title,
						at: d.at,
						writer: head?.writer ?? "",
						approval: head?.approval ?? "message",
						you: v.you,
						flags: v.flags,
					};
				},
			})),
			...linked.changes.map(({ change }) => ({
				at: change.at,
				make: (): UiUpdateDecision => {
					const views = change.sources.map((s) =>
						sourceView(s, s.record ? c.byId.get(s.record) : undefined, s.was ? c.byId.get(s.was) : undefined),
					);
					const ew = entryWho(views.map((v) => ({ who: { ...v, places: [] }, at: v.at })));
					const head = views[ew.head] ?? views[0];
					return {
						id: change.id,
						kind: "change",
						title: change.what,
						at: change.at,
						writer: head?.writer ?? "",
						approval: head?.approval ?? "message",
						you: ew.you,
						flags: ew.flags,
					};
				},
			})),
		].sort((a, b) => a.at - b.at);
		return { list: all.slice(0, max).map((x) => x.make()), total: all.length };
	}

	private updateLinksOf(c: Ctx, u: DecisionRecord, max: number): { list: UiUpdateLink[]; total: number } {
		const ids = u.sources ?? [];
		const list = ids.slice(0, max).map((id): UiUpdateLink => {
			if (id.startsWith("dr-")) {
				const r = c.byId.get(id);
				return r
					? { id, kind: "record", source: this.sourceOf(r, c.byId), title: short(recordGist(r), 120) }
					: { id, kind: "missing" };
			}
			const d = c.decisions.find((x) => x.id === id);
			if (d) {
				const v = decisionView(d, c.byId);
				const head = v.sources[v.head] ?? v.sources[0];
				return { id, kind: "decision", title: d.title, ...(head ? { source: head } : {}) };
			}
			const ch = c.changes.find((x) => x.change.id === id);
			if (ch) {
				const s0 = ch.change.sources[0];
				const head = s0 ? sourceView(s0, s0.record ? c.byId.get(s0.record) : undefined) : undefined;
				return { id, kind: "change", title: ch.change.what, ...(head ? { source: head } : {}) };
			}
			return { id, kind: "missing" };
		});
		return { list, total: ids.length };
	}

	private updateView(c: Ctx, u: DecisionRecord, later: boolean): UiProgressUpdate {
		const f = u.update as UpdateFields;
		const links = this.updateLinksOf(c, u, VIEW_LINKS);
		const decisions = this.updateDecisions(c, u, VIEW_DECISIONS);
		const check = this.state.checks[u.id];
		const sentences: UiUpdateSentence[] = (check?.sentences ?? []).map((s: CheckedSentence) => ({
			field: s.field,
			text: s.text,
			flags: s.flags.filter((fl) => flagCounts(fl, c.settings)).map(({ v: _v, at: _at, ...fl }) => ({ ...fl })),
		}));
		const name = this.host.roles().find((r) => r.id === u.from)?.name ?? u.from;
		return {
			id: u.id,
			at: u.at,
			by: u.from,
			byName: name,
			fields: {
				changed: f.changed,
				next: f.next,
				needsYou: f.needsYou,
				...(f.impact ? { impact: f.impact } : {}),
				...(f.options ? { options: f.options } : {}),
				...(f.until ? { until: f.until } : {}),
			},
			links: links.list,
			linksTotal: links.total,
			decisions: decisions.list,
			decisionsTotal: decisions.total,
			check: {
				state: check
					? "done"
					: this.checking.has(u.id) || c.settings.initiatives.includes(c.ini.id)
						? "checking"
						: "off",
				sentences,
				flagged: sentences.filter((s) => s.flags.length).length,
				...(check?.reader?.error ? { readerError: check.reader.error } : {}),
			},
			...(later ? { later: true } : {}),
		};
	}

	/** The Progress section of one initiative. */
	view(initiative: string, recs = this.host.records(), limit = VIEW_UPDATES): UiProgress | undefined {
		const c = this.ctx(initiative, recs);
		if (!c) return undefined;
		const on = c.settings.initiatives.includes(c.ini.id);
		const roles = this.host.roles();
		const leadName = c.ini.lead ? (roles.find((r) => r.id === c.ini.lead)?.name ?? c.ini.lead) : undefined;
		const base: UiProgress = {
			initiative: c.ini.id,
			on,
			lead: c.ini.lead,
			...(leadName ? { leadName } : {}),
			...(c.ini.leadSet ? { leadSet: { ...c.ini.leadSet } } : {}),
			roles,
			updates: [],
			updatesTotal: 0,
			unlinked: { decisions: 0, changes: 0 },
			missing: 0,
		};
		if (!on) return base;
		const s = this.state.initiatives[c.ini.id] ?? {};
		const newest = [...c.updates].reverse();
		const un = this.unlinkedOf(c);
		const out: UiProgress = {
			...base,
			updates: newest.slice(0, Math.max(1, limit)).map((u, i) => this.updateView(c, u, i > 0)),
			updatesTotal: newest.length,
			unlinked: { decisions: un.decisions.length, changes: un.changes.length },
			missing: c.decisions.filter((d) => missingOf(d).length).length,
		};
		// "Asked <lead> at hh:mm, no update yet" only while no update came after the ask: the ask itself
		// closes at the next round, once the lead's turn is over (a catch-up may post several in one turn).
		const lastAt = this.lastUpdate(c)?.at ?? 0;
		if (s.open && lastAt <= s.open.at) {
			const st = this.host.pokeState(s.open.id);
			out.asked = { at: s.open.at, delivered: st !== undefined && st !== "waiting", by: s.open.by };
		}
		if (s.catchUp) out.catchUp = { from: s.catchUp.from, done: !!s.catchUp.done, stalled: !!s.catchUp.stalled };
		if (!c.ini.lead) {
			const list: UiRoleUpdate[] = [];
			for (let i = c.filed.length - 1; i >= 0 && list.length < ROLE_UPDATES; i--) {
				const r = c.filed[i];
				if (r.source !== "tldr" && !(r.source === "plan" && r.op === "done")) continue;
				list.push({
					id: r.id,
					at: r.at,
					kind: r.source === "tldr" ? "tldr" : "plan",
					role: r.from,
					roleName: roles.find((x) => x.id === r.from)?.name ?? r.from,
					text: short(recordGist(r), 600),
					...(r.needsYou ? { needsYou: true } : {}),
					source: this.sourceOf(r, c.byId),
				});
			}
			out.roleUpdates = list;
		}
		return out;
	}

	/** Everything one update links, for the page's "show all". */
	updateLinks(updateId: string): { links: UiUpdateLink[]; decisions: UiUpdateDecision[] } | undefined {
		const recs = this.host.records();
		const u = recs.find((r) => r.id === updateId && r.source === "update");
		if (!u?.initiative) return undefined;
		const c = this.ctx(u.initiative, recs);
		if (!c) return undefined;
		return {
			links: this.updateLinksOf(c, u, UPDATE_SOURCES_MAX).list,
			decisions: this.updateDecisions(c, u, 100_000).list,
		};
	}

	/** The control socket's view: each feed initiative's state and counts. */
	status(): Record<string, unknown> {
		const settings = this.settings();
		const recs = this.host.records();
		const out: Record<string, unknown> = { settings };
		for (const id of settings.initiatives) {
			const c = this.ctx(id, recs);
			if (!c) {
				out[id] = { error: "no such initiative" };
				continue;
			}
			const s = this.state.initiatives[id] ?? {};
			const un = this.unlinkedOf(c);
			const last = this.lastUpdate(c);
			out[id] = {
				lead: c.ini.lead,
				leadSet: c.ini.leadSet,
				updates: c.updates.length,
				lastUpdate: last ? { id: last.id, at: last.at } : null,
				unlinked: { decisions: un.decisions.length, changes: un.changes.length },
				openFlags: this.openFlagCount(c, s),
				unchecked: c.updates.filter((u) => !this.state.checks[u.id]).length,
				open: s.open ?? null,
				pending: s.pending ?? [],
				lastAuto: s.lastAuto ?? null,
				daily: s.daily ?? null,
				catchUp: s.catchUp ?? null,
				closed: (s.closed ?? []).slice(-5),
			};
		}
		return out;
	}
}
