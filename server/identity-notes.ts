/**
 * A role's notes (layer 2 of its memory) and their index (part of layer 1, sent with every message).
 * Plain logic with node imports only: pi-web-ui keeps a byte-identical copy (server/identity-notes.ts) for
 * its Notebook tab, and a test there fails when the two differ, so change this file, then copy it over.
 *
 * A role's memory has two layers, both written for the AI alone (compact; see templates/role-section.md):
 *   rules  notebook.md: what applies to almost every task, sent whole with every message.
 *   notes  <role>/notes/<id>.md, unlimited: findings, results, lessons, decisions with their reason,
 *          incidents and their fix, each a one-line summary plus its full detail. Only the index goes out
 *          with every message (the newest summaries, older ones rolled into digests); the rest is found
 *          with search and read with open, like ACP's compressed blocks (search_context, decompress).
 * Rules and index together stay within the role's cap (notebookCap): the rules get the cap minus the
 * index budget, and the index whatever room the rules leave, at most its budget.
 *
 * A note file: header lines "key: value" (id, date, chat, topic, summary; when they apply: tier and covers
 * for a digest, digest for a note one rolls up, outdated, rule), a line "---", then the detail. Ids: n<k>
 * for a note; d<k> for a digest, which rolls up notes (tier 2) or digests (tier 3, an overview). A file
 * that isn't in this shape (written by hand) still reads: its first line is the summary.
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The notes folder's name in a role's folder, by default (pi-identity.json's notesDir sets it). */
export const NOTES_DIR = "notes";
/** The index's share of the cap, by default (pi-identity.json's indexBudget, or a role's memory.indexBudget). */
export const INDEX_BUDGET = 2_000;
/** A summary is one index line; anything longer belongs in the detail. */
export const SUMMARY_MAX = 240;
export const TOPIC_MAX = 40;
/** Bytes per token for the estimate shown (o200k on the notebooks of 2026-10-01). Display only: caps are in characters. */
export const BYTES_PER_TOKEN = 3.6;
/** How many hits a search gives by default, and at most. */
export const SEARCH_HITS = 8;
export const SEARCH_MAX = 20;

export const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");
export const estTokens = (bytes: number): number => Math.round(bytes / BYTES_PER_TOKEN);

export interface MemoryCaps {
	/** Rules and index together, in bytes. */
	notebookCap: number;
	/** Past this (rules and index together), an add to the rules asks to tidy first. */
	tidyAt: number;
	/** The index's share of notebookCap. */
	indexBudget: number;
}

/** The most the rules may hold: the cap minus the index's budget. */
export const rulesCap = (caps: MemoryCaps): number => Math.max(0, caps.notebookCap - caps.indexBudget);

/** The room the index gets: its budget, or less when the rules (an older, bigger notebook) leave less. */
export const indexRoom = (caps: MemoryCaps, rulesBytes: number): number =>
	Math.max(0, Math.min(caps.indexBudget, caps.notebookCap - rulesBytes));

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

export interface Note {
	id: string;
	/** 1: a note; 2: a digest of notes; 3: a digest of digests (an overview). */
	tier: number;
	/** YYYY-MM-DD it was written. */
	date: string;
	/** Who wrote it: the first 8 characters of the chat's session id, "owner" or "tidy". */
	chat: string;
	topic: string;
	summary: string;
	detail: string;
	/** A digest: the ids it rolls up. */
	covers: string[];
	/** The digest that rolls this one up: the index shows that digest instead. */
	digest: string;
	/** "<date> <why>" once outdated: left out of the index, flagged in search. */
	outdated: string;
	/** "<date>" once it became a rule: left out of the index, flagged in search. */
	rule: string;
	/** Header lines this code doesn't know, kept as they were. */
	extra: string[];
	/** The file's size in bytes. */
	size: number;
}

const ID_RE = /^[nd][1-9]\d{0,6}$/;
const FILE_RE = /^([nd][1-9]\d{0,6})\.md$/;
const KEY_RE = /^([a-z]+):\s?(.*)$/;

export const isNoteId = (id: string): boolean => ID_RE.test(id);
const numOf = (id: string) => Number(id.slice(1));

/** One line, trimmed, with no list bullet in front. */
export function oneLine(text: string): string {
	return text
		.replace(/\s*\n\s*/g, " ")
		.trim()
		.replace(/^[-*•]\s+/, "")
		.trim();
}

/** A topic: one short line, no brackets. */
export function cleanTopic(topic: string): string {
	return oneLine(topic).replace(/[[\]]/g, "").slice(0, TOPIC_MAX).trim();
}

const blankNote = (id: string): Note => ({
	id,
	tier: id.startsWith("d") ? 2 : 1,
	date: "",
	chat: "",
	topic: "",
	summary: "",
	detail: "",
	covers: [],
	digest: "",
	outdated: "",
	rule: "",
	extra: [],
	size: 0,
});

/** A note file's text, read. Its id is the file's name, whatever the text says. */
export function parseNote(text: string, id: string): Note {
	const note = blankNote(id);
	const rows = text.replace(/\r\n/g, "\n").split("\n");
	const sep = rows.indexOf("---");
	const head = sep === -1 ? [] : rows.slice(0, sep);
	if (sep < 1 || !head.every((row) => !row.trim() || KEY_RE.test(row))) {
		const body = text.trim().split("\n");
		note.summary = oneLine(body[0] ?? "");
		note.detail = body.slice(1).join("\n").trim();
	} else {
		for (const row of head) {
			const m = KEY_RE.exec(row);
			if (!m) continue;
			const [, key, raw] = m;
			const value = raw.trim();
			if (key === "id") continue;
			else if (key === "tier") note.tier = Math.min(3, Math.max(1, Number.parseInt(value, 10) || note.tier));
			else if (key === "date") note.date = value;
			else if (key === "chat") note.chat = value;
			else if (key === "topic") note.topic = value;
			else if (key === "summary") note.summary = value;
			else if (key === "covers") note.covers = value.split(/[\s,]+/).filter(isNoteId);
			else if (key === "digest") note.digest = isNoteId(value) ? value : "";
			else if (key === "outdated") note.outdated = value || "yes";
			else if (key === "rule") note.rule = value || "yes";
			else note.extra.push(row);
		}
		note.detail = rows.slice(sep + 1).join("\n").trim();
	}
	if (id.startsWith("n")) note.tier = 1;
	else if (note.tier < 2) note.tier = 2;
	note.size = byteLength(text);
	return note;
}

/** A note's file text. */
export function formatNote(note: Note): string {
	const rows = [`id: ${note.id}`];
	if (note.tier > 1) rows.push(`tier: ${note.tier}`);
	rows.push(`date: ${note.date}`, `chat: ${note.chat}`, `topic: ${note.topic}`, `summary: ${note.summary}`);
	if (note.covers.length) rows.push(`covers: ${note.covers.join(" ")}`);
	if (note.digest) rows.push(`digest: ${note.digest}`);
	if (note.outdated) rows.push(`outdated: ${note.outdated}`);
	if (note.rule) rows.push(`rule: ${note.rule}`);
	rows.push(...note.extra, "---");
	const detail = note.detail.trim();
	return `${rows.join("\n")}\n${detail ? `${detail}\n` : ""}`;
}

/** The notes folder of a role. */
export const notesPath = (roleDir: string, notesDir: string = NOTES_DIR): string => join(roleDir, notesDir);
export const notePath = (roleDir: string, notesDir: string, id: string): string => join(roleDir, notesDir, `${id}.md`);

/** Newest first: by date, then a note before a digest of the same day, then by number. */
export function byNewest(a: Note, b: Note): number {
	if (a.date !== b.date) return a.date < b.date ? 1 : -1;
	if (a.tier !== b.tier) return a.tier - b.tier;
	return numOf(b.id) - numOf(a.id);
}

/** Every note in a role's notes folder, newest first. Unreadable files are skipped. */
export function listNotes(roleDir: string, notesDir: string = NOTES_DIR): Note[] {
	const dir = notesPath(roleDir, notesDir);
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const notes: Note[] = [];
	for (const name of names) {
		const m = FILE_RE.exec(name);
		if (!m) continue;
		try {
			notes.push(parseNote(readFileSync(join(dir, name), "utf8"), m[1]));
		} catch {
			// gone or unreadable: skip it
		}
	}
	return notes.sort(byNewest);
}

/** One note, or null. */
export function readNote(roleDir: string, notesDir: string, id: string): { note: Note; text: string } | null {
	if (!isNoteId(id)) return null;
	try {
		const text = readFileSync(notePath(roleDir, notesDir, id), "utf8");
		return { note: parseNote(text, id), text };
	} catch {
		return null;
	}
}

/** Write a file whole, never half: a temp file next to it, then a rename. */
function writeAtomic(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	const fd = openSync(tmp, "w");
	try {
		writeSync(fd, text);
	} finally {
		closeSync(fd);
	}
	renameSync(tmp, path);
}

/** Save a note (its id names the file). Returns its size. */
export function saveNote(roleDir: string, notesDir: string, note: Note): number {
	const text = formatNote(note);
	writeAtomic(notePath(roleDir, notesDir, note.id), text);
	note.size = byteLength(text);
	return note.size;
}

/** The highest number given so far with this prefix: in the folder, and among deleted notes (removed.md). */
function highest(roleDir: string, notesDir: string, prefix: "n" | "d"): number {
	let max = 0;
	try {
		for (const name of readdirSync(notesPath(roleDir, notesDir))) {
			const m = FILE_RE.exec(name);
			if (m && m[1].startsWith(prefix)) max = Math.max(max, numOf(m[1]));
		}
	} catch {
		// no folder yet
	}
	try {
		const removed = readFileSync(join(roleDir, "removed.md"), "utf8");
		for (const m of removed.matchAll(/^<!-- .* note ([nd][1-9]\d{0,6}) /gm)) {
			if (m[1].startsWith(prefix)) max = Math.max(max, numOf(m[1]));
		}
	} catch {
		// nothing removed yet
	}
	return max;
}

export interface NewNote {
	tier?: number;
	date: string;
	chat: string;
	topic: string;
	summary: string;
	detail?: string;
	covers?: string[];
}

/** Write a new note under the next free id (never one a deleted note had). Two chats at once never collide. */
export function createNote(roleDir: string, notesDir: string, fields: NewNote): Note {
	const tier = Math.min(3, Math.max(1, fields.tier ?? 1));
	const prefix = tier > 1 ? "d" : "n";
	mkdirSync(notesPath(roleDir, notesDir), { recursive: true });
	let k = highest(roleDir, notesDir, prefix) + 1;
	for (let tries = 0; tries < 100; tries++, k++) {
		const note: Note = {
			...blankNote(`${prefix}${k}`),
			tier,
			date: fields.date,
			chat: fields.chat,
			topic: fields.topic,
			summary: fields.summary,
			detail: fields.detail ?? "",
			covers: fields.covers ?? [],
		};
		const text = formatNote(note);
		let fd: number;
		try {
			fd = openSync(notePath(roleDir, notesDir, note.id), "wx");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
			throw err;
		}
		try {
			writeSync(fd, text);
		} finally {
			closeSync(fd);
		}
		note.size = byteLength(text);
		return note;
	}
	throw new Error("no free note id (100 tries)");
}

/**
 * Keep a deleted or replaced note in the role's removed.md (never searched, never lost). The comment line
 * names the note, so its id is never given again.
 */
export function keepNoteRemoved(roleDir: string, roleId: string, noteId: string, text: string, stamp: string, why: string): void {
	const path = join(roleDir, "removed.md");
	mkdirSync(roleDir, { recursive: true });
	const head = existsSync(path) ? "" : `# Lines removed from the ${roleId} notebook\n`;
	appendFileSync(path, `${head}\n<!-- ${stamp} note ${noteId} ${why} -->\n${text.trimEnd()}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

export interface IndexResult {
	/** What's sent: the index, cut to its room. */
	text: string;
	size: number;
	/** What the whole index would take: past the budget, the role's chat is asked to distill. */
	full: number;
	/** Items (notes and digests) in the whole index, and how many were cut for room. */
	items: number;
	hidden: number;
	/** The whole index is over its budget. */
	over: boolean;
}

/** In the index: not rolled up into a digest, not outdated, not made a rule. */
export const inIndex = (note: Note): boolean => !note.digest && !note.outdated && !note.rule;

const topicKey = (topic: string) => topic.trim().toLowerCase() || "general";

/**
 * The index of the notes: by topic (the topic with the newest note first), each topic's notes newest
 * first and then its digests; cut to `room` bytes by leaving out the oldest notes (digests last), with a
 * last line saying how many. `budget` decides `over`.
 */
export function buildIndex(notes: Note[], room: number, budget: number = room): IndexResult {
	const items = notes.filter(inIndex).sort(byNewest);
	const groups = new Map<string, { title: string; items: Note[] }>();
	for (const note of items) {
		const key = topicKey(note.topic);
		let g = groups.get(key);
		if (!g) {
			g = { title: note.topic.trim() || "general", items: [] };
			groups.set(key, g);
		}
		g.items.push(note);
	}
	for (const g of groups.values()) g.items.sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : byNewest(a, b)));
	const lineOf = (note: Note) => `${note.id} ${note.summary || "(no summary)"}`;
	const render = (shown: Set<string>, hidden: number) => {
		const rows: string[] = [];
		for (const g of groups.values()) {
			const keep = g.items.filter((x) => shown.has(x.id));
			if (!keep.length) continue;
			rows.push(`[${g.title}]`, ...keep.map(lineOf));
		}
		if (hidden) rows.push(`+${hidden} older (notebook search)`);
		return rows.join("\n");
	};
	const all = new Set(items.map((x) => x.id));
	const whole = render(all, 0);
	const full = byteLength(whole);
	const over = full > budget;
	if (full <= room) return { text: whole, size: full, full, items: items.length, hidden: 0, over };
	// Leave out the oldest notes first, digests last, until it fits.
	const order = [...items].sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : -byNewest(a, b)));
	const shown = new Set(all);
	let text = whole;
	for (const note of order) {
		shown.delete(note.id);
		text = render(shown, items.length - shown.size);
		if (byteLength(text) <= room) break;
	}
	if (byteLength(text) > room && shown.size === 0) text = render(shown, items.length);
	return { text, size: byteLength(text), full, items: items.length, hidden: items.length - shown.size, over };
}

/** Counts for /identity and the Notebook tab. */
export function noteCounts(notes: Note[]): { notes: number; digests: number; outdated: number; rules: number } {
	return {
		notes: notes.filter((n) => n.tier === 1).length,
		digests: notes.filter((n) => n.tier > 1).length,
		outdated: notes.filter((n) => !!n.outdated).length,
		rules: notes.filter((n) => !!n.rule).length,
	};
}

// ---------------------------------------------------------------------------
// Distilling (tier 1 -> 2 -> 3)
// ---------------------------------------------------------------------------

export type DistillPlan =
	| { ok: true; tier: number; covers: Note[]; topic: string; detail: string }
	| { ok: false; reason: string };

/**
 * Check a digest of `ids`: at least two, all there, none rolled up already; notes give a tier-2 digest,
 * digests a tier-3 overview. Its detail lists what it rolls up, so opening it shows the way in.
 */
export function planDistill(notes: Note[], ids: string[], topic: string): DistillPlan {
	const want = [...new Set(ids.map((x) => x.trim()).filter(Boolean))];
	if (want.length < 2) return { ok: false, reason: "Not distilled: give at least two ids (space-separated) to roll into one digest." };
	const byId = new Map(notes.map((n) => [n.id, n]));
	const missing = want.filter((x) => !byId.has(x));
	if (missing.length) return { ok: false, reason: `Not distilled: no note ${missing.join(", ")}.` };
	const covers = want.map((x) => byId.get(x) as Note);
	const taken = covers.filter((n) => n.digest);
	if (taken.length) {
		return { ok: false, reason: `Not distilled: ${taken.map((n) => `${n.id} is in ${n.digest}`).join(", ")} already (distill the digest instead).` };
	}
	const tier = Math.min(3, Math.max(...covers.map((n) => n.tier)) + 1);
	const topics = [...new Set(covers.map((n) => topicKey(n.topic)))];
	const chosen = cleanTopic(topic) || (topics.length === 1 ? covers[0].topic : "");
	if (!chosen) return { ok: false, reason: `Not distilled: they're on different topics (${topics.join(", ")}); give the digest's topic.` };
	const detail = covers
		.map((n) => `${n.id} ${n.date} ${n.summary}${n.outdated ? " (outdated)" : ""}${n.rule ? " (now a rule)" : ""}`)
		.join("\n");
	return { ok: true, tier, covers, topic: chosen, detail };
}

/** A digest gone: what it rolled up shows in the index again. Returns the notes it let go. */
export function releaseDigest(roleDir: string, notesDir: string, digestId: string): string[] {
	const freed: string[] = [];
	for (const note of listNotes(roleDir, notesDir)) {
		if (note.digest !== digestId) continue;
		note.digest = "";
		saveNote(roleDir, notesDir, note);
		freed.push(note.id);
	}
	return freed;
}

// ---------------------------------------------------------------------------
// Search and open
// ---------------------------------------------------------------------------

export interface Hit {
	/** n12, d3, or archive/<file>:<line> */
	ref: string;
	score: number;
	size: number;
	date: string;
	topic: string;
	/** outdated, rule, in d3, old */
	flags: string[];
	summary: string;
	preview: string;
}

const STOP = new Set(
	"a an and are as at be by do does for from how in into is it its of on or that the this to was what when where which who why with".split(" "),
);

/** The words of a query: lowercase, no stop words (a word matches inside longer ones: "deploy" finds "pi-web-deploy"). */
export function queryTerms(query: string): string[] {
	const out: string[] = [];
	for (const raw of query.toLowerCase().split(/\s+/)) {
		const word = raw.replace(/^[^\p{L}\p{N}~/.]+|[^\p{L}\p{N}]+$/gu, "");
		if (word.length < 2 || STOP.has(word)) continue;
		if (!out.includes(word)) out.push(word);
	}
	return out;
}

const countIn = (hay: string, needle: string): number => {
	let k = 0;
	for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) k++;
	return k;
};

interface Doc {
	ref: string;
	date: string;
	topic: string;
	summary: string;
	/** The detail as written (previews come from it). */
	detail: string;
	head: string;
	body: string;
	size: number;
	flags: string[];
	weight: number;
}

/** A line of a role's old archive (archive/*.md), as found by search: marked old. */
export interface ArchiveLine {
	ref: string;
	text: string;
	date: string;
}

/**
 * The role's archive, line by line (the weekly tidy-up's copies, its share of the old shared memory):
 * old, but searchable. The same line in several files counts once (the newest file's).
 */
export function archiveLines(roleDir: string): ArchiveLine[] {
	const dir = join(roleDir, "archive");
	let names: string[];
	try {
		names = readdirSync(dir).filter((n) => n.endsWith(".md")).sort().reverse();
	} catch {
		return [];
	}
	const seen = new Set<string>();
	const out: ArchiveLine[] = [];
	for (const name of names) {
		let text: string;
		try {
			text = readFileSync(join(dir, name), "utf8");
		} catch {
			continue;
		}
		const date = /\d{4}-\d{2}-\d{2}/.exec(name)?.[0] ?? "";
		text.split("\n").forEach((row, i) => {
			const line = row.trim();
			if (line.length < 12 || /^#{1,6}\s/.test(line) || /^<!--.*-->$/.test(line)) return;
			const key = line.replace(/^[-*•]\s+/, "").toLowerCase();
			if (seen.has(key)) return;
			seen.add(key);
			out.push({ ref: `archive/${name}:${i + 1}`, text: line, date });
		});
	}
	return out;
}

/** A short stretch of `text` around the first of `terms` in it. */
function previewOf(text: string, terms: string[], width = 160): string {
	const flat = text.replace(/\s+/g, " ").trim();
	const low = flat.toLowerCase();
	let at = -1;
	for (const t of terms) {
		const i = low.indexOf(t);
		if (i !== -1 && (at === -1 || i < at)) at = i;
	}
	if (at === -1) return flat.slice(0, width);
	const start = Math.max(0, at - Math.floor(width / 3));
	const piece = flat.slice(start, start + width);
	return `${start > 0 ? "…" : ""}${piece}${start + width < flat.length ? "…" : ""}`;
}

/**
 * Search a role's notes (and its old archive, marked old) by keywords: BM25-like scores, a word in the
 * summary or topic counting three times one in the detail, more for all words and for the whole phrase.
 * Outdated notes come lower and are flagged; so is a line from the archive.
 */
export function searchNotes(notes: Note[], archive: ArchiveLine[], query: string, limit = SEARCH_HITS): Hit[] {
	const terms = queryTerms(query);
	if (!terms.length) return [];
	const phrase = query.trim().toLowerCase().replace(/\s+/g, " ");
	const docs: Doc[] = notes.map((n) => {
		const flags: string[] = [];
		if (n.outdated) flags.push("outdated");
		if (n.rule) flags.push("rule");
		if (n.digest) flags.push(`in ${n.digest}`);
		if (n.tier > 1) flags.push(n.tier === 3 ? "overview" : "digest");
		return {
			ref: n.id,
			date: n.date,
			topic: n.topic,
			summary: n.summary,
			detail: n.detail,
			head: `${n.topic} ${n.summary}`.toLowerCase(),
			body: n.detail.toLowerCase(),
			size: n.size,
			flags,
			weight: n.outdated ? 0.3 : 1,
		};
	});
	for (const a of archive) {
		docs.push({
			ref: a.ref,
			date: a.date,
			topic: "",
			summary: a.text,
			detail: "",
			head: "",
			body: a.text.toLowerCase(),
			size: byteLength(a.text),
			flags: ["old"],
			weight: 0.5,
		});
	}
	if (!docs.length) return [];
	const avg = docs.reduce((s, d) => s + d.head.length + d.body.length, 0) / docs.length || 1;
	const df = new Map<string, number>();
	for (const t of terms) df.set(t, docs.filter((d) => d.head.includes(t) || d.body.includes(t)).length);
	const k1 = 1.2;
	const b = 0.75;
	const scored: Array<{ doc: Doc; score: number }> = [];
	for (const doc of docs) {
		let score = 0;
		let matched = 0;
		let bestIdf = 0;
		const len = doc.head.length + doc.body.length;
		for (const t of terms) {
			const tf = 3 * countIn(doc.head, t) + countIn(doc.body, t);
			if (!tf) continue;
			matched++;
			const n = df.get(t) ?? 0;
			const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
			bestIdf = Math.max(bestIdf, idf);
			score += (idf * (tf * (k1 + 1))) / (tf + k1 * (1 - b + (b * len) / avg));
		}
		if (!matched) continue;
		if (terms.length > 1 && (doc.head.includes(phrase) || doc.body.includes(phrase))) score += 2 * bestIdf;
		score *= (0.5 + (0.5 * matched) / terms.length) * doc.weight;
		scored.push({ doc, score });
	}
	scored.sort((x, y) => y.score - x.score || (x.doc.date < y.doc.date ? 1 : x.doc.date > y.doc.date ? -1 : 0));
	const max = Math.max(1, Math.min(limit, SEARCH_MAX));
	return scored.slice(0, max).map(({ doc, score }) => ({
		ref: doc.ref,
		score: Math.round(score * 100) / 100,
		size: doc.size,
		date: doc.date,
		topic: doc.topic,
		flags: doc.flags,
		summary: doc.summary,
		preview: doc.detail ? previewOf(doc.detail, terms) : "",
	}));
}

/** Search hits as text for the AI: one line each, then a preview line when the detail matched. */
export function hitsText(hits: Hit[], query: string, totalNotes: number): string {
	if (!hits.length) return `No hits for "${query}" in ${totalNotes} notes and the old archive.`;
	const rows = [`${hits.length} hits for "${query}" (open <id> for the whole note):`];
	for (const h of hits) {
		const flags = h.flags.length ? ` (${h.flags.join(", ")})` : "";
		const topic = h.topic ? ` [${h.topic}]` : "";
		rows.push(`${h.ref} ${h.score} ${h.size}B ${h.date || "-"}${topic}${flags} ${h.summary}`);
		if (h.preview && h.preview.toLowerCase() !== h.summary.toLowerCase()) rows.push(`  ${h.preview}`);
	}
	return rows.join("\n");
}

const ARCHIVE_REF = /^archive\/([A-Za-z0-9][A-Za-z0-9._-]*\.md)(?::(\d{1,7}))?$/;

/**
 * Open a note (its whole file) or a stretch of the archive (archive/<file>:<line>: 10 lines before it to
 * 30 after; archive/<file>: its first 60 lines). Null when there's no such thing.
 */
export function openRef(roleDir: string, notesDir: string, ref: string): { ref: string; text: string } | null {
	const r = ref.trim();
	if (isNoteId(r)) {
		const found = readNote(roleDir, notesDir, r);
		return found ? { ref: r, text: found.text } : null;
	}
	const m = ARCHIVE_REF.exec(r);
	if (!m) return null;
	let text: string;
	try {
		text = readFileSync(join(roleDir, "archive", basename(m[1])), "utf8");
	} catch {
		return null;
	}
	const rows = text.split("\n");
	const line = m[2] ? Number(m[2]) : 1;
	const from = m[2] ? Math.max(1, line - 10) : 1;
	const to = Math.min(rows.length, m[2] ? line + 30 : 60);
	const body = rows.slice(from - 1, to).join("\n");
	return { ref: r, text: `archive/${m[1]} lines ${from}-${to} of ${rows.length} (old):\n${body}` };
}
