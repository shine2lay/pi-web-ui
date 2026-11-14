// @vitest-environment jsdom
/**
 * Memory explorer (design #316): finding things and reading them, written failing-first from design
 * #315's HANDOFF.md (Find panel, results, folder view, note view at three levels, setup files).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	MARKDOWN_MARKS,
	byRole,
	choose,
	click,
	maybeByRole,
	mountExplorer,
	oneByRole,
	text,
	typeInto,
	visibleWords,
	type Mounted,
} from "./memory-explorer/explorer-dom.js";
import { CASE_URI, DESIGN, SETUP_URI, SHARED, fakeApi } from "./memory-explorer/fake-api.js";

let page: Mounted | null = null;
afterEach(() => {
	page?.unmount();
	page = null;
});

const find = (c: HTMLElement) => oneByRole(c, "region", "Search memory");
const rows = (c: HTMLElement) => byRole(c, "button").filter((b) => b.hasAttribute("data-note"));
const rowFor = (c: HTMLElement, uri: string) =>
	byRole(c, "button").find((b) => b.getAttribute("data-note") === uri) as HTMLElement;

async function ask(c: HTMLElement, query: string): Promise<void> {
	await typeInto(oneByRole(find(c), "searchbox") as HTMLInputElement, query);
	await click(oneByRole(find(c), "button", "Search"));
}

describe("search by meaning", () => {
	it("asks memory with the question, the way and the scope, and lists the hits", async () => {
		const api = fakeApi();
		page = await mountExplorer(api);
		await ask(page.container, "how should marketing copy be written");
		expect(api.search).toHaveBeenLastCalledWith(
			{ mode: "meaning", query: "how should marketing copy be written", scope: "all", limit: 30 },
			expect.anything(),
		);
		oneByRole(page.container, "heading", "3 notes match");
		expect(rows(page.container).map((r) => r.getAttribute("data-note"))[0]).toBe(CASE_URI);
	});

	it("labels each hit against the best one: strong, good, weak", async () => {
		page = await mountExplorer(fakeApi());
		await ask(page.container, "memory page");
		const labels = rows(page.container).map((r) => text(r.querySelector("[data-match]")));
		expect(labels).toEqual(["Strong match", "Good match", "Weak match"]);
	});

	it("shows hits' summaries as plain text", async () => {
		page = await mountExplorer(fakeApi());
		await ask(page.container, "memory page");
		for (const row of rows(page.container)) expect(visibleWords(row)).not.toMatch(MARKDOWN_MARKS);
	});
});

describe("search by exact words", () => {
	it("switches the way, says what it does, and shows the matching line", async () => {
		const api = fakeApi();
		page = await mountExplorer(api);
		await click(oneByRole(find(page.container), "button", "Exact words"));
		expect(oneByRole(find(page.container), "button", "Exact words").getAttribute("aria-pressed")).toBe("true");
		expect(text(find(page.container))).toContain("Finds these exact words and shows the line.");
		await ask(page.container, "find things");
		expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "words", query: "find things" }), expect.anything());
		oneByRole(page.container, "heading", "1 matching line in 1 note");
		expect(text(rows(page.container)[0])).toContain("Owner asked to find things");
	});
});

describe("scope", () => {
	it("searches only the chosen place, and the recent list follows it", async () => {
		const api = fakeApi();
		page = await mountExplorer(api);
		await choose(oneByRole(find(page.container), "combobox", "Where to search") as HTMLSelectElement, DESIGN);
		expect(api.recent).toHaveBeenLastCalledWith(DESIGN, 12, expect.anything());
		await ask(page.container, "memory page");
		expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ scope: DESIGN }), expect.anything());
	});
});

describe("no results", () => {
	it("says so and offers the other way and searching everything", async () => {
		const api = fakeApi();
		page = await mountExplorer(api);
		await choose(oneByRole(find(page.container), "combobox", "Where to search") as HTMLSelectElement, SHARED);
		await ask(page.container, "nothing at all");
		oneByRole(page.container, "heading", /Nothing matches/);
		await click(oneByRole(page.container, "button", "Search everything"));
		expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ scope: "all", query: "nothing at all" }), expect.anything());
		await click(oneByRole(page.container, "button", "Try Exact words"));
		expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ mode: "words" }), expect.anything());
	});
});

describe("try examples and clear", () => {
	it("a Try example runs its search; Clear goes back to the recent list", async () => {
		const api = fakeApi();
		page = await mountExplorer(api);
		const chip = byRole(find(page.container), "button").find((b) => b.hasAttribute("data-try")) as HTMLElement;
		await click(chip);
		expect(api.search).toHaveBeenCalledTimes(1);
		expect((oneByRole(find(page.container), "searchbox") as HTMLInputElement).value).toBe(chip.getAttribute("data-try"));
		await click(oneByRole(find(page.container), "button", "Clear search"));
		oneByRole(page.container, "heading", "Changed most recently");
	});
});

describe("reading a note: the three levels memory keeps", () => {
	it("opens a note with title, facts, the stored path and the three levels", async () => {
		const api = fakeApi();
		page = await mountExplorer(api);
		await click(rowFor(page.container, CASE_URI));
		expect(api.read).toHaveBeenCalledWith(CASE_URI, expect.anything());
		const c = page.container;
		oneByRole(c, "heading", "Memory redesign");
		const facts = text(c.querySelector("dl"));
		expect(facts).toContain("Kept in Design's own notes");
		expect(facts).toContain("Kind Case");
		expect(facts).toContain("Changed 4 min ago");
		expect(facts).toContain("Length about 400 words");
		expect(text(c.querySelector("[data-path]"))).toBe(CASE_URI);
		oneByRole(c, "button", "Copy path");
		const levels = oneByRole(c, "region", "How memory keeps it");
		const words = text(levels);
		expect(words.indexOf("One-line summary")).toBeLessThan(words.indexOf("Overview"));
		expect(words.indexOf("Overview")).toBeLessThan(words.indexOf("Full text"));
	});

	it("shows the one-line summary as clean text, without markdown marks", async () => {
		page = await mountExplorer(fakeApi());
		await click(rowFor(page.container, CASE_URI));
		const summary = page.container.querySelector("[data-level='1']") as HTMLElement;
		expect(text(summary)).toContain("Case: memory page redesign Role: design.");
		expect(visibleWords(summary)).not.toMatch(MARKDOWN_MARKS);
	});

	it("folds the overview and renders the full text as formatted text", async () => {
		page = await mountExplorer(fakeApi());
		await click(rowFor(page.container, CASE_URI));
		const overview = page.container.querySelector("[data-level='2']") as HTMLDetailsElement;
		expect(overview.tagName).toBe("DETAILS");
		expect(overview.open).toBe(false);
		const full = page.container.querySelector("[data-level='3']") as HTMLElement;
		expect(byRole(full, "listitem").map((li) => text(li))).toEqual(["Owner asked to find things", "Picked P"]);
		expect(text(full)).not.toMatch(/\*\*|^#/);
	});

	it("Back returns to the list and to the row that opened the note", async () => {
		page = await mountExplorer(fakeApi());
		await click(rowFor(page.container, CASE_URI));
		await click(oneByRole(page.container, "button", "Back to start"));
		oneByRole(page.container, "heading", "Changed most recently");
		expect(document.activeElement?.getAttribute("data-note")).toBe(CASE_URI);
	});

	it("moves focus to the note's title when it opens", async () => {
		page = await mountExplorer(fakeApi());
		await click(rowFor(page.container, CASE_URI));
		expect(text(document.activeElement)).toBe("Memory redesign");
	});
});

describe("setup files", () => {
	it("shows a department's setup file as locked, with no text and no Edit or Delete", async () => {
		page = await mountExplorer(fakeApi());
		const tree = oneByRole(page.container, "navigation", "Where memory keeps things");
		await click(oneByRole(tree, "button", "Design"));
		await click(rowFor(page.container, SETUP_URI));
		const c = page.container;
		expect(text(c)).toContain("It is managed with the department's settings, so it isn't shown or changed here.");
		expect(maybeByRole(c, "button", "Edit")).toBeNull();
		expect(maybeByRole(c, "button", "Delete")).toBeNull();
	});
});

describe("reading a folder", () => {
	it("opens a folder from the tree: its name, what's inside, and no summary said plainly", async () => {
		const api = fakeApi();
		page = await mountExplorer(api);
		const tree = oneByRole(page.container, "navigation", "Where memory keeps things");
		await click(oneByRole(tree, "button", "Design"));
		expect(api.folder).toHaveBeenCalledWith(DESIGN, null, expect.anything());
		const c = page.container;
		oneByRole(c, "heading", "Design");
		expect(text(c)).toContain("No summary written yet.");
		expect(rows(c).map((r) => r.getAttribute("data-note"))).toContain(SETUP_URI);
		expect(byRole(c, "button").some((b) => b.getAttribute("data-folder") === `${DESIGN}/cases`)).toBe(true);
	});
});
