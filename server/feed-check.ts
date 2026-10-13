/**
 * The second-hand check on a lead's progress update (task #85; Data rm-3bbf8e94, rm-981cbe12).
 *
 * An update may say only what its linked records hold. Every sentence is checked in two layers:
 *  - code first (AGENTS.md rule 17): owner credit against the owner's own records (#84's who rules), and
 *    every number, sum of money, duration, date and time against the linked records' words and times;
 *  - then the reader (the cheapest Claude model), only for what code can't see: an impact, a cost, an option
 *    or a date said in other words. It must quote the linked words that hold each claim; code checks every
 *    quote word for word, and a claim without one is flagged.
 * A flag is never hidden or softened here or on the page: only a newer update from the lead clears it.
 *
 * Runs alone too (scripts/feed-check.mts): one update plus its linked records -> each sentence's flags
 * and why.
 */

import type { DecisionRecord, UpdateFields } from "./decision-records.js";
import type { DecisionChange, DecisionEntry, DecisionSourceRef } from "./decision-store.js";
import type { DecisionModel } from "./decision-model.js";
import {
	answerFields,
	contentWords,
	normText,
	planText,
	quoteIn,
	recordText,
	snapQuote,
	whoOf,
} from "./decision-who.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UpdateFieldName = "changed" | "next" | "needsYou" | "impact" | "options" | "until";
export const UPDATE_FIELD_NAMES: readonly UpdateFieldName[] = [
	"changed",
	"next",
	"needsYou",
	"impact",
	"options",
	"until",
];

/** owner: says or implies the owner decided. number: a count its records don't hold. */
export type ClaimKind = "owner" | "impact" | "cost" | "option" | "date" | "number";

export interface CheckFlag {
	kind: ClaimKind;
	by: "code" | "reader";
	/** The words flagged. */
	claim: string;
	/** Why, in plain words. */
	why: string;
}

export interface CheckedSentence {
	n: number;
	field: UpdateFieldName;
	text: string;
	flags: CheckFlag[];
}

export interface UpdateCheck {
	at: number;
	sentences: CheckedSentence[];
	/**
	 * The reader's part: which model read it, or why it couldn't (then only code's flags stand). claims: what it
	 * answered, by sentence number, so a check can be replayed without the model (scripts/feed-check.mts --claims).
	 */
	reader?: { at: number; model?: string; error?: string; skipped?: string; claims?: Record<string, ReaderClaim[]> };
}

/** The owner's own words one linked item holds (an owner record behind it), and the words around them. */
export interface OwnerBacking {
	/** Where: the record or entry id. */
	id: string;
	own: string;
	ctx: string;
}

/** One linked thing an update may draw on. */
export interface MaterialItem {
	id: string;
	kind: "record" | "decision" | "change";
	/** Everything it says (a record's text; an entry's title, what and filled-in fields). */
	text: string;
	/** When it happened (a record's time; an entry's time and its sources'). */
	ats: number[];
	owner: OwnerBacking[];
	/** A record reached through a linked decision or change: which one. */
	via?: string;
}

/** The entries (decisions and changes) that cite a record, for its owner backing. */
export interface EntryOnRecord {
	src: DecisionSourceRef;
	title: string;
	what: string;
}

export interface MaterialLookup {
	record(id: string): DecisionRecord | undefined;
	decision(id: string): DecisionEntry | undefined;
	change(id: string): { decision: DecisionEntry; change: DecisionChange } | undefined;
	/** Every entry source citing this record (all initiatives' entries; empty when none was read). */
	entriesOn(recordId: string): EntryOnRecord[];
}

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

const NOT_GIVEN =
	/^\W*(?:not given|not known|unknown|none|nothing|nothing new|nothing yet|n\/a|no|not yet known|not stated)\W*$/i;
const ABBREV = /\b(?:jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|e\.g|i\.e|vs|approx|no|mr|ms|dr|st|etc|incl)\.$/i;

/** A field's sentences: one per line or list item, split at sentence ends and semicolons. */
export function splitSentences(text: string): string[] {
	const out: string[] = [];
	for (const raw of String(text ?? "").split(/\r?\n/)) {
		const line = raw.replace(/^\s*(?:[-*+\u2022]|\d+[.)])\s+/, "").trim();
		if (!line) continue;
		let start = 0;
		const re = /([.!?])\s+(?=[A-Z0-9"'([])|;\s+/g;
		for (let m = re.exec(line); m; m = re.exec(line)) {
			const end = m.index + (m[1] ? 1 : 0);
			const piece = line.slice(start, end).trim();
			if (m[1] === "." && ABBREV.test(line.slice(0, end))) continue;
			if (piece) out.push(piece);
			start = m.index + m[0].length;
		}
		const rest = line.slice(start).trim();
		if (rest) out.push(rest);
	}
	return out;
}

export function updateSentences(update: UpdateFields): { n: number; field: UpdateFieldName; text: string }[] {
	const out: { n: number; field: UpdateFieldName; text: string }[] = [];
	for (const field of UPDATE_FIELD_NAMES) {
		const value = (update as unknown as Record<string, unknown>)[field];
		if (typeof value !== "string" || !value.trim()) continue;
		for (const text of splitSentences(value)) out.push({ n: out.length + 1, field, text });
	}
	return out;
}

/** Words that may sit around "not known" without saying anything ("not known for d308 and d2972 as recorded"). */
const NOT_GIVEN_FILLER = new Set(
	(
		"for and or the a an of in on as here feed linked record records recorded decision decisions entry entries its their " +
		"impact impacts option options until date dates cost costs field fields have has had is are was were any yet all each " +
		"these those them it this that none not no known given shown stated unknown recorded listed filled n a so far"
	).split(" "),
);
const NOT_GIVEN_PHRASE =
	/\b(?:not (?:yet )?(?:given|known|stated|shown|recorded|listed|filled)|unknown|none recorded|n\/a)\b/i;

/** "not given", "not known", alone or with only decision ids and filler words around it. */
export const isNotGiven = (s: string): boolean => {
	const t = s.trim();
	if (NOT_GIVEN.test(t)) return true;
	if (!NOT_GIVEN_PHRASE.test(t)) return false;
	const rest = t
		.toLowerCase()
		.replace(/\b(?:d|c)\d+\b|\bdr-[0-9a-f]{4,}\b|#\d+/g, " ")
		.replace(/n\/a/g, " ")
		.split(/[^a-z]+/)
		.filter(Boolean);
	return rest.every((w) => NOT_GIVEN_FILLER.has(w));
};

// ---------------------------------------------------------------------------
// Material: what the linked records hold
// ---------------------------------------------------------------------------

function ownFieldsOf(rec: DecisionRecord): { own: string; ctx: string } | undefined {
	if (rec.source === "answer") {
		const fields = answerFields(rec);
		const own = fields.filter((f) => f.owner).map((f) => f.text);
		if (!own.length) return undefined;
		const ctx = fields.filter((f) => f.place === "question").map((f) => f.text);
		return { own: own.join("\n"), ctx: ctx.join("\n") };
	}
	if (rec.source === "board" && rec.kind === "order" && rec.ownerWords?.trim()) {
		// The relayer's own text is not his (E60): only his words back a credit.
		return { own: rec.ownerWords, ctx: "" };
	}
	if (rec.source === "plan" && rec.approval === "dialog") return { own: planText(rec), ctx: "" };
	return undefined;
}

/**
 * The owner's words a record holds. Where entries cite it, only the points #84's who rules give to him
 * (riders and relayed claims are not his), each with its entry's title and what as context; otherwise his
 * raw fields: a picked option or typed answer, an order's own words, a plan he approved in a dialog.
 */
export function ownerBackingOfRecord(rec: DecisionRecord, entries: readonly EntryOnRecord[]): OwnerBacking[] {
	if (entries.length) {
		const out: OwnerBacking[] = [];
		for (const e of entries) {
			const who = whoOf(rec, {
				quotes: e.src.quotes,
				claimsOwner: e.src.claimsOwner,
				part: e.src.part,
				by: e.src.by,
			});
			if (who.you) out.push({ id: rec.id, own: e.src.quotes.join("\n"), ctx: `${e.title}\n${e.what}` });
		}
		// An answer's picked or typed words and an order's own words are his whatever entries cite them (stage
		// test, poke run 1: his typed question). A plan's text stays entries-only: it carries riders.
		if (rec.source === "answer" || (rec.source === "board" && rec.kind === "order")) {
			const raw = ownFieldsOf(rec);
			if (raw) out.push({ id: rec.id, ...raw });
		}
		return out;
	}
	const raw = ownFieldsOf(rec);
	return raw ? [{ id: rec.id, ...raw }] : [];
}

function entryText(d: DecisionEntry): string {
	const parts = [d.title, d.what, d.impact?.text, d.options?.text, d.until?.text];
	for (const c of d.changes ?? []) parts.push(c.what, c.until?.text, c.impact?.text);
	return parts.filter(Boolean).join("\n");
}

function changeText(d: DecisionEntry, c: DecisionChange): string {
	return [c.what, c.until?.text, c.impact?.text, d.title].filter(Boolean).join("\n");
}

function entryBacking(
	id: string,
	sources: readonly DecisionSourceRef[],
	ctx: string,
	look: MaterialLookup,
): OwnerBacking[] {
	const out: OwnerBacking[] = [];
	for (const s of sources) {
		const rec = s.record ? look.record(s.record) : undefined;
		if (!rec) continue;
		const who = whoOf(rec, { quotes: s.quotes, claimsOwner: s.claimsOwner, part: s.part, by: s.by });
		if (who.you) out.push({ id, own: s.quotes.join("\n"), ctx });
	}
	return out;
}

/** Lookups for buildMaterial over a list of records and a list of decisions (the feed and the stand-alone script). */
export function materialLookup(
	records: readonly DecisionRecord[],
	decisions: readonly DecisionEntry[],
): MaterialLookup {
	const byId = new Map(records.map((r) => [r.id, r] as const));
	const decisionById = new Map<string, DecisionEntry>();
	const changeById = new Map<string, { decision: DecisionEntry; change: DecisionChange }>();
	const on = new Map<string, EntryOnRecord[]>();
	const push = (id: string, e: EntryOnRecord): void => {
		const list = on.get(id);
		if (list) list.push(e);
		else on.set(id, [e]);
	};
	for (const d of decisions) {
		decisionById.set(d.id, d);
		for (const s of d.sources) if (s.record) push(s.record, { src: s, title: d.title, what: d.what });
		for (const ch of d.changes) {
			changeById.set(ch.id, { decision: d, change: ch });
			for (const s of ch.sources) if (s.record) push(s.record, { src: s, title: d.title, what: ch.what });
		}
	}
	return {
		record: (id) => byId.get(id),
		decision: (id) => decisionById.get(id.trim().toLowerCase()),
		change: (id) => changeById.get(id.trim().toLowerCase()),
		entriesOn: (id) => on.get(id) ?? [],
	};
}

/** What an update's sources hold: each linked record, decision and change, and the records those cite. */
export function buildMaterial(sourceIds: readonly string[], look: MaterialLookup): MaterialItem[] {
	const out: MaterialItem[] = [];
	const seen = new Set<string>();
	const addRecord = (id: string, via?: string): void => {
		if (seen.has(id)) return;
		const rec = look.record(id);
		if (!rec) return;
		seen.add(id);
		out.push({
			id,
			kind: "record",
			text: recordText(rec),
			ats: [rec.at],
			owner: ownerBackingOfRecord(rec, look.entriesOn(id)),
			...(via ? { via } : {}),
		});
	};
	for (const raw of sourceIds) {
		const id = raw.trim().toLowerCase();
		if (id.startsWith("dr-")) {
			addRecord(id);
			continue;
		}
		if (/^d\d+$/.test(id)) {
			const d = look.decision(id);
			if (!d || seen.has(id)) continue;
			seen.add(id);
			const ctx = `${d.title}\n${d.what}`;
			out.push({
				id,
				kind: "decision",
				text: entryText(d),
				ats: [d.at, ...d.sources.map((s) => s.at)],
				owner: entryBacking(id, d.sources, ctx, look),
			});
			for (const s of d.sources) if (s.record) addRecord(s.record, id);
			continue;
		}
		if (/^c\d+$/.test(id)) {
			const hit = look.change(id);
			if (!hit || seen.has(id)) continue;
			seen.add(id);
			const { decision: d, change: c } = hit;
			out.push({
				id,
				kind: "change",
				text: changeText(d, c),
				ats: [c.at, ...c.sources.map((s) => s.at)],
				owner: entryBacking(id, c.sources, `${c.what}\n${d.title}`, look),
			});
			for (const s of c.sources) if (s.record) addRecord(s.record, id);
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// Owner credit (code)
// ---------------------------------------------------------------------------

const ADVERBS =
	"already|then|also|have|had|has|just|finally|explicitly|personally|yourself|both|earlier|again|did|first|once|clearly|instead|later|now|since|today|yesterday|specifically|directly|himself|herself";
const PAST =
	"decided|chose|picked|approved|asked(?:\\s+for)?|requested|ordered|wanted|agreed(?:\\s+to)?|signed\\s+off|went\\s+with|settled\\s+on|confirmed|accepted|rejected|turned\\s+down|declined|named|said|told|set|gave|okayed|ok'd|authori[sz]ed|preferred|opted(?:\\s+for)?|selected|answered|replied|kept|dropped|vetoed|cleared|allowed|directed|instructed|made\\s+the\\s+call|called\\s+it";
const NOUN =
	"call|pick|choice|decision|order|request|approval|answer|go-ahead|sign-off|instruction|ask|direction|say-so|preference|words?";

const CREDIT: RegExp[] = [
	// "you decided", "you already chose", "the owner picked", "you've approved"
	new RegExp(`\\b(?:you|the owner|owner)(?:\\s+(?:${ADVERBS}))*\\s+(?:${PAST})\\b`, "gi"),
	// "chosen by you", "approved by the owner"
	new RegExp(
		`\\b(?:decided|chosen|picked|approved|requested|ordered|set|named|signed\\s+off|confirmed|accepted|rejected|selected|authori[sz]ed|okayed|cleared|allowed|directed|instructed|asked\\s+for|wanted)\\s+by\\s+(?:you|the owner|owner)\\b`,
		"gi",
	),
	// "per your request", "at the owner's order", "following your answer"
	new RegExp(
		`\\b(?:per|at|on|by|following|after|under|with|from|as|given|since|because\\s+of|thanks\\s+to|in\\s+line\\s+with|according\\s+to)\\s+(?:your|the owner's|owner's)\\s+(?:own\\s+)?(?:${NOUN})\\b`,
		"gi",
	),
	// "your choice kept ...", "the owner's order covers ..." (not "your answer is needed")
	new RegExp(
		`\\b(?:your|the owner's)\\s+(?:own\\s+)?(?:${NOUN})\\s+(?:was|is(?!\\s+(?:needed|pending|required|wanted|missing|due|outstanding|awaited|still|open|not))|stands|kept|keeps|set|sets|made|makes|means|meant|covers|covered|put|puts|left|ended|named|picked|chose|holds|held|applies|applied|stays|stayed|says|said)\\b`,
		"gi",
	),
	/\b(?:owner-decided|decided by the owner|already decided by you|your own words)\b/gi,
];

/** Words that only say who decided, not what: left out when comparing a credit with his words. */
const CREDIT_WORDS = new Set(
	`you your yours owner owner's decide decided decision chose chosen choice pick picked approve approved approval ask asked request requested order ordered want wanted agree agreed sign signed off went settled confirm confirmed accept accepted reject rejected turned declined named said told set gave okayed authorized authorised prefer preferred opted select selected answer answered replied kept dropped vetoed cleared allowed directed instructed call per following own already explicitly personally yourself instead made call go-ahead sign-off instruction direction say-so preference word words`
		.split(/\s+/)
		.flatMap((w) => [...wordsOf(w)]),
);

/** A possessive credit after these words waits for him rather than says he decided ("waits on your answer"). */
const NOT_YET =
	/(?:\bwait(?:s|ing)?|\bdepend(?:s|ing)?|\bhinges?|\brests?|\bneed(?:s|ed)?|\bfor|\bawait(?:s|ing)?|\bpending|\buntil|\bbefore|\bwithout|\bask(?:s|ing)?(?:\s+you)?|\bif|\bonce|\bwhether|\bwhen)\s*$/i;

const CONTRAST = /;|,\s*(?:but|while|whereas|although|though|so that|and then)\b|\s+but\s+|\s+while\s+|\s+whereas\s+/gi;

function stem(w: string): string {
	if (w.length > 5 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
	if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
	if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
	if (w.length > 4 && w.endsWith("es") && !w.endsWith("ses")) return w.slice(0, -1);
	if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
	return w;
}

/** Content words, stemmed; a hyphenated word also gives its parts (when `parts`). */
export function wordsOf(text: string, parts = false): Set<string> {
	const out = new Set<string>();
	for (const w of contentWords(text)) {
		out.add(stem(w));
		if (parts && w.includes("-")) for (const p of w.split("-")) if (p.length > 2) out.add(stem(p));
	}
	return out;
}

/** The clause of a sentence a credit covers: the sentence cut at contrasts (";", ", but", " while"). */
function creditedClause(sentence: string, at: number): string {
	let start = 0;
	let end = sentence.length;
	CONTRAST.lastIndex = 0;
	for (let m = CONTRAST.exec(sentence); m; m = CONTRAST.exec(sentence)) {
		if (m.index + m[0].length <= at) start = m.index + m[0].length;
		else if (m.index > at) {
			end = m.index;
			break;
		}
	}
	return sentence.slice(start, end);
}

export interface CreditHit {
	/** The credit's own words ("you decided"). */
	phrase: string;
	/** What it credits him with: the clause's content words, without the credit's words. */
	words: string[];
}

/** Where a sentence says or implies the owner decided. */
export function creditsOf(sentence: string): CreditHit[] {
	const t = String(sentence ?? "")
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/\byou've\b/gi, "you have")
		.replace(/\byou'd\b/gi, "you had");
	const hits: CreditHit[] = [];
	const seen = new Set<string>();
	for (const re of CREDIT) {
		re.lastIndex = 0;
		for (let m = re.exec(t); m; m = re.exec(t)) {
			if (NOT_YET.test(t.slice(Math.max(0, m.index - 24), m.index))) continue;
			const clause = creditedClause(t, m.index);
			const key = `${clause}`;
			if (seen.has(key)) continue;
			seen.add(key);
			const words = [...wordsOf(clause)].filter((w) => !CREDIT_WORDS.has(w));
			hits.push({ phrase: m[0], words });
		}
	}
	return hits;
}

/** At least one credited word in his own words, and half of them in his words or what he answered. */
export const CREDIT_SHARE = 0.5;

export function creditBacked(hit: CreditHit, backing: readonly OwnerBacking[]): OwnerBacking | undefined {
	if (!backing.length) return undefined;
	if (!hit.words.length) return backing[0];
	for (const b of backing) {
		const own = wordsOf(b.own, true);
		const all = new Set([...own, ...wordsOf(b.ctx, true)]);
		const inOwn = hit.words.filter((w) => own.has(w)).length;
		const inAll = hit.words.filter((w) => all.has(w)).length;
		if (inOwn >= 1 && inAll / hit.words.length >= CREDIT_SHARE) return b;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Numbers, money, durations, dates and times (code)
// ---------------------------------------------------------------------------

export interface NumClaim {
	kind: "cost" | "date" | "impact" | "number";
	raw: string;
	/** d:MM-DD, w:<weekday 0-6>, t:<minute of day>, dur:<minutes>, $:<value>, tok:<value>, p:<value>, n:<value> */
	key: string;
	/** Times said as approximate ("about 13:45"). */
	approx?: boolean;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE =
	"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const ID_LEAD =
	/\b(?:rule|rules|task|tasks|step|steps|part|parts|phase|round|rounds|stage|stages|section|item|option|line|lines|chunk|page|version|issue|pr|adr|level|tier|run|runs|event|events|batch|lane|lanes|#|no\.|number|order|request|question|patch|commit|ticket|card|row|column|account|model|sonnet|opus|haiku|gpt|claude|node|pi|anthropic)\s*$/i;

const monthOf = (s: string): number => MONTHS.indexOf(s.slice(0, 3).toLowerCase()) + 1;
const pad = (n: number): string => String(n).padStart(2, "0");
const dayKey = (m: number, d: number): string => `d:${pad(m)}-${pad(d)}`;

function numValue(s: string, suffix?: string): number {
	let v = Number(s.replace(/,/g, ""));
	const k = (suffix ?? "").toLowerCase();
	if (k === "k" || k === "thousand") v *= 1e3;
	else if (k === "m" || k === "million") v *= 1e6;
	else if (k === "b" || k === "billion") v *= 1e9;
	return Math.round(v * 1000) / 1000;
}

const DUR_MIN: Record<string, number> = {
	min: 1,
	minute: 1,
	h: 60,
	hr: 60,
	hour: 60,
	day: 1440,
	week: 10080,
	month: 43200,
};
function durUnit(u: string): number {
	const k = u.toLowerCase().replace(/s$/, "");
	if (k === "mins" || k === "min" || k === "minute") return 1;
	if (k === "hrs" || k === "hr") return 60;
	if (k === "wk") return 10080;
	return DUR_MIN[k] ?? 0;
}

/** Ids, versions, hashes and references that hold digits but say no number: blanked before reading numbers. */
function maskIds(text: string): string {
	return (
		String(text ?? "")
			.replace(/\b(?:rm|bp|dr|up|ask|dlg|toolu)[-_][0-9a-z_]{4,}\b/gi, " ")
			.replace(/#\d+\b/g, " ")
			.replace(/\bv?\d+\.\d+\.\d+(?:[-.\w]*)?\b/g, " ")
			.replace(/\b[0-9a-f]{7,40}\b/g, (m) => (/[a-f]/.test(m) && /\d/.test(m) ? " " : m))
			// letters and digits in one token (d123, M4, SW-87, ADR-M4-18, anthropic-3, E60, 2026-10-09T..Z), but not a
			// number with its unit (3h, 2k, 10am, 40%)
			.replace(/\b[\w]+(?:[-.:/][\w]+)*\b/g, (tok) => {
				if (!/\d/.test(tok) || !/[a-z]/i.test(tok)) return tok;
				if (/^\d[\d,]*(?:\.\d+)?(?:k|m|b|h|hrs?|mins?|am|pm|st|nd|rd|th|x|mb|gb|kb|ms|s|d|w|wk|wks)$/i.test(tok))
					return tok;
				if (/^\d{1,2}(?::\d{2})?(?:am|pm)$/i.test(tok)) return tok;
				if (/^\d+(?:\.\d+)?-(?:minute|min|hour|hr|day|week|month)s?$/i.test(tok)) return tok;
				if (/^20\d{2}-\d{2}-\d{2}t/i.test(tok)) return tok.slice(0, 10);
				return " ";
			})
	);
}

/** Every number, sum, duration, date and time a text says, with what kind of claim it makes. */
export function numClaims(text: string): NumClaim[] {
	let t = maskIds(text);
	const out: NumClaim[] = [];
	const take = (re: RegExp, f: (m: RegExpExecArray) => NumClaim[] | NumClaim | undefined): void => {
		t = t.replace(re, (...args) => {
			const offset = args[args.length - 2] as number;
			const m = Object.assign(args.slice(0, -2), { index: offset }) as unknown as RegExpExecArray;
			const prefix = t.slice(0, offset);
			if (ID_LEAD.test(prefix) && /^\s*\d/.test(m[0])) return m[0].replace(/\d/g, " ");
			const got = f(m);
			if (got) out.push(...(Array.isArray(got) ? got : [got]));
			return " ".repeat(m[0].length);
		});
	};
	// Dates: 2026-10-09; Oct 3-9; Oct 9; 9 Oct; 10-09 and 10/09 (two-digit month).
	take(/\b20\d{2}-(\d{1,2})-(\d{1,2})\b/g, (m) => ({
		kind: "date",
		raw: m[0],
		key: dayKey(Number(m[1]), Number(m[2])),
	}));
	take(
		new RegExp(
			`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:-|\\u2013|to|through)\\s*(\\d{1,2})(?:st|nd|rd|th)?\\b`,
			"gi",
		),
		(m) => [
			{ kind: "date", raw: `${m[1]} ${m[2]}`, key: dayKey(monthOf(m[1]), Number(m[2])) },
			{ kind: "date", raw: `${m[1]} ${m[3]}`, key: dayKey(monthOf(m[1]), Number(m[3])) },
		],
	);
	take(new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?!:\\d)`, "gi"), (m) => ({
		kind: "date",
		raw: m[0],
		key: dayKey(monthOf(m[1]), Number(m[2])),
	}));
	take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\b`, "gi"), (m) => ({
		kind: "date",
		raw: m[0],
		key: dayKey(monthOf(m[2]), Number(m[1])),
	}));
	take(/\b(0[1-9]|1[0-2])[-/](0[1-9]|[12]\d|3[01])\b(?![-/]\d)/g, (m) => ({
		kind: "date",
		raw: m[0],
		key: dayKey(Number(m[1]), Number(m[2])),
	}));
	// Weekdays, written out (and "Mon".."Sun" capitalised).
	take(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)s?\b/gi, (m) => ({
		kind: "date",
		raw: m[0],
		key: `w:${WEEKDAYS.indexOf(m[1].toLowerCase())}`,
	}));
	take(/\b(Sun|Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat)\b\.?/g, (m) => ({
		kind: "date",
		raw: m[0],
		key: `w:${["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(m[1].slice(0, 3).toLowerCase())}`,
	}));
	// Times: 13:45, 1:45 pm, 9 am (with "about", "~": approximate).
	const approxBefore = (m: RegExpExecArray): boolean =>
		/(?:~|\babout|\baround|\bapprox(?:imately)?|\broughly|\bc\.)\s*$/i.test(t.slice(0, m.index));
	take(/\b([01]?\d|2[0-3]):([0-5]\d)(?:\s*(am|pm)\b)?/gi, (m) => {
		let h = Number(m[1]);
		const ap = (m[3] ?? "").toLowerCase();
		if (ap === "pm" && h < 12) h += 12;
		if (ap === "am" && h === 12) h = 0;
		return { kind: "date", raw: m[0], key: `t:${h * 60 + Number(m[2])}`, approx: approxBefore(m) };
	});
	take(/\b(1[0-2]|0?[1-9])\s*(am|pm)\b/gi, (m) => {
		let h = Number(m[1]) % 12;
		if (m[2].toLowerCase() === "pm") h += 12;
		return { kind: "date", raw: m[0], key: `t:${h * 60}`, approx: approxBefore(m) };
	});
	// Money and tokens.
	take(/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k|m|b|thousand|million|billion)?\b/gi, (m) => ({
		kind: "cost",
		raw: m[0].trim(),
		key: `$:${numValue(m[1], m[2])}`,
	}));
	take(/\b(\d[\d,]*(?:\.\d+)?)\s*(k|m|b|thousand|million|billion)?\s*(?:dollars|usd)\b/gi, (m) => ({
		kind: "cost",
		raw: m[0].trim(),
		key: `$:${numValue(m[1], m[2])}`,
	}));
	take(/\b(\d[\d,]*(?:\.\d+)?)\s*(k|m|b|thousand|million|billion)?\s*(?:input\s+|output\s+)?tokens?\b/gi, (m) => ({
		kind: "cost",
		raw: m[0].trim(),
		key: `tok:${numValue(m[1], m[2])}`,
	}));
	// Durations.
	take(/\b(\d+(?:\.\d+)?)\s*-?\s*(minutes?|mins?|hours?|hrs?|h|days?|weeks?|wks?|months?)\b/gi, (m) => ({
		kind: "date",
		raw: m[0].trim(),
		key: `dur:${Math.round(Number(m[1]) * durUnit(m[2]))}`,
	}));
	// Percent.
	take(/\b(\d+(?:\.\d+)?)\s*(?:%|percent\b)/gi, (m) => ({
		kind: "impact",
		raw: m[0].trim(),
		key: `p:${Number(m[1])}`,
	}));
	// Years alone say nothing to check.
	take(/\b20\d{2}\b/g, () => undefined);
	// Any other number.
	take(/\b(\d[\d,]*(?:\.\d+)?)\s*(k|m|b)?\b/gi, (m) => ({
		kind: "number",
		raw: m[0].trim(),
		key: `n:${numValue(m[1], m[2])}`,
	}));
	return out;
}

const ZONES = ["UTC", "America/Los_Angeles", Intl.DateTimeFormat().resolvedOptions().timeZone];
const zoneFormat = new Map<string, Intl.DateTimeFormat>();
function partsIn(ms: number, zone: string): { m: number; d: number; w: number; min: number } {
	let f = zoneFormat.get(zone);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
			month: "numeric",
			day: "numeric",
			weekday: "short",
			hour: "numeric",
			minute: "numeric",
			hourCycle: "h23",
		});
		zoneFormat.set(zone, f);
	}
	const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
	const w = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(p.weekday));
	return { m: Number(p.month), d: Number(p.day), w, min: Number(p.hour) * 60 + Number(p.minute) };
}

export interface NumIndex {
	keys: Set<string>;
	/** Every number value the material says, whatever its kind. */
	bare: Set<number>;
	/** Minutes of day of the linked times. */
	minutes: number[];
}

export function numIndex(material: readonly MaterialItem[]): NumIndex {
	const keys = new Set<string>();
	const bare = new Set<number>();
	const minutes: number[] = [];
	for (const it of material) {
		for (const c of numClaims(it.text)) {
			keys.add(c.key);
			const v = Number(c.key.split(":")[1]);
			if (!c.key.startsWith("d:") && !c.key.startsWith("w:") && !c.key.startsWith("t:") && Number.isFinite(v))
				bare.add(v);
		}
		for (const at of it.ats) {
			if (!Number.isFinite(at)) continue;
			for (const z of ZONES) {
				const p = partsIn(at, z);
				keys.add(dayKey(p.m, p.d));
				keys.add(`w:${p.w}`);
				minutes.push(p.min);
			}
		}
	}
	return { keys, bare, minutes };
}

export function numHeld(c: NumClaim, idx: NumIndex): boolean {
	if (idx.keys.has(c.key)) return true;
	const [k, v] = [c.key.slice(0, c.key.indexOf(":")), Number(c.key.slice(c.key.indexOf(":") + 1))];
	if (k === "t") {
		const near = c.approx ? 10 : 2;
		return idx.minutes.some((m) => Math.abs(m - v) <= near);
	}
	// A sum of money or a token count is held only by the same kind (above): "$40" isn't held by "40 calls".
	// A plain number is held by the same value of any kind ("6" by "6 model calls" or "6 min").
	if (k === "n") return idx.bare.has(v);
	return false;
}

function numWhy(c: NumClaim): string {
	if (c.key.startsWith("d:") || c.key.startsWith("w:"))
		return `"${c.raw}" isn't in its linked records, and none of them is from that day.`;
	if (c.key.startsWith("t:")) return `"${c.raw}" isn't in its linked records, and none of them is from that time.`;
	if (c.key.startsWith("dur:")) return `"${c.raw}" isn't in its linked records.`;
	if (c.kind === "cost") return `The cost "${c.raw}" isn't in its linked records.`;
	if (c.key.startsWith("p:")) return `"${c.raw}" isn't in its linked records.`;
	return `The number "${c.raw}" isn't in its linked records.`;
}

// ---------------------------------------------------------------------------
// The code check
// ---------------------------------------------------------------------------

/** Code's part of the check: owner credit and every number, date and time. */
export function codeCheck(update: UpdateFields, material: readonly MaterialItem[]): CheckedSentence[] {
	const backing = material.flatMap((m) => m.owner);
	const idx = numIndex(material);
	return updateSentences(update).map((s) => {
		const flags: CheckFlag[] = [];
		if (!isNotGiven(s.text)) {
			for (const hit of creditsOf(s.text)) {
				if (creditBacked(hit, backing)) continue;
				flags.push({
					kind: "owner",
					by: "code",
					claim: hit.phrase,
					why: backing.length
						? "Says you decided, but your own words in its linked records don't say this."
						: "Says you decided, but none of its linked records holds your own words.",
				});
			}
			for (const c of numClaims(s.text)) {
				if (numHeld(c, idx)) continue;
				flags.push({ kind: c.kind, by: "code", claim: c.raw, why: numWhy(c) });
			}
		}
		return { ...s, flags };
	});
}

// ---------------------------------------------------------------------------
// The reader: claims code can't see
// ---------------------------------------------------------------------------

export const READER_SYSTEM = `You check one progress update against the sources it links. You only read; you never judge whether the work is good.

For each numbered sentence, list every claim it makes of these four kinds:
- impact: what something changes, or will change, for the owner, the work, users, time or risk;
- cost: money, tokens, time or effort something takes, or an account's allowance used;
- option: an alternative that was or could be taken, or what was picked over what;
- date: when something happens or happened, a deadline, until when something holds, or how long it lasts.
A sentence in the impact field is an impact claim; in the options field, an option or cost claim; in the until field, a date claim.
Do not list: who decided or approved; plain progress (what was done, landed, sent, read, asked or is next); ids; "not given" or "not known".

For each claim, quote the source words that state the same thing: copy them exactly, character for character, from one source, with that source's id. Give no evidence when no source states it. Do not infer: a claim that the sources only hint at, or that adds a number, a reason, an effect or an alternative they don't state, has no evidence.

Answer with JSON only, no prose:
{"sentences":[{"n":1,"claims":[{"kind":"impact","claim":"<the claim, a few words>","evidence":[{"id":"<source id>","quote":"<exact source words>"}]}]}]}
Every sentence appears once; "claims": [] when it makes none of these claims.`;

export const READER_ITEM_MAX = 4000;
export const READER_TOTAL_MAX = 60_000;

/**
 * The sources the reader sees, most relevant first, within READER_TOTAL_MAX characters: an update can link
 * hundreds of entries, and quotes only count from a source that shares words with the claim anyway. Items
 * sharing no word with any sentence are left out; the rest keep their linked order among equals.
 */
export function readerMaterial(
	sentences: readonly { text: string }[],
	material: readonly MaterialItem[],
): MaterialItem[] {
	const want = new Set<string>();
	for (const s of sentences) for (const w of wordsOf(s.text, true)) want.add(w);
	const scored = material.map((m, i) => {
		let hits = 0;
		for (const w of wordsOf(m.text.slice(0, READER_ITEM_MAX), true)) if (want.has(w)) hits++;
		return { m, i, hits };
	});
	const out: MaterialItem[] = [];
	let total = 0;
	for (const s of scored.filter((x) => x.hits > 0).sort((a, b) => b.hits - a.hits || a.i - b.i)) {
		const len = Math.min(s.m.text.length, READER_ITEM_MAX);
		if (total + len > READER_TOTAL_MAX) continue;
		total += len;
		out.push(s.m);
	}
	return out;
}

export function readerPrompt(
	sentences: readonly { n: number; field: UpdateFieldName; text: string }[],
	material: readonly MaterialItem[],
): string {
	const lines = ["Sentences:"];
	for (const s of sentences) lines.push(`${s.n}. [${s.field}] ${s.text}`);
	lines.push("", "Sources:");
	let total = 0;
	for (const m of readerMaterial(sentences, material)) {
		const date = m.ats.length && Number.isFinite(m.ats[0]) ? new Date(m.ats[0]).toISOString().slice(0, 10) : "";
		let text = m.text.replace(/\s+\n/g, "\n").trim();
		if (text.length > READER_ITEM_MAX) text = `${text.slice(0, READER_ITEM_MAX)} [...]`;
		if (total + text.length > READER_TOTAL_MAX) text = text.slice(0, Math.max(0, READER_TOTAL_MAX - total));
		total += text.length;
		lines.push(`<source id="${m.id}" kind="${m.kind}"${date ? ` date="${date}"` : ""}>`, text, "</source>");
	}
	return lines.join("\n");
}

export interface ReaderClaim {
	kind: "impact" | "cost" | "option" | "date";
	claim: string;
	evidence: { id: string; quote: string }[];
}

export function parseReader(text: string): Map<number, ReaderClaim[]> | undefined {
	const raw = String(text ?? "");
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	let doc: unknown;
	try {
		doc = JSON.parse(raw.slice(start, end + 1));
	} catch {
		return undefined;
	}
	const list = (doc as { sentences?: unknown }).sentences;
	if (!Array.isArray(list)) return undefined;
	const out = new Map<number, ReaderClaim[]>();
	for (const s of list) {
		const n = Number((s as { n?: unknown }).n);
		if (!Number.isInteger(n)) continue;
		const claims: ReaderClaim[] = [];
		for (const c of ((s as { claims?: unknown }).claims as unknown[]) ?? []) {
			const o = c as Record<string, unknown>;
			const kind = String(o.kind ?? "").toLowerCase();
			if (!["impact", "cost", "option", "date"].includes(kind)) continue;
			const evidence = Array.isArray(o.evidence)
				? (o.evidence as Record<string, unknown>[])
						.filter((e) => e && typeof e.id === "string" && typeof e.quote === "string")
						.map((e) => ({ id: String(e.id).trim().toLowerCase(), quote: String(e.quote) }))
				: [];
			claims.push({ kind: kind as ReaderClaim["kind"], claim: String(o.claim ?? "").slice(0, 300), evidence });
		}
		out.set(n, claims);
	}
	return out;
}

/** A quote holds a claim when it is in that source word for word (or nearly: snapQuote) and shares a word. */
/** Task numbers, record and entry ids, and numbers of 2+ digits in a text. */
function idsOf(text: string): Set<string> {
	return new Set(
		(text.toLowerCase().match(/#\d+|\b(?:dr|rm|bp|d|c)-?[0-9a-f]{3,}\b|\b\d{2,}\b/g) ?? []).map((m) =>
			m.replace(/^#/, ""),
		),
	);
}

/** Words that say when (singular forms): a date claim's must all be in its quote. */
const TIME_WORDS = new Set(
	(
		"today tonight tomorrow yesterday morning afternoon evening night midnight noon weekend weekday week month year quarter day hour minute " +
		"monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december " +
		"jan feb mar apr jun jul aug sep sept oct nov dec next last soon later"
	).split(" "),
);

/** The time words of a text, singular ("weekends" -> "weekend"). */
export function timeWordsOf(text: string): Set<string> {
	const out = new Set<string>();
	for (const raw of normText(text).split(/[^a-z]+/)) {
		if (!raw) continue;
		const w = TIME_WORDS.has(raw) ? raw : raw.endsWith("s") && TIME_WORDS.has(raw.slice(0, -1)) ? raw.slice(0, -1) : "";
		if (w) out.add(w);
	}
	return out;
}

export function evidenceHolds(claim: ReaderClaim, sentence: string, material: readonly MaterialItem[]): boolean {
	const byId = new Map(material.map((m) => [m.id, m]));
	const words = wordsOf(`${claim.claim} ${sentence}`, true);
	// A quote about the same thing at another time doesn't hold a date: "starts within minutes" doesn't hold
	// "before the weekend". Every time word of the claim must be in the quote.
	const when = claim.kind === "date" ? timeWordsOf(claim.claim) : new Set<string>();
	for (const e of claim.evidence) {
		const item = byId.get(e.id);
		if (!item) continue;
		const q = e.quote.trim();
		if (normText(q).split(/\s+/).filter(Boolean).length < 2) continue;
		if (!quoteIn(q, item.text) && !snapQuote(q, [item.text])) continue;
		if (when.size) {
			const qt = timeWordsOf(q);
			if (![...when].every((w) => qt.has(w))) continue;
		}
		const qw = wordsOf(q, true);
		if ([...qw].some((w) => words.has(w))) return true;
		// Ids and numbers count as shared words too: "#55 has no 'after'" is about "#55's 'after' condition".
		const qi = idsOf(q);
		if ([...idsOf(`${claim.claim} ${sentence}`)].some((w) => qi.has(w))) return true;
	}
	return false;
}

const FIELD_KIND: Partial<Record<UpdateFieldName, ReaderClaim["kind"]>> = {
	impact: "impact",
	options: "option",
	until: "date",
};

/** Words that make a sentence an option or a cost claim wherever it sits (stage test, run 4: the reader listed none). */
const CUES: [ReaderClaim["kind"], RegExp][] = [
	[
		"option",
		/\b(instead of|could have|could instead|alternatives?|other options?|other choices?|another option|the options? (?:was|were))\b/i,
	],
	["cost", /\b(costs?|costing|spends?|spending|spent|cheaper|pricier|more expensive|less expensive)\b/i],
];

/** The claim kinds a sentence's own words make, found by code. */
export function cueKinds(text: string): ReaderClaim["kind"][] {
	return CUES.filter(([, re]) => re.test(text)).map(([k]) => k);
}

/** The reader's flags for one sentence: each claim with no quote that holds it. */
export function readerFlags(
	s: { field: UpdateFieldName; text: string },
	claims: readonly ReaderClaim[] | undefined,
	material: readonly MaterialItem[],
): CheckFlag[] {
	if (isNotGiven(s.text)) return [];
	const list = [...(claims ?? [])];
	const kind = FIELD_KIND[s.field];
	// A sentence in the impact, options or until field is a claim of that kind, listed or not.
	if (kind && !list.length) list.push({ kind, claim: s.text.slice(0, 200), evidence: [] });
	// So is a sentence whose words make an option or a cost claim, when the reader listed none of that kind.
	for (const k of cueKinds(s.text))
		if (!list.some((c) => c.kind === k)) list.push({ kind: k, claim: s.text.slice(0, 200), evidence: [] });
	const out: CheckFlag[] = [];
	for (const c of list) {
		if (evidenceHolds(c, s.text, material)) continue;
		const named = c.evidence.length > 0;
		out.push({
			kind: c.kind,
			by: "reader",
			claim: c.claim || s.text.slice(0, 200),
			why: named ? "The words it cites aren't in that linked record." : "No linked record says this.",
		});
	}
	return out;
}

export interface CheckOptions {
	model?: DecisionModel;
	/** Run the reader (the feed's readerCheck setting). */
	reader: boolean;
	timeoutMs?: number;
	now?: () => number;
	/** Pool accounts not to ask ("auto"); one that refuses for its limit is added and the next one asked. */
	avoid?: readonly string[];
}

/** The whole check: code's flags, then the reader's (when on and a model is there). */
export async function checkUpdate(
	update: UpdateFields,
	material: readonly MaterialItem[],
	opts: CheckOptions,
): Promise<UpdateCheck> {
	const now = opts.now ?? Date.now;
	const sentences = codeCheck(update, material);
	const toRead = sentences.filter((s) => !isNotGiven(s.text));
	if (!opts.reader || !opts.model) {
		return { at: now(), sentences, reader: { at: now(), skipped: opts.reader ? "no model" : "off" } };
	}
	if (!toRead.length) return { at: now(), sentences, reader: { at: now(), skipped: "nothing to read" } };
	const model = opts.model;
	const prompt = readerPrompt(toRead, material);
	let avoid = [...(opts.avoid ?? [])];
	const ask = () =>
		model({
			system: READER_SYSTEM,
			prompt,
			model: "auto",
			thinking: "low",
			timeoutMs: opts.timeoutMs ?? 180_000,
			avoid,
		});
	let reply = await ask();
	// An account at its limit: the next one in the pool (each asked once).
	while (!reply.ok && reply.limited && reply.account && !avoid.includes(reply.account) && avoid.length < 8) {
		avoid = [...avoid, reply.account];
		reply = await ask();
	}
	if (!reply.ok) return { at: now(), sentences, reader: { at: now(), model: reply.model, error: reply.error } };
	let claims = parseReader(reply.text);
	// An answer that isn't JSON is a slip (stage test, run 11): ask once more before giving up.
	if (!claims) {
		const again = await ask();
		if (again.ok) {
			reply = again;
			claims = parseReader(again.text);
		}
	}
	if (!claims)
		return {
			at: now(),
			sentences,
			reader: { at: now(), model: reply.model, error: "the reader's answer wasn't JSON" },
		};
	withReaderClaims(sentences, claims, material);
	return { at: now(), sentences, reader: { at: now(), model: reply.model, claims: Object.fromEntries(claims) } };
}

/** Add the reader's flags to code's sentences from its claims (checkUpdate, and a replay of a saved check). */
export function withReaderClaims(
	sentences: CheckedSentence[],
	claims: ReadonlyMap<number, ReaderClaim[]> | Readonly<Record<string, ReaderClaim[]>>,
	material: readonly MaterialItem[],
): CheckedSentence[] {
	const of = (n: number): ReaderClaim[] | undefined =>
		claims instanceof Map ? claims.get(n) : (claims as Readonly<Record<string, ReaderClaim[]>>)[String(n)];
	for (const s of sentences) s.flags.push(...readerFlags(s, of(s.n), material));
	return sentences;
}

/** Every flag of a check, in sentence order. */
export function flagsOf(
	check: UpdateCheck | undefined,
): { n: number; field: UpdateFieldName; text: string; flag: CheckFlag }[] {
	const out: { n: number; field: UpdateFieldName; text: string; flag: CheckFlag }[] = [];
	for (const s of check?.sentences ?? [])
		for (const flag of s.flags) out.push({ n: s.n, field: s.field, text: s.text, flag });
	return out;
}
