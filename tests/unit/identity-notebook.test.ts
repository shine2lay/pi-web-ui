/**
 * identity-notebook-tab: unit tests.
 *
 * - the server's NotebookWatch: a window gets the notebook at once and again on every change, whoever
 *   made it (a rename-replace like pi-identity's, an in-place edit); a touch without a change sends
 *   nothing; each window is sent only what it hasn't got; a closed window or tab stops it;
 * - the owner's save keeps the lines it takes out in the role's own removed.md (pi-identity's format);
 * - the page's store (notebook-state.ts): watch, the live push, a save with the tab's ref, the conflict
 *   and cap refusals, a reconnect;
 * - the panel's render (view only: the draft is local state).
 * - identity-notes: the role's two-layer memory in the tab: the push carries the rules' and the notes
 *   index's size (characters, estimated tokens) and follows a note a chat records; the notes listed,
 *   searched (removed.md never), opened (an old archive stretch read-only), edited and deleted (the old
 *   text kept in removed.md); another role's notes never show; the store and the panel for them.
 *
 * No model and no port: the production functions, a temp identities folder and a fake sender.
 */
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	utimesSync,
	writeFileSync,
	existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	droppedLines,
	identityRegistry,
	NOTEBOOK_CAP,
	notebookArchivePath,
	saveIdentityFile,
	textHash,
} from "../../server/identities.js";
import {
	deleteRoleNote,
	readRoleNote,
	roleMemory,
	saveRoleNote,
	searchRoleNotes,
} from "../../server/identity-memory.js";
import {
	byteLength,
	createNote,
	estTokens,
	INDEX_BUDGET,
	type NewNote,
	readNote,
	saveNote,
} from "../../server/identity-notes.js";
import { type NotebookPush, NotebookWatch } from "../../server/notebook-watch.js";
import type { UiNoteHit, UiRoleMemory } from "../../server/protocol.js";
import { setAppSend } from "../../web/src/app-globals.js";
import { NotebookPanel } from "../../web/src/components/NotebookPanel.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import {
	clearNotebookSaved,
	closeNote,
	deleteOpenNote,
	getNotebook,
	getWatchedNotebook,
	NOTEBOOK_TAB_REF,
	openNote,
	receiveNote,
	receiveNotebook,
	receiveNotebookSaved,
	receiveNoteSaved,
	receiveNotesFound,
	resendNotebookWatch,
	resetNotebookState,
	saveNotebook,
	saveOpenNote,
	searchNotes,
	watchNotebook,
} from "../../web/src/notebook-state.js";

/** identity-notes: what the rules (notebook.md) may hold: the notebook cap minus the notes index's budget. */
const RULES_CAP = NOTEBOOK_CAP - INDEX_BUDGET;

let root: string;
let idDir: string;
const savedEnv = { id: process.env.PI_IDENTITY_DIR, mem: process.env.PI_MEMORY_DIR };

function writeIdentity(id: string, title: string, notebook?: string) {
	const d = join(idDir, id);
	mkdirSync(d, { recursive: true });
	writeFileSync(join(d, "identity.json"), JSON.stringify({ id, title }));
	if (notebook !== undefined) writeFileSync(join(d, "notebook.md"), notebook);
}
const notebookPath = (id: string) => join(idDir, id, "notebook.md");
const roleDir = (id: string) => join(idDir, id);

/** A note as a role's chat records it (pi-identity's createNote, the same code). */
function record(id: string, fields: Partial<NewNote> & { summary: string }) {
	return createNote(roleDir(id), "notes", { date: "2026-10-02", chat: "abcd1234", topic: "general", ...fields });
}

/** The registry's def and settings for a role. */
function roleOf(id: string) {
	const reg = identityRegistry(true);
	const def = reg.identities.find((d) => d.id === id);
	if (!def) throw new Error(`no identity ${id}`);
	return { def, settings: reg.settings };
}

/** Replace the file the way pi-identity and the Settings page do: a temp file, then rename. */
function replaceWhole(id: string, text: string) {
	const tmp = `${notebookPath(id)}.tmp-test`;
	writeFileSync(tmp, text);
	renameSync(tmp, notebookPath(id));
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "identity-notebook-"));
	idDir = join(root, "identities");
	mkdirSync(idDir);
	process.env.PI_IDENTITY_DIR = idDir;
	process.env.PI_MEMORY_DIR = join(root, "memory");
	writeIdentity("temper", "temper", "- #fact one\n");
	writeIdentity("ops", "ops/tooling");
	identityRegistry(true);
});

afterEach(() => {
	if (savedEnv.id === undefined) delete process.env.PI_IDENTITY_DIR;
	else process.env.PI_IDENTITY_DIR = savedEnv.id;
	if (savedEnv.mem === undefined) delete process.env.PI_MEMORY_DIR;
	else process.env.PI_MEMORY_DIR = savedEnv.mem;
	rmSync(root, { recursive: true, force: true });
	setAppSend(null);
	resetNotebookState();
});

describe("the server watches a notebook for the windows showing it", () => {
	const make = () => new NotebookWatch<string>({ identities: () => identityRegistry().identities, intervalMs: 60_000 });
	const inbox = () => {
		const got: NotebookPush[] = [];
		return { got, send: (m: NotebookPush) => void got.push(m) };
	};

	it("sends the notebook at once, then again only when its text changes", () => {
		const w = make();
		const a = inbox();
		w.watch("A", "temper", a.send);
		expect(a.got).toHaveLength(1);
		expect(a.got[0]).toMatchObject({
			type: "identity_notebook",
			id: "temper",
			text: "- #fact one\n",
			hash: textHash("- #fact one\n"),
			size: 12,
			cap: RULES_CAP,
		});
		w.check();
		expect(a.got).toHaveLength(1);

		// A chat's notebook tool replaces the file (new inode): pushed.
		replaceWhole("temper", "- #fact one\n- #fact two\n");
		w.check();
		expect(a.got).toHaveLength(2);
		expect(a.got[1]).toMatchObject({
			text: "- #fact one\n- #fact two\n",
			hash: textHash("- #fact one\n- #fact two\n"),
		});

		// A touch without a change: nothing.
		const later = new Date(Date.now() + 5_000);
		utimesSync(notebookPath("temper"), later, later);
		w.check();
		expect(a.got).toHaveLength(2);

		// An edit in place (a hand edit) counts too.
		writeFileSync(notebookPath("temper"), "- #fact three\n");
		w.check();
		expect(a.got.at(-1)).toMatchObject({ text: "- #fact three\n" });
		w.close();
	});

	it("each window gets what it hasn't got; a closed window or tab stops; another identity is a new watch", () => {
		const w = make();
		const a = inbox();
		const b = inbox();
		w.watch("A", "temper", a.send);
		w.watch("B", "temper", b.send);
		expect(w.size).toBe(2);
		replaceWhole("temper", "- #fact two\n");
		w.check();
		expect(a.got.map((m) => m.text)).toEqual(["- #fact one\n", "- #fact two\n"]);
		expect(b.got.map((m) => m.text)).toEqual(["- #fact one\n", "- #fact two\n"]);

		w.watch("A", null, a.send); // A's tab closed
		w.drop("B"); // B's socket closed
		expect(w.size).toBe(0);
		replaceWhole("temper", "- #fact three\n");
		w.check();
		expect(a.got).toHaveLength(2);
		expect(b.got).toHaveLength(2);

		// A switches to another chat, of another identity.
		w.watch("A", "ops", a.send);
		expect(a.got.at(-1)).toMatchObject({ id: "ops", text: "", hash: textHash("") });
		w.close();
	});

	it("an identity that's gone is an error, not a throw", () => {
		const w = make();
		const a = inbox();
		w.watch("A", "nobody", a.send);
		expect(a.got).toHaveLength(1);
		expect(a.got[0]?.id).toBe("nobody");
		expect(typeof a.got[0]?.error).toBe("string");
		expect(a.got[0]?.text).toBeUndefined();
		expect(() => w.check()).not.toThrow();
		w.close();
	});

	it("a window whose sender throws doesn't stop the others", () => {
		const w = make();
		const b = inbox();
		w.watch("A", "temper", () => {
			throw new Error("socket gone");
		});
		w.watch("B", "temper", b.send);
		replaceWhole("temper", "- #fact two\n");
		expect(() => w.check()).not.toThrow();
		expect(b.got.at(-1)).toMatchObject({ text: "- #fact two\n" });
		w.close();
	});
});

describe("identity-notes: the role's notes in the tab", () => {
	const make = () => new NotebookWatch<string>({ identities: () => identityRegistry().identities, intervalMs: 60_000 });

	it("the push carries what's sent with every message (rules + index, characters and tokens) and follows a chat's new note", () => {
		const w = make();
		const got: NotebookPush[] = [];
		w.watch("A", "temper", (m) => void got.push(m));
		expect(got[0]?.memory).toMatchObject({
			index: "",
			indexSize: 0,
			indexBudget: INDEX_BUDGET,
			hidden: 0,
			over: false,
			sent: 12,
			cap: NOTEBOOK_CAP,
			tokens: estTokens(12),
			rulesCap: RULES_CAP,
			rulesSize: 12,
			counts: { notes: 0, digests: 0, outdated: 0, rules: 0 },
		});

		const n1 = record("temper", { topic: "deploy", summary: "pi-web-deploy rolls a bad install back" });
		w.check();
		expect(got).toHaveLength(2);
		const index = `[deploy]\n${n1.id} pi-web-deploy rolls a bad install back`;
		expect(got[1]?.memory).toMatchObject({
			index,
			indexSize: byteLength(index),
			sent: 12 + byteLength(index),
			tokens: estTokens(12 + byteLength(index)),
			counts: { notes: 1, digests: 0, outdated: 0, rules: 0 },
		});
		expect(got[1]?.text).toBe("- #fact one\n"); // the rules didn't change

		// A touch of the note's file without a change: nothing new.
		const later = new Date(Date.now() + 5_000);
		utimesSync(join(roleDir("temper"), "notes", `${n1.id}.md`), later, later);
		w.check();
		expect(got).toHaveLength(2);
		w.close();
	});

	it("the index past its budget leaves out the oldest lines and says it's over", () => {
		writeFileSync(
			join(roleDir("temper"), "identity.json"),
			JSON.stringify({ id: "temper", title: "temper", memory: { indexBudget: 120 } }),
		);
		for (let i = 1; i <= 6; i++)
			record("temper", { date: `2026-09-0${i}`, summary: `note number ${i} about something` });
		const { def, settings } = roleOf("temper");
		const mem = roleMemory(def, settings);
		expect(mem.indexBudget).toBe(120);
		expect(mem.over).toBe(true);
		expect(mem.hidden).toBeGreaterThan(0);
		expect(mem.indexSize).toBeLessThanOrEqual(120);
		expect(mem.indexFull).toBeGreaterThan(120);
		expect(mem.index).toContain("note number 6");
		expect(mem.index).not.toContain("note number 1 ");
		expect(mem.index).toContain(`+${mem.hidden} older (notebook search)`);
		expect(mem.cap).toBe(NOTEBOOK_CAP);
		expect(mem.rulesCap).toBe(NOTEBOOK_CAP - 120);
	});

	it("lists, searches and opens a role's notes; removed.md is never searched; another role's never show", () => {
		const n1 = record("temper", {
			date: "2026-10-01",
			topic: "backups",
			summary: "offsite-backup runs nightly at 05:00",
			detail: "rclone crypt offsite: over r2:spark-backup/offsite",
		});
		const n2 = record("temper", {
			date: "2026-10-02",
			topic: "deploy",
			summary: "pi-web-deploy result exits 0 once live",
		});
		record("ops", { summary: "OPSONLY secret line", detail: "OPSONLY detail" });
		const { def, settings } = roleOf("temper");

		const all = searchRoleNotes(def, settings, "");
		expect(all.total).toBe(2);
		expect(all.hits.map((h) => h.ref)).toEqual([n2.id, n1.id]);
		expect(all.hits[1]).toMatchObject({ topic: "backups", date: "2026-10-01", flags: [] });

		const found = searchRoleNotes(def, settings, "rclone crypt");
		expect(found.hits.map((h) => h.ref)).toEqual([n1.id]);
		expect(found.hits[0]?.preview).toContain("rclone crypt");
		expect(searchRoleNotes(def, settings, "OPSONLY").hits).toEqual([]);

		const opened = readRoleNote(def, settings, n1.id);
		expect(opened).toMatchObject({ ok: true, ref: n1.id, editable: true });
		if (!opened.ok) throw new Error("not opened");
		expect(opened.text).toContain("rclone crypt offsite: over r2:spark-backup/offsite");
		expect(opened.hash).toBe(textHash(opened.text));
		// ops's note ids aren't temper's: temper has no third note.
		expect(readRoleNote(def, settings, "n3")).toMatchObject({ ok: false });
		expect(readRoleNote(def, settings, "../ops/notes/n1")).toMatchObject({ ok: false });

		// What removed.md holds is never found.
		writeFileSync(join(roleDir("temper"), "removed.md"), "<!-- x -->\n- REMOVEDWORD gone for good\n");
		expect(searchRoleNotes(def, settings, "REMOVEDWORD").hits).toEqual([]);
	});

	it("an old archive line is found marked old and opens read-only", () => {
		mkdirSync(join(roleDir("temper"), "archive"), { recursive: true });
		writeFileSync(
			join(roleDir("temper"), "archive", "notebook-2026-09-27.md"),
			"# old\n- #fact the ARCHIVEWORD line from before the split\n",
		);
		const { def, settings } = roleOf("temper");
		const hit = searchRoleNotes(def, settings, "ARCHIVEWORD").hits[0];
		expect(hit).toMatchObject({ ref: "archive/notebook-2026-09-27.md:2", flags: ["old"], date: "2026-09-27" });
		const opened = readRoleNote(def, settings, hit?.ref ?? "");
		expect(opened).toMatchObject({ ok: true, editable: false });
		if (!opened.ok) throw new Error("not opened");
		expect(opened.text).toContain("ARCHIVEWORD");
		expect(saveRoleNote(def, settings, hit?.ref ?? "", "x", opened.hash)).toEqual({ ok: false, code: "unknown" });
		expect(deleteRoleNote(def, settings, hit?.ref ?? "", opened.hash)).toEqual({ ok: false, code: "unknown" });
	});

	it("the owner's edit and delete keep the old text in removed.md (never searched)", () => {
		const n1 = record("temper", { topic: "backups", summary: "offsite-backup runs nightly", detail: "OLDDETAIL kept" });
		const n2 = record("temper", { topic: "deploy", summary: "pi-web-deploy checks itself" });
		const { def, settings } = roleOf("temper");
		const first = readRoleNote(def, settings, n1.id);
		if (!first.ok) throw new Error("not opened");

		expect(saveRoleNote(def, settings, n1.id, first.text, "stale")).toEqual({ ok: false, code: "changed" });
		expect(saveRoleNote(def, settings, n1.id, "no header at all", first.hash)).toMatchObject({
			ok: false,
			code: "invalid",
		});
		const noSummary = first.text.replace(/^summary:.*$/m, "summary:");
		const refused = saveRoleNote(def, settings, n1.id, noSummary, first.hash);
		expect(refused).toMatchObject({ ok: false, code: "invalid" });
		expect(refused.ok ? [] : refused.problems?.join(" ")).toContain("summary");
		expect(saveRoleNote(def, settings, "n99", first.text, first.hash)).toEqual({ ok: false, code: "unknown" });

		const edited = first.text.replace("OLDDETAIL kept", "NEWDETAIL now");
		const ok = saveRoleNote(def, settings, n1.id, edited, first.hash);
		expect(ok).toMatchObject({ ok: true });
		expect(searchRoleNotes(def, settings, "NEWDETAIL").hits.map((h) => h.ref)).toEqual([n1.id]);
		expect(searchRoleNotes(def, settings, "OLDDETAIL").hits).toEqual([]);
		const removed = () => readFileSync(join(roleDir("temper"), "removed.md"), "utf8");
		expect(removed()).toContain(`note ${n1.id} replaced by the owner (pi-web-ui)`);
		expect(removed()).toContain("OLDDETAIL kept");

		const second = readRoleNote(def, settings, n2.id);
		if (!second.ok) throw new Error("not opened");
		expect(deleteRoleNote(def, settings, n2.id, "stale")).toEqual({ ok: false, code: "changed" });
		expect(deleteRoleNote(def, settings, n2.id, second.hash)).toEqual({ ok: true, freed: [] });
		expect(existsSync(join(roleDir("temper"), "notes", `${n2.id}.md`))).toBe(false);
		expect(removed()).toContain(`note ${n2.id} deleted by the owner (pi-web-ui)`);
		expect(searchRoleNotes(def, settings, "").hits.map((h) => h.ref)).toEqual([n1.id]);
		// A deleted note's id is never given again.
		expect(record("temper", { summary: "a later note" }).id).not.toBe(n2.id);
	});

	it("a digest stands in for its notes in the index; deleting it puts them back", () => {
		const a = record("temper", { date: "2026-09-01", topic: "backups", summary: "first backup finding" });
		const b = record("temper", { date: "2026-09-02", topic: "backups", summary: "second backup finding" });
		const d = createNote(roleDir("temper"), "notes", {
			tier: 2,
			date: "2026-10-02",
			chat: "tidy",
			topic: "backups",
			summary: "backups digest",
			covers: [a.id, b.id],
		});
		for (const id of [a.id, b.id]) {
			const found = readNote(roleDir("temper"), "notes", id);
			if (!found) throw new Error(`no ${id}`);
			saveNote(roleDir("temper"), "notes", { ...found.note, digest: d.id });
		}
		const { def, settings } = roleOf("temper");
		const mem = roleMemory(def, settings);
		expect(mem.index).toBe(`[backups]\n${d.id} backups digest`);
		expect(mem.counts).toMatchObject({ notes: 2, digests: 1 });
		// The rolled-up notes stay searchable, saying which digest holds them.
		expect(searchRoleNotes(def, settings, "first backup").hits[0]).toMatchObject({ ref: a.id, flags: [`in ${d.id}`] });

		const digest = readRoleNote(def, settings, d.id);
		if (!digest.ok) throw new Error("not opened");
		const gone = deleteRoleNote(def, settings, d.id, digest.hash);
		expect(gone.ok && [...gone.freed].sort()).toEqual([a.id, b.id].sort());
		const after = roleMemory(def, settings).index;
		expect(after).toContain(`${a.id} first backup finding`);
		expect(after).toContain(`${b.id} second backup finding`);
	});
});

describe("the owner's save keeps what it takes out", () => {
	it("droppedLines: removed lines and the old wording of changed ones, once each, no blanks or headings", () => {
		const before = "## Rules\n- #fact one\n\n- #fact two\n- #fact one\n- #lesson three\n";
		const after = "## Rules\n- #fact two\n- #lesson three, reworded\n";
		expect(droppedLines(before, after)).toEqual(["- #fact one", "- #lesson three"]);
		expect(droppedLines(before, before)).toEqual([]);
		expect(droppedLines("", "- new\n")).toEqual([]);
		// Trailing spaces don't make a line "new".
		expect(droppedLines("- a  \n", "- a\n")).toEqual([]);
	});

	it("a notebook save appends the dropped lines to the archive in pi-identity's format", () => {
		const ids = identityRegistry(true).identities;
		const now = new Date(2026, 8, 30, 21, 5);
		const r1 = saveIdentityFile(
			ids,
			"temper",
			"notebook",
			"- #fact two\n",
			textHash("- #fact one\n"),
			process.env,
			now,
		);
		expect(r1).toEqual({ ok: true, hash: textHash("- #fact two\n"), size: 12, archived: 1 });
		const archive = notebookArchivePath("temper");
		// Inside the role's own folder, as private as its notebook; nothing in the shared archive.
		expect(archive).toBe(join(idDir, "temper", "removed.md"));
		expect(existsSync(join(root, "memory", "archive"))).toBe(false);
		expect(readFileSync(archive, "utf8")).toBe(
			"# Lines removed from the temper notebook\n\n<!-- 2026-09-30 21:05 removed or changed by the owner (pi-web-ui) -->\n- #fact one\n",
		);

		// Only adding: nothing archived, the archive untouched.
		const r2 = saveIdentityFile(ids, "temper", "notebook", "- #fact two\n- #fact four\n", textHash("- #fact two\n"));
		expect(r2).toMatchObject({ ok: true, archived: 0 });
		expect(readFileSync(archive, "utf8").match(/<!--/g)).toHaveLength(1);

		// A second removal adds a second entry under the same header.
		saveIdentityFile(ids, "temper", "notebook", "", textHash("- #fact two\n- #fact four\n"), process.env, now);
		const text = readFileSync(archive, "utf8");
		expect(text.match(/^# Lines removed/gm)).toHaveLength(1);
		expect(text.endsWith("-->\n- #fact two\n- #fact four\n")).toBe(true);
	});

	it("an about page save and a refused save archive nothing", () => {
		const ids = identityRegistry(true).identities;
		writeFileSync(join(idDir, "temper", "about.md"), "old about\n");
		expect(saveIdentityFile(ids, "temper", "about", "new about\n", textHash("old about\n"))).toMatchObject({
			ok: true,
			archived: 0,
		});
		expect(saveIdentityFile(ids, "temper", "notebook", "", textHash("stale"))).toEqual({ ok: false, code: "changed" });
		expect(existsSync(notebookArchivePath("temper"))).toBe(false);
	});

	it("a save whose lines can't be archived is refused, the notebook kept as it was", () => {
		const ids = identityRegistry(true).identities;
		// The archive can't be written: a folder sits where the file should be.
		mkdirSync(join(idDir, "temper", "removed.md"));
		expect(saveIdentityFile(ids, "temper", "notebook", "- #fact two\n", textHash("- #fact one\n"))).toEqual({
			ok: false,
			code: "io",
		});
		expect(readFileSync(notebookPath("temper"), "utf8")).toBe("- #fact one\n");
		// Only adding needs no archive: it still saves.
		expect(
			saveIdentityFile(ids, "temper", "notebook", "- #fact one\n- #fact two\n", textHash("- #fact one\n")),
		).toMatchObject({ ok: true, archived: 0 });
	});
});

describe("the page's notebook store", () => {
	const sent: unknown[] = [];
	beforeEach(() => {
		sent.length = 0;
		setAppSend((msg) => {
			sent.push(msg);
			return true;
		});
	});
	const push = (text: string, extra: Record<string, unknown> = {}) =>
		receiveNotebook({
			type: "identity_notebook",
			id: "temper",
			text,
			hash: textHash(text),
			size: text.length,
			cap: 8000,
			...extra,
		});

	it("watches the tab's identity, takes only its pushes, and stops when the tab closes", () => {
		watchNotebook("temper");
		expect(sent).toEqual([{ type: "identity_notebook_watch", id: "temper" }]);
		expect(getNotebook()).toMatchObject({ id: "temper", status: "loading" });
		watchNotebook("temper"); // the same tab rendering again: no new watch
		expect(sent).toHaveLength(1);

		receiveNotebook({ type: "identity_notebook", id: "ops", text: "x", hash: "h" });
		expect(getNotebook()?.status).toBe("loading");
		push("- #fact one\n");
		expect(getNotebook()).toMatchObject({ status: "ready", text: "- #fact one\n", size: 12, cap: 8000 });
		push("- #fact two\n");
		expect(getNotebook()).toMatchObject({ text: "- #fact two\n", hash: textHash("- #fact two\n") });

		receiveNotebook({ type: "identity_notebook", id: "temper", error: "EACCES" });
		expect(getNotebook()).toMatchObject({ status: "error", error: "EACCES" });

		watchNotebook(null);
		expect(sent.at(-1)).toEqual({ type: "identity_notebook_watch", id: null });
		expect(getNotebook()).toBeNull();
		expect(getWatchedNotebook()).toBeNull();
	});

	it("saves with the tab's ref against the version it started from; takes the answer meant for it", () => {
		watchNotebook("temper");
		push("- a\n");
		const base = textHash("- a\n");
		expect(saveNotebook("- a\n- b\n", base)).toBe(true);
		expect(sent.at(-1)).toEqual({
			type: "identity_file_save",
			id: "temper",
			file: "notebook",
			text: "- a\n- b\n",
			baseHash: base,
			ref: NOTEBOOK_TAB_REF,
		});
		expect(getNotebook()?.saving).toBe(true);
		expect(saveNotebook("again", base)).toBe(false); // one at a time

		// The live push of its own save may come first: the save is still on its way.
		push("- a\n- b\n");
		expect(getNotebook()).toMatchObject({ saving: true, text: "- a\n- b\n" });
		receiveNotebookSaved({
			type: "identity_file_saved",
			id: "temper",
			file: "notebook",
			ok: true,
			hash: textHash("- a\n- b\n"),
			size: 8,
			ref: NOTEBOOK_TAB_REF,
		});
		expect(getNotebook()).toMatchObject({ saving: false, saved: { ok: true }, text: "- a\n- b\n", size: 8 });
		clearNotebookSaved();
		expect(getNotebook()?.saved).toBeUndefined();
	});

	it("a refusal keeps the notebook as it is and says why (changed meanwhile, over the cap)", () => {
		watchNotebook("temper");
		push("- a\n");
		saveNotebook("mine\n", textHash("- a\n"));
		push("- a\n- from a chat\n"); // a chat wrote meanwhile
		receiveNotebookSaved({ type: "identity_file_saved", id: "temper", file: "notebook", ok: false, code: "changed" });
		expect(getNotebook()).toMatchObject({
			saving: false,
			saved: { ok: false, code: "changed" },
			text: "- a\n- from a chat\n",
		});

		saveNotebook("x".repeat(9000), textHash("- a\n- from a chat\n"));
		receiveNotebookSaved({ type: "identity_file_saved", id: "temper", file: "notebook", ok: false, code: "over_cap" });
		expect(getNotebook()).toMatchObject({ saved: { ok: false, code: "over_cap" }, text: "- a\n- from a chat\n" });
	});

	it("a new socket asks for the watch again; a save lost with the old one shows as not saved", () => {
		resendNotebookWatch(); // no tab: nothing
		expect(sent).toHaveLength(0);
		watchNotebook("temper");
		push("- a\n");
		saveNotebook("- b\n", textHash("- a\n"));
		sent.length = 0;
		resendNotebookWatch();
		expect(sent).toEqual([{ type: "identity_notebook_watch", id: "temper" }]);
		expect(getNotebook()).toMatchObject({ saving: false, saved: { ok: false, code: "io" } });
	});

	it("a save that can't be sent (no socket) shows as not saved", () => {
		watchNotebook("temper");
		push("- a\n");
		setAppSend(() => false);
		expect(saveNotebook("- b\n", textHash("- a\n"))).toBe(false);
		expect(getNotebook()).toMatchObject({ saving: false, saved: { ok: false, code: "io" } });
	});

	it("identity-notes: lists and searches the notes, taking only the answer to the current query", () => {
		watchNotebook("temper");
		push("- a\n", { memory: memOf() });
		expect(getNotebook()?.memory).toMatchObject({ sent: 100, tokens: 28 });
		expect(searchNotes("")).toBe(true);
		expect(sent.at(-1)).toEqual({ type: "identity_notes_search", id: "temper", query: "" });
		expect(getNotebook()?.notes).toMatchObject({ query: "", status: "loading" });
		receiveNotesFound({ type: "identity_notes_found", id: "temper", query: "other", hits: [hit("n9")], total: 9 });
		expect(getNotebook()?.notes.status).toBe("loading");
		receiveNotesFound({
			type: "identity_notes_found",
			id: "temper",
			query: "",
			hits: [hit("n2"), hit("n1")],
			total: 2,
		});
		expect(getNotebook()?.notes).toMatchObject({ status: "ready", total: 2 });
		expect(getNotebook()?.notes.hits.map((h) => h.ref)).toEqual(["n2", "n1"]);

		searchNotes("  deploy  ");
		expect(sent.at(-1)).toEqual({ type: "identity_notes_search", id: "temper", query: "deploy" });
		receiveNotesFound({ type: "identity_notes_found", id: "temper", query: "deploy", hits: [], total: 2 });
		expect(getNotebook()?.notes).toMatchObject({ query: "deploy", status: "ready", hits: [] });

		// A chat records a note: the push's notesVersion moves and the list is asked again.
		const before = sent.length;
		push("- a\n", { memory: memOf({ notesVersion: "v1" }) });
		expect(sent.length).toBe(before); // same version: nothing
		push("- a\n", { memory: memOf({ notesVersion: "v2" }) });
		expect(sent.at(-1)).toEqual({ type: "identity_notes_search", id: "temper", query: "deploy" });
	});

	it("identity-notes: opens a note, edits it (read again after), deletes it (closes, says so)", () => {
		watchNotebook("temper");
		push("- a\n", { memory: memOf() });
		searchNotes("");
		receiveNotesFound({ type: "identity_notes_found", id: "temper", query: "", hits: [hit("n1")], total: 1 });
		expect(openNote("n1")).toBe(true);
		expect(sent.at(-1)).toEqual({ type: "identity_note_get", id: "temper", ref: "n1" });
		receiveNote({ type: "identity_note", id: "temper", ref: "n2", text: "x", hash: "h" }); // not the open one
		expect(getNotebook()?.notes.open).toMatchObject({ ref: "n1", status: "loading" });
		const text = "id: n1\nsummary: one\n---\ndetail\n";
		receiveNote({
			type: "identity_note",
			id: "temper",
			ref: "n1",
			text,
			hash: textHash(text),
			size: 30,
			editable: true,
		});
		expect(getNotebook()?.notes.open).toMatchObject({ status: "ready", text, editable: true, busy: null });

		expect(saveOpenNote(`${text}more\n`)).toBe(true);
		expect(sent.at(-1)).toEqual({
			type: "identity_note_save",
			id: "temper",
			ref: "n1",
			text: `${text}more\n`,
			baseHash: textHash(text),
		});
		expect(saveOpenNote("again")).toBe(false); // one at a time
		receiveNoteSaved({
			type: "identity_note_saved",
			id: "temper",
			ref: "n1",
			ok: false,
			code: "invalid",
			problems: ["p"],
		});
		expect(getNotebook()?.notes.open).toMatchObject({
			busy: null,
			done: { ok: false, code: "invalid", problems: ["p"] },
		});
		saveOpenNote(`${text}more\n`);
		sent.length = 0;
		receiveNoteSaved({ type: "identity_note_saved", id: "temper", ref: "n1", ok: true, hash: "h2", size: 35 });
		expect(getNotebook()?.notes.open).toMatchObject({ busy: null, done: { ok: true }, hash: "h2" });
		expect(sent).toEqual([
			{ type: "identity_note_get", id: "temper", ref: "n1" },
			{ type: "identity_notes_search", id: "temper", query: "" },
		]);

		const again = `${text}more\n`;
		receiveNote({ type: "identity_note", id: "temper", ref: "n1", text: again, hash: textHash(again), editable: true });
		expect(deleteOpenNote()).toBe(true);
		expect(sent.at(-1)).toEqual({ type: "identity_note_delete", id: "temper", ref: "n1", baseHash: textHash(again) });
		receiveNoteSaved({ type: "identity_note_saved", id: "temper", ref: "n1", ok: true, deleted: true, freed: [] });
		expect(getNotebook()?.notes).toMatchObject({ open: null, deleted: "n1", status: "loading" });
		expect(sent.at(-1)).toEqual({ type: "identity_notes_search", id: "temper", query: "" });
		// The server's push right after it (the notes moved): the list follows, "n1 deleted" stays up...
		push("- a\n", { memory: memOf({ notesVersion: "after-delete" }) });
		expect(getNotebook()?.notes).toMatchObject({ open: null, deleted: "n1", status: "loading" });
		receiveNotesFound({ type: "identity_notes_found", id: "temper", query: "", hits: [], total: 0 });
		expect(getNotebook()?.notes).toMatchObject({ deleted: "n1", status: "ready", hits: [] });
		// ...until the owner's own search.
		searchNotes("");
		expect(getNotebook()?.notes.deleted).toBeUndefined();

		// An old archive stretch opens read-only: no edit, no delete.
		openNote("archive/notebook-2026-09-27.md:2");
		receiveNote({
			type: "identity_note",
			id: "temper",
			ref: "archive/notebook-2026-09-27.md:2",
			text: "old",
			hash: textHash("old"),
			editable: false,
		});
		expect(saveOpenNote("x")).toBe(false);
		expect(deleteOpenNote()).toBe(false);
		closeNote();
		expect(getNotebook()?.notes.open).toBeNull();
	});

	it("identity-notes: a new socket asks for the list and the loading note again; an edit lost with it shows as not saved", () => {
		watchNotebook("temper");
		push("- a\n", { memory: memOf() });
		searchNotes("deploy");
		openNote("n1");
		sent.length = 0;
		resendNotebookWatch();
		expect(sent).toEqual([
			{ type: "identity_notebook_watch", id: "temper" },
			{ type: "identity_notes_search", id: "temper", query: "deploy" },
			{ type: "identity_note_get", id: "temper", ref: "n1" },
		]);
		receiveNote({ type: "identity_note", id: "temper", ref: "n1", text: "t", hash: textHash("t"), editable: true });
		saveOpenNote("t2");
		resendNotebookWatch();
		expect(getNotebook()?.notes.open).toMatchObject({ busy: null, done: { ok: false, code: "io" } });
	});
});

/** identity-notes: a search hit as the server sends it. */
function hit(ref: string, extra: Partial<UiNoteHit> = {}): UiNoteHit {
	return {
		ref,
		score: 1,
		size: 100,
		date: "2026-10-02",
		topic: "deploy",
		flags: [],
		summary: `${ref} summary`,
		preview: "",
		...extra,
	};
}

/** identity-notes: a role's memory as the push carries it. */
function memOf(extra: Partial<UiRoleMemory> = {}): UiRoleMemory {
	return {
		index: "[deploy]\nn1 pi-web-deploy rolls a bad install back",
		indexSize: 48,
		indexFull: 48,
		indexBudget: 2000,
		hidden: 0,
		over: false,
		sent: 100,
		cap: 8000,
		tokens: 28,
		rulesCap: 6000,
		rulesSize: 52,
		counts: { notes: 3, digests: 1, outdated: 2, rules: 1 },
		notesVersion: "v1",
		...extra,
	};
}

describe("the Notebook tab's view", () => {
	beforeEach(() => setAppSend(() => true));
	const render = (onOpenAbout?: () => void) =>
		renderToStaticMarkup(
			createElement(
				LanguageProvider,
				null,
				createElement(NotebookPanel, { identity: { id: "temper", title: "temper" }, onOpenAbout }),
			),
		);

	it("loading until the notebook comes", () => {
		watchNotebook("temper");
		expect(render()).toContain('data-status="loading"');
	});

	it("the rules as raw text (identity-notes: no markdown view), their size against the cap, Edit, and the About page link when offered", () => {
		watchNotebook("temper");
		const text = "## Rules\n- #decision **one** thing\n";
		receiveNotebook({ type: "identity_notebook", id: "temper", text, hash: textHash(text), size: 6100, cap: 8000 });
		const html = render(() => {});
		expect(html).toContain('data-status="ready"');
		expect(html).toContain(`data-hash="${textHash(text)}"`);
		expect(html).toContain('<pre class="notebook-raw notebook-rules">## Rules\n- #decision **one** thing\n</pre>');
		expect(html).not.toContain("<h2>");
		expect(html).not.toContain("<strong>");
		expect(html).toMatch(/class="notebook-size"[^>]*data-size="6100"/);
		expect(html).toContain("6,100 / 8,000");
		expect(html).toContain('class="identity-meter-fill" style="width:76%"');
		expect(html).toContain("notebook-edit");
		expect(html).toContain("notebook-about-link");
		expect(render()).not.toContain("notebook-about-link");
	});

	it("an empty notebook says so; one over the cap is marked; an unreadable one shows the error", () => {
		watchNotebook("temper");
		receiveNotebook({ type: "identity_notebook", id: "temper", text: "", hash: textHash(""), size: 0, cap: 8000 });
		expect(render()).toContain('class="notebook-empty"');
		const big = "x".repeat(8001);
		receiveNotebook({ type: "identity_notebook", id: "temper", text: big, hash: textHash(big), size: 8001, cap: 8000 });
		expect(render()).toContain('class="notebook-size over"');
		receiveNotebook({ type: "identity_notebook", id: "temper", error: "EACCES" });
		const html = render();
		expect(html).toContain('data-status="error"');
		expect(html).toContain("EACCES");
	});

	it("identity-notes: what's sent (characters, tokens), the index raw against its budget, the notes' counts and rows", () => {
		watchNotebook("temper");
		const text = "! rule one\n";
		receiveNotebook({
			type: "identity_notebook",
			id: "temper",
			text,
			hash: textHash(text),
			size: 11,
			cap: 6000,
			memory: memOf({ hidden: 2, over: true, indexFull: 2500 }),
		});
		let html = render();
		expect(html).toMatch(/class="notebook-sent"[^>]*data-sent="100"[^>]*data-tokens="28"/);
		expect(html).toContain("Sent: 100 / 8,000 (~28 tokens)");
		expect(html).toContain('<pre class="notebook-raw notebook-rules">! rule one\n</pre>');
		expect(html).toContain(
			'<pre class="notebook-raw notebook-index">[deploy]\nn1 pi-web-deploy rolls a bad install back</pre>',
		);
		expect(html).toMatch(/class="notebook-index-size over"[^>]*data-size="48"[^>]*data-full="2500"/);
		expect(html).toContain("2 older lines left out");
		expect(html).toContain("over its budget (2,500 in full)");
		expect(html).toContain("3 notes, 1 digests, 2 outdated, 1 made rules");
		expect(html).toContain('class="notebook-search-input"');

		searchNotes("");
		receiveNotesFound({
			type: "identity_notes_found",
			id: "temper",
			query: "",
			hits: [hit("n2", { flags: ["outdated"], summary: "old way" }), hit("n1", { preview: "matched detail" })],
			total: 2,
		});
		html = render();
		expect(html).toContain('data-ref="n2"');
		expect(html).toContain("n2 2026-10-02 [deploy] (outdated) old way");
		expect(html).toContain('<span class="notebook-note-preview">matched detail</span>');

		searchNotes("nothing");
		receiveNotesFound({ type: "identity_notes_found", id: "temper", query: "nothing", hits: [], total: 2 });
		expect(render()).toContain("No note matches \u201cnothing\u201d.");
	});

	it("identity-notes: an open note raw with Edit and Delete; an old archive stretch read-only; a deleted note says so", () => {
		watchNotebook("temper");
		receiveNotebook({
			type: "identity_notebook",
			id: "temper",
			text: "",
			hash: textHash(""),
			size: 0,
			cap: 6000,
			memory: memOf(),
		});
		openNote("n1");
		const note = "id: n1\nsummary: one\n---\nthe detail\n";
		receiveNote({ type: "identity_note", id: "temper", ref: "n1", text: note, hash: textHash(note), editable: true });
		let html = render();
		expect(html).toMatch(/class="notebook-open" data-ref="n1"/);
		expect(html).toContain(`<pre class="notebook-raw notebook-note-text">${note}</pre>`);
		expect(html).toContain("notebook-note-edit");
		expect(html).toContain("notebook-note-delete");

		openNote("archive/notebook-2026-09-27.md:2");
		receiveNote({
			type: "identity_note",
			id: "temper",
			ref: "archive/notebook-2026-09-27.md:2",
			text: "old line",
			hash: textHash("old line"),
			editable: false,
		});
		html = render();
		expect(html).not.toContain("notebook-note-edit");
		expect(html).not.toContain("notebook-note-delete");
		expect(html).toContain("Old archive (read-only)");

		openNote("n1");
		receiveNote({ type: "identity_note", id: "temper", ref: "n1", text: note, hash: textHash(note), editable: true });
		deleteOpenNote();
		receiveNoteSaved({ type: "identity_note_saved", id: "temper", ref: "n1", ok: true, deleted: true, freed: [] });
		expect(render()).toContain("n1 deleted (kept in removed.md).");
	});
});
