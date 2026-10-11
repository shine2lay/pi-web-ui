/**
 * decision-store (task #84): the decisions the reader (and roles) found in task #83's records, the
 * initiatives they are filed under, the reader's settings and its state. All in <dataDir>/decisions/:
 *
 *   decisions.json     decisions, their changes and where each came from (reader or role)
 *   initiatives.json   [{ id, name, markers, lead }] (lead: task #85)
 *   settings.json      { enabled, model, thinking, readEveryMinutes, batchRecords, batchChars, callTimeoutSeconds, dailyTokenCap, readFrom }
 *   reader-state.json  records read, tokens per day, the cap, the last error
 *
 * Who decided is not stored: decision-who works it out from the records each time.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DecisionRecord } from "./decision-records.js";
import { INITIATIVE_ID, INITIATIVE_MAX, localDay } from "./decision-records.js";
import { planText, recordText } from "./decision-who.js";

export const DECISIONS_FILE = "decisions.json";
export const INITIATIVES_FILE = "initiatives.json";
export const SETTINGS_FILE = "settings.json";
export const READER_STATE_FILE = "reader-state.json";

export const CHANGE_TYPES = [
	"reversed",
	"widened",
	"limit-raised",
	"limit-moved",
	"re-recorded",
	"end-added",
	"end-changed",
	"end-dropped",
	"other",
] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

/** One place a decision or change is recorded. */
export interface DecisionSourceRef {
	/** dr-… of a kept record (task #83). */
	record?: string;
	/** The record's ref (rm-…, bp-…, ask:…, <chat file>:<line>), kept for links and the replay. */
	ref?: string;
	/** A role's entry for a decision that lived only in files, notes or code. */
	link?: string;
	at: number;
	/** Verbatim quotes of the point itself. */
	quotes: string[];
	/** The wording says the owner decided (reader or role). */
	claimsOwner?: boolean;
	/** Dialog answers: the option's main choice or a rider inside it. */
	part?: "main" | "rider";
	/** "reader" or "role:<id>". */
	by: string;
	/** The reader repeated an earlier statement of the same decision. */
	same?: boolean;
	/** A plan change the reader saw as what changed: dr-… of the plan's version before it (words it took out are there). */
	was?: string;
}

/** One of the three owner fields: impact, options and their cost, until when. */
export interface OwnerField {
	text: string;
	/** "reader" (a quote from the record) or "role:<id>". */
	by: string;
	record?: string;
	at: number;
}

export interface DecisionChange {
	id: string;
	type: ChangeType;
	what: string;
	at: number;
	until?: OwnerField;
	impact?: OwnerField;
	sources: DecisionSourceRef[];
	by: string;
	notDecision?: { by: string; at: number; why?: string };
}

export interface DecisionEntry {
	id: string;
	/** null = Unfiled. */
	initiative: string | null;
	/** tag, marker, reader or role:<id>. */
	filedBy: string;
	/**
	 * Other initiatives whose records changed or restated it later. It is listed there too, but its own
	 * filing stays: a record that mentions a decision doesn't make it that initiative's (stage test round 11).
	 */
	alsoIn?: string[];
	title: string;
	what: string;
	at: number;
	impact?: OwnerField;
	options?: OwnerField;
	until?: OwnerField;
	sources: DecisionSourceRef[];
	changes: DecisionChange[];
	by: string;
	notDecision?: { by: string; at: number; why?: string };
}

export interface DecisionsDoc {
	v: 1;
	next: number;
	decisions: DecisionEntry[];
}

export interface Initiative {
	id: string;
	name: string;
	/** "re:<regex>" (case-insensitive), "task:<role> #<n>" (that queued task's plans), or a phrase. */
	markers: string[];
	/** The initiative's lead role (task #85 sets it). */
	lead: string | null;
	/** What it covers, in plain words: the reader files records without a marker by it. */
	about?: string;
	addedBy?: string;
}

export const READER_THINKING = ["off", "minimal", "low", "medium", "high"] as const;
export type ReaderThinking = (typeof READER_THINKING)[number];

export interface ReaderSettings {
	enabled: boolean;
	/** "auto" = the cheapest Claude model in the chat pool, or "provider/id". */
	model: string;
	/** The reader's thinking level (pi's default is the chats' own, often "max": far too slow here). */
	thinking: ReaderThinking;
	readEveryMinutes: number;
	batchRecords: number;
	batchChars: number;
	/** How long one model call may take before it counts as failed. */
	callTimeoutSeconds: number;
	dailyTokenCap: number;
	/** First local day read (YYYY-MM-DD). */
	readFrom: string;
	/** The initiatives whose records it reads: a record filed to one of them by its tag or markers (no model).
	 *  Other records stay unread, so listing an initiative later reads its records then. None = nothing. */
	initiatives: string[];
}

export const DEFAULT_SETTINGS: ReaderSettings = {
	// Off until settings.json turns it on: the reader spends model tokens from the chats' Claude pool, and an
	// install must never start reading days of records by itself (owner, task #84: the page goes live with
	// the reader off until he chooses).
	enabled: false,
	model: "auto",
	// Stage test round 5 (2026-10-10): with "low" the three runs found 20, 22 and 23 of 26 must-catch
	// points; "medium" found 25, 23 and 22 with fewer wrong links, for about 1.5 times the output tokens.
	// Rounds 9 and 10 ("medium"): 3 of 6 runs found every point; the misses were links a closer read
	// makes (a reversal inside a long dialog answer, an order's two parts kept apart). Rounds 11-13
	// ("high"): 4 of 9 runs found every point, for about twice the output tokens, so back to "medium"
	// (owner's choice, task #84, 2026-10-10).
	thinking: "medium",
	readEveryMinutes: 5,
	batchRecords: 12,
	// Stage test round 3 (2026-10-10): with 40,000 the reader tied restatements in big plans to the wrong
	// decision; with 12,000 a big plan is read alone, after the plans before it are known decisions.
	batchChars: 12_000,
	// Stage test round 7 (2026-10-10): a batch of 12 short records took longer than 180 s with "medium".
	callTimeoutSeconds: 420,
	dailyTokenCap: 2_000_000,
	readFrom: "2026-10-03",
	// None listed = nothing read, so an install never starts reading by itself (owner, 2026-10-10 17:50, via
	// COO rm-8fcaa366: "only enable it for teams in temper"; task #98).
	initiatives: [],
};

export interface DayTokens {
	input: number;
	output: number;
	calls: number;
}

export interface ReaderState {
	v: 1;
	/** record id -> how it was read: d = has decisions, n = not a decision, x = gave up on it. */
	read: Record<string, "d" | "n" | "x">;
	tokens: Record<string, DayTokens>;
	/** The local day the cap stopped the reader. */
	capHit?: string;
	lastRun?: number;
	lastModel?: string;
	lastError?: { at: number; error: string };
	/** record id -> failed attempts. */
	tries?: Record<string, number>;
	/** A record that is an exact copy of an earlier one (a done note written to two chats) -> the record
	 *  read in its place. */
	copies?: Record<string, string>;
	/** Claude pool account -> until when (ms) it rests after refusing a call for its limit. */
	resting?: Record<string, number>;
}

/** Team in Temper's markers, from Data's METHOD.md (decision-log-check-2026-10-09). */
export const TEAM_IN_TEMPER: Initiative = {
	id: "team-in-temper",
	name: "Team in Temper",
	markers: [
		"re:team.in.temper",
		"re:pi.in.temper",
		"Team page",
		"re:projects? page",
		"team run",
		"team runtime",
		"team trial",
		"re:first (project|trial|team)",
		"re:\\bM[1-8]\\b",
		"re:\\bLR\\d+\\b",
		"switch-on",
		"re:\\bR2\\b",
		"leader loop",
		"re:\\b(SW|ADR-M4)-\\d+",
		"re:bp-(3f9d7bd9|138173ea|49635ed8|5a5db13c|e072f992|3e3475b8|72507050|9b03a07a|6b440cd4|be8d76b9|d59ad76e|ce2cae61|cae457e8|0444486a|fff8cdfa|7ca34155|bcbd4039|b63b947e|fd4817ba|b7429b81|6b3fc76d)",
		"re:#(37|38|39|47|48|49|50|51|52|54|67|68|73|74|75|76|77|78|79)\\b",
		...[37, 38, 39, 47, 48, 49, 50, 51, 52, 54, 68, 73, 74, 75, 76, 77, 78, 79].map((n) => `task:temper #${n}`),
		...[14, 15, 16, 17, 20, 21, 24, 25].map((n) => `task:architecture #${n}`),
		"task:ops #67",
		"task:ops #78",
		"task:security #2",
		"task:design #55",
	],
	lead: null,
	about:
		"AI roles (Pi members) working as a team inside Temper: team runs, trials and Projects, member boxes and their turns, the leader and reviews, the login/host helper temper-pi-host and its limits, switch-on and its checklist, the Team/Projects page that shows the runs. Not the chat app's own role messages, Board, queues or role chats.",
};

function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function writeJson(file: string, value: unknown): void {
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(value, null, "\t") + "\n");
	renameSync(tmp, file);
}

const num = (v: unknown, d: number, min: number, max: number): number => {
	const n = Number(v);
	return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};

export function parseSettings(raw: unknown): ReaderSettings {
	const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	return {
		enabled: o.enabled === undefined ? DEFAULT_SETTINGS.enabled : o.enabled !== false,
		model: typeof o.model === "string" && o.model.trim() ? o.model.trim() : DEFAULT_SETTINGS.model,
		thinking: READER_THINKING.includes(o.thinking as ReaderThinking)
			? (o.thinking as ReaderThinking)
			: DEFAULT_SETTINGS.thinking,
		readEveryMinutes: num(o.readEveryMinutes, DEFAULT_SETTINGS.readEveryMinutes, 1, 1440),
		batchRecords: Math.round(num(o.batchRecords, DEFAULT_SETTINGS.batchRecords, 1, 50)),
		batchChars: Math.round(num(o.batchChars, DEFAULT_SETTINGS.batchChars, 4_000, 150_000)),
		callTimeoutSeconds: Math.round(num(o.callTimeoutSeconds, DEFAULT_SETTINGS.callTimeoutSeconds, 30, 1800)),
		dailyTokenCap: Math.round(num(o.dailyTokenCap, DEFAULT_SETTINGS.dailyTokenCap, 0, 1e9)),
		readFrom:
			typeof o.readFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(o.readFrom) ? o.readFrom : DEFAULT_SETTINGS.readFrom,
		// Short ids by the initiative tag's rule; anything else is left out.
		initiatives: Array.isArray(o.initiatives)
			? [
					...new Set(
						o.initiatives
							.filter((v): v is string => typeof v === "string")
							.map((v) => v.trim())
							.filter((v) => v.length <= INITIATIVE_MAX && INITIATIVE_ID.test(v)),
					),
				]
			: [...DEFAULT_SETTINGS.initiatives],
	};
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

function markerHits(marker: string, rec: DecisionRecord, text: string): boolean {
	const m = marker.trim();
	if (!m) return false;
	const task = /^task:([a-z0-9-]+)\s*#(\d+)$/i.exec(m);
	if (task) return rec.source === "plan" && rec.from === task[1] && rec.task === Number(task[2]);
	if (m.startsWith("re:")) {
		try {
			return new RegExp(m.slice(3), "i").test(text);
		} catch {
			return false;
		}
	}
	const esc = m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
	return new RegExp(`(?:^|\\W)${esc}(?:$|\\W)`, "i").test(text);
}

/** File a record by its tag, then by markers (the initiative with most marker hits). */
export function fileRecord(
	rec: DecisionRecord,
	initiatives: Initiative[],
): { initiative: string; by: "tag" | "marker" } | undefined {
	if (rec.initiative && initiatives.some((i) => i.id === rec.initiative))
		return { initiative: rec.initiative, by: "tag" };
	// The record's own ref counts too: an order's id is a marker for the order itself.
	const text = `${rec.ref ?? ""}\n${rec.source === "plan" ? planText(rec) : recordText(rec)}`;
	let best: { id: string; hits: number } | undefined;
	for (const ini of initiatives) {
		const hits = ini.markers.filter((m) => markerHits(m, rec, text)).length;
		if (hits > 0 && (!best || hits > best.hits)) best = { id: ini.id, hits };
	}
	return best ? { initiative: best.id, by: "marker" } : undefined;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class DecisionStore {
	readonly dir: string;
	private doc: DecisionsDoc | undefined;
	/** fileRecord's initiative per record id, for one initiatives list (a record never changes; the list can). */
	private filed = { key: "", by: new Map<string, string | null>() };

	constructor(
		dir: string,
		private readonly opts: { now?: () => number } = {},
	) {
		this.dir = dir;
	}

	now(): number {
		return this.opts.now ? this.opts.now() : Date.now();
	}

	private file(name: string): string {
		return join(this.dir, name);
	}

	// decisions ---------------------------------------------------------------

	load(): DecisionsDoc {
		if (this.doc) return this.doc;
		const raw = readJson<DecisionsDoc>(this.file(DECISIONS_FILE));
		this.doc =
			raw && Array.isArray(raw.decisions)
				? { v: 1, next: Number(raw.next) || raw.decisions.length + 1, decisions: raw.decisions }
				: { v: 1, next: 1, decisions: [] };
		return this.doc;
	}

	save(): void {
		if (!this.doc) return;
		mkdirSync(this.dir, { recursive: true });
		writeJson(this.file(DECISIONS_FILE), this.doc);
	}

	/** Re-read from disk on the next load (another writer changed it). */
	forget(): void {
		this.doc = undefined;
	}

	decisions(): DecisionEntry[] {
		return this.load().decisions;
	}

	get(id: string): DecisionEntry | undefined {
		const key = id.trim().toLowerCase();
		return this.load().decisions.find((d) => d.id === key);
	}

	/** The decision a change id belongs to. */
	findChange(id: string): { decision: DecisionEntry; change: DecisionChange } | undefined {
		const key = id.trim().toLowerCase();
		for (const d of this.load().decisions) {
			const c = d.changes.find((x) => x.id === key);
			if (c) return { decision: d, change: c };
		}
		return undefined;
	}

	addDecision(e: Omit<DecisionEntry, "id" | "changes"> & { changes?: DecisionChange[] }): DecisionEntry {
		const doc = this.load();
		const entry: DecisionEntry = { ...e, id: `d${doc.next++}`, changes: e.changes ?? [] };
		doc.decisions.push(entry);
		return entry;
	}

	addChange(decision: DecisionEntry, c: Omit<DecisionChange, "id">): DecisionChange {
		const doc = this.load();
		const change: DecisionChange = { ...c, id: `c${doc.next++}` };
		decision.changes.push(change);
		decision.changes.sort((a, b) => a.at - b.at);
		return change;
	}

	// initiatives -------------------------------------------------------------

	initiatives(): Initiative[] {
		const raw = readJson<{ initiatives?: Initiative[] } | Initiative[]>(this.file(INITIATIVES_FILE));
		const list = Array.isArray(raw) ? raw : raw?.initiatives;
		if (Array.isArray(list)) {
			return list
				.filter((i) => i && typeof i.id === "string")
				.map((i) => ({
					id: i.id,
					name: typeof i.name === "string" && i.name ? i.name : i.id,
					markers: Array.isArray(i.markers) ? i.markers.filter((m) => typeof m === "string") : [],
					lead: typeof i.lead === "string" && i.lead ? i.lead : null,
					...(typeof i.about === "string" && i.about.trim() ? { about: i.about.trim() } : {}),
					...(i.addedBy ? { addedBy: i.addedBy } : {}),
				}));
		}
		const seeded = [TEAM_IN_TEMPER];
		this.saveInitiatives(seeded);
		return seeded;
	}

	saveInitiatives(list: Initiative[]): void {
		mkdirSync(this.dir, { recursive: true });
		writeJson(this.file(INITIATIVES_FILE), { initiatives: list });
	}

	/** The records filed (by tag, then markers: fileRecord) to one of these initiative ids, in their order. */
	inInitiatives(recs: DecisionRecord[], ids: string[], initiatives?: Initiative[]): DecisionRecord[] {
		if (!ids.length || !recs.length) return [];
		const list = initiatives ?? this.initiatives();
		const key = JSON.stringify(list);
		if (key !== this.filed.key) this.filed = { key, by: new Map() };
		const want = new Set(ids);
		return recs.filter((r) => {
			let to = this.filed.by.get(r.id);
			if (to === undefined) {
				to = fileRecord(r, list)?.initiative ?? null;
				this.filed.by.set(r.id, to);
			}
			return to !== null && want.has(to);
		});
	}

	// settings and state --------------------------------------------------------

	settings(): ReaderSettings {
		return parseSettings(readJson(this.file(SETTINGS_FILE)));
	}

	readerState(): ReaderState {
		const raw = readJson<ReaderState>(this.file(READER_STATE_FILE));
		return {
			v: 1,
			read: raw?.read && typeof raw.read === "object" ? raw.read : {},
			tokens: raw?.tokens && typeof raw.tokens === "object" ? raw.tokens : {},
			...(raw?.capHit ? { capHit: raw.capHit } : {}),
			...(raw?.lastRun ? { lastRun: raw.lastRun } : {}),
			...(raw?.lastModel ? { lastModel: raw.lastModel } : {}),
			...(raw?.lastError ? { lastError: raw.lastError } : {}),
			...(raw?.tries ? { tries: raw.tries } : {}),
			...(raw?.copies && typeof raw.copies === "object" ? { copies: raw.copies } : {}),
			...(raw?.resting && typeof raw.resting === "object" ? { resting: raw.resting } : {}),
		};
	}

	saveReaderState(s: ReaderState): void {
		mkdirSync(this.dir, { recursive: true });
		writeJson(this.file(READER_STATE_FILE), s);
	}

	tokensToday(s: ReaderState): number {
		const t = s.tokens[localDay(this.now())];
		return t ? t.input + t.output : 0;
	}
}

export function existsDecisions(dir: string): boolean {
	return existsSync(join(dir, DECISIONS_FILE));
}
