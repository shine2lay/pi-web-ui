/**
 * identity-notes: a role's two-layer memory (pi-identity) for the right panel's Notebook tab.
 *
 * pi-identity keeps a role's memory in two layers: its rules (notebook.md), sent with every message,
 * and its notes (<role>/notes/<id>.md, unlimited), found by search and opened when needed. An index of
 * the notes' one-line summaries goes out with the rules; rules and index together stay within the
 * role's notebookCap. This module reads them the way pi-identity does (identity-notes.ts is a byte copy
 * of its notes.ts), so the tab shows what the role's chats get: the rules, the index, their size in
 * characters and estimated tokens, and the notes, with search, open, edit and delete. A replaced or
 * deleted note goes to the role's removed.md first, as pi-identity keeps them (never searched).
 *
 * Everything here stays inside the role's own folder; pi-worktree keeps other roles' chats from asking
 * (its API_RE lists these messages).
 */

import { readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { type IdentityDef, identityFilePath, textHash } from "./identities.js";
import { roleCaps, type Settings } from "./identity-config.js";
import {
	archiveLines,
	buildIndex,
	byteLength,
	estTokens,
	formatNote,
	indexRoom,
	isNoteId,
	keepNoteRemoved,
	listNotes,
	type Note,
	noteCounts,
	notePath,
	notesPath,
	openRef,
	parseNote,
	readNote,
	releaseDigest,
	rulesCap,
	SEARCH_MAX,
	SUMMARY_MAX,
	saveNote,
	searchNotes,
} from "./identity-notes.js";
import type { IdentitySaveError, UiNoteHit, UiRoleMemory } from "./protocol.js";

/** The notes the tab lists before a search (newest first). */
export const LIST_MAX = 200;
/** A note the owner saves may be at most this big (a safety limit, like about.md's). */
export const NOTE_MAX = 64_000;

const KEY_RE = /^([a-z]+):\s?(.*)$/;

function readTextOrEmpty(path: string): string {
	try {
		return readFileSync(path, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
		throw err;
	}
}

function stampOf(d: Date): string {
	const p = (x: number) => String(x).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The role's limits: pi-identity.json's, with identity.json's `memory` over them. */
export const capsOf = (def: IdentityDef, settings: Settings) => roleCaps(settings, def.role.config);

/** What the role's rules (notebook.md) may hold: the cap minus the index's budget. */
export const rulesCapOf = (def: IdentityDef, settings: Settings): number => rulesCap(capsOf(def, settings));

/**
 * A role's memory as its chats get it (pi-identity's memoryOf): the index built in the room the rules
 * leave, and what both take. `rules` = notebook.md's text when the caller has it already.
 */
export function roleMemory(def: IdentityDef, settings: Settings, rules?: string): UiRoleMemory {
	const caps = capsOf(def, settings);
	const rulesSize = byteLength(rules ?? readTextOrEmpty(identityFilePath(def, "notebook")));
	const notes = listNotes(def.dir, settings.notesDir);
	const index = buildIndex(notes, indexRoom(caps, rulesSize), caps.indexBudget);
	const sent = rulesSize + index.size;
	return {
		index: index.text,
		indexSize: index.size,
		indexFull: index.full,
		indexBudget: caps.indexBudget,
		hidden: index.hidden,
		over: index.over,
		sent,
		cap: caps.notebookCap,
		tokens: estTokens(sent),
		rulesCap: rulesCap(caps),
		rulesSize,
		counts: noteCounts(notes),
		// The notes as read: a touched file that says the same sends nothing new.
		notesVersion: textHash(JSON.stringify(notes)),
	};
}

/**
 * A cheap signature of what the tab shows besides notebook.md: each note file's name, inode, size and
 * mtime (stats, no reads), and the role's limits. It changes when a note is recorded, edited, flagged,
 * distilled or deleted (pi-identity writes notes whole, by rename), or the limits change.
 */
export function memorySignature(def: IdentityDef, settings: Settings): string {
	const caps = capsOf(def, settings);
	const parts = [`${caps.notebookCap}:${caps.indexBudget}:${settings.notesDir}`];
	const dir = notesPath(def.dir, settings.notesDir);
	let names: string[] = [];
	try {
		names = readdirSync(dir)
			.filter((n) => n.endsWith(".md"))
			.sort();
	} catch {
		parts.push("no notes");
	}
	for (const name of names) {
		try {
			const s = statSync(join(dir, name));
			parts.push(`${name}:${s.ino}:${s.size}:${s.mtimeMs}`);
		} catch {
			parts.push(`${name}:gone`);
		}
	}
	return textHash(parts.join("|"));
}

function flagsOf(n: Note): string[] {
	const flags: string[] = [];
	if (n.outdated) flags.push("outdated");
	if (n.rule) flags.push("rule");
	if (n.digest) flags.push(`in ${n.digest}`);
	if (n.tier > 1) flags.push(n.tier === 3 ? "overview" : "digest");
	return flags;
}

const rowOf = (n: Note): UiNoteHit => ({
	ref: n.id,
	score: 0,
	size: n.size,
	date: n.date,
	topic: n.topic,
	flags: flagsOf(n),
	summary: n.summary,
	preview: "",
});

/**
 * Search a role's notes and its old archive (marked old) the way its chats' `notebook search` does;
 * removed.md is never searched. An empty query lists the notes, newest first (at most LIST_MAX).
 */
export function searchRoleNotes(
	def: IdentityDef,
	settings: Settings,
	query: string,
): { hits: UiNoteHit[]; total: number } {
	const notes = listNotes(def.dir, settings.notesDir);
	if (!query.trim()) return { hits: notes.slice(0, LIST_MAX).map(rowOf), total: notes.length };
	return { hits: searchNotes(notes, archiveLines(def.dir), query, SEARCH_MAX), total: notes.length };
}

export type NoteRead =
	{ ok: true; ref: string; text: string; hash: string; size: number; editable: boolean } | { ok: false; error: string };

/** A note's whole file (editable), or a stretch of the old archive (archive/<file>:<line>, read-only). */
export function readRoleNote(def: IdentityDef, settings: Settings, ref: string): NoteRead {
	const r = ref.trim();
	if (isNoteId(r)) {
		const found = readNote(def.dir, settings.notesDir, r);
		if (!found) return { ok: false, error: `No note ${r}` };
		return {
			ok: true,
			ref: r,
			text: found.text,
			hash: textHash(found.text),
			size: byteLength(found.text),
			editable: true,
		};
	}
	const opened = openRef(def.dir, settings.notesDir, r);
	if (!opened) return { ok: false, error: `Nothing at ${r}` };
	return {
		ok: true,
		ref: opened.ref,
		text: opened.text,
		hash: textHash(opened.text),
		size: byteLength(opened.text),
		editable: false,
	};
}

/** What's wrong with a note as the owner typed it (empty: nothing). */
export function noteProblems(text: string): string[] {
	const rows = text.replace(/\r\n/g, "\n").split("\n");
	const sep = rows.indexOf("---");
	if (sep < 1 || !rows.slice(0, sep).every((row) => !row.trim() || KEY_RE.test(row))) {
		return ["Keep the header: its key: value lines, then a line with only ---, then the detail."];
	}
	const problems: string[] = [];
	const summary = rows.slice(0, sep).find((row) => row.startsWith("summary:"));
	const value = summary ? summary.slice("summary:".length).trim() : "";
	if (!value) problems.push("summary: is empty (it's the note's line in the index).");
	else if (value.length > SUMMARY_MAX)
		problems.push(`summary: is ${value.length} characters, more than ${SUMMARY_MAX}.`);
	return problems;
}

export type NoteSave =
	{ ok: true; hash: string; size: number } | { ok: false; code: IdentitySaveError; problems?: string[] };

/**
 * Save a note as the owner edited it (its whole file). Refused: no such note (unknown), too big
 * (too_big), changed since it was read (changed), a header pi-identity wouldn't read (invalid), or a
 * write that failed (io). The old version goes to removed.md first: a failed archive refuses the save.
 */
export function saveRoleNote(
	def: IdentityDef,
	settings: Settings,
	ref: string,
	text: string,
	baseHash: string,
	now: Date = new Date(),
): NoteSave {
	if (!isNoteId(ref)) return { ok: false, code: "unknown" };
	if (byteLength(text) > NOTE_MAX) return { ok: false, code: "too_big" };
	const found = readNote(def.dir, settings.notesDir, ref);
	if (!found) return { ok: false, code: "unknown" };
	if (textHash(found.text) !== baseHash) return { ok: false, code: "changed" };
	const problems = noteProblems(text);
	if (problems.length) return { ok: false, code: "invalid", problems };
	const note = parseNote(text, ref);
	try {
		keepNoteRemoved(def.dir, def.id, ref, found.text, stampOf(now), "replaced by the owner (pi-web-ui)");
		const size = saveNote(def.dir, settings.notesDir, note);
		return { ok: true, hash: textHash(formatNote(note)), size };
	} catch {
		return { ok: false, code: "io" };
	}
}

export type NoteDelete = { ok: true; freed: string[] } | { ok: false; code: IdentitySaveError };

/**
 * Delete a note: it goes to removed.md first (never searched, its id never given again). A digest's
 * notes show in the index again. Refused like a save.
 */
export function deleteRoleNote(
	def: IdentityDef,
	settings: Settings,
	ref: string,
	baseHash: string,
	now: Date = new Date(),
): NoteDelete {
	if (!isNoteId(ref)) return { ok: false, code: "unknown" };
	const found = readNote(def.dir, settings.notesDir, ref);
	if (!found) return { ok: false, code: "unknown" };
	if (textHash(found.text) !== baseHash) return { ok: false, code: "changed" };
	try {
		keepNoteRemoved(def.dir, def.id, ref, found.text, stampOf(now), "deleted by the owner (pi-web-ui)");
		unlinkSync(notePath(def.dir, settings.notesDir, ref));
		return { ok: true, freed: found.note.tier > 1 ? releaseDigest(def.dir, settings.notesDir, ref) : [] };
	} catch {
		return { ok: false, code: "io" };
	}
}
