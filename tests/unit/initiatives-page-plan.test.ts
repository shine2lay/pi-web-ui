/// <reference types="vite/client" />
// @vitest-environment jsdom
// initiatives-page-plan (docs/initiatives-page-plan.md, Ops #226): step 2's plan section (goals, start days,
// done-when items with their proof) and a project's own detail, on a fixed work registry page, alone and
// through the supplied design's view and template. No chats, server or model calls; the names are made up.
import { afterEach, describe, expect, it, vi } from "vitest";
import { workPageFrom } from "../../server/work-page";
import type { InitiativesExactInput, InitiativesExactOutcome } from "../../web/src/initiatives-exact-model";
import { createInitiativesExactView, type InitiativesExactActions } from "../../web/src/initiatives-exact-view";
import { bindInitiativesSurface } from "../../web/src/initiatives-u0/surface";
import { buildInitiativesPage, type InitiativesPageArgs } from "../../web/src/initiatives-page/model";
import { planPart } from "../../web/src/initiatives-page/plan";
import { NO_INITIATIVE, projectFrameId } from "../../web/src/initiatives-page/types";
import type { UiWorkPage } from "../../web/src/types";
import { AT, PAGE, pageArgs } from "./initiatives-page-fixture";

const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** The fixture with a goal on every record (the fixture's own have none). */
const GOALS: UiWorkPage = {
	...PAGE,
	initiatives: PAGE.initiatives.map((r) => ({ ...r, outcome: `${r.name} is done right` })),
	projects: PAGE.projects.map((r) => ({ ...r, outcome: ` ${r.name} is done right ` })),
};

const plan = (page: UiWorkPage) => planPart(page, undefined, vi.fn()).initiatives ?? {};
const build = (page: UiWorkPage = GOALS, over: Partial<InitiativesPageArgs> = {}) =>
	buildInitiativesPage(pageArgs({ open: vi.fn(), work: { page, status: "ready" }, ...over }));
/** The view's rule for a done outcome: every step done. */
const done = (oc: InitiativesExactOutcome) => !!oc.steps?.length && oc.steps.every((s) => s.kind === "done");

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
	const find = (text: string | RegExp) =>
		Array.from(document.querySelectorAll("button")).find((el) =>
			typeof text === "string" ? norm(el.textContent) === text : text.test(norm(el.textContent)),
		);
	return {
		actions,
		text: () => norm(document.body.textContent),
		button: find,
		/** A detail fact's value: "Started", "Lead", "Roles". */
		fact: (label: string) =>
			norm(
				Array.from(document.querySelectorAll("dt")).find((dt) => norm(dt.textContent) === label)?.nextElementSibling
					?.textContent,
			),
		click(text: string | RegExp) {
			const b = find(text);
			if (!b) {
				const all = Array.from(document.querySelectorAll("button")).map((el) => norm(el.textContent));
				throw new Error(`no button ${text} among ${JSON.stringify(all)}`);
			}
			b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			if (dirty) binding.update();
			dirty = false;
		},
	};
}

describe("step 2's plan part, on a fixed registry page", () => {
	it("gives an initiative its goal, start day and done-when items in order, met ones with proof and marker", () => {
		const alpha = plan(GOALS).alpha;
		expect(alpha?.goal).toBe("Alpha launch is done right");
		expect(alpha?.started).toBe("Sat Oct 17");
		expect(alpha?.outcomesNote).toBeUndefined();
		const login = { label: "Login form", kind: "active", at: "1 of 2 done" };
		expect(alpha?.outcomes).toEqual([
			{ title: "item 1", owner: "Marked by Ops", steps: [{ label: "Proof: checked", kind: "done", at: "Sun Oct 18" }] },
			{ title: "item 2", owner: "Architecture (lead)", steps: [login] },
			{ title: "item 3", owner: "Architecture (lead)", steps: [login] },
		]);
	});

	it("counts only met items as done and shows proof only on them, for every initiative and project", () => {
		const { input } = build();
		const records = [
			...GOALS.initiatives.map((r) => [r.id, r] as const),
			...GOALS.projects.map((r) => [projectFrameId(r.id), r] as const),
		];
		expect(records.length).toBe(7);
		for (const [id, r] of records) {
			const frame = [...(input.initiatives ?? []), ...(input.details ?? [])].find((f) => f.id === id);
			expect(frame?.outcomes?.map((oc) => oc.title)).toEqual(r.doneWhen.map((d) => d.item));
			expect(frame?.outcomes?.filter(done).length).toBe(r.doneWhen.filter((d) => d.met).length);
			frame?.outcomes?.forEach((oc, k) =>
				expect(oc.steps?.some((s) => s.label?.startsWith("Proof: "))).toBe(!!r.doneWhen[k]?.met),
			);
		}
	});

	it("drops a reworded item's mark, through the registry's own replay", () => {
		const L = (ts: number, e: Record<string, unknown>, by = "ops") =>
			JSON.stringify({ v: 1, seq: ts, ts: AT + ts, by, ...e });
		const log = [
			L(1, {
				op: "initiative.create",
				id: "plan-x",
				name: "Plan X",
				outcome: "X is out",
				doneWhen: ["Feed is live", "Page shows it"],
				lead: "ops",
			}),
			L(2, { op: "initiative.met", id: "plan-x", item: "Feed is live", proof: "deploy 1" }),
			L(3, { op: "initiative.met", id: "plan-x", item: "Page shows it", proof: "screenshot" }, "owner"),
			L(4, {
				op: "initiative.change",
				id: "plan-x",
				changes: { doneWhen: ["page shows it", "Feed is live everywhere"] },
			}),
		].join("\n");
		// The replay leaves out a last line without its newline (it may be half-written).
		const x = plan(workPageFrom(log + "\n", [], AT))["plan-x"];
		expect(x?.outcomes?.map((oc) => [oc.title, oc.owner, done(oc)])).toEqual([
			["page shows it", "Marked by you", true],
			["Feed is live everywhere", "Ops (lead)", false],
		]);
		expect(x?.outcomes?.[0]?.steps).toEqual([{ label: "Proof: screenshot", kind: "done", at: "Sun Oct 18" }]);
		expect(x?.outcomes?.[1]?.steps).toEqual([{ label: "No project yet", kind: "pending" }]);
	});

	it("says No project yet, or No open project, when no open project works on an open item", () => {
		expect(plan(GOALS).gamma?.outcomes).toEqual([
			{ title: "item 1", owner: "Ops (lead)", steps: [{ label: "No project yet", kind: "pending" }] },
		]);
		const finished = {
			...GOALS,
			projects: GOALS.projects.map((p) => (p.id === "p-login" ? { ...p, status: "done" as const } : p)),
		};
		expect(plan(finished).alpha?.outcomes?.[1]?.steps).toEqual([{ label: "No open project", kind: "pending" }]);
	});

	it("says so when a record has no items or no goal, and gives the box no goal or items of its own", () => {
		const bare = { ...PAGE, initiatives: [{ ...PAGE.initiatives[2]!, doneWhen: [] }] };
		expect(plan(bare).alpha).toEqual({ started: "Sat Oct 17", outcomesNote: "No done-when items recorded yet." });
		const box = plan(GOALS)[NO_INITIATIVE];
		expect(box?.goal).toBe("Each project here has its own goal: open one to see it.");
		expect(box?.outcomes).toBeUndefined();
		expect(build().input.loose?.detail?.outcomeCount).toEqual({ done: 1, total: 4 });
	});
});

describe("a project's own detail", () => {
	it("is a frame for every project, which the selection may name, opened from its row or box item", () => {
		const { input } = build();
		expect(build(GOALS, { selected: projectFrameId("p-docs") }).selected).toBe("~project:p-docs");
		expect(build(GOALS, { selected: "~project:gone" }).selected).toBe("alpha");
		expect(input.details?.map((d) => d.id)).toEqual([
			"~project:p-search",
			"~project:p-login",
			"~project:p-lane",
			"~project:p-docs",
		]);
		expect(input.initiatives?.[0]?.roles?.map((r) => r.opens)).toEqual(["~project:p-login", "~project:p-search"]);
		expect(input.loose?.items?.map((l) => l.opens)).toEqual(["~project:p-docs", "~project:p-lane"]);
		const docs = input.details?.find((d) => d.id === "~project:p-docs");
		expect(docs).toMatchObject({
			name: "Docs sweep",
			lead: "Docs",
			statusLabel: "Active",
			statusNote: "Project in no initiative",
			goal: "Docs sweep is done right",
			started: "Sat Oct 17",
			rolesLine: "1 role",
			canMessageLead: false,
			canChangeLead: false,
			gapsNote: "Gaps show on \u201cProjects in no initiative\u201d.",
		});
		expect(docs?.roles?.map((r) => [r.name, r.taskTitle])).toEqual([["Docs sweep", "0 of 3 done"]]);
		const login = input.details?.find((d) => d.id === "~project:p-login");
		expect(login?.statusNote).toBe("Project in Alpha launch");
		expect(login?.decisionsNote).toBe("Decisions show on its initiative, Alpha launch.");
		expect(login?.outcomes?.[1]?.steps).toEqual([{ label: "Login form", kind: "active", at: "1 of 2 done" }]);
	});

	// Ops #252 (docs/gate-near-limit.md): its own limit, 3x its slowest land-gate time (3397 ms) rounded up to whole
	// 5 s. One long sequential scenario (one mount, then five clicks, each checked from where the last left it), and
	// this file's only mount, so it carries the view's and jsdom's cold start too. It can't be split.
	it("shows through the design: goal, start day, items, then the proof and marker when an item opens", () => {
		const page = mount(build().input);
		expect(page.text()).toContain("Goal · Alpha launch is done right");
		expect(page.fact("Started")).toBe("Sat Oct 17");
		expect(page.text()).toContain("Outcomes · 1 of 3 done");
		expect(page.text()).toContain("In progress: Login form · 1 of 2 done");

		page.click("Login form");
		expect(page.actions.select).toHaveBeenLastCalledWith("~project:p-login");
		expect(page.text()).toContain("Project in Alpha launch");
		expect(page.text()).toContain("Goal · Login form is done right");
		expect(page.text()).toContain("Outcomes · 1 of 2 done");
		expect(page.text()).not.toContain("Proof: checked");
		// The button's number, title and state sit side by side with no space between them.
		page.click(/^1 ?item 1 ?Done · Sun Oct 18$/);
		expect(page.text()).toContain("Proof: checked");
		expect(page.text()).toContain("Marked by Ops");
		expect(page.button("Login form")?.getAttribute("aria-current")).toBe("true");

		page.click("Docs sweep");
		expect(page.actions.select).toHaveBeenLastCalledWith("~project:p-docs");
		expect(page.actions.select).not.toHaveBeenCalledWith(NO_INITIATIVE);
		expect(page.text()).toContain("Project in no initiative");
		expect(page.text()).toContain("Done when · 0 of 3 done");
		expect(page.text()).not.toContain("Proof: ");

		page.click(/^Gamma archive/);
		expect(page.text()).toContain("Not started: No project yet");
		page.click("Projects in no initiative · 2");
		expect(page.text()).toContain("Goal · Each project here has its own goal: open one to see it.");
		expect(page.text()).toContain("Outcomes · 1 of 4 done");
	}, 15_000);
});
