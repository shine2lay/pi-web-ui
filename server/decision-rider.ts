/**
 * decision-rider (Ops #98, Data's second ruling rm-8cb70820): the rider check, a small model step of its own.
 *
 * In a dialog he answered, a role wrote the options, and the option he picked can carry a rider: a separate
 * choice the role tucked into its text, on a matter the question didn't put to him. He picked the option for
 * what the question asked, so a rider is the role's decision, not his.
 *
 * The check labels each passage (sentence, "; " clause or line) of the options he picked, their description
 * and preview, "main" or "rider", in one call per record, on fixed input: the record alone, never the
 * reader's points. Code then gives each of the reader's points on the record its part from the passages its
 * quotes cover (rule 17: the model labels fixed passages; which point is a rider is counted in code). The
 * reader's own rider mark is no longer used for dialog answers: it judged the same words differently from run
 * to run (Data's bar check, 2026-10-10).
 */
import type { DecisionModel, DecisionModelCall, DecisionModelReply } from "./decision-model.js";
import type { DecisionRecord } from "./decision-records.js";
import { restatesQuestion, toks } from "./decision-who.js";

export type RiderPart = "main" | "rider";

/** One labelled stretch of a picked option's description or preview. */
export interface RiderPassage {
	/** "P1", "P2", ... in the order of the dialog. */
	id: string;
	/** Index of its question in rec.questions. */
	question: number;
	/** The picked option's label. */
	option: string;
	field: "description" | "preview";
	start: number;
	end: number;
}

/** A preview longer than this is labelled on its first part only (previews are mock-ups and code). */
export const PREVIEW_MAX = 3_000;

/** A text's passages: its lines, cut after ". ", "! ", "? " and at "; ". */
export function passagesOf(text: string): { start: number; end: number }[] {
	const out: { start: number; end: number }[] = [];
	for (const line of text.matchAll(/[^\n]+/g)) {
		const base = line.index ?? 0;
		const s = line[0];
		let from = 0;
		for (const m of s.matchAll(/(?<=[.!?])\s+(?=\S)|;\s+/g)) {
			const at = m.index ?? 0;
			if (s.slice(from, at).trim()) out.push({ start: base + from, end: base + at });
			from = at + m[0].length;
		}
		if (s.slice(from).trim()) out.push({ start: base + from, end: base + s.length });
	}
	return out;
}

function previewOf(o: { preview?: string }): string | undefined {
	const p = o.preview;
	return p ? p.slice(0, PREVIEW_MAX) : undefined;
}

/** The passages the check labels: those of every option he picked that has a description or a preview. */
export function riderPassagesOf(rec: DecisionRecord): RiderPassage[] {
	if (rec.source !== "answer") return [];
	const out: RiderPassage[] = [];
	for (const [qi, q] of (rec.questions ?? []).entries()) {
		const picked = new Set(q.picked ?? []);
		for (const o of q.options ?? []) {
			if (!picked.has(o.label)) continue;
			const fields: ["description" | "preview", string | undefined][] = [
				["description", o.description],
				["preview", previewOf(o as { preview?: string })],
			];
			for (const [field, text] of fields) {
				if (!text?.trim()) continue;
				for (const p of passagesOf(text))
					out.push({ id: `P${out.length + 1}`, question: qi, option: o.label, field, start: p.start, end: p.end });
			}
		}
	}
	return out;
}

export const RIDER_SYSTEM = `You check one dialog that the owner of a small software company answered. An AI role asked him one or more questions and wrote the options; he picked one option per question (or typed his own answer).

He picked an option for what its question asked him. Sometimes the role also tucks a separate choice of its own into the text of an option, on a matter the question didn't ask him about: a rider. He gets a rider by picking the option, but he never chose it; the role did.

Label every numbered passage [P1], [P2], ... of the options he picked:
- "main": the matter the question asks him to decide (what its options differ on), or what picking this option means for that matter: how it works, why, what it costs, changes or leaves out, its limits and details, or words that repeat the question.
- "rider": a separate choice the role settles inside the option, on a matter that neither the question nor its other options raise: for example how something else will run, an order of turns or steps, a rule, a setting, a limit, an owner or a next step that the question never asked about.

Judge each passage against its own question and that question's options. When the question or its other options talk about a passage's matter, it is main.

Answer with JSON only, every passage once: {"labels":{"P1":"main","P2":"rider"}}`;

function oneLine(s: string | undefined): string {
	return String(s ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

/** The dialog as the check reads it: each question, its options, and the picked ones cut into passages. */
export function riderPrompt(rec: DecisionRecord, passages = riderPassagesOf(rec)): string {
	const lines: string[] = [];
	if (rec.title?.trim()) lines.push(`Dialog: ${oneLine(rec.title)}`);
	if (rec.body?.trim()) lines.push(rec.body.trim());
	for (const [qi, q] of (rec.questions ?? []).entries()) {
		lines.push("", `Question ${qi + 1}${q.header ? ` (${oneLine(q.header)})` : ""}: ${oneLine(q.question)}`);
		if (q.detail?.trim()) lines.push(q.detail.trim());
		const picked = new Set(q.picked ?? []);
		for (const o of q.options ?? []) {
			if (!picked.has(o.label)) {
				const preview = previewOf(o as { preview?: string });
				lines.push(`- Option "${o.label}" (not picked)${o.description ? `: ${oneLine(o.description)}` : ""}`);
				if (preview) lines.push(`  Preview: ${oneLine(preview)}`);
				continue;
			}
			lines.push(`- Option "${o.label}" (HE PICKED THIS)`);
			for (const field of ["description", "preview"] as const) {
				const text = field === "description" ? o.description : previewOf(o as { preview?: string });
				const mine = passages.filter((p) => p.question === qi && p.option === o.label && p.field === field);
				if (!text || !mine.length) continue;
				lines.push(field === "description" ? "  Its text:" : "  Its preview:");
				for (const p of mine) lines.push(`  [${p.id}] ${oneLine(text.slice(p.start, p.end))}`);
			}
		}
		if (q.typed?.trim()) lines.push(`- He typed: ${oneLine(q.typed)}`);
	}
	lines.push("", `Label all ${passages.length} passages (${passages.map((p) => p.id).join(", ")}).`);
	return lines.join("\n");
}

/** The check's answer: a label for every passage, or undefined (not JSON, or a passage missing). */
export function parseRiderAnswer(text: string, ids: string[]): Map<string, RiderPart> | undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return undefined;
	let json: unknown;
	try {
		json = JSON.parse(text.slice(start, end + 1));
	} catch {
		return undefined;
	}
	const labels = (json as { labels?: unknown })?.labels;
	if (!labels || typeof labels !== "object") return undefined;
	const out = new Map<string, RiderPart>();
	for (const id of ids) {
		const v = String((labels as Record<string, unknown>)[id] ?? "")
			.trim()
			.toLowerCase();
		if (v !== "main" && v !== "rider") return undefined;
		out.set(id, v);
	}
	return out;
}

/** A quote's share of words in rider passages from which the whole quote counts as rider. */
export const RIDER_SHARE = 0.5;

interface Tagged {
	w: string;
	/** The passage the word is in; undefined for the option's label. */
	passage?: string;
}

/** A picked option's words, label first (as quotes give "Label: description"), each with its passage. */
function optionWords(rec: DecisionRecord, passages: RiderPassage[]): Tagged[][] {
	const out: Tagged[][] = [];
	for (const [qi, q] of (rec.questions ?? []).entries()) {
		const picked = new Set(q.picked ?? []);
		for (const o of q.options ?? []) {
			if (!picked.has(o.label)) continue;
			const tag = (field: "description" | "preview", text: string): Tagged[] =>
				toks(text).map((t) => ({
					w: t.w,
					passage: passages.find(
						(p) =>
							p.question === qi && p.option === o.label && p.field === field && t.start >= p.start && t.end <= p.end,
					)?.id,
				}));
			const label: Tagged[] = toks(o.label).map((t) => ({ w: t.w }));
			if (o.description) out.push([...label, ...tag("description", o.description)]);
			const preview = previewOf(o as { preview?: string });
			if (preview) out.push(tag("preview", preview));
		}
	}
	return out;
}

/** Where a run of words stands in a longer one, or -1. */
function indexOfRun(hay: Tagged[], needle: string[], from = 0): number {
	outer: for (let i = from; i + needle.length <= hay.length; i++) {
		for (let j = 0; j < needle.length; j++) if (hay[i + j].w !== needle[j]) continue outer;
		return i;
	}
	return -1;
}

/** The passages a quote's words are in (a "..." quote's parts in order), or undefined when it isn't there. */
function quotePassages(quote: string, options: Tagged[][]): (string | undefined)[] | undefined {
	const parts = String(quote ?? "")
		.split(/\s*(?:\.\.\.|\u2026)\s*/)
		.map((p) => toks(p).map((t) => t.w))
		.filter((p) => p.length);
	if (!parts.length) return undefined;
	for (const words of options) {
		const got: (string | undefined)[] = [];
		let from = 0;
		let ok = true;
		for (const p of parts) {
			const i = indexOfRun(words, p, from);
			if (i < 0) {
				ok = false;
				break;
			}
			for (let k = i; k < i + p.length; k++) got.push(words[k].passage);
			from = i + p.length;
		}
		if (ok) return got;
	}
	return undefined;
}

/**
 * A point's part from the check's labels: "rider" when one of its quotes in a picked option's text (that
 * doesn't restate the question) has at least half its words in rider passages, else "main". Undefined when
 * none of its quotes is in such text (nothing for the check to judge).
 */
export function partFromLabels(
	rec: DecisionRecord,
	quotes: string[],
	labels: ReadonlyMap<string, RiderPart>,
	passages = riderPassagesOf(rec),
): RiderPart | undefined {
	if (rec.source !== "answer" || !passages.length) return undefined;
	const options = optionWords(rec, passages);
	let judged = false;
	for (const q of quotes) {
		const at = quotePassages(q, options);
		if (!at || !at.some((p) => p !== undefined)) continue;
		if (restatesQuestion(rec, q)) continue;
		judged = true;
		const rider = at.filter((p) => p !== undefined && labels.get(p) === "rider").length;
		if (rider > 0 && rider >= RIDER_SHARE * at.length) return "rider";
	}
	return judged ? "main" : undefined;
}

/** The record needs the check for these points: one of their quotes is in a picked option's own text. */
export function needsRiderCheck(rec: DecisionRecord, quoteSets: string[][]): boolean {
	if (rec.source !== "answer") return false;
	const passages = riderPassagesOf(rec);
	if (!passages.length) return false;
	const options = optionWords(rec, passages);
	return quoteSets.some((qs) =>
		qs.some((q) => {
			const at = quotePassages(q, options);
			return Boolean(at?.some((p) => p !== undefined)) && !restatesQuestion(rec, q);
		}),
	);
}

/** One rider check of a record: its labels (undefined when the call failed or the answer didn't parse), and the reply. */
export async function askRiders(
	model: DecisionModel,
	rec: DecisionRecord,
	call: Omit<DecisionModelCall, "system" | "prompt">,
): Promise<{ labels: Map<string, RiderPart> | undefined; reply: DecisionModelReply; passages: RiderPassage[] }> {
	const passages = riderPassagesOf(rec);
	const reply = await model({ system: RIDER_SYSTEM, prompt: riderPrompt(rec, passages), ...call });
	const labels = reply.ok
		? parseRiderAnswer(
				reply.text,
				passages.map((p) => p.id),
			)
		: undefined;
	return { labels, reply, passages };
}
