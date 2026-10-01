/**
 * identity-notebook-tab: unit tests.
 *
 * - the server's NotebookWatch: a window gets the notebook at once and again on every change, whoever
 *   made it (a rename-replace like pi-identity's, an in-place edit); a touch without a change sends
 *   nothing; each window is sent only what it hasn't got; a closed window or tab stops it;
 * - the owner's save keeps the lines it takes out in the memory archive (pi-identity's format);
 * - the page's store (notebook-state.ts): watch, the live push, a save with the tab's ref, the conflict
 *   and cap refusals, a reconnect;
 * - the panel's render (view only: the draft is local state).
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
import { type NotebookPush, NotebookWatch } from "../../server/notebook-watch.js";
import { setAppSend } from "../../web/src/app-globals.js";
import { NotebookPanel } from "../../web/src/components/NotebookPanel.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import {
	clearNotebookSaved,
	getNotebook,
	getWatchedNotebook,
	NOTEBOOK_TAB_REF,
	receiveNotebook,
	receiveNotebookSaved,
	resendNotebookWatch,
	resetNotebookState,
	saveNotebook,
	watchNotebook,
} from "../../web/src/notebook-state.js";

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
		expect(a.got).toEqual([
			{
				type: "identity_notebook",
				id: "temper",
				text: "- #fact one\n",
				hash: textHash("- #fact one\n"),
				size: 12,
				cap: NOTEBOOK_CAP,
			},
		]);
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
		expect(archive).toBe(join(root, "memory", "archive", "notebook-temper-removed.md"));
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
		// The archive folder can't be made: a file sits where it should be.
		mkdirSync(join(root, "memory"), { recursive: true });
		writeFileSync(join(root, "memory", "archive"), "not a folder");
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
});

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

	it("the notebook as markdown, its size against the cap, Edit, and the About page link when offered", () => {
		watchNotebook("temper");
		const text = "## Rules\n- #decision **one** thing\n";
		receiveNotebook({ type: "identity_notebook", id: "temper", text, hash: textHash(text), size: 6100, cap: 8000 });
		const html = render(() => {});
		expect(html).toContain('data-status="ready"');
		expect(html).toContain(`data-hash="${textHash(text)}"`);
		expect(html).toContain("<h2>Rules</h2>");
		expect(html).toContain("<strong>one</strong>");
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
});
