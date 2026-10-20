/// <reference types="vite/client" />
// @vitest-environment jsdom
// initiatives-page-tasks (docs/initiatives-page-tasks.md, Ops #227): step 3 on a fixed registry page with linked
// tasks: the status rules in order, open tasks under their projects, what waits on the owner, the ON YOU bar,
// the filter counts and the clicks that open a task's chat. No chats, server or model calls; made-up names.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InitiativesExactInput } from "../../web/src/initiatives-exact-model";
import { createInitiativesExactView, type InitiativesExactActions } from "../../web/src/initiatives-exact-view";
import { bindInitiativesSurface } from "../../web/src/initiatives-u0/surface";
import { buildInitiativesPage, type InitiativesPageArgs } from "../../web/src/initiatives-page/model";
import { ruleOf, statusOf } from "../../web/src/initiatives-page/tasks";
import { NO_INITIATIVE, projectFrameId } from "../../web/src/initiatives-page/types";
import type { UiWorkPageTask } from "../../web/src/types";
import { AT, NOW, PAGE, TASKS, TASKS_PAGE, pageArgs } from "./initiatives-page-tasks-fixture";

const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const NAMES = [
	"Alpha launch",
	"Beta cleanup",
	"Gamma archive",
	"Delta rollout",
	"Epsilon pause",
	"Zeta idea",
	"Eta notes",
	"Theta search",
];

function build(over: Partial<InitiativesPageArgs> = {}) {
	const open = vi.fn();
	return { open, ...buildInitiativesPage(pageArgs({ open, ...over })) };
}
const byId = (input: InitiativesExactInput) => Object.fromEntries((input.initiatives ?? []).map((i) => [i.id, i]));

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const clean of cleanups.splice(0)) clean();
	document.body.replaceChildren();
});

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
	const buttons = () => Array.from(document.querySelectorAll("button")).map((b) => norm(b.textContent));
	return {
		values: () => view.values() as unknown as { summary: string; filters: { label: string; count: string }[] },
		text: () => norm(document.body.textContent),
		buttons,
		// The list's cards, by name: a card's button starts with its name, after ON YOU when it shows.
		cards: () => buttons().flatMap((b) => NAMES.filter((n) => new RegExp(`^(ON YOU \u00b7 \\d+)?${n}`).test(b))),
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

/** A bare open task for the rule cases. */
const tk = (n: number, more: Partial<UiWorkPageTask> = {}): UiWorkPageTask => ({
	queue: "/chats/ops-home.jsonl",
	queueName: "ops",
	task: n,
	added: AT,
	title: "task " + n,
	parent: { initiative: "x" },
	...more,
});

describe("the status rules, in order", () => {
	it("gives one chip per rule, the earlier rule winning", () => {
		const asks = tk(1, { state: "asking", needsYou: { text: "?" } });
		const blocked = tk(2, { state: "blocked" });
		const stuck = tk(3, { state: "stuck" });
		const paused = tk(4, { state: "ready", paused: { at: AT, why: "later" } });
		const working = tk(5, { state: "working" });
		const done = tk(6, { state: "done" });
		// 1: a done or dropped record keeps its registry word, even with a task asking.
		expect(ruleOf("done", [asks])).toEqual({ label: "Done" });
		expect(ruleOf("dropped", [working])).toEqual({ label: "Dropped" });
		// 2 before 3 before 4 before 5.
		expect(ruleOf("active", [working, paused, blocked, asks])).toEqual({ status: "you", label: "Needs you" });
		expect(ruleOf("active", [working, paused, blocked])).toEqual({ status: "attention", label: "Needs attention" });
		expect(ruleOf("active", [stuck]).status).toBe("attention");
		expect(ruleOf("active", [paused, tk(7, { state: "blocked", paused: paused.paused })]).status).toBe("attention");
		expect(ruleOf("active", [paused, done])).toEqual({ status: "paused", label: "Paused by you" });
		expect(ruleOf("active", [paused, working])).toEqual({ status: "moving", label: "Moving" });
		for (const state of ["ready", "working", "asking", "waiting"] as const)
			expect(ruleOf("active", [tk(8, { state })]).status).toBe("moving");
		// An open task whose state isn't recorded: Unknown, never Moving or an all-clear.
		expect(ruleOf("active", [tk(9)])).toEqual({ status: "unknown", label: "Unknown" });
		// 6: no open task.
		expect(ruleOf("active", [])).toEqual({ label: "No tasks yet" });
		expect(ruleOf("active", [done, tk(10, { state: "dropped" }), tk(11, { state: "removed" })])).toEqual({
			label: "No open tasks",
		});
		// A closed task's question no longer counts.
		expect(ruleOf("active", [{ ...asks, state: "done" }])).toEqual({ label: "No open tasks" });
	});

	// Ops #252 (docs/gate-near-limit.md): its own limit, 3x its slowest land-gate time (6043 ms, a timeout) rounded up
	// to whole 5 s. It mounts the view once, but it is this file's first mount, and most of its time is the view's and
	// jsdom's cold start: later one-mount cases here take a fraction of it. Splitting can't take that away (only
	// production code could), so it isn't split.
	it("puts every initiative's chip, the projects in no initiative and the filter counts on those rules", () => {
		const { input } = build();
		const i = byId(input);
		expect(Object.fromEntries(Object.values(i).map((x) => [x.name, x.status ?? `grey: ${x.statusLabel}`]))).toEqual({
			"Alpha launch": "you",
			"Delta rollout": "attention",
			"Epsilon pause": "paused",
			"Zeta idea": "grey: No tasks yet",
			"Eta notes": "grey: No open tasks",
			"Theta search": "moving",
			"Beta cleanup": "grey: Done",
			"Gamma archive": "grey: Dropped",
		});
		expect(statusOf(TASKS_PAGE, NO_INITIATIVE)).toBe("you");
		expect(statusOf(TASKS_PAGE, "gone")).toBeUndefined();
		const docs = input.details?.find((d) => d.id === projectFrameId("p-docs"));
		expect([docs?.status, docs?.statusLabel]).toEqual(["you", "Active"]);
		const page = mount(input);
		expect(page.values().filters.map((f) => [f.label, f.count])).toEqual([
			["All", "8"],
			["Needs you", "1"],
			["Needs attention", "1"],
			["Paused by you", "1"],
		]);
		expect(page.cards().length).toBe(8);
		page.click(/^Needs attention \d/);
		expect(page.cards()).toEqual(["Delta rollout"]);
		page.click(/^Paused by you \d/);
		expect(page.cards()).toEqual(["Epsilon pause"]);
		page.click(/^Needs you \d/);
		expect(page.cards()).toEqual(["Alpha launch"]);
	}, 20_000);

	it("says Paused by you only when the owner paused every open task, and names them", () => {
		const { input } = build({ selected: "epsilon" });
		const epsilon = byId(input).epsilon;
		expect(epsilon?.pausedText).toBe("You paused every open task here: Design #8, Design #11.");
		expect(epsilon?.roles?.map((r) => [r.name, r.statusLabel, r.statusTone, r.taskTitle])).toEqual([
			["Directly under this initiative", "Paused by you", "paused", "2 open tasks"],
		]);
		expect(epsilon?.roles?.[0]?.tasks?.map((t) => [t.task, t.kind, t.note])).toEqual([
			["#8", "paused", "Paused by you; awaits your resume"],
			["#11", "paused", "Paused by you; awaits your resume"],
		]);
		expect(mount(input).text()).toContain("You paused every open task here: Design #8, Design #11.");
	});

	it("gives the box of projects in no initiative its chip by the same rules, grey while nothing there is open", () => {
		// H-INITIATIVES-PAGE-3b: the live box kept step 1's "No initiative" while its tasks gave a rules chip.
		const { input } = build({ selected: NO_INITIATIVE });
		expect([input.loose?.detail?.status, input.loose?.detail?.statusLabel]).toEqual(["you", "No initiative"]);
		const closed = { ...TASKS_PAGE, tasks: TASKS.map((x) => ({ ...x, state: "done" as const })) };
		const quiet = build({ selected: NO_INITIATIVE, work: { page: closed, status: "ready" } }).input.loose?.detail;
		expect([quiet?.status, quiet?.statusLabel]).toEqual([undefined, "No initiative"]);
		const page = mount(input);
		expect((page.values() as unknown as { sel: { sText: string } }).sel.sText).toBe("Needs you");
		// The box is no initiative card, so the filter counts stay as they were.
		expect(page.values().filters.map((f) => f.count)).toEqual(["8", "1", "1", "1"]);
	});
});

describe("who's doing what", () => {
	it("lists each project's open tasks with their department, status, next step and time, most urgent first", () => {
		const alpha = byId(build().input).alpha;
		// initiatives-projects-done: the done project (Search box) is in the Finished projects fold, not a row.
		expect(alpha?.roles?.map((r) => [r.name, r.statusLabel, r.statusTone, r.note ?? r.taskTitle, r.at])).toEqual([
			["Login form", "Needs you", "you", "3 open tasks", "09:40"],
			["Directly under this initiative", "Moving", "moving", "1 open task", "09:30"],
		]);
		expect(alpha?.finishedProjects?.map((p) => p.name)).toEqual(["Search box"]);
		const login = alpha?.roles?.[0]?.tasks ?? [];
		expect(login.map((t) => [t.name, t.task, t.taskTitle, t.kind ?? t.statusLabel, t.note, t.wait, t.at])).toEqual([
			["Design", "#3", "Pick the login copy", "Needs you", "Awaiting your answer", undefined, "09:15"],
			[
				"QA",
				"#4",
				"Check the login form",
				"blocked",
				undefined,
				"Ops #12 · Ops owes the login API (due 10:40)",
				"09:20",
			],
			["Ops", "#12", "Wire the login API", "working", undefined, undefined, "09:10"],
		]);
		expect(alpha?.roles?.[1]?.tasks?.map((t) => [t.name, t.task, t.kind, t.note])).toEqual([
			["Ops", "#15", "queued", "Waiting for tasks: #12"],
		]);
	});

	it("shows what a blocked or waiting task waits on, and an unrecorded state as unknown", () => {
		const i = byId(build().input);
		expect(i.delta?.roles?.[0]?.tasks?.map((t) => [t.name, t.task, t.kind, t.wait ?? t.note])).toEqual([
			["Ops", "#20", "blocked", "staging credentials from Systems"],
			["Systems", "#5", "waiting", "Recorded wait: staging deploy · checked every 2 min · until 12:40"],
		]);
		expect(i.theta?.roles?.[0]?.tasks?.map((t) => [t.task, t.kind, t.note])).toEqual([
			["#30", "working", undefined],
			["#31", "unknown", "Its queue hasn\u2019t recorded a state for it yet"],
		]);
	});

	it("puts the tasks of projects in no initiative under them, and shows tasks linked to nothing nowhere", () => {
		const { input } = build({ selected: NO_INITIATIVE });
		const rows = input.loose?.detail?.roles ?? [];
		expect(rows.map((r) => [r.name, r.statusLabel, r.note])).toEqual([["Docs sweep", "Needs you", "2 open tasks"]]);
		expect(input.loose?.detail?.finishedProjects?.map((p) => p.name)).toEqual(["Old lane"]);
		expect(rows[0]?.tasks?.map((t) => t.task)).toEqual(["#2", "#3"]);
		const shown = JSON.stringify(input);
		for (const stray of ["Tidy the scheduler", "deleted project", "deleted initiative", "Standalone question"])
			expect(shown.includes(stray), stray).toBe(false);
		const listed = [input.loose?.detail, ...(input.initiatives ?? [])].flatMap((i) =>
			(i?.roles ?? []).flatMap((r) => (r.tasks ?? []).map((t) => `${t.name} ${t.task}`)),
		);
		const open = TASKS.filter(
			(t) =>
				!["done", "dropped", "removed"].includes(t.state ?? "") &&
				!("standalone" in t.parent) &&
				!["p-gone", "gone"].includes(
					"project" in t.parent ? t.parent.project : "initiative" in t.parent ? t.parent.initiative : "",
				),
		);
		expect(listed.length).toBe(open.length);
	});

	it("opens a task's own chat from its row, or its queue's chat while that isn't known", () => {
		const { input, open } = build({ selected: "alpha" });
		const page = mount(input);
		page.click("#3 Pick the login copy");
		expect(open).toHaveBeenLastCalledWith("/chats/design-3.jsonl");
		page.click("#4 Check the login form");
		expect(open).toHaveBeenLastCalledWith("/chats/qa-home.jsonl");
		page.click("#15 Draft the launch note");
		expect(open).toHaveBeenLastCalledWith("/chats/ops-home.jsonl");
		expect(page.buttons().some((b) => /^(Answer|Unblock|Resume|Mark done)/.test(b))).toBe(false);
	});
});

describe("waiting on you and the ON YOU bar", () => {
	it("lists the linked tasks' questions with their department and wait, and opens the asking chat", () => {
		const { input, open } = build({ selected: "alpha" });
		const i = byId(input);
		expect(i.alpha?.onYou?.map((o) => [o.kind, o.from, o.age, o.title, o.context, o.choices])).toEqual([
			["Question", "Design", "30m", "Which sign-in wording ships?", "#3 Pick the login copy", undefined],
		]);
		expect(input.loose?.detail?.onYou?.map((o) => [o.from, o.age, o.title])).toEqual([
			["Docs", "2h", "Publish the docs now or after QA?"],
		]);
		expect(input.loose?.items?.map((l) => [l.name, l.onYou ?? false])).toEqual([
			["Docs sweep", true],
			["Old lane", false],
		]);
		for (const id of ["beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"]) expect(i[id]?.onYou).toEqual([]);
		const page = mount(input);
		expect(page.values().summary).toBe("2 things are waiting on you across initiatives.");
		const text = page.text();
		expect(text).toContain("from Design");
		expect(text).toContain("waiting 30m");
		page.click("Which sign-in wording ships?");
		expect(open).toHaveBeenLastCalledWith("/chats/design-3.jsonl");
	});

	// Ops #251 (docs/gate-light-tests.md): one case per registry state, each mounting the view once. As one case that
	// mounted it 8 times, it ran past vitest's 5 s test timeout under land-gate load.
	describe("says nothing is waiting only when the registry is loaded whole, live, and nothing is", () => {
		const said = (work: InitiativesPageArgs["work"]) => {
			const page = mount(build({ work }).input);
			const out = [
				page.values().summary,
				page
					.values()
					.filters.map((f) => f.count)
					.join(" "),
			] as const;
			cleanups.splice(0).forEach((c) => c());
			document.body.replaceChildren();
			return out;
		};
		const quiet = { ...TASKS_PAGE, tasks: TASKS.filter((t) => !t.needsYou) };
		it("loading", () => {
			expect(said({ page: null, status: "loading" })[0]).not.toMatch(/Nothing/);
		});
		it("failed before any page was read", () => {
			expect(said({ page: null, status: "error", error: "x", failedAt: AT })[0]).not.toMatch(/^Nothing|: Nothing/);
		});
		it("failed after a page with questions", () => {
			expect(said({ page: TASKS_PAGE, status: "error", error: "x", failedAt: NOW })[0]).toBe(
				"As of 09:40: 2 things are waiting on you across initiatives.",
			);
		});
		it("failed after a page with no questions", () => {
			expect(said({ page: quiet, status: "error", error: "x", failedAt: NOW })[0]).toBe(
				"As of 09:40: Nothing was waiting on you then; that may have changed since.",
			);
		});
		it("loaded, but too big to read whole", () => {
			expect(said({ page: { ...TASKS_PAGE, problem: "too-big" }, status: "ready" })).toEqual([
				"At least 2 things are waiting on you; the registry couldn\u2019t be read whole, so there may be more.",
				"8 \u2014 \u2014 \u2014",
			]);
		});
		it("loaded, but with a change it couldn't read", () => {
			expect(said({ page: { ...quiet, problem: "unknown-change" }, status: "ready" })[0]).toBe(
				"What\u2019s waiting on you isn\u2019t fully known: the registry couldn\u2019t be read whole.",
			);
		});
		it("loaded whole and live, with no questions", () => {
			// Without Design #3's question, Alpha launch's blocked QA #4 makes it Needs attention too.
			expect(said({ page: quiet, status: "ready" })).toEqual(["Nothing is waiting on you.", "8 0 2 1"]);
		});
		it("loaded whole and live, with no tasks", () => {
			expect(said({ page: PAGE, status: "ready" })).toEqual(["Nothing is waiting on you.", "3 0 0 0"]);
		});
	});
});
