/// <reference types="vite/client" />
// @vitest-environment jsdom
// initiatives-page-exact (docs/initiatives-page-exact.md, Ops #225): the live Initiatives page's core model
// on a fixed work registry page, alone and through the supplied design's view and template. No chats,
// server or model calls; the names are made up (none of the design's sample).
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { InitiativesExactInput } from "../../web/src/initiatives-exact-model";
import { createInitiativesExactView, type InitiativesExactActions } from "../../web/src/initiatives-exact-view";
import { bindInitiativesSurface } from "../../web/src/initiatives-u0/surface";
import { buildInitiativesPage, type InitiativesPageArgs } from "../../web/src/initiatives-page/model";
import { statusOf } from "../../web/src/initiatives-page/tasks";
import { NO_INITIATIVE } from "../../web/src/initiatives-page/types";
import { AT, NOW, PAGE, pageArgs } from "./initiatives-page-fixture";

const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

function build(over: Partial<InitiativesPageArgs> = {}) {
	return buildInitiativesPage(pageArgs({ open: vi.fn(), ...over }));
}

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const clean of cleanups.splice(0)) clean();
	document.body.replaceChildren();
});

/** The real template with the view, on `input`; the host gives Message lead and Change lead. */
function mount(input: InitiativesExactInput) {
	const actions: InitiativesExactActions = {
		open: vi.fn(),
		retry: vi.fn(),
		messageLead: vi.fn(),
		changeLead: vi.fn(),
		select: vi.fn(),
	};
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
	const buttons = () => Array.from(document.querySelectorAll("button")).map((b) => norm(b.textContent));
	return {
		actions,
		values: () => view.values() as unknown as { summary: string; filters: { label: string; count: string }[] },
		text: () => norm(document.body.textContent),
		buttons,
		click(text: string | RegExp) {
			const b = Array.from(document.querySelectorAll("button")).find((el) =>
				typeof text === "string" ? norm(el.textContent) === text : text.test(norm(el.textContent)),
			);
			if (!b) throw new Error(`no button ${text}`);
			b.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			if (dirty) binding.update();
			dirty = false;
		},
	};
}

describe("the Initiatives page's core model, on a fixed registry page", () => {
	it("lists active initiatives first, then done, then dropped, each with its lead and done-when count", () => {
		const { input, selected } = build();
		expect(input.initiatives?.map((i) => i.name)).toEqual(["Alpha launch", "Beta cleanup", "Gamma archive"]);
		// initiatives-page-tasks: an active initiative with no task linked says so in its grey chip.
		expect(input.initiatives?.map((i) => i.statusLabel)).toEqual(["No tasks yet", "Done", "Dropped"]);
		expect(input.initiatives?.map((i) => i.lead)).toEqual(["Architecture", "QA", "Ops"]);
		expect(input.initiatives?.map((i) => i.outcomeCount)).toEqual([
			{ done: 1, total: 3 },
			{ done: 2, total: 2 },
			{ done: 0, total: 1 },
		]);
		expect(selected).toBe("alpha");
		expect(input.page).toEqual({ state: "live", at: "09:40", date: "Sun Oct 18" });
	});

	it("shows an initiative's projects as rows with their lead, count and status", () => {
		const alpha = build().input.initiatives?.[0];
		// initiatives-projects-done: the done project (Search box) leaves the rows for the Finished projects fold.
		expect(alpha?.roles?.map((r) => [r.name, r.part, r.taskTitle, r.statusLabel, r.statusTone])).toEqual([
			["Login form", "Lead · Frontend", "1 of 2 done", "No tasks yet", "neutral"],
		]);
		expect(alpha?.finishedProjects?.map((p) => [p.name, p.lead, p.state, p.at, p.count])).toEqual([
			["Search box", "Backend", "done", "Sun Oct 18", "1 of 1 done"],
		]);
		expect(alpha?.projectCount).toEqual({ done: 1, total: 2, dropped: 0 });
		expect(alpha?.rolesLine).toBe("3 roles · lead + 2");
		expect(alpha?.members).toEqual(["Frontend", "Backend"]);
		expect(build().input.initiatives?.[1]?.rowsNote).toBe("No projects in this initiative yet.");
	});

	it("puts projects in no initiative (none named, or an unknown one) in their own box", () => {
		const { input } = build();
		expect(input.loose?.heading).toBe("Projects in no initiative · 2");
		expect(input.loose?.items?.map((l) => [l.name, l.note])).toEqual([
			["Docs sweep", "Lead · Docs · 0 of 3 done · Active"],
			["Old lane", "Lead · Ops · 1 of 1 done · Done"],
		]);
		expect(input.loose?.detail?.id).toBe(NO_INITIATIVE);
		expect(input.loose?.detail?.outcomeCount).toEqual({ done: 1, total: 4 });
		expect(input.loose?.detail?.roles?.map((r) => r.name)).toEqual(["Docs sweep"]);
		expect(input.loose?.detail?.finishedProjects?.map((p) => p.name)).toEqual(["Old lane"]);
		expect(build({ selected: NO_INITIATIVE }).selected).toBe(NO_INITIATIVE);
		const none = build({ work: { page: { ...PAGE, projects: PAGE.projects.slice(0, 2) }, status: "ready" } });
		expect(none.input.loose).toBeUndefined();
		expect(build({ selected: "gone" }).selected).toBe("alpha");
	});

	// initiatives-page-tasks (step 3) connected the tasks: with none linked, no status, rows or asks come from them.
	it("with no task linked, gives no task status, rows or asks, and leaves the all-clear to the view", () => {
		const { input } = build();
		for (const i of [...(input.initiatives ?? []), input.loose!.detail!]) {
			expect(i.status).toBeUndefined();
			expect(i.onYou).toEqual([]);
			for (const r of i.roles ?? []) expect([r.note, r.tasks]).toEqual([undefined, undefined]);
		}
		expect(input.summary).toBeUndefined();
		expect(input.filtersNote).toBeUndefined();
		expect(statusOf(PAGE, "alpha")).toBeUndefined();
	});

	it("takes decisions and the lead's updates only for the initiative the decision log shows", () => {
		const { input, sources } = build();
		const [alpha, beta] = input.initiatives ?? [];
		expect(alpha?.decisions?.map((d) => [d.title, d.body, d.at, d.sourceRef])).toEqual([
			["Ship the small form first", "The login form ships before the search box.", "09:40", "d1#0"],
		]);
		expect(sources["d1#0"]?.record).toBe("dr-1");
		expect(alpha?.leadReport).toBe("Form landed.");
		expect(alpha?.leadNext).toBe("Wire the search box.");
		// initiatives-live: the lead's post is one of the records in Latest updates, with the lead's name.
		expect(alpha?.latest).toEqual([{ at: "09:40", role: "Architecture", text: "Progress update: Form landed." }]);
		expect(beta?.decisions).toBeUndefined();
		expect(beta?.decisionsNote).toBe("No decisions are recorded for this initiative yet.");
		expect(beta?.latest).toEqual([]);
		expect(beta?.latestNote).toBe("No updates recorded yet.");
		expect(input.initiatives?.[0]?.finish).toBeUndefined();
		expect(input.initiatives?.[0]?.spendTotal).toBeUndefined();
	});

	it("shows Message <lead> only where the lead's home chat is known, Change lead only where the log keeps the lead", () => {
		const m = build();
		expect(m.input.initiatives?.map((i) => [i.id, i.canMessageLead, i.canChangeLead])).toEqual([
			["alpha", true, true],
			["beta", false, false],
			["gamma", false, false],
		]);
		expect(m.leadChats).toEqual({ alpha: "/chats/architecture-home.jsonl" });
		expect(m.changeLead).toEqual(["alpha"]);
		expect(m.input.loose?.detail?.canMessageLead).toBe(false);
		expect(m.input.loose?.detail?.canChangeLead).toBe(false);
	});

	it("uses the drawn page states: loading, first-load error, out of date, unreadable, old data", () => {
		expect(build({ work: { page: null, status: "loading" } }).input).toEqual({ page: { state: "loading" } });
		expect(build({ work: { page: null, status: "error", error: "x", failedAt: AT } }).input.page).toEqual({
			state: "error",
			at: "09:40",
		});
		expect(build({ work: { page: PAGE, status: "error", error: "x", failedAt: NOW } }).input.page?.state).toBe("stale");
		expect(build({ work: { page: { ...PAGE, problem: "unreadable" }, status: "ready" } }).input.page?.state).toBe(
			"error",
		);
		const old = build({ work: { page: { ...PAGE, problem: "too-big" }, status: "ready" } }).input;
		expect(old.page?.state).toBe("live");
		expect(old.initiatives?.map((i) => i.oldSince)).toEqual(["09:40", "09:40", "09:40"]);
		expect(build().input.initiatives?.[0]?.oldSince).toBeUndefined();
	});
});

describe("the core model through the supplied design", () => {
	// Ops #278 (docs/gate-view-cases.md): its own limit, 15 s. One mount and its checks, and it is this file's first
	// mount: the mount is nearly all of its time (alone about 420 ms cold against 150 ms warm; the checks under
	// 10 ms). It timed out once in a land gate under load (6197 ms). There is nothing to split.
	it("draws the header, cards, box and detail, with the filters counted", () => {
		const page = mount(build().input);
		const text = page.text();
		expect(text).toContain("3 initiatives · Sun Oct 18");
		expect(text).toContain("Live · updated 09:40");
		expect(text).toContain("1 of 3 outcomes done");
		expect(text).toContain("Projects in no initiative · 2");
		const v = page.values();
		// initiatives-page-tasks: loaded whole and live, with no task waiting on the owner: a true all-clear.
		expect(v.summary).toBe("Nothing is waiting on you.");
		expect(v.filters.map((f) => [f.label, f.count])).toEqual([
			["All", "3"],
			["Needs you", "0"],
			["Blocked", "0"],
			["Paused by you", "0"],
		]);
		expect(page.buttons()).toContain("Message Architecture");
		expect(page.buttons()).toContain("Change lead");
		expect(page.buttons().some((b) => /New initiative|Resume|Mark read/.test(b))).toBe(false);
	});

	// Ops #278 (docs/gate-view-cases.md): its own limit, 15 s. One mount and two clicks, and the mount is most of its
	// time (alone about 170 ms against 25 ms for the clicks). It timed out once, in the same land gate as the case
	// above (6085 ms). A piece per click would still mount, and the second click comes after the first.
	it("hides Message and Change lead where they can't work, and opens the box like an initiative", () => {
		const page = mount(build().input);
		page.click(/^Beta cleanup/);
		expect(page.actions.select).toHaveBeenCalledWith("beta");
		expect(page.buttons().some((b) => b.startsWith("Message "))).toBe(false);
		expect(page.buttons()).not.toContain("Change lead");
		page.click("Projects in no initiative · 2");
		expect(page.actions.select).toHaveBeenCalledWith(NO_INITIATIVE);
		expect(page.text()).toContain("No one leads this");
	});

	// initiatives-page-tasks: a loaded, live, empty registry truly has nothing waiting, so it is no longer listed.
	// Ops #252 (docs/gate-near-limit.md): one case per state, each mounting the view once, then one for the old-data
	// mount, with the same inputs and checks. As one case that mounted it 5 times, it came within 0.1 s of vitest's
	// 5 s test timeout under land-gate load.
	describe("never says nothing is waiting, loading, failing, stale or not read whole", () => {
		const states: [string, InitiativesPageArgs["work"]][] = [
			["loading", { page: null, status: "loading" }],
			["failing before any page was read", { page: null, status: "error", error: "x", failedAt: AT }],
			["stale: failing after a page was read", { page: PAGE, status: "error", error: "x", failedAt: NOW }],
			["not read whole", { page: { ...PAGE, problem: "too-big" }, status: "ready" }],
		];
		it.each(states)("%s", (_name, work) => {
			const page = mount(build({ work }).input);
			expect(page.values().summary).not.toMatch(/^Nothing is waiting/);
			expect(page.text()).not.toMatch(/Nothing is waiting on you\./);
		});
		it("not read whole: says its data is old", () => {
			const old = mount(build({ work: { page: { ...PAGE, problem: "too-big" }, status: "ready" } }).input);
			expect(old.text()).toContain("Old data, not confirmed.");
		});
	});
});

describe("shipped files", () => {
	it("hold none of the design's sample data", () => {
		const shipped = [
			"web/src/initiatives-page/model.ts",
			"web/src/initiatives-page/types.ts",
			"web/src/initiatives-page/plan.ts",
			"web/src/initiatives-page/tasks.ts",
			"web/src/initiatives-page/gaps.ts",
			"web/src/work-page-state.ts",
			"web/src/components/InitiativesPage.tsx",
		];
		const sample = [
			"Team in Temper",
			"Reliability",
			"Notebook import",
			"Budget & tokens",
			"credit flag",
			"13:05",
			"Oct 11",
		];
		for (const file of shipped) {
			const source = readFileSync(join(process.cwd(), file), "utf8");
			for (const s of sample) expect(source.includes(s), `${file} holds "${s}"`).toBe(false);
		}
	});
});
