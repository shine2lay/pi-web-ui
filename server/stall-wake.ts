/**
 * stall-wake (Ops #284, docs/stall-watch.md "Waking the chain"): what the stall check (stall-watch.ts, Ops #283)
 * does with its findings when stall-watch.json says "mode": "on". Each stalled stretch wakes its chain in turn:
 * step 1 (its lead) when the stretch is first found, each later step gapHours after the one before while the same
 * stretch is still found, and the owner's step as a message to COO's home chat, once. No model anywhere.
 *
 * - One message per recipient per round, holding all its due items (role-messages.ts requestStall).
 * - A ledger (~/.pi-web-ui/stall-watch.jsonl, 30 days' detail plus unresolved checkpoints) records every step:
 *   sent, held (the owner paused role
 *   messages), wakes-off (pi-queue's wakeOnDone is false), no-chat (the role has no home chat) or capped. A step
 *   is never sent twice for a stretch, across restarts and installs.
 * - Caps: STALL_DAY_CAP messages per recipient per local day, STALL_HOUR_CAP in all per hour; a capped step waits
 *   for a round with room.
 * - It never starts, changes or completes anything: the leads decide; the check only wakes them.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { UiWorkPage } from "./protocol.js";
import type { StallExtra, StallFinding, StallSettings } from "./stall-watch.js";

export const STALL_LEDGER_FILE = "stall-watch.jsonl";
/** Historical detail, and checkpoints after a positively verified end, stay this long. */
export const STALL_LEDGER_KEEP_MS = 30 * 24 * 3_600_000;
/** At most this many stall messages to one recipient per local day. */
export const STALL_DAY_CAP = 6;
/** At most this many stall messages in all in any hour. */
export const STALL_HOUR_CAP = 20;
/** Who the owner's step goes to: COO puts it to him. */
export const STALL_OWNER_VIA = "coo";
/** Rough length cap of one item's text (rule 23: short). */
const ITEM_MAX = 600;
const HOUR = 3_600_000;

export type StallLedgerState = "sent" | "held" | "wakes-off" | "no-chat" | "capped";

/** One ledger line: one step of one stretch, and what became of it. */
export interface StallLedgerLine {
	stretch: string;
	step: number;
	/** The role it went (or was to go) to; the owner's step: "coo". */
	to: string;
	at: number;
	/** The role message (sent). */
	id?: string;
	state: StallLedgerState;
	/** The owner's step (to COO). */
	owner?: true;
	/** Positive end evidence was first seen then. Absence/suppression alone never sets this. */
	endedAt?: number;
}

/** Done with this step: it went, or it never can (wakes off, no home chat); the chain moves on after the gap. */
const FINAL: ReadonlySet<StallLedgerState> = new Set(["sent", "wakes-off", "no-chat"]);

/** One due step of one finding. */
export interface StallDue {
	finding: StallFinding;
	step: number;
	/** Recipient role ("coo" for the owner's step). */
	to: string;
	owner: boolean;
}

export interface StallBatch {
	to: string;
	items: StallDue[];
}

export interface StallRoundInput {
	findings: StallFinding[];
	ledger: readonly StallLedgerLine[];
	now: number;
	gapHours: number;
	/** The owner has role messages paused. */
	paused: boolean;
	/** Wakes are on (pi-queue's wakeOnDone). */
	wakesOn: boolean;
	/** The role has a home chat to send to. */
	hasHome: (role: string) => boolean;
	dayCap?: number;
	hourCap?: number;
}

export interface StallRoundPlan {
	/** One message per recipient, in the order its first item was found. */
	batches: StallBatch[];
	/** Lines for steps that didn't go (held, wakes-off, no-chat, capped). */
	lines: StallLedgerLine[];
}

/** pi-queue's global disabled-wakes switch, also used by its lead reminders. A missing file means on; an
 *  unreadable file fails quiet until it can be read again. No owner setting is changed here. */
export function stallWakesOn(file: string): boolean {
	try {
		return JSON.parse(readFileSync(file, "utf8"))?.wakeOnDone !== false;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "ENOENT";
	}
}

/** The machine's calendar day (the daily cap counts per local day). */
export function localDay(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** The step a stretch is at: the last final step, and when it was recorded. */
export function stallProgress(stretch: string, ledger: readonly StallLedgerLine[]): { step: number; at?: number } {
	let step = 0;
	let at: number | undefined;
	for (const l of ledger) {
		if (l.stretch !== stretch || !FINAL.has(l.state)) continue;
		if (l.step > step || (l.step === step && at !== undefined && l.at < at)) {
			step = l.step;
			at = l.at;
		}
	}
	return { step, at };
}

/** The next step of a finding and when it is due, or undefined when its chain is done (the owner step went). */
export function stallNext(
	f: StallFinding,
	ledger: readonly StallLedgerLine[],
	now: number,
	gapHours: number,
): { step: number; dueAt: number } | undefined {
	const p = stallProgress(f.stretch, ledger);
	const step = p.step + 1;
	if (step > f.chain.length) return undefined;
	const dueAt = step === 1 || p.at === undefined ? now : p.at + gapHours * HOUR;
	return { step, dueAt };
}

/** The last line of a stretch's step (the newest). */
function lastLine(ledger: readonly StallLedgerLine[], stretch: string, step: number): StallLedgerLine | undefined {
	let last: StallLedgerLine | undefined;
	for (const l of ledger) if (l.stretch === stretch && l.step === step && (!last || l.at >= last.at)) last = l;
	return last;
}

/** Messages sent (distinct ids) that match. */
function sentCount(ledger: readonly StallLedgerLine[], match: (l: StallLedgerLine) => boolean): number {
	const ids = new Set<string>();
	for (const l of ledger) if (l.state === "sent" && match(l)) ids.add(l.id ?? `${l.stretch}#${l.step}`);
	return ids.size;
}

/**
 * One round (pure): which steps are due, batched per recipient, and lines for those that can't go. A held or
 * capped step is written once while it stays so (not every round), and comes back while the stretch is found.
 */
export function planStallRound(x: StallRoundInput): StallRoundPlan {
	const lines: StallLedgerLine[] = [];
	const byTo = new Map<string, StallDue[]>();
	const note = (d: StallDue, state: StallLedgerState) => {
		const last = lastLine(x.ledger, d.finding.stretch, d.step);
		if (!FINAL.has(state) && last?.state === state) return;
		lines.push({
			stretch: d.finding.stretch,
			step: d.step,
			to: d.to,
			at: x.now,
			state,
			...(d.owner ? { owner: true as const } : {}),
		});
	};
	const seen = new Set<string>();
	for (const f of x.findings) {
		if (seen.has(f.stretch)) continue;
		seen.add(f.stretch);
		const next = stallNext(f, x.ledger, x.now, x.gapHours);
		if (!next || x.now < next.dueAt) continue;
		const who = f.chain[next.step - 1];
		const owner = who === "owner";
		const d: StallDue = { finding: f, step: next.step, to: owner ? STALL_OWNER_VIA : who, owner };
		if (x.paused) note(d, "held");
		else if (!x.wakesOn) note(d, "wakes-off");
		else if (!x.hasHome(d.to)) note(d, "no-chat");
		else {
			const list = byTo.get(d.to);
			if (list) list.push(d);
			else byTo.set(d.to, [d]);
		}
	}
	const dayCap = x.dayCap ?? STALL_DAY_CAP;
	const hourCap = x.hourCap ?? STALL_HOUR_CAP;
	const day = localDay(x.now);
	let hour = sentCount(x.ledger, (l) => l.at > x.now - HOUR);
	const batches: StallBatch[] = [];
	for (const [to, items] of byTo) {
		const today = sentCount(x.ledger, (l) => l.to === to && localDay(l.at) === day);
		if (today >= dayCap || hour >= hourCap) {
			for (const d of items) note(d, "capped");
			continue;
		}
		hour++;
		batches.push({ to, items });
	}
	return { batches, lines };
}

// ---------------------------------------------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "HH:MM" on the same local day as `now`, else "Oct 20 01:03" (the server's local time). */
export function stallWhen(at: number, now: number): string {
	const d = new Date(at);
	const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
	return localDay(at) === localDay(now) ? hm : `${MONTHS[d.getMonth()]} ${d.getDate()} ${hm}`;
}

const clip = (s: string, n: number) => {
	const t = String(s ?? "")
		.replace(/\s+/g, " ")
		.trim();
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The rule in plain words. */
export function stallRuleText(f: Pick<StallFinding, "rule" | "since">, now: number): string {
	return f.rule === "empty"
		? `no open task since ${stallWhen(f.since, now)}`
		: `nothing recorded since ${stallWhen(f.since, now)}`;
}

const kindWord = (f: StallFinding) => (f.kind === "project" ? "Project" : "Initiative");
const tool = (f: StallFinding) => (f.kind === "project" ? "work_project" : "work_initiative");
const who = (role: string) => (role === "owner" ? "the owner through COO" : role);

function itemHead(f: StallFinding): string {
	const where = f.kind === "project" && f.initiative ? `${f.id}, in initiative ${f.initiative}` : f.id;
	return `${kindWord(f)} "${clip(f.name, 80)}" (${where})`;
}

function contextLines(f: StallFinding): string[] {
	const out: string[] = [];
	if (f.lastDone) {
		const d = f.lastDone;
		out.push(`Last done: ${d.queue} #${d.task} "${clip(d.title, 70)}"${d.summary ? `: ${clip(d.summary, 110)}` : ""}.`);
	} else out.push("Last done: no task done under it yet.");
	if (f.open.length) {
		const shown = f.open.slice(0, 3).map((t) => {
			const wait = t.waitsOn ? `, waits on ${clip(t.waitsOn, 70)}` : "";
			return `${t.queue} #${t.task} "${clip(t.title, 50)}" (${t.status}${wait})`;
		});
		// The count first: the list may be clipped to fit.
		out.push(`Open (${f.open.length}): ${shown.join("; ")}${f.open.length > shown.length ? "; \u2026" : ""}.`);
	}
	return out;
}

/** One item for a lead: what's stalled, what was last done, what's open, who comes next and how to clear it. */
export function stallLeadItemText(d: StallDue, now: number, gapHours: number): string {
	const f = d.finding;
	const rest = f.chain.slice(d.step);
	const next = rest.length
		? `Next: if nothing changes, ${who(rest[0])} is woken at ${stallWhen(now + gapHours * HOUR, now)}${rest.length > 1 ? `, then ${rest.slice(1).map(who).join(", then ")}` : ""}.`
		: "Next: nothing more is sent automatically; it stays on the Initiatives page.";
	const clear = `To clear it: queue the next task under it (queue_add with ${f.kind} ${f.id}), close it (${tool(f)} change, status done or dropped), or record a wait with its end (${tool(f)} wait).`;
	const head = `${itemHead(f)}: ${stallRuleText(f, now)}.`;
	// The head, who comes next and how to clear it always go whole; the context gets what's left of ~600.
	const room = Math.max(120, ITEM_MAX - head.length - next.length - clear.length);
	return [head, clip(contextLines(f).join(" "), room), next, clear].join("\n");
}

/** One item for COO, the owner's step: who was woken when, and what to put to the owner. */
export function stallOwnerItemText(d: StallDue, ledger: readonly StallLedgerLine[], now: number): string {
	const f = d.finding;
	const earlier: string[] = [];
	for (let step = 1; step < d.step; step++) {
		const l = [...ledger]
			.filter((x) => x.stretch === f.stretch && x.step === step && FINAL.has(x.state))
			.sort((a, b) => a.at - b.at)[0];
		const role = f.chain[step - 1];
		const name = role === STALL_OWNER_VIA ? "COO (you)" : role;
		if (!l) earlier.push(`${name} (no record)`);
		else if (l.state === "sent") earlier.push(`${name} at ${stallWhen(l.at, now)}`);
		else earlier.push(`${name} not (${l.state === "wakes-off" ? "wakes are off" : "no home chat"})`);
	}
	const woken = earlier.length
		? `Woken: ${earlier.join(", ")}; nothing changed.`
		: "Its lead is the owner, so no role was woken first.";
	return [
		`${itemHead(f)}: ${stallRuleText(f, now)}. ${woken}`,
		clip(contextLines(f).join(" "), 300),
		"Put it to the owner as one dialog with the full package (rule 21): drop it, pause it, reassign it, or name the next work. Nothing more is sent automatically for it; it stays on the Initiatives page.",
	].join("\n");
}

/** The whole message for one recipient (the header and hint are role-messages.ts's). */
export function stallMessageText(
	b: StallBatch,
	ledger: readonly StallLedgerLine[],
	now: number,
	gapHours: number,
): string {
	return b.items
		.map((d) => (d.owner ? stallOwnerItemText(d, ledger, now) : stallLeadItemText(d, now, gapHours)))
		.join("\n\n");
}

/** What the role message record carries about each item (role-messages.ts RoleStallInfo). */
export interface StallItemInfo {
	kind: "project" | "initiative";
	id: string;
	name: string;
	rule: "empty" | "silent";
	since: number;
	step: number;
	owner?: true;
}

export function stallItemInfo(d: StallDue): StallItemInfo {
	const f = d.finding;
	return {
		kind: f.kind,
		id: f.id,
		name: f.name,
		rule: f.rule,
		since: f.since,
		step: d.step,
		...(d.owner ? { owner: true as const } : {}),
	};
}

/** The stretch an item info belongs to (as stall-watch.ts makes it). */
export const stretchOf = (i: Pick<StallItemInfo, "kind" | "id" | "rule" | "since">) =>
	`${i.kind}:${i.id}:${i.rule}:${i.since}`;

// ---------------------------------------------------------------------------------------------------------------
// The ledger file
// ---------------------------------------------------------------------------------------------------------------

function isLine(v: unknown): v is StallLedgerLine {
	const l = v as StallLedgerLine;
	return (
		!!l &&
		typeof l === "object" &&
		typeof l.stretch === "string" &&
		Number.isInteger(l.step) &&
		typeof l.to === "string" &&
		typeof l.at === "number" &&
		["sent", "held", "wakes-off", "no-chat", "capped"].includes(l.state) &&
		(l.endedAt === undefined || Number.isFinite(l.endedAt))
	);
}

/** Compact consumed-step checkpoints outlive the detail window until an end is positively verified. */
function keepLine(l: StallLedgerLine, now: number): boolean {
	if (l.endedAt !== undefined) return now - l.endedAt < STALL_LEDGER_KEEP_MS;
	return FINAL.has(l.state) || now - l.at < STALL_LEDGER_KEEP_MS;
}

function replaceStallLedger(file: string, lines: readonly StallLedgerLine[]): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
	renameSync(tmp, file);
}

/** Recent detail and every unresolved consumed step; a bad/cut-off line is skipped. */
export function readStallLedger(file: string, now: number): StallLedgerLine[] {
	if (!existsSync(file)) return [];
	const raw = readFileSync(file, "utf8");
	const all: StallLedgerLine[] = [];
	for (const s of raw.split("\n")) {
		if (!s.trim()) continue;
		try {
			const v = JSON.parse(s);
			if (isLine(v)) all.push(v);
		} catch {
			// A line cut short by a crash: skipped.
		}
	}
	const keep = all.filter((l) => keepLine(l, now));
	const clean = keep.map((l) => `${JSON.stringify(l)}\n`).join("");
	if (raw !== clean) {
		// Also remove a cut-off final line before appending: otherwise the next good receipt would join it
		// and be lost on the following restart. Durable role-store receipts recover any missing send.
		replaceStallLedger(file, keep);
	}
	return keep;
}

export function appendStallLedger(file: string, lines: readonly StallLedgerLine[]): void {
	if (!lines.length) return;
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
}

// ---------------------------------------------------------------------------------------------------------------
// The act
// ---------------------------------------------------------------------------------------------------------------

export interface StallWakeHost {
	/** The owner has role messages paused. */
	paused(): boolean;
	/** pi-queue's wakeOnDone (~/.pi/agent/pi-queue.json; absent = on). */
	wakesOn(): boolean;
	/** The role has a home chat. */
	hasHome(role: string): boolean;
	/** All durable stall creation receipts: recover missing steps before working out caps (including items
	 *  no longer found). This covers a crash between creating a role message and recording its ledger line. */
	history?(): StallLedgerLine[];
	/** A stall record that already holds this step for this role (a send whose ledger line was lost). */
	sentBefore?(stretch: string, step: number, to: string): { id: string; at: number } | undefined;
	/** Positive evidence from this round's complete registry inputs; no evidence means retain conservatively. */
	ended?(stretch: string): boolean;
	/** role-messages.ts requestStall. */
	send(input: {
		role: string;
		items: StallItemInfo[];
		text: string;
	}): { ok: true; id: string } | { ok: false; error: string };
	log(line: string): void;
}

/** Who was asked about a stretch, for the Initiatives page: the role ("owner" for the owner's step) and when. */
export interface StallAsked {
	role: string;
	at: number;
}

/**
 * The work page with the stall check's last findings on its records (UiWorkPageRecord.stall), for the Initiatives
 * page's note lines: rule, since, and who was asked in the stretch. Records not found stalled are left as they are.
 */
export function withStall(
	page: UiWorkPage,
	findings: readonly StallFinding[],
	asked: (stretch: string) => StallAsked[],
	now = Date.now(),
): UiWorkPage {
	if (!findings.length) return page;
	const by = new Map(findings.map((f) => [`${f.kind}:${f.id}`, f]));
	const lay = (kind: "project" | "initiative", list: UiWorkPage["projects"]) =>
		list.map((r) => {
			const f = by.get(`${kind}:${r.id}`);
			// Between 10-min rounds the live page may already show a wait, a changed lead or a new task.
			// Don't put an older finding on that now-quiet or moving item.
			if (!f || r.status !== "active" || (r.wait && r.wait.until > now) || r.lead !== f.chain[0]) return r;
			// Same occupancy as stallReview: direct tasks only; an initiative with an active project is
			// covered by that project, while a dropped child's leftover task doesn't cover its initiative.
			const tasks = page.tasks.filter((t) =>
				kind === "project"
					? "project" in t.parent && t.parent.project === r.id
					: "initiative" in t.parent && t.parent.initiative === r.id,
			);
			const open = tasks.filter((t) => !["done", "dropped", "removed"].includes(t.state ?? "ready"));
			if (f.rule === "empty" && open.length) return r;
			if (
				f.rule === "silent" &&
				(!open.length ||
					r.updatedAt > f.since ||
					tasks.some((t) => (t.stateAt ?? 0) > f.since || (t.progress?.at ?? 0) > f.since) ||
					open.some((t) => t.needsYou) ||
					open.every((t) => t.paused))
			)
				return r;
			if (kind === "initiative" && page.projects.some((p) => p.initiative === r.id && p.status === "active")) return r;
			return { ...r, stall: { rule: f.rule, since: f.since, asked: asked(f.stretch) } };
		});
	return { ...page, projects: lay("project", page.projects), initiatives: lay("initiative", page.initiatives) };
}

/** Positive stretch-end evidence only. A paused/needs-you item, a missing record or an incomplete read is
 *  never enough. Used only for stretches no longer found, not for deciding whether a current one is due. */
export function stallStretchEnded(stretch: string, page: UiWorkPage, extra: StallExtra): boolean {
	if (page.problem) return false;
	const [kind, id, rule, sinceText] = stretch.split(":");
	if ((kind !== "project" && kind !== "initiative") || !id) return false;
	const since = Number(sinceText);
	if (!Number.isFinite(since)) return false;
	const r = (kind === "project" ? page.projects : page.initiatives).find((r) => r.id === id);
	if (!r) return false;
	if (r.status === "done" || r.status === "dropped") return true;
	const times = extra.times.get(`${kind}:${id}`);
	if ((times?.statusAt ?? 0) > since || (times?.resumedAt ?? 0) > since || (r.wait?.at ?? 0) > since) return true;
	const tasks = page.tasks.filter((t) =>
		kind === "project"
			? "project" in t.parent && t.parent.project === id
			: "initiative" in t.parent && t.parent.initiative === id,
	);
	const open = tasks.filter((t) => !["done", "dropped", "removed"].includes(t.state ?? "ready"));
	if (open.some((t) => t.needsYou) || (open.length > 0 && open.every((t) => t.paused))) return false;
	if (
		(times?.leftAt ?? 0) > since ||
		tasks.some((t) => t.added > since || (t.stateAt ?? 0) > since || (t.progress?.at ?? 0) > since)
	)
		return true;
	if (
		rule === "silent" &&
		(r.updatedAt > since ||
			(times?.eventAt ?? 0) > since ||
			(kind === "initiative" && (extra.leadUpdates.get(id) ?? 0) > since))
	)
		return true;
	return (
		kind === "initiative" &&
		page.projects.some((p) => p.initiative === id && p.status === "active" && p.createdAt > since)
	);
}

/** The stall check's act for mode "on": wakes each finding's chain in turn (see the file's head). */
export class StallWake {
	private ledgerCache: StallLedgerLine[] | undefined;

	constructor(
		private readonly host: StallWakeHost,
		private readonly file: string,
		private readonly settings: () => Pick<StallSettings, "gapHours">,
	) {}

	/** The ledger, read once, then kept with appended receipts and conservative retention each round. */
	ledger(now = Date.now()): StallLedgerLine[] {
		if (!this.ledgerCache) {
			try {
				this.ledgerCache = readStallLedger(this.file, now);
			} catch (err) {
				this.host.log(`stall: couldn't read the ledger ${this.file}: ${(err as Error)?.message ?? err}`);
				throw err;
			}
		}
		return this.ledgerCache;
	}

	private record(lines: StallLedgerLine[]): void {
		if (!lines.length) return;
		appendStallLedger(this.file, lines);
		this.ledgerCache?.push(...lines);
	}

	private retain(findings: StallFinding[], now: number): void {
		const ledger = this.ledger(now);
		const current = new Set(findings.map((f) => f.stretch));
		const ends = new Map<string, boolean>();
		const next = ledger
			.map((l) => {
				if (current.has(l.stretch)) return l.endedAt === undefined ? l : { ...l, endedAt: undefined };
				if (l.endedAt !== undefined) return l;
				if (!ends.has(l.stretch)) ends.set(l.stretch, this.host.ended?.(l.stretch) === true);
				return ends.get(l.stretch) ? { ...l, endedAt: now } : l;
			})
			.filter((l) => keepLine(l, now));
		if (next.length !== ledger.length || next.some((l, i) => l !== ledger[i])) {
			replaceStallLedger(this.file, next);
			this.ledgerCache = next;
		}
	}

	/** One round's findings: send what is due. Never throws past a recipient (logged). */
	readonly act = (findings: StallFinding[], now: number): void => {
		this.retain(findings, now);
		const ledger = this.ledger(now);
		const known = new Set(ledger.filter((l) => l.state === "sent").map((l) => `${l.stretch}#${l.step}`));
		const recovered = (this.host.history?.() ?? []).filter((l) => {
			const key = `${l.stretch}#${l.step}`;
			const unresolved = findings.some((f) => f.stretch === l.stretch) || ledger.some((m) => m.stretch === l.stretch);
			if (l.state !== "sent" || (now - l.at >= STALL_LEDGER_KEEP_MS && !unresolved) || known.has(key)) return false;
			known.add(key);
			return true;
		});
		this.record(recovered);
		const gapHours = this.settings().gapHours;
		const plan = planStallRound({
			findings,
			ledger,
			now,
			gapHours,
			paused: this.host.paused(),
			wakesOn: this.host.wakesOn(),
			hasHome: (r) => this.host.hasHome(r),
		});
		this.record(plan.lines);
		for (const l of plan.lines) this.host.log(`stall: step ${l.step} of ${l.stretch} for ${l.to}: ${l.state}`);
		for (const b of plan.batches) {
			// A send whose ledger line was lost (a crash between the two): record it, don't send again.
			const found: StallLedgerLine[] = [];
			const items = b.items.filter((d) => {
				const before = this.host.sentBefore?.(d.finding.stretch, d.step, b.to);
				if (!before) return true;
				found.push(this.line(d, before.at, "sent", before.id));
				return false;
			});
			this.record(found);
			if (!items.length) continue;
			const batch = { to: b.to, items };
			const res = this.host.send({
				role: b.to,
				items: items.map(stallItemInfo),
				text: stallMessageText(batch, this.ledger(now), now, gapHours),
			});
			if (!res.ok) {
				this.host.log(`stall: couldn't wake ${b.to}: ${res.error}`);
				continue;
			}
			this.record(items.map((d) => this.line(d, now, "sent", res.id)));
			this.host.log(
				`stall: woke ${b.to} (${res.id}) about ${items.map((d) => `${d.finding.id} step ${d.step}${d.owner ? " (owner)" : ""}`).join(", ")}`,
			);
		}
	};

	private line(d: StallDue, at: number, state: StallLedgerState, id?: string): StallLedgerLine {
		return {
			stretch: d.finding.stretch,
			step: d.step,
			to: d.to,
			at,
			...(id ? { id } : {}),
			state,
			...(d.owner ? { owner: true as const } : {}),
		};
	}

	/** Who was asked about a stretch so far (sent steps, oldest first): the Initiatives page's note line. */
	asked(stretch: string, now = Date.now()): StallAsked[] {
		let ledger: StallLedgerLine[];
		try {
			ledger = this.ledger(now);
		} catch {
			return [];
		}
		return ledger
			.filter((l) => l.stretch === stretch && l.state === "sent")
			.sort((a, b) => a.at - b.at)
			.map((l) => ({ role: l.owner ? "owner" : l.to, at: l.at }));
	}
}
