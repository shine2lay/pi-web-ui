/**
 * The Memory explorer's plain words (design #316): what the page calls a stored path, a place, a kind
 * of note, a time and a length. One canonical place for these, shared by every part of the page.
 *
 * Memory keeps notes under a few top-level places: `viking://user/default/memories` (shared by every
 * chat), `viking://resources` (project documents) and `viking://user/<department>/memories` (each
 * department's own). The first folder inside a place says what kind of note it is.
 */

import type { NoteKind, RootGroup } from "./explorer-api.js";

const SHARED_ROOT = "viking://user/default/memories";
const PROJECTS_ROOT = "viking://resources";
const DEPARTMENT_ROOT = /^viking:\/\/user\/([^/]+)\/memories/;
const SETUP_FILES = new Set(["identity.md", "soul.md"]);

/** First folder inside a place -> [kind, folder label, one-note word]. */
const KIND_FOLDERS: Readonly<Record<string, readonly [NoteKind, string, string]>> = {
	preferences: ["rule", "Rules", "Rule"],
	cases: ["case", "Cases", "Case"],
	experiences: ["case", "Lessons", "Lesson"],
	entities: ["fact", "Facts about things", "Fact"],
	events: ["event", "Events", "Event"],
	instructions: ["other", "Instructions", "Instruction"],
};

/** Words for the kind bar's key, one per kind that has a colour. */
export const KIND_KEY: ReadonlyArray<readonly [NoteKind, string]> = [
	["rule", "Rules"],
	["case", "Cases and lessons"],
	["fact", "Facts"],
	["event", "Events"],
	["doc", "Documents"],
];

/** Department names keep their own spelling. */
const DEPARTMENT_NAMES: Readonly<Record<string, string>> = { coo: "COO", qa: "QA", rollcall: "RollCall", ops: "Ops" };
const MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

export const GROUP_HEADINGS: Readonly<Record<RootGroup, string>> = {
	shared: "Shared by every chat",
	projects: "Project documents",
	department: "Each department's own notes",
};

interface Place {
	readonly uri: string;
	readonly group: RootGroup;
	/** Department id for a department's place. */
	readonly department?: string;
}

function placeOf(uri: string): Place {
	if (uri === SHARED_ROOT || uri.startsWith(`${SHARED_ROOT}/`)) return { uri: SHARED_ROOT, group: "shared" };
	if (uri === PROJECTS_ROOT || uri.startsWith(`${PROJECTS_ROOT}/`)) return { uri: PROJECTS_ROOT, group: "projects" };
	const department = DEPARTMENT_ROOT.exec(uri);
	if (department) return { uri: department[0], group: "department", department: department[1] };
	throw new Error(`not a place memory keeps notes: ${uri}`);
}

/** Folders and file below the place, e.g. ["preferences", "a.md"]. */
function segments(uri: string): string[] {
	const place = placeOf(uri);
	return uri.slice(place.uri.length).split("/").filter(Boolean);
}

function lastSegment(uri: string): string {
	return uri.slice(uri.lastIndexOf("/") + 1);
}

export function groupOf(uri: string): RootGroup {
	return placeOf(uri).group;
}

export function departmentName(id: string): string {
	return DEPARTMENT_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

/** The name of a top-level place: "Shared notes", "Project documents", or the department. */
export function rootName(uri: string): string {
	const place = placeOf(uri);
	if (place.group === "shared") return "Shared notes";
	if (place.group === "projects") return "Project documents";
	return departmentName(place.department as string);
}

/** Where a note is kept, as a phrase: "Shared notes", "Project documents", "Design's own notes". */
export function keptIn(uri: string): string {
	const place = placeOf(uri);
	return place.group === "department" ? `${rootName(uri)}'s own notes` : rootName(uri);
}

/** A file or folder name in plain words; product names keep their own spelling. */
export function humanize(name: string): string {
	let words = name
		.replace(/\.md(_\d+)?$/, "")
		.replace(/^[a-z]\d+(-[a-z]\d+)*-/, "")
		.replace(/[_-]+/g, " ")
		.trim();
	words = words
		.replace(/\bshowtell\b/gi, "Show&Tell")
		.replace(/\bqa\b/g, "QA")
		.replace(/\brollcall\b/gi, "RollCall")
		.replace(/\bui\b/g, "UI");
	return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

/** A folder's label: the place's name, a kind ("Rules"), a month or day of events, or its name. */
export function folderLabel(uri: string): string {
	const segs = segments(uri);
	if (segs.length === 0) return rootName(uri);
	const last = segs[segs.length - 1];
	if (groupOf(uri) === "projects") return last;
	if (segs.length === 1 && KIND_FOLDERS[last]) return KIND_FOLDERS[last][1];
	if (segs[0] === "events" && segs.length === 3) return `${MONTHS[Number(last) - 1]} ${segs[1]}`;
	if (segs[0] === "events" && segs.length === 4) return `${MONTHS[Number(segs[2]) - 1].slice(0, 3)} ${Number(last)}`;
	return humanize(last);
}

/** A note's title from its file name. */
export function noteTitle(uri: string): string {
	const file = lastSegment(uri);
	if (file === ".overview.md") return `Overview of ${folderLabel(uri.slice(0, -"/.overview.md".length))}`;
	return groupOf(uri) === "projects" ? file : humanize(file);
}

export function kindOf(uri: string): NoteKind {
	if (groupOf(uri) === "projects") return "doc";
	return KIND_FOLDERS[segments(uri)[0]]?.[0] ?? "other";
}

export function kindWord(uri: string): string {
	if (groupOf(uri) === "projects") return "Document";
	const segs = segments(uri);
	return segs.length > 1 ? (KIND_FOLDERS[segs[0]]?.[2] ?? "Note") : "Note";
}

/** A department's setup file: managed with its settings, never shown or changed here. */
export function isSetupFile(uri: string): boolean {
	return SETUP_FILES.has(lastSegment(uri));
}

/** The parent folder of a note or folder; null for a top-level place. */
export function parentOf(uri: string): string | null {
	return segments(uri).length === 0 ? null : uri.slice(0, uri.lastIndexOf("/"));
}

/** Folders from the place down to `uri`, inclusive. */
export function chainOf(uri: string): string[] {
	const chain: string[] = [];
	for (let at: string | null = uri; at; at = parentOf(at)) chain.unshift(at);
	return chain;
}

const PLACEHOLDER_SUMMARY = /^\[[^\]]*not ready\]$/i;

/** A stored summary as one line of plain words; null when none was written. */
export function summaryText(raw: string | null | undefined): string | null {
	if (!raw) return null;
	const plain = raw
		.replace(/^\S+ L0 abstract:\s*/, "")
		.replace(/^\s*#{1,6}\s*/gm, "")
		.replace(/\*\*|__|`/g, "")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/^\s*[-*+]\s+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!plain || PLACEHOLDER_SUMMARY.test(plain) || !/\p{L}/u.test(plain)) return null;
	return plain;
}

/** How close a meaning hit is, read against the best hit for the same question (3 strong .. 1 weak). */
export function matchLevel(score: number, best: number): 1 | 2 | 3 {
	if (score >= 0.85 && score >= best - 0.012) return 3;
	return score >= best - 0.03 ? 2 : 1;
}

export const MATCH_WORDS: Readonly<Record<1 | 2 | 3, string>> = { 1: "Weak match", 2: "Good match", 3: "Strong match" };

/** How long ago, in plain words. */
export function ago(iso: string | null, nowMs: number): string {
	if (!iso) return "unknown";
	const at = Date.parse(iso);
	if (Number.isNaN(at)) return "unknown";
	const minutes = (nowMs - at) / 60_000;
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${Math.floor(minutes)} min ago`;
	if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`;
	if (minutes < 48 * 60) return "yesterday";
	return new Date(at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** A clock time, e.g. "5:20 PM". */
export function clock(iso: string | null): string {
	if (!iso) return "unknown";
	return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/** How long a note is, from its stored size in bytes. */
export function lengthWords(bytes: number | null): string {
	if (bytes == null) return "unknown length";
	if (bytes < 60) return "a few words";
	return `about ${(Math.round(bytes / 6 / 10) * 10 || 10).toLocaleString("en-US")} words`;
}

export function countWords(n: number, one: string, many: string): string {
	return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}
