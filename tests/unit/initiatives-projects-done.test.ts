/// <reference types="vite/client" />
// @vitest-environment jsdom
// initiatives-projects-done (docs/initiatives-projects-done.md, Ops #274, H-PROJECTS-DONE-1): finished projects
// at a glance. The card counts an initiative's projects; done and dropped projects leave "Who's doing what" for
// their own "Finished projects" fold at its top, closed by default. The core model on a fixed registry page,
// alone and through the real view and template. No chats, server or model calls; the names are made up.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InitiativesExactInput } from "../../web/src/initiatives-exact-model";
import { createInitiativesExactView, type InitiativesExactActions } from "../../web/src/initiatives-exact-view";
import { bindInitiativesSurface } from "../../web/src/initiatives-u0/surface";
import { buildInitiativesPage, finishedProjects, projectCount } from "../../web/src/initiatives-page/model";
import type { UiWorkPage, UiWorkPageRecord } from "../../web/src/types";
import { AT, pageArgs } from "./initiatives-page-fixture";

const DAY = 86_400_000;
const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
/** The texts of an element's innermost elements with text, in document order (each span or button on its own). */
const leaves = (el: Element) =>
	Array.from(el.querySelectorAll("*"))
		.filter((e) => e.children.length === 0 && norm(e.textContent) !== "")
		.map((e) => norm(e.textContent));
/** The texts of an element's own children with text, in order (a fold line's or a row's parts). */
const parts = (el: Element) =>
	Array.from(el.children)
		.map((e) => norm(e.textContent))
		.filter((s) => s !== "");

const rec = (
	id: string,
	name: string,
	lead: string,
	status: UiWorkPageRecord["status"],
	met: number,
	total: number,
	initiative?: string | null,
	daysAgo = 0,
): UiWorkPageRecord => ({
	id,
	name,
	outcome: "",
	lead,
	status,
	createdAt: AT - 30 * DAY,
	createdBy: "owner",
	updatedAt: AT - daysAgo * DAY,
	doneWhen: Array.from({ length: total }, (_, k) => ({
		item: `item ${k + 1}`,
		...(k < met ? { met: { proof: "checked", by: "ops", at: AT } } : {}),
	})),
	...(initiative !== undefined ? { initiative } : {}),
});

/** Alpha: 2 done, 1 dropped and 4 active projects (the hypothesis's sealed case). Beta: no projects. Gamma: one
 *  project, done. In no initiative: one active, one done, one dropped. */
const PAGE: UiWorkPage = {
	at: AT,
	initiatives: [
		rec("gamma", "Gamma rollout", "qa", "active", 0, 1),
		rec("beta", "Beta cleanup", "docs", "active", 0, 1),
		rec("alpha", "Alpha launch", "architecture", "active", 1, 3),
	],
	projects: [
		rec("p-search", "Search box", "backend", "done", 3, 3, "alpha", 2),
		rec("p-one", "Lane one", "frontend", "active", 0, 2, "alpha"),
		rec("p-login", "Login form", "frontend", "done", 2, 2, "alpha", 1),
		rec("p-two", "Lane two", "backend", "active", 1, 2, "alpha"),
		rec("p-idea", "Old idea", "design", "dropped", 0, 1, "alpha", 3),
		rec("p-three", "Lane three", "qa", "active", 0, 1, "alpha"),
		rec("p-four", "Lane four", "docs", "active", 0, 0, "alpha"),
		rec("p-gamma", "Gamma check", "qa", "done", 1, 1, "gamma", 4),
		rec("p-docs", "Docs sweep", "docs", "active", 0, 3, null),
		rec("p-lane", "Spare lane", "ops", "done", 1, 1, null, 5),
		rec("p-spare", "Spare idea", "ops", "dropped", 0, 0, "no-such-initiative", 6),
	],
	tasks: [],
	activity: [],
};

const build = (page: UiWorkPage = PAGE, selected = "alpha") =>
	buildInitiativesPage(pageArgs({ work: { page, status: "ready" }, selected, open: vi.fn() }));
const byName = (input: InitiativesExactInput, name: string) => input.initiatives?.find((i) => i.name === name);

describe("the core model: projects split into active rows and finished ones", () => {
	it("counts done projects of all but the dropped ones, and the dropped ones apart", () => {
		expect(projectCount(PAGE.projects.filter((p) => p.initiative === "alpha"))).toEqual({
			done: 2,
			total: 6,
			dropped: 1,
		});
		expect(projectCount([])).toEqual({ done: 0, total: 0, dropped: 0 });
	});

	it("gives an initiative only its active projects as rows, and its finished ones newest first", () => {
		const alpha = byName(build().input, "Alpha launch");
		expect(alpha?.roles?.map((r) => r.name)).toEqual(["Lane one", "Lane two", "Lane three", "Lane four"]);
		expect(alpha?.rowsNote).toBeUndefined();
		expect(alpha?.projectCount).toEqual({ done: 2, total: 6, dropped: 1 });
		expect(alpha?.finishedProjects).toEqual([
			{
				name: "Login form",
				opens: "~project:p-login",
				lead: "Frontend",
				state: "done",
				at: "Sat Oct 17",
				count: "2 of 2 done",
			},
			{
				name: "Search box",
				opens: "~project:p-search",
				lead: "Backend",
				state: "done",
				at: "Fri Oct 16",
				count: "3 of 3 done",
			},
			{
				name: "Old idea",
				opens: "~project:p-idea",
				lead: "Design",
				state: "dropped",
				at: "Thu Oct 15",
				count: "0 of 1 done",
			},
		]);
		// The fold's rows are the model's own helper on the same records.
		expect(finishedProjects(PAGE.projects.filter((p) => p.initiative === "alpha"))).toEqual(alpha?.finishedProjects);
	});

	it("gives no count and no fold to an initiative with no projects, and says when none is active", () => {
		const { input } = build();
		const beta = byName(input, "Beta cleanup");
		expect(beta?.projectCount).toBeUndefined();
		expect(beta?.finishedProjects).toEqual([]);
		expect(beta?.rowsNote).toBe("No projects in this initiative yet.");
		const gamma = byName(input, "Gamma rollout");
		expect(gamma?.projectCount).toEqual({ done: 1, total: 1, dropped: 0 });
		expect(gamma?.roles).toEqual([]);
		expect(gamma?.rowsNote).toBe("No active projects.");
		expect(gamma?.finishedProjects?.map((p) => [p.name, p.count])).toEqual([["Gamma check", "1 of 1 done"]]);
	});

	it("splits the projects in no initiative the same way, and keeps every one of them in the box's list", () => {
		const { input } = build();
		const loose = input.loose?.detail;
		expect(loose?.roles?.map((r) => r.name)).toEqual(["Docs sweep"]);
		expect(loose?.rowsNote).toBeUndefined();
		expect(loose?.finishedProjects?.map((p) => [p.name, p.state, p.at, p.count])).toEqual([
			["Spare lane", "done", "Tue Oct 13", "1 of 1 done"],
			["Spare idea", "dropped", "Mon Oct 12", "No done-when items yet"],
		]);
		// The left column's box items are unchanged: every project in no initiative, each with its status.
		expect(input.loose?.items?.map((l) => l.name).sort()).toEqual(["Docs sweep", "Spare idea", "Spare lane"]);
		const allOver = { ...PAGE, projects: PAGE.projects.filter((p) => p.id !== "p-docs") };
		const over = build(allOver).input.loose?.detail;
		expect(over?.roles).toEqual([]);
		expect(over?.rowsNote).toBe("No active projects.");
		expect(over?.finishedProjects).toHaveLength(2);
	});
});

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const clean of cleanups.splice(0)) clean();
	document.body.replaceChildren();
});

/** The real template with the view, on `input`. */
function mount(input: InitiativesExactInput) {
	const actions: InitiativesExactActions = { open: vi.fn(), retry: vi.fn(), select: vi.fn() };
	let dirty = false;
	const view = createInitiativesExactView(
		() => input,
		() => actions,
		() => {
			dirty = true;
		},
	);
	const binding = bindInitiativesSurface(document, () => view.values());
	cleanups.push(() => {
		binding.dispose();
		view.dispose();
	});
	const buttons = () => Array.from(document.querySelectorAll("button"));
	const button = (text: string | RegExp) => {
		const b = buttons().find((el) =>
			typeof text === "string" ? norm(el.textContent) === text : text.test(norm(el.textContent)),
		);
		if (!b) throw new Error(`no button ${text}`);
		return b;
	};
	return {
		actions,
		text: () => norm(document.body.textContent),
		button,
		click(text: string | RegExp) {
			button(text).dispatchEvent(new MouseEvent("click", { bubbles: true }));
			if (dirty) binding.update();
			dirty = false;
		},
	};
}

describe("the page: the card's projects line and the Finished projects fold", () => {
	// Ops #278 (docs/gate-view-cases.md): its own limit, 15 s. One mount and its checks, and it is this file's first
	// mount: in a whole-file run it takes about 375 ms against 117 ms for a later one-mount case. It timed out once in
	// a land gate under load (5467 ms). There is nothing to split.
	it("puts the projects count under the outcomes count on each card with projects, and none without", () => {
		const page = mount(build().input);
		expect(leaves(page.button(/^Alpha launch/)).slice(-2)).toEqual([
			"1 of 3 outcomes done",
			"2 of 6 projects done \u00b7 1 dropped",
		]);
		expect(leaves(page.button(/^Gamma rollout/)).slice(-2)).toEqual(["0 of 1 outcomes done", "1 of 1 project done"]);
		expect(leaves(page.button(/^Beta cleanup/)).slice(-1)).toEqual(["0 of 1 outcomes done"]);
		expect(norm(page.button(/^Beta cleanup/).textContent)).not.toMatch(/project/);
	}, 15_000);

	it("shows the fold closed, above the first active row, and lists the finished projects when opened", () => {
		const page = mount(build().input);
		const fold = page.button(/^Finished projects \u00b7 3/);
		expect(parts(fold)).toEqual(["Finished projects \u00b7 3", "latest Sat Oct 17"]);
		expect(fold.getAttribute("aria-expanded")).toBe("false");
		const first = page.button("Lane one");
		expect(fold.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		for (const name of ["Login form", "Search box", "Old idea"]) expect(page.text()).not.toContain(name);

		page.click(/^Finished projects \u00b7 3/);
		expect(page.button(/^Finished projects \u00b7 3/).getAttribute("aria-expanded")).toBe("true");
		const rows = Array.from(document.querySelectorAll("li")).filter((li) =>
			/^(Login form|Search box|Old idea)/.test(norm(li.textContent)),
		);
		expect(rows.map(parts)).toEqual([
			["Login form", "Lead \u00b7 Frontend", "2 of 2 done", "done Sat Oct 17"],
			["Search box", "Lead \u00b7 Backend", "3 of 3 done", "done Fri Oct 16"],
			["Old idea", "Lead \u00b7 Design", "0 of 1 done", "dropped Thu Oct 15"],
		]);
		// Still above the active rows once open.
		expect(rows[2].compareDocumentPosition(page.button("Lane one")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

		// A name opens its project, as a row's name does.
		page.click("Search box");
		expect(page.actions.select).toHaveBeenCalledWith("~project:p-search");
	});

	it("shows no fold for an initiative with no finished project", () => {
		const page = mount(build(PAGE, "beta").input);
		expect(page.text()).toContain("No projects in this initiative yet.");
		expect(page.text()).not.toContain("Finished projects");
	});
});
