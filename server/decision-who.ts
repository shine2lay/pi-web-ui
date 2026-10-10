/**
 * decision-who (task #84, Data rm-3bbf8e94 conditions 1-3): who decided, as two facts side by side,
 * worked out in code from the record's metadata, never from a role's wording or the reader's say-so.
 *
 *   writer   = the role that wrote the record (the chat's role for plans and dialogs, the sender for
 *              messages, the poster for Board posts). The owner is the writer only of his own words:
 *              his dialog pick (and what he typed) and an order's ownerWords.
 *   approval = how it reached a decision: an auto-approved plan, a plan he approved in a dialog, his
 *              pick in a dialog, his order, a message, Board news (plus: a queued task's done note, a
 *              role's question to him, and an entry a role added by hand).
 *
 * "You" only when one of his own records backs the point: the point's quote is word for word in the
 * option he picked (label, description or preview) or in what he typed, inside an order's ownerWords,
 * or in a plan he approved in a dialog ("<role> proposed, you approved"). The reader can only take
 * "you" away (a rider bundled in the option he picked), never grant it. A role's wording that says he
 * decided is flagged when no owner record backs the point.
 */
import type { DecisionRecord } from "./decision-records.js";

export type ApprovalKind =
	| "auto-plan"
	| "dialog-plan"
	| "dialog-pick"
	| "dialog-question"
	| "order"
	| "message"
	| "board-news"
	| "task-report"
	| "role-entry";

/** rider: a role's choice inside the option he picked; claims-owner: a role says he decided, not in his
 * words; quote-not-found: the reader's quote isn't in the record word for word. */
export type WhoFlag = "rider" | "claims-owner" | "quote-not-found";

/** Where a point's quote was found. */
export type QuotePlace =
	| "label"
	| "description"
	| "preview"
	| "typed"
	| "question"
	| "unpicked"
	| "owner-words"
	| "relayer-text"
	| "plan"
	| "text";

export interface WhoSource {
	quotes: string[];
	/** The reader: the wording says the owner decided, requested or "already decided". */
	claimsOwner?: boolean;
	/** The reader, dialog answers: the point is the option's main choice or a rider bundled inside it. */
	part?: "main" | "rider";
	/** Who added the source: "reader" or "role:<id>". */
	by?: string;
	/** A plan change read as what changed: the plan's version before it, where words it took out are found. */
	was?: DecisionRecord;
}

export interface Who {
	/** "owner", a role id, or "" when unknown. */
	writer: string;
	approval: ApprovalKind;
	/** dialog-plan: the role that proposed it. rider: the role whose choice it is. */
	role?: string;
	/** order: the role that relayed it (wrote the order's own text). */
	relayer?: string;
	you: boolean;
	flags: WhoFlag[];
	places: QuotePlace[];
}

// ---------------------------------------------------------------------------
// Word-for-word quotes
// ---------------------------------------------------------------------------

/** Same words, ignoring case, spacing, curly quotes, dash kinds and markdown emphasis. */
export function normText(s: string): string {
	return String(s ?? "")
		.normalize("NFKC")
		.replace(/[\u2018\u2019\u201A\u201B\u2032`]/g, "'")
		.replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
		.replace(/[\u2010-\u2015\u2212]/g, "-")
		.replace(/\u2026/g, "...")
		.replace(/\*\*|__/g, "")
		.replace(/\s+/g, " ")
		.replace(/\s*-\s*/g, "-")
		.trim()
		.toLowerCase();
}

function trimQuote(q: string): string {
	return normText(q).replace(/^[\s"'.,;:!?()[\]-]+|[\s"'.,;:!?()[\]-]+$/g, "");
}

/** The quote is in the text word for word ("..." in the quote skips words, in order). */
export function quoteIn(quote: string, text: string | undefined): boolean {
	if (!text) return false;
	const q = trimQuote(quote);
	if (!q) return false;
	const t = normText(text);
	let pos = 0;
	for (const part of q.split(/\s*\.\.\.\s*/)) {
		const p = part.replace(/^[\s"'.,;:!?()[\]-]+|[\s"'.,;:!?()[\]-]+$/g, "");
		if (!p) continue;
		const i = t.indexOf(p, pos);
		if (i < 0) return false;
		pos = i + p.length;
	}
	return true;
}

/** A quote long enough to stand for a point: two words or more, or the whole field. */
function enough(quote: string, field: string): boolean {
	const q = trimQuote(quote);
	if (q.split(/\s+/).filter(Boolean).length >= 2) return true;
	return q.length > 0 && q === trimQuote(field);
}

// ---------------------------------------------------------------------------
// A role's wording that says the owner decided
// ---------------------------------------------------------------------------

const CLAIM =
	/\b(?:(?:the )?owner(?:'s)?|his|you(?:r)?)\b[^.!?\n]{0,40}?\b(?:decided|decides|decision|decisions|chose|chosen|choice|picked|approved|asked for|requested|request|ordered|order|wants|wanted|agreed)\b|\b(?:already decided|decided by the owner|owner-decided|on the owner's (?:ask|request|decision|order))\b/i;

/** The text says the owner decided, chose, requested or ordered something (a role's own entry). */
export function textClaimsOwner(text: string): boolean {
	return CLAIM.test(String(text ?? "").replace(/[\u2018\u2019]/g, "'"));
}

/** The record says of itself that it records the owner's decision ("This is a record of his decision"):
 *  everything in it is given as his. */
const RECORD_CLAIM =
	/\b(?:this|it|the following|below)\b[^.!?\n]{0,30}\b(?:is|are)\b[^.!?\n]{0,20}\brecords?\b[^.!?\n]{0,20}\b(?:his|the owner's|owner)\b[^.!?\n]{0,15}\b(?:decisions?|orders?|choices?)\b/i;

/** "Owner (temper chat, 10-03):" at the head of a line: what follows on it is given as his. */
const ATTRIBUTION = /^\W*(?:the\s+)?owner\b[^:\n]{0,80}:/i;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
const indentOf = (l: string): number => l.length - l.trimStart().length;
const claims = (s: string): boolean => CLAIM.test(s.replace(/[\u2018\u2019]/g, "'"));

/** The line holding the quote starts with an owner attribution, or a line that introduces it (a list's
 *  head ending with a colon, or the paragraph's head) says it is the owner's. */
function scopeClaims(text: string, quote: string): boolean {
	const lines = String(text ?? "").split(/\r?\n/);
	const first = quote.split(/\s*(?:\.\.\.|\u2026)\s*/).find((x) => x.trim()) ?? quote;
	const qi = lines.findIndex((l) => quoteIn(first, l));
	if (qi < 0) return false;
	if (ATTRIBUTION.test(lines[qi])) return true;
	let ind = indentOf(lines[qi]);
	let item = LIST_ITEM.test(lines[qi]);
	for (let k = qi - 1; k >= 0; k--) {
		const l = lines[k];
		if (!l.trim()) break;
		const li = indentOf(l);
		const lItem = LIST_ITEM.test(l);
		const parent = li < ind || (item && !lItem && li <= ind);
		if (!parent) continue;
		const bare = l.replace(/\([^)]*\)/g, "").replace(/[*_`\s]+$/g, "");
		if (/:$/.test(bare) && claims(l)) return true;
		if (!lItem) return ATTRIBUTION.test(l);
		ind = li;
		item = lItem;
	}
	return false;
}

/** Words too common to tie a list head to a sentence. */
const STOP = new Set(
	"and the for are was but not all any one two with this that from only what when then them they have more also each some into over after before about there their which will would should could other these those its his her our your".split(
		" ",
	),
);

/** The content words of a text, lower case, a plural's "s" dropped ("A round:" -> round). */
function contentWords(s: string): Set<string> {
	const out = new Set<string>();
	for (const w of normText(s).match(/[a-z][a-z0-9-]{2,}/g) ?? []) {
		if (STOP.has(w)) continue;
		out.add(w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
	}
	return out;
}

/** What a sentence credits to the owner: the words after "Owner (...) chose" or "Owner (...):". */
function creditedPart(s: string): string | undefined {
	const t = s.replace(/[\u2018\u2019]/g, "'");
	const m = CLAIM.exec(t);
	if (m) return t.slice(m.index + m[0].length);
	const a = ATTRIBUTION.exec(t);
	return a ? t.slice(a.index + a[0].length) : undefined;
}

/** The quote is a list item under a head ("A round:") that spells out something an earlier sentence of
 *  the same field credits to the owner ("Owner (temper chat) chose review rounds, ..."): the details are
 *  given as part of his choice, though his own words never had them (Data's E20). A head on another
 *  topic ("Run view:", "Pause:") isn't. */
export function sectionClaims(field: string, quote: string): boolean {
	const lines = String(field ?? "").split(/\r?\n/);
	const first = quote.split(/\s*(?:\.\.\.|\u2026)\s*/).find((x) => x.trim()) ?? quote;
	const qi = lines.findIndex((l) => quoteIn(first, l));
	if (qi < 0 || !LIST_ITEM.test(lines[qi])) return false;
	const ind = indentOf(lines[qi]);
	let head = -1;
	for (let k = qi - 1; k >= 0; k--) {
		const l = lines[k];
		if (!l.trim()) break;
		if (LIST_ITEM.test(l) && indentOf(l) >= ind) continue;
		if (/:$/.test(l.replace(/\([^)]*\)/g, "").replace(/[*_`\s]+$/g, ""))) head = k;
		break;
	}
	if (head < 0) return false;
	const headWords = contentWords(lines[head]);
	if (!headWords.size) return false;
	const before = lines.slice(0, head).join("\n").replace(/\s+/g, " ");
	for (const s of before.split(/(?<=[.!?])\s+|;\s+/)) {
		const part = creditedPart(s);
		if (!part) continue;
		const words = contentWords(part);
		for (const w of headWords) if (words.has(w)) return true;
	}
	return false;
}

/** The record's wording credits the owner with one of the quotes: the sentence or scope around it
 *  (wordingClaimsOwner), or a section spelling out a choice credited to him (sectionClaims; a plan's
 *  Decided field, a message's or a post's text). */
export function recordClaimsOwner(rec: DecisionRecord, quotes: string[]): boolean {
	if (wordingClaimsOwner(recordText(rec), quotes)) return true;
	const field =
		rec.source === "plan"
			? rec.plan?.decided
			: rec.source === "message" || rec.source === "board"
				? rec.text
				: undefined;
	return Boolean(field) && quotes.some((q) => sectionClaims(field as string, q));
}

/** The wording around one of the quotes says the owner decided it: its sentence, its line's owner
 *  attribution, or the list head or paragraph head that introduces it. */
export function wordingClaimsOwner(text: string, quotes: string[]): boolean {
	if (quotes.some((q) => quoteIn(q, text)) && RECORD_CLAIM.test(String(text ?? "").replace(/[\u2018\u2019]/g, "'")))
		return true;
	const flat = String(text ?? "").replace(/\s+/g, " ");
	const sentences = flat.split(/(?<=[.!?])\s+|\s+-\s+|;\s+/);
	for (const s of sentences) {
		if (!quotes.some((q) => quoteIn(q, s))) continue;
		if (claims(s)) return true;
	}
	return quotes.some((q) => scopeClaims(text, q));
}

// ---------------------------------------------------------------------------
// The record's fields, by who wrote them
// ---------------------------------------------------------------------------

export function planText(rec: DecisionRecord): string {
	const p = rec.plan ?? {};
	return [p.title, p.goal, p.doneWhen, p.decided, p.steps, p.verify, p.mustNot, rec.summary].filter(Boolean).join("\n");
}

/** Everything a record says, for quote checks and marker matching. */
export function recordText(rec: DecisionRecord): string {
	const parts: (string | undefined)[] = [rec.title, rec.text, rec.ownerWords, rec.body, rec.summary];
	if (rec.plan) parts.push(planText(rec));
	for (const q of rec.questions ?? []) {
		parts.push(q.header, q.question, q.detail, q.typed);
		for (const o of q.options ?? []) parts.push(o.label, o.description, (o as { preview?: string }).preview);
	}
	return parts.filter(Boolean).join("\n");
}

/** A quote is found word for word in the record: in its text, or in a picked option written as one line
 *  ("Label: description", "Label - description"), as quotes of a dialog answer often give it. */
export function quoteFound(rec: DecisionRecord, quote: string): boolean {
	if (quoteIn(quote, recordText(rec))) return true;
	return rec.source === "answer" && answerFields(rec).some((f) => quoteIn(quote, f.text));
}

function askingRole(rec: DecisionRecord): string {
	if (typeof rec.to === "string" && rec.to && rec.to !== "owner") return rec.to;
	return rec.chat ?? "";
}

interface Field {
	place: QuotePlace;
	text: string;
	owner: boolean;
	/** A question's own text, when he picked an option that approves what it proposes ("Go ahead"). */
	approved?: boolean;
}

/** A picked option that approves what the question proposes, rather than choosing between ways. */
const APPROVAL_PICK =
	/^\W*(?:go ahead|yes|approve[ds]?|accept(?:ed)?|agree[ds]?|ok(?:ay)?|proceed|do it|confirm(?:ed)?|take (?:[\w'\u2019-]+ ){0,3}(?:advice|recommendation|plan|proposal))\b/i;

function answerFields(rec: DecisionRecord): Field[] {
	const out: Field[] = [];
	let anyApproval = false;
	for (const q of rec.questions ?? []) {
		const picked = new Set(q.picked ?? []);
		const approved = [...picked].some((l) => APPROVAL_PICK.test(l));
		anyApproval ||= approved;
		for (const o of q.options ?? []) {
			const own = picked.has(o.label);
			const preview = (o as { preview?: string }).preview;
			if (own) {
				out.push({ place: "label", text: o.label, owner: true });
				if (o.description) {
					out.push({ place: "description", text: o.description, owner: true });
					// The option as one line, as quotes often give it: "Label: description", "Label - description".
					for (const sep of [": ", " - ", " \u2014 ", ". "])
						out.push({ place: "description", text: `${o.label}${sep}${o.description}`, owner: true });
				}
				if (preview) out.push({ place: "preview", text: preview, owner: true });
			} else {
				out.push({
					place: "unpicked",
					text: [o.label, o.description, preview].filter(Boolean).join("\n"),
					owner: false,
				});
			}
		}
		if (q.typed) out.push({ place: "typed", text: q.typed, owner: true });
		out.push({
			place: "question",
			text: [q.header, q.question, q.detail].filter(Boolean).join("\n"),
			owner: false,
			approved,
		});
	}
	out.push({
		place: "question",
		text: [rec.title, rec.body].filter(Boolean).join("\n"),
		owner: false,
		approved: anyApproval,
	});
	return out;
}

/**
 * The label of the option he picked whose description or preview holds these quotes, when no quote gives the
 * label already. The reader adds it to his main pick, so the card says which option he chose whatever words
 * the model quoted from it.
 */
export function pickedLabel(rec: DecisionRecord, quotes: string[]): string | undefined {
	if (rec.source !== "answer" || !quotes.length) return undefined;
	for (const q of rec.questions ?? []) {
		const picked = new Set(q.picked ?? []);
		for (const o of q.options ?? []) {
			if (!picked.has(o.label)) continue;
			const preview = (o as { preview?: string }).preview;
			const body = [o.description, preview].filter(Boolean).join("\n");
			const inside = quotes.some(
				(qt) => quoteIn(qt, body) || (o.description && quoteIn(qt, `${o.label}: ${o.description}`)),
			);
			if (!inside) continue;
			const bare = o.label.replace(/\s*\((?:recommended|default)\)\s*$/i, "");
			if (quotes.some((qt) => quoteIn(bare, qt) || quoteIn(qt, o.label))) return undefined;
			return o.label;
		}
	}
	return undefined;
}

/** For each quote: the first field it is in (owner fields first), or undefined. */
function locate(quotes: string[], fields: Field[]): ({ field: Field; quote: string } | undefined)[] {
	const ordered = [...fields.filter((f) => f.owner), ...fields.filter((f) => !f.owner)];
	return quotes.map((quote) => {
		const field = ordered.find((f) => quoteIn(quote, f.text));
		return field ? { field, quote } : undefined;
	});
}

function plain(
	writer: string,
	approval: ApprovalKind,
	rec: DecisionRecord,
	src: WhoSource,
	text: string,
	place: QuotePlace,
): Who {
	const flags: WhoFlag[] = [];
	const found = src.quotes.filter((q) => quoteIn(q, text));
	if (src.quotes.length === 0 || found.length < src.quotes.length) flags.push("quote-not-found");
	if (src.claimsOwner || recordClaimsOwner(rec, src.quotes)) flags.push("claims-owner");
	return { writer, approval, you: false, flags, places: found.length ? [place] : [] };
}

// ---------------------------------------------------------------------------
// who
// ---------------------------------------------------------------------------

/** Who decided, for one record and the point the reader (or a role) found in it. */
export function whoOf(rec: DecisionRecord | undefined, src: WhoSource): Who {
	const quotes = (src.quotes ?? []).filter((q) => typeof q === "string" && q.trim());
	const s: WhoSource = { ...src, quotes };
	if (!rec) {
		const role = (src.by ?? "").replace(/^role:/, "");
		return {
			writer: role,
			approval: "role-entry",
			you: false,
			flags: src.claimsOwner ? ["claims-owner"] : [],
			places: [],
		};
	}
	switch (rec.source) {
		case "answer":
			return whoOfAnswer(rec, s);
		case "board":
			if (rec.kind === "order") return whoOfOrder(rec, s);
			return plain(rec.from, "board-news", rec, s, recordText(rec), "text");
		case "message":
			return plain(rec.from, "message", rec, s, recordText(rec), "text");
		case "plan": {
			const role = rec.from || rec.chat || "";
			if (rec.op === "done") return plain(role, "task-report", rec, s, recordText(rec), "plan");
			// A change may take words out of the plan: those are found in the version before it.
			const planWords = s.was?.source === "plan" ? `${recordText(rec)}\n${planText(s.was)}` : recordText(rec);
			if (rec.approval === "dialog") {
				const text = planWords;
				const all = quotes.length > 0 && quotes.every((q) => quoteIn(q, text));
				return {
					writer: role,
					approval: "dialog-plan",
					role,
					you: all,
					flags: all ? [] : ["quote-not-found"],
					places: all ? ["plan"] : [],
				};
			}
			return plain(role, "auto-plan", rec, s, planWords, "plan");
		}
		default:
			return plain(rec.from, "message", rec, s, recordText(rec), "text");
	}
}

function whoOfAnswer(rec: DecisionRecord, src: WhoSource): Who {
	const role = askingRole(rec);
	const located = locate(src.quotes, answerFields(rec));
	const places = [...new Set(located.filter(Boolean).map((l) => l!.field.place))];
	const flags: WhoFlag[] = [];
	if (src.quotes.length === 0 || located.some((l) => !l)) {
		flags.push("quote-not-found");
		return { writer: role, approval: "dialog-question", you: false, flags, places };
	}
	const own = located.filter((l) => l!.field.owner && enough(l!.quote, l!.field.text));
	const unpicked = located.some((l) => l!.field.place === "unpicked");
	// He picked "Go ahead" (or the like) on a question that proposes it: "<role> proposed, you approved".
	// Every point of the proposal is in what he approved, so the reader's rider mark (which is about a
	// choice riding inside the option he picked) doesn't apply here.
	if (!own.length && !unpicked && located.every((l) => l!.field.approved && enough(l!.quote, l!.field.text))) {
		return { writer: role, approval: "dialog-plan", role, you: true, flags, places };
	}
	if (!own.length || unpicked) {
		if (src.claimsOwner) flags.push("claims-owner");
		return { writer: role, approval: "dialog-question", you: false, flags, places };
	}
	if (src.part === "rider") {
		flags.push("rider");
		return { writer: role, approval: "dialog-pick", role, you: false, flags, places };
	}
	return { writer: "owner", approval: "dialog-pick", you: true, flags, places };
}

function whoOfOrder(rec: DecisionRecord, src: WhoSource): Who {
	const relayer = rec.via ?? (rec.from !== "owner" ? rec.from : "");
	const own = rec.ownerWords ?? "";
	const relayed = [rec.title, rec.text].filter(Boolean).join("\n");
	const inOwn = src.quotes.filter((q) => quoteIn(q, own) && enough(q, own));
	const inRelayed = src.quotes.filter((q) => !quoteIn(q, own) && quoteIn(q, relayed));
	const missing = src.quotes.filter((q) => !quoteIn(q, own) && !quoteIn(q, relayed));
	const places: QuotePlace[] = [];
	if (inOwn.length) places.push("owner-words");
	if (inRelayed.length) places.push("relayer-text");
	if (src.quotes.length === 0 || missing.length) {
		return { writer: relayer, approval: "order", relayer, you: false, flags: ["quote-not-found"], places };
	}
	// Every quote in his own words: his order. A point quoted partly from the relayer's text isn't all his.
	if (inOwn.length === src.quotes.length)
		return { writer: "owner", approval: "order", relayer, you: true, flags: [], places };
	// (Partly) only in the relayer's text: an order says it's his, his words don't.
	return { writer: relayer, approval: "order", relayer, you: false, flags: ["claims-owner"], places };
}

// ---------------------------------------------------------------------------
// An entry (a decision or a change) with several sources
// ---------------------------------------------------------------------------

export interface SourceWho {
	who: Who;
	at: number;
}

export interface EntryWho {
	/** The source shown in the entry's head: the first one his own record backs, else the earliest. */
	head: number;
	you: boolean;
	/** Flags shown on the entry. claims-owner is dropped when one of his own records backs the point. */
	flags: WhoFlag[];
}

export function entryWho(sources: SourceWho[]): EntryWho {
	if (!sources.length) return { head: -1, you: false, flags: [] };
	const order = sources.map((s, i) => ({ s, i })).sort((a, b) => a.s.at - b.s.at);
	const backed = order.find((x) => x.s.who.you);
	const flags = new Set<WhoFlag>();
	for (const { s } of order) for (const f of s.who.flags) flags.add(f);
	if (backed) flags.delete("claims-owner");
	const head = backed ? backed.i : order[0].i;
	return { head, you: Boolean(backed), flags: [...flags] };
}
