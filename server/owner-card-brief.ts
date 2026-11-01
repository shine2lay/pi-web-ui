/**
 * owner-card-brief (Ops #682; owner, 2026-10-31 via COO: "whenever a card comes to me, I need to know the context in
 * the simplest terms ... i am just picking blind"): the plain brief every queue card that reaches the owner opens
 * with, in the browser (the Queue tab, the Roles page and its answer dialog) and in Telegram.
 *
 * Built from the records alone, no model (rule 17): the card's kind (pi-queue's saved `card`, else what its fixed
 * texts say), its `in_short`, the task's plan, its project in the work registry, the tasks that wait on it (their
 * `after`, blocks and outside afters, in every queue the server knows) and the package's answers and recommendation.
 * Plain words: ids and paths are taken out (the card's title keeps "Task #N", for finding it). At most BRIEF_MAX
 * characters, so every surface can show it whole and first.
 *
 * Not part of the ask's signature (stuck-asks.ts stuckSig): a fresher count of waiting tasks refreshes what the web
 * shows, and never sends the Telegram card again.
 */
import type { UiOwnerCardBriefLine, UiTaskQueueTask } from "./protocol.js";
import type { StuckSource, StuckWanted } from "./stuck-asks.js";

export const OWNER_CARD_KINDS = [
	"stopped",
	"failed",
	"stalled",
	"climbed",
	"block",
	"owner-only",
	"passed-on",
] as const;
export type OwnerCardKind = (typeof OWNER_CARD_KINDS)[number];

/** The whole brief, as "Label: text" lines, stays within this many characters. */
export const BRIEF_MAX = 600;

const LABEL = {
	inShort: "In short",
	project: "The project",
	task: "This task",
	why: "Why you, now",
	waiting: "Waiting on it",
	answers: "Your answers",
	recommended: "Recommended",
} as const;

const WHY: Record<OwnerCardKind, string> = {
	stopped: "Its run was stopped while it was working; nothing more is known about who stopped it.",
	failed: "Its run failed with an error.",
	stalled: "Its chat stopped twice and couldn't be woken.",
	climbed: "It asked its lead a question; no lead answered in time, so it comes to you.",
	block: "It waits on another department that hasn't answered.",
	"owner-only": "Only you can give this.",
	"passed-on": "Its lead passed it to you.",
};
const WHY_UNKNOWN = "The task asks you a question.";

/** pi-queue's owner-only kinds (queue.ts OWNER_ONLY_WORDS, which speak of the owner), said to him. */
const OWNER_ONLY: readonly [RegExp, string][] = [
	[/approving a plan or a change to it/i, "approving a plan or a change to it"],
	[/spending or a spending limit/i, "spending or a spending limit"],
	[/switching something on or publishing it/i, "switching something on or publishing it"],
	[/setting or lifting his stops and pauses/i, "setting or lifting your stops and pauses"],
	[/his own observation of something/i, "your own observation of something"],
	[/another consent of his/i, "another consent of yours"],
];

/** What the queue's own fixed answers do (pi-queue: Carry on, Remove it, and the block and climb answers). */
const FIXED_ANSWERS: Readonly<Record<string, string>> = {
	"carry on": "it picks up where it stopped",
	"remove it": "it leaves the queue, and its chat and work stay",
	"keep waiting": "it keeps waiting, and comes back to you if nothing changes",
	"go on without it": "it carries on without what it waited for, within its plan",
	"go with the task's recommendation": "it does what the task recommends",
	"not now": "it leaves this for now",
};
const OWN_ANSWER = "the task's own answer";
const FOLLOW_RECOMMENDATION = "go with the task's recommendation";
const FOLLOW_NONE = "it goes with what it recommends; it named nothing here";
/** pi-queue's askOwnerPackage, for an answer the task gave no words of its own. */
const GENERIC_AUTHORIZES = /^Only what the answer says, within the task's approved plan/i;
const NO_ANSWERS = "Write your answer; the task gets it as you wrote it.";

/** pi-queue's fixed card texts, for cards saved before it wrote their kind. */
const STOPPED_TEXT = /^(?:You stopped this task's run\b|This task's run was stopped\b)/;
const FAILED_TEXT = /^The run failed\b/;
const STALLED_TEXT =
	/^(?:This task's chat\b[\s\S]*Reply here to carry on, or remove the task from the queue\.?\s*$|The agent stopped twice without finishing this task\b)/;
const CLIMBED_TEXT = /^The task is stuck on a question for its lead and nobody answered\b|\(Sent to you because /;
const CLIMBED_HEAD = /asked a question, and no lead answered it in time/i;
const BLOCK_HEAD = /is blocked, and every lead it waited on stayed silent/i;
const OWNER_ONLY_HEAD = /only you can give this/i;
const PASSED_ON_HEAD = /passed on to you by/i;
const BLOCK_CHOICES = ["keep waiting", "go on without it"];

// ---------------------------------------------------------------------------------------------------------------
// Plain words: no ids, no paths

const URL = /\bhttps?:\/\/[^\s)>\]]+/gi;
/** Absolute and home paths, relative ones with a folder (two levels, or one and a file ending), and file names. */
const PATHS: readonly RegExp[] = [
	/(?<![\w/])(?:~|\.{1,2})?\/[\w.@+~-]+(?:\/[\w.@+~-]*)*/g,
	/\b[\w@+.-]+(?:\/[\w@+.-]+){2,}/g,
	/\b[\w@+.-]+\/[\w@+-]+\.[a-z][a-z0-9]{0,5}\b/gi,
	/\b[\w-]+(?:\.[\w-]+)*\.(?:ts|tsx|mjs|cjs|json|jsonl|md|css|sh|py|ya?ml|toml|txt|log|html|lock|service)\b/gi,
];
/** Task numbers, rule numbers, record ids, commits, code names (ADR-M4-18, SW-87, C1) and notebook ids. */
const IDS: readonly RegExp[] = [
	/\s*#\d+\b/g,
	/\brules?\s+\d+[a-z]?(?:\s*(?:,|and|or)\s*\d+[a-z]?)*/gi,
	/\b(?:rm|dr|bp|cr|rq|ar|req)-[0-9a-z]{6,}\b/gi,
	/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi,
	/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b/g,
	/\b[A-Z]{1,4}\d{1,4}\b/g,
	/\b[nd]\d{2,}\b/g,
];

/** Whether a text still holds an id or a path (the brief's bar; its tests hold it to this). */
export function hasIdOrPath(text: string): boolean {
	return [URL, ...PATHS, ...IDS].some((re) => new RegExp(re.source, re.flags.replace("g", "")).test(text));
}

/** Markdown marks, links, paths and ids taken out, and what they leave behind tidied. */
export function plainWords(raw: string): string {
	let s = raw
		.replace(/\r\n?/g, "\n")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/\*\*|__|\*/g, "")
		.replace(/^\s*(?:[-+]|\d+[.)]|#{1,6})\s+/gm, "")
		.replace(/\s+/g, " ");
	s = s.replace(URL, " ");
	for (const re of PATHS) s = s.replace(re, " ");
	for (const re of IDS) s = s.replace(re, " ");
	return tidy(s);
}

/** What removing ids and paths leaves: empty brackets, "(see , )", spaces before punctuation, loose ends. */
function tidy(s: string): string {
	let t = s;
	for (let i = 0; i < 3; i++) {
		t = t
			.replace(/\(\s*(?:(?:see|cf|per|via|in|at|from|on|e\.g|i\.e)\.?\s*)?[\s,;:.&+/-]*\)/gi, " ")
			.replace(/\[\s*[\s,;:.]*\]/g, " ")
			.replace(/\s+([,.;:!?)\u201D])/g, "$1")
			.replace(/([(\u201C])\s+/g, "$1")
			.replace(/([,;:])(?:\s*[,;:])+/g, "$1")
			.replace(/[,;:]+(?=\s*[.!?])/g, "")
			.replace(/\s{2,}/g, " ")
			.trim()
			.replace(/^[,;:.\-\u2013\u2014\s]+/, "")
			.replace(/[,;:\-\u2013\u2014\s]+$/, "");
	}
	return t;
}

const ABBREVIATION = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|approx|incl|cf|Mr|Mrs|Ms|Dr|St|No)\.$/i;
const SENTENCE_END = /[.!?]["'\u201D\u2019)]*(?=\s+["'\u201C\u2018(]?[\p{Lu}\p{N}]|\s*$)/gu;

/** A text's first sentence. */
function firstSentence(s: string): string {
	for (const m of s.matchAll(SENTENCE_END)) {
		const end = (m.index ?? 0) + m[0].length;
		if (ABBREVIATION.test(s.slice(0, (m.index ?? 0) + 1))) continue;
		return s.slice(0, end).trim();
	}
	return s.trim();
}

const words = (s: string) => s.split(/\s+/).filter((w) => /\p{L}{2,}/u.test(w)).length;

/** The first sentence of a record's text in plain words, or "" when taking ids and paths out leaves no sentence. */
export function plainSentence(raw: string | undefined, minWords = 4): string {
	if (!raw?.trim()) return "";
	const s = firstSentence(plainWords(raw));
	return words(s) >= minWords ? s : "";
}

/** At most `max` characters, cut after a whole word, with "…". */
function capWords(s: string, max: number): string {
	if (s.length <= max) return s;
	if (max < 8) return "";
	const room = s.slice(0, max - 1);
	const sp = room.lastIndexOf(" ");
	const head = (sp > room.length * 0.5 ? room.slice(0, sp) : room).replace(/[\s,;:.\-\u2013\u2014(\u201C"']+$/, "");
	return head ? `${head}\u2026` : "";
}

/** Ends like a sentence. */
export const closed = (s: string) => (!s || /[.!?\u2026]["'\u201D\u2019)]*$/.test(s) ? s : `${s}.`);
const unclosed = (s: string) => s.replace(/[.!]+$/, "");
const quoted = (s: string) => `\u201C${s}\u201D`;

// ---------------------------------------------------------------------------------------------------------------
// The card's package (pi-queue queue.ts ownerDetail)

interface OwnerPackage {
	inShort?: string;
	/** Its first plain paragraph: who asks and why (the heads the kind is inferred from). */
	head: string;
	/** Each answer's "Picking it authorizes". */
	authorizes: Map<string, string>;
	recommends?: string;
}

function packageOf(detail: string | undefined): OwnerPackage {
	const out: OwnerPackage = { head: "", authorizes: new Map() };
	if (!detail) return out;
	const text = detail.replace(/\r\n?/g, "\n");
	for (const para of text.split(/\n[ \t]*\n/)) {
		const p = para.trim();
		const short = /^\*\*In short:\*\*\s*([\s\S]*)$/.exec(p);
		if (short) out.inShort ??= short[1].trim();
		else if (!out.head && p && !p.startsWith("**") && !p.startsWith("- ")) out.head = p;
		const rec = /^\*\*[^*\n]{1,40} recommends:\*\*\s*([\s\S]*)$/.exec(p);
		if (rec) out.recommends = rec[1].trim();
	}
	let inAnswers = false;
	let choice: string | undefined;
	for (const line of text.split("\n")) {
		if (line.startsWith("**Your answers:**")) {
			inAnswers = true;
			continue;
		}
		if (!inAnswers) continue;
		if (line.startsWith("**")) break;
		const c = /^- \*\*(.+?)\*\*/.exec(line);
		if (c) {
			choice = c[1].trim();
			continue;
		}
		const a = /^\s+Picking it authorizes:\s*(.+)$/.exec(line);
		if (a && choice !== undefined && !out.authorizes.has(choice)) out.authorizes.set(choice, a[1].trim());
	}
	return out;
}

/** The card's kind: the one pi-queue saved, else what its fixed texts and package head say; undefined: unknown. */
export function ownerCardKind(t: {
	card?: string;
	question: string;
	choices?: readonly string[];
	detail?: string;
}): OwnerCardKind | undefined {
	if (t.card !== undefined)
		return (OWNER_CARD_KINDS as readonly string[]).includes(t.card) ? (t.card as OwnerCardKind) : undefined;
	return inferredKind(t.question.trim(), packageOf(t.detail).head, t.choices ?? []);
}

function inferredKind(question: string, head: string, choices: readonly string[]): OwnerCardKind | undefined {
	if (OWNER_ONLY_HEAD.test(head)) return "owner-only";
	if (PASSED_ON_HEAD.test(head)) return "passed-on";
	if (BLOCK_HEAD.test(head)) return "block";
	if (CLIMBED_HEAD.test(head) || CLIMBED_TEXT.test(question)) return "climbed";
	if (STOPPED_TEXT.test(question)) return "stopped";
	if (FAILED_TEXT.test(question)) return "failed";
	if (STALLED_TEXT.test(question)) return "stalled";
	const said = choices.map((c) => c.trim().toLowerCase());
	if (said.length === BLOCK_CHOICES.length && BLOCK_CHOICES.every((c) => said.includes(c))) return "block";
	return undefined;
}

function whyOf(kind: OwnerCardKind | undefined, head: string): string {
	if (!kind) return WHY_UNKNOWN;
	if (kind !== "owner-only") return WHY[kind];
	const words = OWNER_ONLY.find(([re]) => re.test(head))?.[1];
	return words ? `Only you can give this: ${words}.` : WHY[kind];
}

function meaningOf(choice: string, pkg: OwnerPackage, recommends: boolean): string {
	const key = choice.trim().toLowerCase();
	if (key === FOLLOW_RECOMMENDATION && !recommends) return FOLLOW_NONE;
	const fixed = FIXED_ANSWERS[key];
	if (fixed) return fixed;
	const own =
		pkg.authorizes.get(choice) ??
		[...pkg.authorizes].find(([k]) => k.trim().toLowerCase() === choice.trim().toLowerCase())?.[1];
	if (own && !GENERIC_AUTHORIZES.test(own)) {
		const s = plainSentence(own, 1);
		if (s) return s;
	}
	return OWN_ANSWER;
}

// ---------------------------------------------------------------------------------------------------------------
// The brief

/** A project's record in the work registry. */
export interface OwnerCardProject {
	name: string;
	outcome?: string;
}

/** A task that waits on this one: its title, and its queue's name when it is another queue ("" = unknown name). */
export interface OwnerCardWaiter {
	title: string;
	queue?: string;
}

export interface OwnerCardBriefInput {
	title: string;
	goal?: string;
	question: string;
	choices: readonly string[];
	detail?: string;
	/** pi-queue's saved kind of card, when it wrote one. */
	card?: string;
	/** pi-queue's one plain sentence on the card, when it wrote one. */
	inShort?: string;
	/** Its project's record; null: it isn't part of one; undefined: the record couldn't be found or read. */
	project: OwnerCardProject | null | undefined;
	waiting: readonly OwnerCardWaiter[];
}

/**
 * One part of a line that can be shortened to fit, down to its floor (0: it may go). Parts give in turn: what
 * the brief can best do without first (the goal and the project's outcome), the pi-queue's own words last.
 */
export interface Flex {
	text: string;
	cap: number;
	floor: number;
	turn: number;
}

export const GIVES_FIRST = 0;
export const GIVES_SECOND = 1;
export const GIVES_THIRD = 2;
const GIVES_LAST = 3;
export const flex = (text: string, floor: number, turn: number): Flex => ({
	text,
	cap: text.length,
	floor: Math.min(floor, text.length),
	turn,
});
/** A part as it is shown now: cut to its cap after a whole word. */
export const shown = (f: Flex) => capWords(f.text, f.cap);
/** A part shown as a sentence, or "" once cutting leaves less than `min` characters of it. */
function shownSentence(f: Flex, min = 24): string {
	const s = shown(f);
	return s.length >= Math.min(min, f.text.length) ? s : "";
}

/**
 * Fit a brief within BRIEF_MAX: the longest part that can still give (in turn) is shortened a little at a time and
 * the lines made again, until the whole brief fits. When no part can give, `loosen` may make room another way
 * (true: it did). Any id or path left in a line's fixed words is taken out last.
 */
export function fitBrief(
	parts: readonly Flex[],
	lines: () => UiOwnerCardBriefLine[],
	loosen: () => boolean = () => false,
): UiOwnerCardBriefLine[] {
	const size = (f: Flex) => Math.min(f.cap, f.text.length);
	let out = lines();
	for (let over = briefText(out).length - BRIEF_MAX, guard = 0; over > 0 && guard < 1000; guard++) {
		const give = parts.filter((f) => size(f) > f.floor).sort((a, b) => a.turn - b.turn || size(b) - size(a))[0];
		if (give)
			give.cap = Math.max(give.floor, size(give) - Math.max(4, Math.ceil(over / 2), Math.ceil(size(give) * 0.15)));
		else if (!loosen()) break;
		out = lines();
		over = briefText(out).length - BRIEF_MAX;
	}
	return out.map((l) => (hasIdOrPath(l.text) ? { ...l, text: plainWords(l.text) } : l));
}

/** The lines of the plain brief, at most BRIEF_MAX characters as "Label: text" lines. */
export function ownerCardBrief(input: OwnerCardBriefInput): UiOwnerCardBriefLine[] {
	const pkg = packageOf(input.detail);
	const kind = ownerCardKind({ ...input, choices: input.choices });
	const inShort = flex(plainWords(input.inShort ?? pkg.inShort ?? ""), 40, GIVES_LAST);
	const project =
		input.project === null
			? null
			: input.project === undefined
				? undefined
				: {
						name: flex(plainWords(input.project.name) || "Unnamed project", 20, GIVES_THIRD),
						outcome: flex(plainSentence(input.project.outcome, 3), 0, GIVES_FIRST),
					};
	const title = flex(plainWords(input.title) || "Untitled task", 30, GIVES_THIRD);
	const goal = flex(plainSentence(input.goal), 0, GIVES_FIRST);
	const why = whyOf(kind, pkg.head);
	const waiters = input.waiting.map((w) => ({
		title: flex(plainWords(w.title) || "Untitled task", 20, GIVES_SECOND),
		queue: w.queue === undefined ? undefined : flex(plainWords(w.queue), 12, GIVES_SECOND),
	}));
	const recText = (pkg.recommends ?? "").replace(/^The task recommends:\s*/i, "");
	const rec = flex(/^None\b/i.test(recText) ? "" : plainSentence(recText, 2), 24, GIVES_SECOND);
	const answers = input.choices
		.map((c) => ({
			name: flex(plainWords(c), 12, GIVES_THIRD),
			meaning: flex(meaningOf(c, pkg, !!rec.text), 12, GIVES_SECOND),
		}))
		.filter((a) => a.name.text);
	let named = 2;
	const sentence = shownSentence;
	const projectText = (): string => {
		if (project === null) return "Not part of a project.";
		if (project === undefined) return "Its project's record couldn't be found.";
		const outcome = sentence(project.outcome);
		return outcome ? `${quoted(shown(project.name))}: ${closed(outcome)}` : `${quoted(shown(project.name))}.`;
	};
	const lines = (): UiOwnerCardBriefLine[] => {
		const out: UiOwnerCardBriefLine[] = [];
		const inShortText = sentence(inShort);
		if (inShortText) out.push({ label: LABEL.inShort, text: closed(inShortText) });
		out.push({ label: LABEL.project, text: projectText() });
		const goalText = sentence(goal);
		out.push({ label: LABEL.task, text: `${quoted(shown(title))}.${goalText ? ` ${closed(goalText)}` : ""}` });
		out.push({ label: LABEL.why, text: why });
		const where = (q: Flex | undefined) =>
			q === undefined ? " (same queue)" : q.text ? ` (in ${quoted(shown(q))})` : " (in another queue)";
		const list = waiters.slice(0, named).map((w) => `${quoted(shown(w.title))}${where(w.queue)}`);
		const more = waiters.length - list.length;
		out.push({
			label: LABEL.waiting,
			text: !waiters.length
				? "Nothing else waits on it."
				: `${waiters.length} ${waiters.length === 1 ? "task" : "tasks"}: ${list.join(", ")}${more > 0 ? ` and ${more} more` : ""}.`,
		});
		out.push({
			label: LABEL.answers,
			text: answers.length
				? answers.map((a) => `${quoted(shown(a.name))}: ${closed(unclosed(shown(a.meaning)))}`).join(" ")
				: NO_ANSWERS,
		});
		const recShown = sentence(rec);
		out.push({ label: LABEL.recommended, text: recShown ? closed(recShown) : "None given." });
		return out;
	};

	// Fit: shorten the longest part that can still give, a little at a time, until the whole brief fits.
	const parts: Flex[] = [
		inShort,
		title,
		goal,
		rec,
		...(project ? [project.name, project.outcome] : []),
		...waiters.flatMap((w) => (w.queue ? [w.title, w.queue] : [w.title])),
		...answers.flatMap((a) => [a.name, a.meaning]),
	];
	// When no part can give any more, name one waiting task instead of two.
	return fitBrief(parts, lines, () => named > 1 && ((named = 1), true));
}

/** A waiting ask's brief to put on a record the browser gets (nothing when it has none). */
export function briefOfAsk(ask: { brief?: UiOwnerCardBriefLine[] } | undefined): {
	brief?: UiOwnerCardBriefLine[];
} {
	return ask?.brief?.length ? { brief: ask.brief } : {};
}

/** The brief as one text, a line each: "Label: text". */
export function briefText(lines: readonly UiOwnerCardBriefLine[]): string {
	return lines.map((l) => `${l.label}: ${l.text}`).join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// From the records

/** A queued task, as much of it as says what it waits on. */
export interface OwnerCardQueueTask {
	id: number;
	status: string;
	plan: { title: string };
	after?: readonly number[];
	block?: { on?: readonly { file: string; id: number }[] };
	/** Tasks in other queues it comes after; `over` is set (a record) once that one is done or gone. */
	outside?: readonly { file: string; id: number; over?: unknown }[];
}

/** A queue the server knows: its chat's transcript, the name the owner knows it by, its tasks. */
export interface OwnerCardQueue {
	file: string;
	name?: string;
	tasks: readonly OwnerCardQueueTask[];
}

/** Statuses of a task that hasn't started, so it may wait on another one. */
const NOT_STARTED = new Set(["ready", "blocked"]);

/**
 * The tasks that wait on this one, in queue order: its own queue's tasks that come after it, and tasks in any queue
 * blocked on it or coming after it from outside. A queue known twice (an open chat and the block module's copy)
 * counts once: the first one given.
 */
export function ownerCardWaiters(
	target: { file: string; id: number },
	queues: readonly OwnerCardQueue[],
	sameFile: (a: string, b: string) => boolean = (a, b) => a === b,
): OwnerCardWaiter[] {
	const out: OwnerCardWaiter[] = [];
	const seen: string[] = [];
	for (const q of queues) {
		if (seen.some((f) => sameFile(f, q.file))) continue;
		seen.push(q.file);
		const same = sameFile(q.file, target.file);
		const names = (r: { file: string; id: number }) =>
			r.id === target.id && (r.file === "" ? same : sameFile(r.file, target.file));
		for (const t of q.tasks) {
			if ((same && t.id === target.id) || !NOT_STARTED.has(t.status)) continue;
			const waits =
				(same && (t.after ?? []).includes(target.id)) ||
				(t.status === "blocked" && (t.block?.on ?? []).some(names)) ||
				(t.outside ?? []).some((o) => !o.over && names(o));
			if (waits) out.push(same ? { title: t.plan.title } : { title: t.plan.title, queue: q.name ?? "" });
		}
	}
	return out;
}

export interface OwnerCardRecords {
	queues: readonly OwnerCardQueue[];
	/** A project's record in the work registry; null: no such project; undefined: the registry can't be read. */
	project(id: string): OwnerCardProject | null | undefined;
	sameFile?(a: string, b: string): boolean;
}

/** A stuck task's brief from the records: its queue (transcript) is where other tasks name it. */
export function ownerCardBriefOf(
	task: UiTaskQueueTask,
	queueFile: string,
	records: OwnerCardRecords,
): UiOwnerCardBriefLine[] {
	const parent = task.parent;
	let project: OwnerCardProject | null | undefined = null;
	if (parent && "project" in parent) {
		try {
			// A project the registry doesn't have is one whose record couldn't be found, not "no project".
			project = records.project(parent.project) ?? undefined;
		} catch {
			project = undefined;
		}
	}
	return ownerCardBrief({
		title: task.plan.title,
		goal: task.plan.goal,
		question: task.question ?? "",
		choices: task.choices ?? [],
		...(task.detail ? { detail: task.detail } : {}),
		...(task.card ? { card: task.card } : {}),
		...(task.inShort ? { inShort: task.inShort } : {}),
		project,
		waiting: ownerCardWaiters({ file: queueFile, id: task.id }, records.queues, records.sameFile),
	});
}

/**
 * The brief of each stuck ask (stuck-asks.ts), from the open chats' queues and those the cross-queue block module
 * has read (queue-blocks.ts knownQueues). A lane task's own chat holds a copy of its queue: only queue chats count.
 */
export function stuckAskBriefs(
	sources: readonly StuckSource[],
	known: readonly OwnerCardQueue[],
	project: OwnerCardRecords["project"],
): (w: StuckWanted) => UiOwnerCardBriefLine[] | undefined {
	const queues: OwnerCardQueue[] = [
		...sources
			.filter((s) => !s.queue.from)
			.map((s) => ({
				file: s.file,
				...(s.meta.conversationTitle ? { name: s.meta.conversationTitle } : {}),
				tasks: s.queue.tasks,
			})),
		...known,
	];
	return (w) => {
		if (!w.task || !w.queueFile) return undefined;
		try {
			return ownerCardBriefOf(w.task, w.queueFile, { queues, project });
		} catch {
			return undefined;
		}
	};
}
