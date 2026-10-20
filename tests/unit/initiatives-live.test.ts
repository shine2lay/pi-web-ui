/// <reference types="vite/client" />
// @vitest-environment jsdom
// initiatives-live (docs/live-progress.md, H-INIT-LIVE-1, Ops #271): the Initiatives page's Latest updates come
// from every record (registry changes, the lead's posts, open tasks' progress lines, done tasks' summaries), and
// "Blocked" replaces "Needs attention", each row saying what it waits on. On fixed registry pages that carry the
// live-progress fields (and pages from an older server that don't). No chats, server or model calls.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InitiativesExactInitiative, InitiativesExactInput } from "../../web/src/initiatives-exact-model";
import { createInitiativesExactView } from "../../web/src/initiatives-exact-view";
import { bindInitiativesSurface } from "../../web/src/initiatives-u0/surface";
import { buildInitiativesPage } from "../../web/src/initiatives-page/model";
import { ruleOf } from "../../web/src/initiatives-page/tasks";
import type { UiWorkActivity, UiWorkPage, UiWorkPageTask } from "../../web/src/types";
import { AT, NOW, PAGE, pageArgs } from "./initiatives-page-fixture";

const MIN = 60_000;
const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

const task = (n: number, title: string, more: Partial<UiWorkPageTask> = {}): UiWorkPageTask => ({
	queue: "/chats/ops-home.jsonl",
	queueName: "ops",
	task: n,
	added: AT - 120 * MIN,
	title,
	parent: { project: "p-login" },
	...more,
});
const ref = (t: UiWorkPageTask) => ({ queue: t.queue, queueName: t.queueName, task: t.task, added: t.added });

/** Ops #5 done at AT+1 with a summary; Ops #6 working with a progress line at AT+2; the lead posted at AT. */
const done = task(5, "Ship the form", {
	state: "done",
	stateAt: AT + 1 * MIN,
	doneSummary: "Form shipped and checked.",
});
const working = task(6, "Wire the search", {
	state: "working",
	stateAt: AT - 60 * MIN,
	chat: "/chats/ops-6.jsonl",
	progress: { text: "Writing the search tests", at: AT + 2 * MIN },
});
const ACTIVITY: UiWorkActivity[] = [
	{ at: AT + 1 * MIN, by: "ops", op: "task.state", task: ref(done), status: "done" },
	{ at: AT - 30 * MIN, by: "ops", op: "task.link", task: ref(working), parent: { project: "p-login" } },
	{ at: AT - 90 * MIN, by: "owner", op: "project.create", id: "p-login" },
];
const page = (tasks: UiWorkPageTask[], activity: UiWorkActivity[] = ACTIVITY): UiWorkPage => ({
	...PAGE,
	tasks,
	activity,
});

function alphaOf(p: UiWorkPage, over: Parameters<typeof pageArgs>[0] = {}): InitiativesExactInitiative {
	const m = buildInitiativesPage(pageArgs({ work: { page: p, status: "ready" }, open: vi.fn(), ...over }));
	const alpha = m.input.initiatives?.find((i) => i.id === "alpha");
	if (!alpha) throw new Error("no alpha");
	return alpha;
}
/** Login form's task rows, by task number. */
function rowsOf(alpha: InitiativesExactInitiative) {
	const login = alpha.roles?.find((r) => r.name === "Login form");
	return new Map((login?.tasks ?? []).map((r) => [r.task, r]));
}

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const clean of cleanups.splice(0)) clean();
	document.body.replaceChildren();
});
function mountText(input: InitiativesExactInput): string {
	const view = createInitiativesExactView(
		() => input,
		() => ({ open: vi.fn(), retry: vi.fn(), select: vi.fn() }),
		() => {},
	);
	const binding = bindInitiativesSurface(document, () => view.values());
	cleanups.push(() => {
		binding.dispose();
		view.dispose();
	});
	return norm(document.body.textContent);
}

describe("Latest updates from the records", () => {
	it("merges progress lines, done summaries, registry changes and the lead's posts, newest first, three at most", () => {
		const alpha = alphaOf(page([done, working]));
		expect(alpha.latest).toEqual([
			{ at: "09:42", role: "Ops", text: "#6 Writing the search tests" },
			{ at: "09:41", role: "Ops", text: "#5 done: Form shipped and checked." },
			{ at: "09:40", role: "Architecture", text: "Progress update: Form landed." },
		]);
		// The registry's bare "done" line gives way to the summary; Activity keeps every registry change.
		expect(alpha.activity?.map((a) => a.text)).toContain("Ops #5 \u201cShip the form\u201d: done");
	});

	it("shows a done task's summary with no lead post at all (H-INIT-LIVE-1's sealed part)", () => {
		const alpha = alphaOf(page([done]), { decisions: null });
		expect(alpha.latest?.[0]).toEqual({ at: "09:41", role: "Ops", text: "#5 done: Form shipped and checked." });
		expect(alpha.latest?.map((l) => l.text)).not.toContain("Ops #5 \u201cShip the form\u201d: done");
	});

	it("keeps the lead's newest post as the lead's report, with its age", () => {
		const alpha = alphaOf(page([done, working]));
		expect([alpha.leadReport, alpha.leadReportAt]).toEqual(["Form landed.", "5m ago"]);
		const text = mountText({ initiatives: [alpha], selected: "alpha" });
		expect(text).toContain("Lead\u2019s report \u00b7 5m agoForm landed.");
		expect(text).not.toContain("Last report");
	});

	it("works as before on an older server's page: no progress or summary fields add nothing", () => {
		const old = (t: UiWorkPageTask): UiWorkPageTask => {
			const { progress: _p, doneSummary: _d, withLead: _w, ...rest } = t;
			return rest;
		};
		const alpha = alphaOf(page([old(done), old(working)]), { decisions: null });
		expect(alpha.latest).toEqual([
			{ at: "09:41", role: "Ops", text: "Ops #5 \u201cShip the form\u201d: done" },
			{
				at: "09:10",
				role: "Ops",
				text: "Linked Ops #6 \u201cWire the search\u201d to the project \u201cLogin form\u201d",
			},
			{ at: "08:10", role: "You", text: "Made the project \u201cLogin form\u201d" },
		]);
		expect(rowsOf(alpha).get("#6")?.note).toBeUndefined();
		const empty = alphaOf(page([], []), { decisions: null });
		expect(empty.latest).toEqual([]);
		expect(empty.latestNote).toBe("No updates recorded yet.");
	});

	it("never shows unsafe agent text, and clips a long summary to 300 characters", () => {
		const unsafe = { ...working, progress: { text: "evil \u202e text", at: AT + 2 * MIN } };
		const long = { ...done, doneSummary: "x".repeat(400) };
		const alpha = alphaOf(page([long, unsafe], []), { decisions: null });
		expect(alpha.latest?.map((l) => l.text)).toEqual([`#5 done: ${"x".repeat(299)}\u2026`]);
		expect(rowsOf(alpha).get("#6")?.note).toBeUndefined();
	});
});

describe("Blocked, with what it waits on", () => {
	const stuckWithLead = task(7, "Pick the copy", {
		state: "stuck",
		stateAt: AT - 20 * MIN,
		withLead: "ops",
		// An inconsistent page still never makes it the owner's: withLead wins (the live-progress contract).
		needsYou: { text: "Which copy?", since: AT - 20 * MIN },
	});
	const stuck = task(8, "Old stuck", { state: "stuck", stateAt: AT - 40 * MIN });
	const blocked = task(9, "Wait for Temper", {
		state: "blocked",
		stateAt: AT - 50 * MIN,
		block: { since: AT - 50 * MIN, on: ["Temper #113"], lead: "temper", owes: "the dispatcher" },
	});
	const asking = task(10, "Ask the lead", { state: "asking", stateAt: AT - 10 * MIN, withLead: "architecture" });

	it("says Question with <lead> for a question a lead holds, never Needs you", () => {
		const alpha = alphaOf(page([stuckWithLead, asking]));
		const rows = rowsOf(alpha);
		expect(rows.get("#7")).toMatchObject({ kind: "blocked", note: "Question with Ops" });
		expect(rows.get("#7")?.statusLabel).toBeUndefined();
		expect(rows.get("#10")).toMatchObject({ kind: "waiting", note: "Question with Architecture" });
		expect(alpha.onYou).toEqual([]);
		expect(alpha.status).toBe("attention");
		expect(ruleOf("active", [stuckWithLead])).toEqual({ status: "attention", label: "Blocked" });
	});

	it("names what a blocked task waits on, and a stuck one without a listed question isn't put on the owner", () => {
		const rows = rowsOf(alphaOf(page([stuck, blocked])));
		expect(rows.get("#9")).toMatchObject({ kind: "blocked", wait: "Temper #113 \u00b7 Temper owes the dispatcher" });
		expect(rows.get("#8")?.note).toBe("Stuck on a question that isn\u2019t listed: open its chat");
		expect(rows.get("#8")?.note).not.toMatch(/you/i);
	});

	it("keeps Needs you for a question that reached the owner", () => {
		const reached = task(11, "Owner pick", {
			state: "stuck",
			stateAt: AT - 5 * MIN,
			needsYou: { text: "Which way?", since: AT - 5 * MIN },
		});
		const alpha = alphaOf(page([reached]));
		expect(rowsOf(alpha).get("#11")).toMatchObject({ statusLabel: "Needs you", note: "Awaiting your answer" });
		expect(alpha.onYou?.map((o) => o.title)).toEqual(["Which way?"]);
	});

	it("shows a working task's progress line with its age when it has no next step", () => {
		const rows = rowsOf(alphaOf(page([working])));
		// NOW is AT+5; the line is from AT+2.
		expect(rows.get("#6")?.note).toBe("Writing the search tests \u00b7 3m ago");
		expect(rows.get("#6")?.at).toBe("09:42");
	});

	it("never reads Needs attention anywhere on the page", () => {
		const m = buildInitiativesPage(
			pageArgs({ work: { page: page([stuckWithLead, stuck, blocked, asking]), status: "ready" }, open: vi.fn() }),
		);
		const text = mountText(m.input);
		expect(text).not.toContain("Needs attention");
		expect(text).toContain("Blocked");
		expect(text).toContain("Question with Ops");
	});
});
