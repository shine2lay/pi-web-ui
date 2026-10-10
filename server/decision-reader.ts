/**
 * decision-reader (task #84; the owner's pick: "A small model reads each record"): reads new records
 * from task #83's store in batches and finds the design decisions in them, and their changes.
 *
 * Each batch is one isolated model call with no tools (decision-model.ts). For each record the model
 * says: not a decision, a new decision, a change of a known one (reversed, widened, a limit raised or
 * moved, re-recorded as the owner's, an end condition added, changed or dropped), or the same decision
 * said again. For each point it gives verbatim quotes (code checks them word for word and uses them to
 * find which field holds the point: decision-who.ts), whether the wording claims the owner decided, and
 * for a dialog answer whether the point is the option's main choice or a rider bundled inside it.
 *
 * Filing: the record's tag first, then the initiatives' markers, then the model's guess; unfiled
 * decisions are kept under Unfiled. A daily token cap (settings) stops it; tokens per day are kept.
 * Nothing sent to the model is logged: only counts, sizes, the model used and errors.
 */
import type { DecisionRecord, DecisionRecords } from "./decision-records.js";
import { dayStart, localDay } from "./decision-records.js";
import type { DecisionModel } from "./decision-model.js";
import {
	CHANGE_TYPES,
	type ChangeType,
	type DecisionEntry,
	type DecisionSourceRef,
	type DecisionStore,
	fileRecord,
	type Initiative,
	type OwnerField,
	type ReaderSettings,
	type ReaderState,
} from "./decision-store.js";
import { pickedLabel, quoteFound, recordClaimsOwner, recordText, whoOf } from "./decision-who.js";

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

export const READER_SYSTEM = `You read records from the chats of a small software company run by AI roles (temper, architecture, ops, design, coo, ...) for one person, the owner. Records are messages between roles, Board posts (news, or orders that carry the owner's own words), the owner's answers in dialogs, and queued task plans with their done notes.

Your job: find the design decisions in each record, so the owner can see every decision about his initiatives, who really made it and what it costs him.

A decision is a choice about how something is built, run, limited, sequenced, shown or scoped: one way chosen over another, something put in or out of scope, a rule, an order of work, what a page or view shows, a condition or date for when it ends. Limits are decisions wherever they appear, even inside a status note: caps, ceilings, budgets, counts, rates, timeouts (for example "ceiling 120/h" or "6 model calls per turn"). Count a decision when the record makes it, records it or relays it.
Not decisions: progress or status reports, test results, deploys and restarts, questions still open, proposals nobody has picked yet, a role's own next step in its own work (waiting, retrying or not, asking someone for a fix) unless it sets a rule for later, how finished work was done (what a test or proof covered or left out), one-time requests about the case at hand (please don't retry this, send me that), acknowledgements, thanks, and plans that only list steps without choosing between ways of doing something.

First compare each point with KNOWN DECISIONS and with the new items earlier in this batch (N<n>). Then:
- it says a known decision again, unchanged: "same", with of. Only when it adds nothing to it: a further choice inside a known decision's area (who holds which copy, what a number is, what happens in a given case) is its own new item, or a change when it alters what the known decision says;
- it changes a known decision: "change", with of and type. Types: reversed (dropped, or replaced by something else); widened (more cases or more scope); limit-raised (a limit or number set higher, lower or lifted); limit-moved (a date, deadline or target moved); end-added, end-changed, end-dropped (the condition for when it ends, or what must happen before it goes ahead); re-recorded (now written down as the owner's decision); other only when none of these fits. A narrower or replaced version of a known decision is a change of it, not a new decision (for example: every team could do something, and now only some may); so is a known limit lifted, removed or set again (limit-raised, or reversed when it is dropped altogether). When a record says a rule was changed, narrowed or replaced, or calls an earlier one old, find the known decision it changes;
- otherwise "new": only when no known decision is about the same thing.
List every decision in the record, one item each; long plans usually hold several. Don't split one decision into several items. But when one line or sentence holds several points that touch different known decisions (or a known one and a new one), make one item per point, each with its own of and quoting only that point's words. For example, "Reviews move to Fridays and the cap goes up to 10" is two items when the review day and the cap are both known decisions. Check every known decision the record touches: a record that drops or replaces several known decisions gives a change item for each of them.

Credit: claimsOwner is true when the record's wording credits the owner with the point: it says he decided, chose, picked, asked for, requested, ordered or wants it; quotes his words for it; lists it under a line such as "Owner (...):", "the owner's decisions", "already decided" or "This is a record of his decision"; or adds it as a detail of how a choice credited to him works. Otherwise false. When the record credits the owner, quote the point where it is credited (in a plan, usually its Decided field). A known decision said again and credited to the owner is "same" with claimsOwner true. Such a list ("the owner's decisions: A, B, C") restates several choices at once, often in one sentence: check each listed choice against the known decisions on its own, and give each known one its own item ("same" or "change", with its of, quoting only that choice's words) before any new item for the rest.

Orders: the owner's own words and the relayer's text are different parts. For a point the owner states, quote his own words. A point that is only in the relayer's text is its own item, quoted from that text. Never quote both parts in one item: when the relayer adds a limit, condition or detail to what the owner asked (he asks for a shared page; the relayer adds "only for the team, behind a login"), the owner's ask is one item quoting his words, and the addition is another item quoting the relayer's text.

Plan changes: a queue plan change shows only what changed since the task's last version (read before): the lines added or changed, and the lines taken out. Find the decisions the change makes: an added line may be a new point or a change of a known one; a line taken out may drop or replace one (reversed, end-dropped). For a point that was taken out, quote the taken-out line.

Dialog answers: the owner's pick is his decision (part "main"). Also read the picked option's description and preview: a further choice bundled inside the option he picked, that is not what the option's label says, is a separate item with part "rider".

For every item:
- point: "rule" when it sets how something is built, run, limited, shown or scoped from now on (a design, a rule, a scope, a limit, a number or date, who does what); "go" when someone allows, orders, holds, pauses or stops a step; "own-step" when it is only about the work at hand: what the writer did or how (what a finished test or proof covered or left out), is doing or will do next, what it waits for, whether it retries, or a one-time request to someone about this case (please don't retry this, send me that).
- quotes: 1 to 3 short quotes copied character for character from the record, stating the point itself. Never reword, never join pieces. For a dialog answer quote the point's own words in the option he picked (its label, description or preview) or in what he typed. The code adds the picked option's label to each item, so quote the label only for a point the label itself states; one quote serves one point, so two items never share the same quotes.
- claimsOwner: true or false, see Credit.
- part: "main" or "rider" for dialog answers, else null.
- impact: a quote of what it costs or changes for the owner (money, time, risk, what he can or can't do), or "".
- options: a quote naming the other options and their cost, or "".
- until: a quote of until when it holds or what ends it, or "".
For "new" also: id (N1, N2, ... in this batch), title (at most 8 plain words), what (one plain sentence).
For "change" also: of, type, what (one plain sentence saying what changed).
For "same" also: of.
For each record also: initiative, an id from INITIATIVES when the record header says "filed: none" and the record is about that initiative (it names it or one of its parts, or carries on work for it); else null.

Answer with JSON only, no other text:
{"records":[{"r":"R1","initiative":null,"items":[]},{"r":"R2","initiative":null,"items":[{"kind":"new","id":"N1","title":"...","what":"...","point":"rule","quotes":["..."],"claimsOwner":false,"part":null,"impact":"","options":"","until":""}]},{"r":"R3","initiative":null,"items":[{"kind":"change","of":"N1","type":"widened","what":"...","point":"rule","quotes":["..."],"claimsOwner":true,"part":null,"impact":"","until":""}]}]}
List every record R1..Rn once, in order.`;

const MAX_FIELD = 6_000;
const MAX_KNOWN = 60;
/** Known decisions named in each record's header as most like it (relatedDecisions). */
const RELATED_PER_RECORD = 4;

function clip(s: string | undefined, n: number): string {
	const t = String(s ?? "").trim();
	return t.length > n ? `${t.slice(0, n)} [...]` : t;
}

function stamp(ms: number): string {
	const d = new Date(ms);
	const p = (x: number) => String(x).padStart(2, "0");
	return `${localDay(ms)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const toText = (to: DecisionRecord["to"]): string => (Array.isArray(to) ? to.join(", ") : String(to ?? ""));

type PlanFields = NonNullable<DecisionRecord["plan"]>;

/** A plan's fields in the order the reader sees them, with their limits. */
const PLAN_FIELDS: [keyof PlanFields, string, number][] = [
	["title", "Title", MAX_FIELD],
	["decided", "Decided", MAX_FIELD],
	["goal", "Goal", MAX_FIELD],
	["mustNot", "Must not", MAX_FIELD],
	["doneWhen", "Done when", 3000],
	["steps", "Steps", 3000],
	["verify", "Verify", 2000],
];

const textLines = (s: string | undefined): string[] =>
	String(s ?? "")
		.split("\n")
		.map((l) => l.trimEnd())
		.filter((l) => l.trim());

/** Lines of `cur` that aren't in `prev` (added or changed) and lines of `prev` that aren't in `cur`
 *  (taken out), by the longest common run of lines; blank lines and trailing spaces don't count. */
export function lineDelta(prev: string | undefined, cur: string | undefined): { added: string[]; removed: string[] } {
	const a = textLines(prev);
	const b = textLines(cur);
	const n = a.length;
	const m = b.length;
	const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--)
			lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
	}
	const added: string[] = [];
	const removed: string[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (a[i] === b[j]) {
			i++;
			j++;
		} else if (lcs[i + 1][j] >= lcs[i][j + 1]) removed.push(a[i++]);
		else added.push(b[j++]);
	}
	while (i < n) removed.push(a[i++]);
	while (j < m) added.push(b[j++]);
	return { added, removed };
}

const refLine = (ref: string | undefined): number => Number(/:(\d+)$/.exec(ref ?? "")?.[1] ?? Number.NaN);

/** Finds a plan change's previous version: the same task's last plan (added or changed) earlier in the
 *  same chat file. A change with none (its task began before the store) is read whole. */
export function planVersions(all: DecisionRecord[]): (rec: DecisionRecord) => DecisionRecord | undefined {
	const byTask = new Map<string, DecisionRecord[]>();
	for (const r of all) {
		if (r.source !== "plan" || r.op === "done" || !r.file || r.task === undefined) continue;
		const k = `${r.file}\0${r.task}`;
		const list = byTask.get(k) ?? [];
		list.push(r);
		byTask.set(k, list);
	}
	return (rec) => {
		if (rec.source !== "plan" || rec.op !== "update" || !rec.file) return undefined;
		const line = refLine(rec.ref);
		let best: DecisionRecord | undefined;
		for (const r of byTask.get(`${rec.file}\0${rec.task}`) ?? []) {
			const l = refLine(r.ref);
			if (l < line && (!best || l > refLine(best.ref))) best = r;
		}
		return best;
	};
}

/** A record with the same content as an earlier one, apart from where it was kept (a done note written
 *  to two chats): copy id -> the earlier record's id. */
export function copiesIn(all: DecisionRecord[]): Map<string, string> {
	const stable = (v: unknown): string =>
		Array.isArray(v)
			? `[${v.map(stable).join(",")}]`
			: v && typeof v === "object"
				? `{${Object.keys(v)
						.sort()
						.map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
						.join(",")}}`
				: JSON.stringify(v);
	const first = new Map<string, string>();
	const out = new Map<string, string>();
	for (const r of all) {
		const { id, ref, file, entry, seen, how, chat, v, lines, atIs, ...content } = r;
		void [ref, file, entry, seen, how, chat, v, lines, atIs];
		const key = stable(content);
		const orig = first.get(key);
		if (orig) out.set(id, orig);
		else first.set(key, id);
	}
	return out;
}

/** One record as the reader sees it: a header saying who wrote what, then its fields. A plan change
 *  with its previous version (`was`) shows only what changed. */
export function renderRecord(
	rec: DecisionRecord,
	label: string,
	filed: string | undefined,
	maxChars: number,
	was?: DecisionRecord,
): string {
	const head: string[] = [`=== ${label}`];
	const body: string[] = [];
	const field = (name: string, value: string | undefined, n = MAX_FIELD) => {
		if (value && value.trim()) body.push(`${name}: ${clip(value, n)}`);
	};
	switch (rec.source) {
		case "message":
			head.push(`message (${rec.kind ?? "message"})`, stamp(rec.at), `from ${rec.from} to ${toText(rec.to)}`);
			body.push(clip(rec.text, MAX_FIELD * 2));
			break;
		case "board":
			if (rec.kind === "order") {
				head.push("Board order", stamp(rec.at), `relayed by ${rec.via ?? "a role"} to ${toText(rec.to)}`);
				field("Title", rec.title);
				field("The owner's own words", rec.ownerWords);
				field(`${rec.via ?? "The relaying role"}'s text`, rec.text, MAX_FIELD * 2);
			} else {
				head.push("Board news", stamp(rec.at), `posted by ${rec.from} to ${toText(rec.to)}`);
				field("Title", rec.title);
				body.push(clip(rec.text, MAX_FIELD * 2));
			}
			break;
		case "answer": {
			const asker = typeof rec.to === "string" ? rec.to : (rec.chat ?? "a role");
			head.push("the owner's answer in a dialog", stamp(rec.at), `asked by ${asker}`);
			field("Dialog", [rec.title, rec.body].filter(Boolean).join(" - "));
			for (const [i, q] of (rec.questions ?? []).entries()) {
				body.push(
					`Q${i + 1}${q.header ? ` (${q.header})` : ""}: ${clip(q.question, 1500)}${q.detail ? ` ${clip(q.detail, 1500)}` : ""}`,
				);
				for (const o of q.options ?? []) {
					const mark = (q.picked ?? []).includes(o.label) ? "[PICKED]" : "[not picked]";
					body.push(`  ${mark} ${o.label}${o.description ? ` - ${clip(o.description, 1500)}` : ""}`);
					if (o.preview) body.push(`    preview: ${clip(o.preview, 2500)}`);
				}
				if (q.typed) body.push(`  he typed: ${clip(q.typed, 2000)}`);
			}
			break;
		}
		case "plan": {
			const task = `task ${rec.from} #${rec.task ?? "?"}`;
			if (rec.op === "done") {
				head.push("queued task done note", stamp(rec.at), task);
				body.push(clip(rec.summary, MAX_FIELD));
			} else {
				const appr =
					rec.approval === "dialog" ? "approved by the owner in a dialog" : "auto-approved (the owner didn't see it)";
				head.push(`queue plan ${rec.op === "update" ? "change" : "added"}`, stamp(rec.at), task, appr);
				const p = rec.plan ?? {};
				if (rec.op === "update" && was?.source === "plan") {
					// What changed since the task's last version, which was read before.
					const w = was.plan ?? {};
					const same: string[] = [];
					let changed = false;
					field("Title", p.title);
					for (const [key, name, n] of PLAN_FIELDS) {
						const d = lineDelta(w[key], p[key]);
						if (!d.added.length && !d.removed.length) {
							if (key !== "title" && p[key]?.trim()) same.push(name);
							continue;
						}
						changed = true;
						if (d.added.length) body.push(`${name}, lines added or changed:\n${clip(d.added.join("\n"), n)}`);
						if (d.removed.length) body.push(`${name}, lines taken out:\n${clip(d.removed.join("\n"), n)}`);
					}
					if (same.length) body.push(`Unchanged since the task's last version: ${same.join(", ")}`);
					if (!changed) body.push("The plan's text didn't change.");
				} else {
					for (const [key, name, n] of PLAN_FIELDS) field(name, p[key], n);
				}
			}
			break;
		}
	}
	head.push(`filed: ${filed ?? "none"}`);
	const out = `${head.join(" · ")}\n${body.join("\n")}`;
	return out.length > maxChars ? `${out.slice(0, maxChars)} [...]` : out;
}

function words(s: string): Set<string> {
	return new Set(
		String(s)
			.toLowerCase()
			.split(/[^a-z0-9#-]+/)
			.filter((w) => w.length >= 4),
	);
}

const decisionWords = (d: DecisionEntry): Set<string> =>
	words(`${d.title} ${d.what} ${d.changes.map((c) => c.what).join(" ")}`);

/**
 * For each record text, the known decisions most like it: shared words weighted by how rare they are among the
 * known decisions (a shared "proactively" says more than a shared "work"), over the decision's length. At least
 * two shared words; at most perRecord each. Code, not the model, picks them, and they are always among the
 * known decisions shown, however many there are. (Not named per record: when a record changes a decision in
 * other words, its word neighbours would point the model the wrong way; stage test round 9.)
 */
export function relatedDecisions(
	all: DecisionEntry[],
	recordTexts: string[],
	perRecord = RELATED_PER_RECORD,
): DecisionEntry[][] {
	const live = all.filter((d) => !d.notDecision);
	const dw = live.map((d) => decisionWords(d));
	const df = new Map<string, number>();
	for (const ws of dw) for (const w of ws) df.set(w, (df.get(w) ?? 0) + 1);
	const n = live.length;
	return recordTexts.map((text) => {
		const rw = words(text);
		return live
			.map((d, i) => {
				let shared = 0;
				let score = 0;
				for (const w of dw[i])
					if (rw.has(w)) {
						shared++;
						score += Math.log((n + 1) / (df.get(w) ?? 1));
					}
				return { d, shared, score: score / Math.sqrt(Math.max(4, dw[i].size)) };
			})
			.filter((x) => x.shared >= 2 && x.score > 0)
			.sort((a, b) => b.score - a.score || lastAt(b.d) - lastAt(a.d))
			.slice(0, perRecord)
			.map((x) => x.d);
	});
}

/**
 * The known decisions shown to the model: first the ones related to each record (relatedDecisions), then the
 * ones sharing most words with the batch, then the newest.
 */
export function knownDecisions(
	all: DecisionEntry[],
	batchText: string,
	max = MAX_KNOWN,
	related: DecisionEntry[] = [],
): DecisionEntry[] {
	const live = all.filter((d) => !d.notDecision);
	const bw = words(batchText);
	const scored = live
		.map((d) => {
			let hits = 0;
			for (const w of decisionWords(d)) if (bw.has(w)) hits++;
			return { d, hits };
		})
		.filter((x) => x.hits >= 2)
		.sort((a, b) => b.hits - a.hits)
		.slice(0, Math.round(max * 0.7))
		.map((x) => x.d);
	const newest = [...live].sort((a, b) => lastAt(b) - lastAt(a)).slice(0, max);
	const out = new Map<string, DecisionEntry>();
	for (const d of [...related.filter((x) => !x.notDecision), ...scored, ...newest]) {
		if (out.size >= max) break;
		out.set(d.id, d);
	}
	return [...out.values()].sort((a, b) => a.at - b.at);
}

const lastAt = (d: DecisionEntry): number => Math.max(d.at, ...d.changes.map((c) => c.at));

export function renderKnown(list: DecisionEntry[]): string {
	if (!list.length) return "(none yet)";
	return list
		.map((d) => {
			const last = d.changes.filter((c) => !c.notDecision).slice(-1)[0];
			const tail = last ? ` Latest change (${last.type}): ${clip(last.what, 160)}` : "";
			return `${d.id.toUpperCase()} [${d.initiative ?? "unfiled"}] ${clip(d.title, 80)}: ${clip(d.what, 200)}${tail}`;
		})
		.join("\n");
}

export function buildPrompt(recordsText: string[], known: DecisionEntry[], initiatives: Initiative[]): string {
	return [
		"INITIATIVES:",
		initiatives.map((i) => `${i.id}: ${i.name}${i.about ? ` (${i.about})` : ""}`).join("\n") || "(none)",
		"",
		"KNOWN DECISIONS:",
		renderKnown(known),
		"",
		`RECORDS (${recordsText.length}):`,
		recordsText.join("\n\n"),
	].join("\n");
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

/** What a point does (the reader's checklist): sets a rule for later, lets a step go (or holds or
 *  stops it), or is only the writer's own step in its own work, which code drops (rule 17: the model
 *  only labels, the code decides). */
export type Point = "rule" | "go" | "own-step";

const pointOf = (v: unknown): Point => {
	const s = String(v ?? "")
		.toLowerCase()
		.replace(/[^a-z]/g, "");
	return s === "ownstep" || s === "own" ? "own-step" : s === "go" ? "go" : "rule";
};

export type ReaderItem =
	| {
			kind: "new";
			id: string;
			title: string;
			what: string;
			/** Older answers gave the initiative per item; the record's own answer comes first. */
			initiative: string | null;
			point: Point;
			quotes: string[];
			claimsOwner: boolean;
			part: "main" | "rider" | null;
			impact: string;
			options: string;
			until: string;
	  }
	| {
			kind: "change";
			of: string;
			type: ChangeType;
			what: string;
			point: Point;
			quotes: string[];
			claimsOwner: boolean;
			part: "main" | "rider" | null;
			impact: string;
			until: string;
	  }
	| { kind: "same"; of: string; quotes: string[]; claimsOwner: boolean; part: "main" | "rider" | null };

export interface ParsedAnswer {
	/** record label (R1…) -> its items. A label left out isn't here. */
	records: Map<string, ReaderItem[]>;
	/** record label -> the initiative the model files it under (null: none). */
	initiatives: Map<string, string | null>;
	problems: string[];
}

function jsonPart(text: string): string | undefined {
	const t = text.replace(/^\uFEFF/, "");
	const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
	const src = fence ? fence[1] : t;
	const a = src.indexOf("{");
	const b = src.lastIndexOf("}");
	return a >= 0 && b > a ? src.slice(a, b + 1) : undefined;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const strs = (v: unknown): string[] =>
	(Array.isArray(v) ? v : typeof v === "string" ? [v] : []).map(str).filter(Boolean).slice(0, 5);
const partOf = (v: unknown): "main" | "rider" | null => (v === "main" || v === "rider" ? v : null);

/** The model's JSON, checked against the schema. Bad items are dropped and said in problems. */
export function parseAnswer(text: string, labels: string[]): ParsedAnswer {
	const problems: string[] = [];
	const records = new Map<string, ReaderItem[]>();
	const initiatives = new Map<string, string | null>();
	const raw = jsonPart(text);
	let json: unknown;
	try {
		json = raw ? JSON.parse(raw) : undefined;
	} catch (e) {
		problems.push(`not JSON: ${(e as Error).message}`);
		return { records, initiatives, problems };
	}
	const list = (json as { records?: unknown })?.records;
	if (!Array.isArray(list)) {
		problems.push("no records list");
		return { records, initiatives, problems };
	}
	const want = new Set(labels);
	const newIds = new Set<string>();
	for (const r of list) {
		const label = str((r as { r?: unknown })?.r).toUpperCase();
		if (!want.has(label)) {
			problems.push(`unknown record ${label || "(none)"}`);
			continue;
		}
		const init = str((r as { initiative?: unknown }).initiative).toLowerCase();
		initiatives.set(label, init && init !== "none" && init !== "null" ? init : null);
		const items: ReaderItem[] = [];
		const rawItems = (r as { items?: unknown }).items;
		for (const it of Array.isArray(rawItems) ? rawItems : []) {
			const o = { ...((it ?? {}) as Record<string, unknown>) };
			// The point's type written where the kind goes ("kind": "go"): the other fields say which kind it is.
			if (pointOf(o.kind) !== "rule" || str(o.kind).toLowerCase() === "rule") {
				if (o.point === undefined) o.point = o.kind;
				o.kind = str(o.of) ? (str(o.type) ? "change" : "same") : "new";
			}
			const kind = str(o.kind);
			const quotes = strs(o.quotes);
			const claimsOwner = o.claimsOwner === true;
			const part = partOf(o.part);
			if (kind === "new") {
				const id = str(o.id).toUpperCase() || `N${newIds.size + 1}`;
				const title = str(o.title);
				const what = str(o.what) || title;
				if (!what || !quotes.length) {
					problems.push(`${label}: new item without what or quotes`);
					continue;
				}
				newIds.add(id);
				items.push({
					kind: "new",
					id,
					title: title || clip(what, 60),
					what,
					initiative: str(o.initiative) || null,
					point: pointOf(o.point),
					quotes,
					claimsOwner,
					part,
					impact: str(o.impact),
					options: str(o.options),
					until: str(o.until),
				});
			} else if (kind === "change") {
				const of = str(o.of).toUpperCase();
				const type = str(o.type).toLowerCase() as ChangeType;
				const what = str(o.what);
				if (!of || !what || !quotes.length) {
					problems.push(`${label}: change without of, what or quotes`);
					continue;
				}
				items.push({
					kind: "change",
					of,
					type: (CHANGE_TYPES as readonly string[]).includes(type) ? type : "other",
					what,
					point: pointOf(o.point),
					quotes,
					claimsOwner,
					part,
					impact: str(o.impact),
					until: str(o.until),
				});
			} else if (kind === "same") {
				const of = str(o.of).toUpperCase();
				if (!of) {
					problems.push(`${label}: same without of`);
					continue;
				}
				items.push({ kind: "same", of, quotes, claimsOwner, part });
			} else {
				problems.push(`${label}: unknown kind ${kind || "(none)"}`);
			}
		}
		records.set(label, items);
	}
	const missing = labels.filter((l) => !records.has(l));
	if (missing.length) problems.push(`records left out: ${missing.join(" ")}`);
	return { records, initiatives, problems };
}

// ---------------------------------------------------------------------------
// The reader
// ---------------------------------------------------------------------------

export interface ReaderOptions {
	records: DecisionRecords;
	store: DecisionStore;
	model: DecisionModel;
	/** Older answer records lack the options' previews: read them from the chat line they cite. */
	withPreviews?: (rec: DecisionRecord) => Promise<DecisionRecord>;
	log?: (line: string) => void;
	onChange?: () => void;
	/** An item dropped as only the writer's own step (point "own-step"); the stage test lists them. */
	onSkip?: (rec: DecisionRecord, item: ReaderItem) => void;
	/** What one batch showed the model: its records, the known decisions and each record's related ones (stage test). */
	onBatch?: (recs: DecisionRecord[], known: DecisionEntry[], related: DecisionEntry[][]) => void;
	now?: () => number;
	/** Waits between retries (tests pass 0). */
	retryWaitMs?: number[];
	/** A plan change's previous version (default: planVersions over the records store; the stage test
	 *  looks in the live store, read-only). */
	previousPlan?: (rec: DecisionRecord) => DecisionRecord | undefined;
}

export interface BatchResult {
	read: number;
	decisions: number;
	changes: number;
	same: number;
	/** Items dropped as only the writer's own step. */
	skipped: number;
	tokens: number;
	problems: string[];
	error?: string;
	/** The error is a limit refusal with no account left to ask: the reader waits. */
	limited?: boolean;
}

export interface ReadResult {
	batches: number;
	read: number;
	stopped: "done" | "cap" | "error" | "disabled" | "busy" | "limit" | "quota";
	error?: string;
}

const DEFAULT_RETRY_WAIT = [10_000, 30_000];
const MAX_TRIES = 3;
/** How long a pool account rests after refusing a call for its limit (the next account is asked meanwhile). */
export const LIMIT_REST_MS = 60 * 60_000;

export class DecisionReader {
	private running = false;
	private timer: NodeJS.Timeout | undefined;
	private everyMs = 0;
	/** Records seen by this reader, by id: to tell whether a known decision is backed by the owner. */
	private readonly seen = new Map<string, DecisionRecord>();

	constructor(private readonly o: ReaderOptions) {}

	private now(): number {
		return this.o.now ? this.o.now() : Date.now();
	}

	private log(line: string): void {
		this.o.log?.(`[decisions] ${line}`);
	}

	settings(): ReaderSettings {
		return this.o.store.settings();
	}

	/** Exact copies among the records since readFrom (copy id -> the record read in its place). */
	private copies = new Map<string, string>();

	/** Records not read yet, oldest first. An exact copy of an earlier record isn't read again. */
	unread(settings = this.settings(), state = this.o.store.readerState()): DecisionRecord[] {
		const from = dayStart(settings.readFrom) ?? 0;
		const all = this.o.records.list({ since: from });
		for (const r of all) this.seen.set(r.id, r);
		this.copies = copiesIn(all);
		return all.filter((r) => !state.read[r.id] && !this.copies.has(r.id));
	}

	/** A copy takes the reading of the record read in its place, once that one is read. */
	private settleCopies(state: ReaderState): boolean {
		let changed = false;
		for (const [copy, orig] of this.copies) {
			const mark = state.read[orig];
			if (!mark || state.read[copy]) continue;
			state.read[copy] = mark;
			state.copies = { ...state.copies, [copy]: orig };
			changed = true;
		}
		return changed;
	}

	/**
	 * The version a plan change is read against, or none (read in full). Only a version that was read, or
	 * is read in this pass (on or after readFrom), since its unchanged lines are left out; and only when
	 * the change is shorter to read than the whole plan.
	 */
	private versions(settings = this.settings()): (rec: DecisionRecord) => DecisionRecord | undefined {
		const lookup = this.o.previousPlan ?? planVersions(this.o.records.list({ source: "plan" }));
		const from = dayStart(settings.readFrom) ?? 0;
		const read = this.o.store.readerState().read;
		return (rec) => {
			const was = lookup(rec);
			if (!was || (!read[was.id] && was.at < from)) return undefined;
			const inFull = renderRecord(rec, "R0", undefined, Number.POSITIVE_INFINITY).length;
			return renderRecord(rec, "R0", undefined, Number.POSITIVE_INFINITY, was).length < inFull ? was : undefined;
		};
	}

	/** One of the decision's own sources (not a repeat) is backed by the owner's own record, and isn't a rider. */
	private ownerBacked(entry: DecisionEntry): boolean {
		return entry.sources.some((s) => {
			if (s.same) return false;
			const rec = s.record ? this.seen.get(s.record) : undefined;
			const was = s.was ? this.seen.get(s.was) : undefined;
			const w = whoOf(rec, { quotes: s.quotes, claimsOwner: s.claimsOwner, part: s.part, by: s.by, was });
			return w.you && !w.flags.includes("rider");
		});
	}

	/** Start the timer: a read every readEveryMinutes (re-read from settings each time). */
	start(): void {
		if (this.timer) return;
		const schedule = () => {
			const every = this.settings().readEveryMinutes * 60_000;
			if (this.timer && every === this.everyMs) return;
			if (this.timer) clearInterval(this.timer);
			this.everyMs = every;
			this.timer = setInterval(() => void this.tick(), every);
			this.timer.unref?.();
		};
		schedule();
		const first = setTimeout(() => void this.tick(), 20_000);
		first.unref?.();
		this.reschedule = schedule;
	}

	private reschedule: (() => void) | undefined;

	stop(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	async tick(): Promise<ReadResult> {
		try {
			this.reschedule?.();
		} catch {
			/* keep the old timer */
		}
		return this.readAll();
	}

	/** Read batches until nothing is left, the cap is reached or a call fails. */
	async readAll(opts: { maxBatches?: number } = {}): Promise<ReadResult> {
		if (this.running) return { batches: 0, read: 0, stopped: "busy" };
		this.running = true;
		let batches = 0;
		let read = 0;
		try {
			for (;;) {
				const settings = this.settings();
				if (!settings.enabled) return { batches, read, stopped: "disabled" };
				if (opts.maxBatches !== undefined && batches >= opts.maxBatches) return { batches, read, stopped: "limit" };
				const state = this.o.store.readerState();
				const today = localDay(this.now());
				if (state.capHit && state.capHit !== today) {
					delete state.capHit;
					this.o.store.saveReaderState(state);
				}
				const unread = this.unread(settings, state);
				if (this.settleCopies(state)) this.o.store.saveReaderState(state);
				if (!unread.length) return { batches, read, stopped: "done" };
				const batch = this.pickBatch(unread, settings);
				const estimate = Math.ceil(batch.chars / 3.2) + 6_000;
				if (this.o.store.tokensToday(state) + estimate > settings.dailyTokenCap) {
					if (state.capHit !== today) {
						state.capHit = today;
						this.o.store.saveReaderState(state);
						this.log(`daily token cap reached (${settings.dailyTokenCap}); ${unread.length} records wait for tomorrow`);
						this.o.onChange?.();
					}
					return { batches, read, stopped: "cap" };
				}
				const res = await this.readBatch(batch.records, settings);
				batches++;
				read += res.read;
				if (res.error) return { batches, read, stopped: res.limited ? "quota" : "error", error: res.error };
			}
		} finally {
			this.running = false;
		}
	}

	/** Pool accounts still resting after a limit refusal (expired rests are dropped). */
	private resting(): string[] {
		const state = this.o.store.readerState();
		const now = this.now();
		const all = Object.entries(state.resting ?? {});
		const live = all.filter(([, until]) => until > now);
		if (live.length !== all.length) {
			state.resting = Object.fromEntries(live);
			this.o.store.saveReaderState(state);
		}
		return live.map(([account]) => account);
	}

	private pickBatch(unread: DecisionRecord[], s: ReaderSettings): { records: DecisionRecord[]; chars: number } {
		const out: DecisionRecord[] = [];
		let chars = 0;
		const wasOf = this.versions(s);
		for (const r of unread) {
			// A plan change counts by what it shows: what changed since its last version.
			const was = wasOf(r);
			const text = was ? renderRecord(r, "R0", undefined, Number.POSITIVE_INFINITY, was).length : recordText(r).length;
			const size = Math.min(text + 200, s.batchChars);
			if (out.length && (out.length >= s.batchRecords || chars + size > s.batchChars)) break;
			out.push(r);
			chars += size;
		}
		return { records: out, chars };
	}

	/** One model call for these records, applied to the store. Exported for the stage test. */
	async readBatch(recs: DecisionRecord[], settings = this.settings(), secondLook = false): Promise<BatchResult> {
		const store = this.o.store;
		const initiatives = store.initiatives();
		const full = this.o.withPreviews ? await Promise.all(recs.map((r) => this.o.withPreviews!(r))) : recs;
		for (const r of full) this.seen.set(r.id, r);
		const wasOf = this.versions(settings);
		const was = full.map((r) => wasOf(r));
		for (const w of was) if (w) this.seen.set(w.id, w);
		const filed = full.map((r) => fileRecord(r, initiatives));
		const labels = full.map((_, i) => `R${i + 1}`);
		const perRecord = Math.max(4_000, Math.floor(settings.batchChars / Math.max(1, Math.min(full.length, 4))));
		const texts = full.map((r, i) => renderRecord(r, labels[i], filed[i]?.initiative, perRecord, was[i]));
		const related = relatedDecisions(store.decisions(), texts);
		const known = knownDecisions(store.decisions(), texts.join("\n"), MAX_KNOWN, related.flat());
		this.o.onBatch?.(full, known, related);
		const prompt = buildPrompt(texts, known, initiatives);
		const result: BatchResult = { read: 0, decisions: 0, changes: 0, same: 0, skipped: 0, tokens: 0, problems: [] };

		let parsed: ParsedAnswer | undefined;
		let lastError = "";
		let limited = false;
		const waits = this.o.retryWaitMs ?? DEFAULT_RETRY_WAIT;
		const auto = !settings.model || settings.model === "auto";
		let hops = 0;
		for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
			const reply = await this.o.model({
				system: READER_SYSTEM,
				prompt,
				model: settings.model,
				thinking: settings.thinking,
				timeoutMs: settings.callTimeoutSeconds * 1000,
				...(auto ? { avoid: this.resting() } : {}),
			});
			const used = reply.usage ? reply.usage.input + reply.usage.output : 0;
			result.tokens += used;
			this.countTokens(reply.usage, reply.model);
			if (!reply.ok && reply.limited) {
				lastError = reply.error;
				// An account that refused for its limit rests, and the next one is asked at once (not a try);
				// with none left, or a fixed model, the reader stops and waits.
				if (auto && reply.account && hops < 8) {
					const state = store.readerState();
					state.resting = { ...(state.resting ?? {}), [reply.account]: this.now() + LIMIT_REST_MS };
					store.saveReaderState(state);
					this.log(
						`account ${reply.account} refused for its limit; it rests ${LIMIT_REST_MS / 60_000} min, asking the next one`,
					);
					hops++;
					attempt--;
					continue;
				}
				limited = true;
				this.log(`batch of ${full.length}: ${reply.error}; the reader waits`);
				break;
			}
			if (!reply.ok) {
				lastError = reply.error;
				this.log(`batch of ${full.length}: call failed (${reply.error}), try ${attempt + 1}/${MAX_TRIES}`);
				// A batch that is too slow is read in halves rather than tried again at the same size.
				if (full.length > 1 && /timed out/.test(reply.error)) break;
				if (attempt < MAX_TRIES - 1) await sleep(waits[Math.min(attempt, waits.length - 1)] ?? 0);
				continue;
			}
			const p = parseAnswer(reply.text, labels);
			if (p.records.size === 0) {
				lastError = `the answer didn't parse: ${p.problems.slice(0, 3).join("; ")}`;
				this.log(`batch of ${full.length}: ${lastError}, try ${attempt + 1}/${MAX_TRIES}`);
				continue;
			}
			parsed = p;
			break;
		}
		if (!parsed) {
			// A call that keeps failing: note it and leave the records for the next read; a batch that keeps
			// giving answers that don't parse, or times out, is split, and a single record that can't be read
			// is set aside.
			const state = store.readerState();
			state.lastError = { at: this.now(), error: lastError };
			if (full.length === 1 && !/timed out|rate|limit|overloaded|429|5\d\d|network|fetch/i.test(lastError)) {
				state.read[full[0].id] = "x";
				result.read = 1;
			}
			store.saveReaderState(state);
			if (!limited && full.length > 1 && /didn't parse|timed out/.test(lastError)) {
				const half = Math.ceil(full.length / 2);
				const a = await this.readBatch(recs.slice(0, half), settings, secondLook);
				const b = await this.readBatch(recs.slice(half), settings, secondLook);
				return mergeResults(result, a, b);
			}
			result.error = lastError;
			if (limited) result.limited = true;
			this.o.onChange?.();
			return result;
		}
		result.problems = parsed.problems;

		// Apply, record by record, in order.
		const batchIds = new Map<string, DecisionEntry>();
		const state = store.readerState();
		const again: DecisionRecord[] = [];
		for (const [i, rec] of full.entries()) {
			const items = parsed.records.get(labels[i]);
			if (!items) continue; // left out: read again next time
			// A plan's Decided part is where a role writes its choices down. Said to hold nothing: one more
			// read, alone; what that read says stands.
			if (!secondLook && !items.length && rec.source === "plan" && rec.plan?.decided?.trim()) {
				again.push(recs[i]);
				continue;
			}
			let any = false;
			let his = false;
			const said = parsed.initiatives.get(labels[i]);
			const guess = said && initiatives.some((x) => x.id === said) ? said : null;
			for (const item of items) {
				// Only the writer's own step in its own work (waiting, retrying or not, what it does next):
				// not a decision, whatever else the model said about it.
				if (item.kind !== "same" && item.point === "own-step") {
					result.skipped++;
					this.o.onSkip?.(rec, item);
					continue;
				}
				const applied = this.apply(rec, filed[i], item, batchIds, initiatives, guess, was[i]);
				if (applied === "new") result.decisions++;
				else if (applied === "change") result.changes++;
				else if (applied === "same") result.same++;
				if (applied) any = true;
				if (
					applied &&
					whoOf(rec, { quotes: item.quotes, claimsOwner: item.claimsOwner, part: item.part ?? undefined, was: was[i] })
						.you
				)
					his = true;
			}
			// An order is his by definition: the Board carries only the owner's orders, in his words. When the
			// reader gave no point quoted from his words, the order still shows as his, as one decision
			// quoting them (the relayer's additions keep their own items, flagged).
			if (!his && rec.source === "board" && rec.kind === "order" && this.addOrder(rec, filed[i])) {
				result.decisions++;
				any = true;
			}
			state.read[rec.id] = any ? "d" : "n";
			result.read++;
		}
		state.lastRun = this.now();
		delete state.lastError;
		store.save();
		store.saveReaderState(state);
		this.log(
			`read ${result.read} records: ${result.decisions} decisions, ${result.changes} changes, ${result.same} repeats, ${result.skipped ? `${result.skipped} own steps left out, ` : ""}${result.tokens} tokens${parsed.problems.length ? `; ${parsed.problems.length} problems: ${parsed.problems.slice(0, 3).join("; ")}` : ""}${again.length ? `; ${again.length} plan${again.length === 1 ? "" : "s"} with nothing found read again alone` : ""}`,
		);
		this.o.onChange?.();
		if (!again.length) return result;
		const more: BatchResult[] = [];
		for (const rec of again) more.push(await this.readBatch([rec], settings, true));
		return mergeResults(result, ...more);
	}

	private countTokens(usage: { input: number; output: number } | undefined, model?: string): void {
		const state = this.o.store.readerState();
		const day = localDay(this.now());
		const t = (state.tokens[day] ??= { input: 0, output: 0, calls: 0 });
		t.input += usage?.input ?? 0;
		t.output += usage?.output ?? 0;
		t.calls += 1;
		if (model) state.lastModel = model;
		this.o.store.saveReaderState(state);
	}

	/** An order as one decision quoting his words (see readBatch). */
	private addOrder(rec: DecisionRecord, filed: { initiative: string; by: "tag" | "marker" } | undefined): boolean {
		const own = String(rec.ownerWords ?? "")
			.replace(/\s+/g, " ")
			.trim();
		if (!own) return false;
		const quote = own.length <= 400 ? own : own.slice(0, Math.max(own.lastIndexOf(" ", 400), 1));
		const title = rec.title?.trim() || own;
		this.o.store.addDecision({
			initiative: filed?.initiative ?? null,
			filedBy: filed ? filed.by : "",
			title: clip(title, 100),
			what: clip(title, 300),
			at: rec.at,
			sources: [{ record: rec.id, ref: rec.ref, at: rec.at, quotes: [quote], by: "reader" }],
			by: "reader",
		});
		return true;
	}

	private apply(
		rec: DecisionRecord,
		filed: { initiative: string; by: "tag" | "marker" } | undefined,
		item: ReaderItem,
		batchIds: Map<string, DecisionEntry>,
		initiatives: Initiative[],
		recordGuess: string | null = null,
		was?: DecisionRecord,
	): "new" | "change" | "same" | undefined {
		const store = this.o.store;
		// His main pick in a dialog: the option's own label goes with the quotes, so the card says what he picked.
		const label = rec.source === "answer" && item.part !== "rider" ? pickedLabel(rec, item.quotes) : undefined;
		const source: DecisionSourceRef = {
			record: rec.id,
			ref: rec.ref,
			at: rec.at,
			quotes: label ? [label, ...item.quotes] : item.quotes,
			...(item.claimsOwner ? { claimsOwner: true } : {}),
			...(item.part && rec.source === "answer" ? { part: item.part } : {}),
			by: "reader",
			...(was ? { was: was.id } : {}),
		};
		const ownerField = (q: string): OwnerField | undefined =>
			q && quoteFound(rec, q) ? { text: q, by: "reader", record: rec.id, at: rec.at } : undefined;
		const target = (of: string): DecisionEntry | undefined => batchIds.get(of) ?? store.get(of.toLowerCase());
		if (item.kind === "new" || ((item.kind === "change" || item.kind === "same") && !target(item.of))) {
			if (item.kind === "same") return undefined;
			// The model's filing comes last (tag, then markers): its answer for the record, else (older
			// answers) for the item.
			const guess =
				recordGuess ??
				(item.kind === "new" && item.initiative && initiatives.some((x) => x.id === item.initiative)
					? item.initiative
					: null);
			const initiative = filed?.initiative ?? guess;
			const entry = store.addDecision({
				initiative,
				filedBy: filed ? filed.by : guess ? "reader" : "",
				title: item.kind === "new" ? item.title : clip(item.what, 60),
				what: item.what,
				at: rec.at,
				...(ownerField(item.impact) ? { impact: ownerField(item.impact) } : {}),
				...(item.kind === "new" && ownerField(item.options) ? { options: ownerField(item.options) } : {}),
				...(ownerField(item.until) ? { until: ownerField(item.until) } : {}),
				sources: [source],
				by: "reader",
			});
			if (item.kind === "new") batchIds.set(item.id, entry);
			return "new";
		}
		const entry = target(item.of)!;
		// A record of another initiative (or of one, for an unfiled decision) lists the decision there too.
		const here = filed?.initiative ?? recordGuess;
		if (here && here !== entry.initiative && !entry.alsoIn?.includes(here))
			entry.alsoIn = [...(entry.alsoIn ?? []), here];
		// Said again, but now as the owner's decision while it wasn't his: that is a change of its own
		// ("re-recorded as yours"), so the page shows when and where his name got attached to it.
		const claimed = item.claimsOwner || recordClaimsOwner(rec, item.quotes);
		if (item.kind === "same" && !(claimed && !this.ownerBacked(entry))) {
			if (entry.sources.some((s) => s.record === rec.id)) return undefined;
			entry.sources.push({ ...source, same: true });
			entry.sources.sort((a, b) => a.at - b.at);
			return "same";
		}
		if (item.kind === "same") {
			if (entry.changes.some((c) => c.sources.some((s) => s.record === rec.id))) return undefined;
			store.addChange(entry, {
				type: "re-recorded",
				what: `Written down as your decision: ${clip(entry.title, 80)}`,
				at: rec.at,
				sources: [{ ...source, claimsOwner: true }],
				by: "reader",
			});
			return "change";
		}
		store.addChange(entry, {
			type: item.type,
			what: item.what,
			at: rec.at,
			...(ownerField(item.until) ? { until: ownerField(item.until) } : {}),
			...(ownerField(item.impact) ? { impact: ownerField(item.impact) } : {}),
			sources: [source],
			by: "reader",
		});
		return "change";
	}
}

function mergeResults(base: BatchResult, ...rest: BatchResult[]): BatchResult {
	const out = { ...base, problems: [...base.problems] };
	for (const r of rest) {
		out.read += r.read;
		out.decisions += r.decisions;
		out.changes += r.changes;
		out.same += r.same;
		out.skipped += r.skipped;
		out.tokens += r.tokens;
		out.problems.push(...r.problems);
		if (r.error) out.error = r.error;
		if (r.limited) out.limited = true;
	}
	return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Status for the page: tokens per day, the cap, unread count, last error. */
export function readerStatus(store: DecisionStore, reader: DecisionReader | undefined, now = Date.now()) {
	const settings = store.settings();
	const state: ReaderState = store.readerState();
	const today = localDay(now);
	const t = state.tokens[today];
	return {
		enabled: settings.enabled,
		model: settings.model,
		lastModel: state.lastModel ?? null,
		dailyTokenCap: settings.dailyTokenCap,
		tokensToday: t ? t.input + t.output : 0,
		capHit: state.capHit === today,
		tokensByDay: Object.fromEntries(Object.entries(state.tokens).map(([d, v]) => [d, v.input + v.output])),
		unread: reader ? reader.unread(settings, state).length : 0,
		lastRun: state.lastRun ?? null,
		lastError: state.lastError ?? null,
		/** Pool accounts resting after a limit refusal -> until when (ms). */
		resting: Object.fromEntries(Object.entries(state.resting ?? {}).filter(([, until]) => until > now)),
	};
}
