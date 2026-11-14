// @vitest-environment jsdom
/**
 * Memory explorer (design #316): the first screen and its states, written failing-first from design
 * #315's HANDOFF.md ("The screen, top to bottom" and "States").
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	MARKDOWN_MARKS,
	bannedTermsIn,
	before,
	byRole,
	click,
	maybeByRole,
	mountExplorer,
	oneByRole,
	text,
	visibleWords,
	type Mounted,
} from "./memory-explorer/explorer-dom.js";
import { fakeApi } from "./memory-explorer/fake-api.js";

let page: Mounted | null = null;
afterEach(() => {
	page?.unmount();
	page = null;
});

describe("first screen, top to bottom", () => {
	it("shows title, health line, Find, the recent list, then the tree, in that order", async () => {
		page = await mountExplorer(fakeApi());
		const c = page.container;
		const title = oneByRole(c, "heading", "Memory");
		const health = oneByRole(c, "status", /Memory is up/);
		const find = oneByRole(c, "region", "Search memory");
		const recent = oneByRole(c, "heading", "Changed most recently");
		const tree = oneByRole(c, "navigation", "Where memory keeps things");
		expect(before(title, health)).toBe(true);
		expect(before(health, find)).toBe(true);
		expect(before(find, recent)).toBe(true);
		expect(before(recent, tree)).toBe(true);
	});

	it("health line says up, last save, notes and checked time in one line", async () => {
		page = await mountExplorer(fakeApi());
		const health = text(oneByRole(page.container, "status", /Memory is up/));
		expect(health).toMatch(/last save 4 min ago/);
		expect(health).toMatch(/6 notes/);
		expect(health).toMatch(/checked/);
	});

	it("Find has a question box, Search, the two ways and the scope menu", async () => {
		page = await mountExplorer(fakeApi());
		const find = oneByRole(page.container, "region", "Search memory");
		oneByRole(find, "searchbox", "What do you want to find?");
		oneByRole(find, "button", "Search");
		expect(oneByRole(find, "button", "By meaning").getAttribute("aria-pressed")).toBe("true");
		expect(oneByRole(find, "button", "Exact words").getAttribute("aria-pressed")).toBe("false");
		const scope = oneByRole(find, "combobox", "Where to search") as HTMLSelectElement;
		const options = [...scope.options].map((o) => o.textContent);
		expect(options.slice(0, 3)).toEqual(["Everything", "Shared notes", "Project documents"]);
		expect(options).toContain("Design");
		expect(byRole(find, "button").filter((b) => b.hasAttribute("data-try")).length).toBeGreaterThanOrEqual(3);
	});

	it("lists the newest notes first with plain one-line summaries", async () => {
		page = await mountExplorer(fakeApi());
		const rows = byRole(page.container, "button").filter((b) => b.hasAttribute("data-note"));
		expect(rows.length).toBeGreaterThanOrEqual(4);
		expect(text(rows[0])).toMatch(/^Memory redesign/);
		for (const row of rows) expect(visibleWords(row)).not.toMatch(MARKDOWN_MARKS);
		expect(text(rows[0])).toContain("Case: memory page redesign Role: design.");
	});

	it("never lists a setup file among recent notes", async () => {
		page = await mountExplorer(fakeApi());
		const uris = byRole(page.container, "button").map((b) => b.getAttribute("data-note"));
		expect(uris).not.toContain("viking://user/design/memories/identity.md");
	});

	it("groups the tree: shared, project documents, each department, with counts", async () => {
		page = await mountExplorer(fakeApi());
		const tree = oneByRole(page.container, "navigation", "Where memory keeps things");
		const words = text(tree);
		expect(words.indexOf("Shared by every chat")).toBeLessThan(words.indexOf("Project documents"));
		expect(words.indexOf("Project documents")).toBeLessThan(words.indexOf("Each department's own notes"));
		const design = oneByRole(tree, "button", "Design");
		expect(text(design.closest("[data-tree-row]"))).toMatch(/Design\s*2/);
	});

	it("uses no internal words on the page (stored paths are data, left out)", async () => {
		page = await mountExplorer(fakeApi());
		expect(bannedTermsIn(visibleWords(page.container))).toEqual([]);
	});

	it("shows stored paths only as marked data", async () => {
		page = await mountExplorer(fakeApi());
		const withPaths = [...page.container.querySelectorAll("*")].filter(
			(el) => el.children.length === 0 && /viking:\/\//.test(el.textContent ?? ""),
		);
		expect(withPaths.length).toBeGreaterThan(0);
		for (const el of withPaths) expect(el.closest("[data-path]")).not.toBeNull();
	});
});

describe("states", () => {
	it("loading: checking memory, placeholders, busy", async () => {
		page = await mountExplorer(fakeApi({ hang: ["health", "roots", "recent"] }));
		const c = page.container;
		oneByRole(c, "status", /Checking memory/);
		expect(c.querySelector('[aria-busy="true"]')).not.toBeNull();
		oneByRole(c, "heading", /Loading memory/);
	});

	it("working: memory up, edit and delete on", async () => {
		page = await mountExplorer(fakeApi());
		await click(byRole(page.container, "button").find((b) => b.hasAttribute("data-note")) as HTMLElement);
		expect((oneByRole(page.container, "button", "Edit") as HTMLButtonElement).disabled).toBe(false);
	});

	it("degraded: memory up but some places could not be read, says so", async () => {
		page = await mountExplorer(fakeApi({ health: "degraded" }));
		expect(text(oneByRole(page.container, "status", /Memory is up/))).toMatch(/some places couldn't be read/i);
	});

	it("offline: memory down, last copy shown, edit and delete off with the reason", async () => {
		page = await mountExplorer(fakeApi({ health: "down" }));
		const c = page.container;
		const health = oneByRole(c, "status", /Memory is down/);
		expect(text(health)).toMatch(/since/);
		oneByRole(health, "button", "Try again");
		await click(byRole(c, "button").find((b) => b.hasAttribute("data-note")) as HTMLElement);
		expect((oneByRole(c, "button", "Edit") as HTMLButtonElement).disabled).toBe(true);
		expect((oneByRole(c, "button", "Delete") as HTMLButtonElement).disabled).toBe(true);
		expect(text(c)).toContain("Editing and deleting are off while memory is down.");
	});

	it("empty: memory holds no notes, says so in plain words", async () => {
		page = await mountExplorer(fakeApi({ empty: true }));
		oneByRole(page.container, "heading", "Memory has no notes yet");
	});

	it("error: the list could not load, says so with Try again", async () => {
		const api = fakeApi({ fail: { recent: "FAILED", roots: "FAILED" } });
		page = await mountExplorer(api);
		const c = page.container;
		expect(text(c)).toMatch(/Couldn't load memory/);
		const retry = byRole(c, "button", "Try again");
		expect(retry.length).toBeGreaterThan(0);
		const calls = api.recent.mock.calls.length;
		await click(retry[0]);
		expect(api.recent.mock.calls.length).toBeGreaterThan(calls);
	});

	it("never shows error codes or stack text", async () => {
		page = await mountExplorer(fakeApi({ fail: { recent: "FAILED", roots: "FAILED", health: "MEMORY_DOWN" } }));
		expect(text(page.container)).not.toMatch(/FAILED|MEMORY_DOWN|Error:|at \w+ \(/);
		expect(maybeByRole(page.container, "status", /Memory is (up|down)|Checking/)).not.toBeNull();
	});
});
