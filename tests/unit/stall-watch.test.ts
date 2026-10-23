/**
 * stall-watch (Ops #283, docs/stall-watch.md): the stall check's rules on fixed registries whose right answers
 * are known: the cases it must catch fire, the cases it must pass don't, each run twice with the same result;
 * whom it would wake, in turn; the settings; the dry run's log lines; the extra times from the registry's text.
 * Fixed fixtures only: never the live registry.
 */
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UiWorkPage } from "../../server/protocol.js";
import { workPageFrom, type WorkQueueFacts, type WorkTaskFacts } from "../../server/work-page.js";
import { DecisionRecords } from "../../server/decision-records.js";
import { withStall } from "../../server/stall-wake.js";
import {
	LeadUpdatesFile,
	leadUpdatesOf,
	STALL_DEFAULTS,
	STALL_OVERVIEW_MAX_AGE_MS,
	StallDryLog,
	StallWatch,
	stallExtraFrom,
	stallFindings,
	stallReview,
	stallSettings,
	stallTime,
	stallTimesFrom,
	stallWakeLine,
	youngEnough,
	type StallExtra,
	type StallFinding,
	type StallSettings,
} from "../../server/stall-watch.js";

const H = 3_600_000;
const M = 60_000;
/** 2026-10-20 16:00 UTC (09:00 PDT). */
const NOW = Date.UTC(2026, 9, 20, 16, 0);
const S: StallSettings = { ...STALL_DEFAULTS };

const Q = "/home/u/.pi/agent/sessions/ops-home.jsonl";

/** A registry built line by line; seq follows the order the lines are added, as the store writes them. */
class Reg {
	private lines: string[] = [];
	private seq = 0;
	readonly facts = new Map<string, Map<number, WorkTaskFacts>>();

	ev(ts: number, e: Record<string, unknown>, by = "ops"): this {
		this.lines.push(JSON.stringify({ v: 1, seq: ++this.seq, ts, by, ...e }));
		return this;
	}
	initiative(ts: number, id: string, lead = "ops"): this {
		return this.ev(
			ts,
			{ op: "initiative.create", id, name: `Ini ${id}`, outcome: "o", doneWhen: ["d"], lead },
			"owner",
		);
	}
	project(ts: number, id: string, lead = "ops", initiative: string | null = null): this {
		return this.ev(ts, {
			op: "project.create",
			id,
			name: `Proj ${id}`,
			outcome: "o",
			doneWhen: ["d"],
			lead,
			initiative,
		});
	}
	change(ts: number, kind: "project" | "initiative", id: string, changes: Record<string, unknown>): this {
		return this.ev(ts, { op: `${kind}.change`, id, changes });
	}
	/** A task linked at ts (added = ts), under a project or an initiative, in the ops queue unless given. */
	task(
		ts: number,
		task: number,
		parent: { project: string } | { initiative: string },
		status?: string,
		queue = Q,
	): this {
		this.ev(ts, {
			op: "task.link",
			queue,
			queueName: queue === Q ? "ops" : "design",
			task,
			added: ts,
			title: `Task ${task}`,
			parent,
		});
		if (status) this.state(ts, task, ts, status, queue);
		return this;
	}
	state(ts: number, task: number, added: number, status: string, queue = Q): this {
		return this.ev(ts, { op: "task.state", queue, task, added, status });
	}
	wait(ts: number, kind: "project" | "initiative", id: string, until: number, why = "waits for the review"): this {
		return this.ev(ts, { op: `${kind}.wait`, id, until, why });
	}
	resume(ts: number, kind: "project" | "initiative", id: string): this {
		return this.ev(ts, { op: `${kind}.resume`, id });
	}
	fact(task: number, added: number, f: WorkTaskFacts, queue = Q): this {
		let m = this.facts.get(queue);
		if (!m) this.facts.set(queue, (m = new Map()));
		m.set(task, { added, ...f });
		return this;
	}
	text(): string {
		return this.lines.map((l) => `${l}\n`).join("");
	}
	queueFacts(): WorkQueueFacts[] {
		return [...this.facts].map(([file, tasks]) => ({ file, tasks }));
	}
	page(now = NOW): UiWorkPage {
		return workPageFrom(this.text(), this.queueFacts(), now);
	}
	extra(updates: { initiative: string; at: number }[] = [], upTo = Number.POSITIVE_INFINITY): StallExtra {
		return stallExtraFrom(this.text(), updates, upTo);
	}
}

/** Runs the rules twice, from the text up, and expects the same answer both times. */
function twice(reg: Reg, now = NOW, s = S, updates: { initiative: string; at: number }[] = []) {
	const a = stallReview(reg.page(now), reg.extra(updates), now, s);
	const b = stallReview(reg.page(now), reg.extra(updates), now, s);
	expect(b).toEqual(a);
	return a;
}
const flagged = (fs: StallFinding[]) => fs.map((f) => `${f.kind}:${f.id}:${f.rule}`).sort();

// ---------------------------------------------------------------------------------------------------------------
// The fixtures: one registry with every case, so each case also proves it doesn't disturb the others
// ---------------------------------------------------------------------------------------------------------------

function fixture(): Reg {
	const r = new Reg();
	// The initiatives: one with no project and no task (must catch), one with an active project (must pass).
	r.initiative(NOW - 30 * H, "lonely-ini", "design");
	r.initiative(NOW - 30 * H, "busy-ini", "architecture");

	// Must catch.
	// 1. Its only task closed 2 h 10 min ago.
	r.project(NOW - 5 * H, "closed-2h10", "ops", "busy-ini").task(NOW - 5 * H, 1, { project: "closed-2h10" }, "working");
	r.state(NOW - 130 * M, 1, NOW - 5 * H, "done").fact(1, NOW - 5 * H, { doneSummary: "built the thing" });
	// 2. Never had a task, created 3 h ago.
	r.project(NOW - 3 * H, "never-task", "design");
	// 4. Open tasks, nothing recorded for 25 h. Its one task is blocked on nothing recorded: a dead end too, and
	// that rule (Ops #483) comes first, at once.
	r.project(NOW - 30 * H, "silent-25h", "ops").task(NOW - 25 * H, 2, { project: "silent-25h" }, "blocked");
	// 4b. The same, but its task waits on another queue's open task: moving, so only the silent rule.
	r.project(NOW - 30 * H, "silent-linked", "ops").task(NOW - 25 * H, 8, { project: "silent-linked" });
	r.ev(NOW - 25 * H, {
		op: "task.state",
		queue: Q,
		task: 8,
		added: NOW - 25 * H,
		status: "blocked",
		block: { on: ["temper #38"], reminders: 0, since: NOW - 25 * H },
	});
	// 5. A wait that ran out an hour ago, empty all along since it was created 10 h ago.
	r.project(NOW - 10 * H, "wait-over", "ops").wait(NOW - 9 * H, "project", "wait-over", NOW - 1 * H);

	// Must pass.
	r.project(NOW - 40 * H, "working", "ops", "busy-ini").task(NOW - 2 * H, 3, { project: "working" }, "working");
	r.project(NOW - 5 * H, "closed-1h", "ops").task(NOW - 5 * H, 4, { project: "closed-1h" }, "working");
	r.state(NOW - 1 * H, 4, NOW - 5 * H, "done");
	r.project(NOW - 1 * H, "new-1h", "ops");
	r.project(NOW - 40 * H, "paused", "ops").task(NOW - 30 * H, 5, { project: "paused" }, "ready");
	r.fact(5, NOW - 30 * H, { paused: { at: NOW - 29 * H, why: "owner: pause it" } });
	r.project(NOW - 40 * H, "needs-you", "ops").task(NOW - 30 * H, 6, { project: "needs-you" }, "asking");
	r.fact(6, NOW - 30 * H, { needsYou: { text: "Which port?", since: NOW - 29 * H } });
	r.project(NOW - 40 * H, "done-proj", "ops").ev(NOW - 31 * H, {
		op: "project.met",
		id: "done-proj",
		item: "d",
		proof: "p",
	});
	r.change(NOW - 30 * H, "project", "done-proj", { status: "done" });
	r.project(NOW - 40 * H, "dropped-proj", "ops").change(NOW - 30 * H, "project", "dropped-proj", { status: "dropped" });
	r.project(NOW - 40 * H, "waiting", "ops").wait(NOW - 20 * H, "project", "waiting", NOW + 20 * H);
	r.project(NOW - 40 * H, "tldr-3h", "ops").task(NOW - 30 * H, 7, { project: "tldr-3h" }, "working");
	r.fact(7, NOW - 30 * H, { progress: { text: "halfway", at: NOW - 3 * H } });
	return r;
}

const MUST_CATCH = [
	"initiative:lonely-ini:empty",
	"project:closed-2h10:empty",
	"project:never-task:empty",
	"project:silent-25h:dead-end",
	"project:silent-linked:silent",
	"project:wait-over:empty",
];

describe("stall-watch rules (fixtures, each run twice)", () => {
	it("fires on every must-catch case and on no must-pass case", () => {
		const { findings, items } = twice(fixture());
		expect(flagged(findings)).toEqual(MUST_CATCH);
		const state = Object.fromEntries(items.map((i) => [`${i.kind}:${i.id}`, i.state]));
		expect(state).toEqual({
			"initiative:lonely-ini": "flagged",
			"initiative:busy-ini": "covered",
			"project:closed-2h10": "flagged",
			"project:never-task": "flagged",
			"project:silent-25h": "flagged",
			"project:silent-linked": "flagged",
			"project:wait-over": "flagged",
			"project:working": "fine",
			"project:closed-1h": "pending",
			"project:new-1h": "pending",
			"project:paused": "quiet",
			"project:needs-you": "quiet",
			"project:waiting": "quiet",
			"project:tldr-3h": "fine",
		});
		const why = Object.fromEntries(items.map((i) => [i.id, i.why]));
		expect(why.paused).toBe("every open task is paused by the owner: ops #5");
		expect(why["needs-you"]).toBe("waits on the owner: ops #6");
		expect(why.waiting).toBe(`waits until ${stallTime(NOW + 20 * H)}: waits for the review`);
		expect(why["busy-ini"]).toBe("covered by its active projects: closed-2h10, working");
	});

	it("starts each stretch where the rules say", () => {
		const { findings } = twice(fixture());
		const since = Object.fromEntries(findings.map((f) => [f.id, f.since]));
		expect(since).toEqual({
			"lonely-ini": NOW - 30 * H,
			"closed-2h10": NOW - 130 * M,
			"never-task": NOW - 3 * H,
			"silent-25h": NOW - 25 * H,
			"silent-linked": NOW - 25 * H,
			"wait-over": NOW - 1 * H,
		});
		for (const f of findings) expect(f.stretch).toBe(`${f.kind}:${f.id}:${f.rule}:${f.since}`);
	});

	it("fills in the finding's last done task and open tasks", () => {
		const { findings } = twice(fixture());
		const closed = findings.find((f) => f.id === "closed-2h10")!;
		expect(closed).toMatchObject({
			kind: "project",
			name: "Proj closed-2h10",
			initiative: "busy-ini",
			lastDone: { queue: "ops", task: 1, title: "Task 1", summary: "built the thing", at: NOW - 130 * M },
			open: [],
		});
		const silent = findings.find((f) => f.id === "silent-25h")!;
		expect(silent.open).toEqual([{ queue: "ops", task: 2, title: "Task 2", status: "blocked" }]);
		expect(silent.lastDone).toBeUndefined();
		expect(silent.initiative).toBeUndefined();
	});

	it("flags each case only from its threshold on", () => {
		const r = fixture();
		// 1 h 59 min after the close: not yet; 2 h exactly: flagged.
		const at2h = NOW - 130 * M + 2 * H;
		expect(flagged(twice(r, at2h - M).findings)).not.toContain("project:closed-2h10:empty");
		expect(flagged(twice(r, at2h).findings)).toContain("project:closed-2h10:empty");
		// The 1 h-old close and the 1 h-old project come due an hour later.
		expect(flagged(twice(r, NOW + 1 * H).findings)).toEqual(
			expect.arrayContaining(["project:closed-1h:empty", "project:new-1h:empty"]),
		);
	});

	it("an initiative's own open task keeps it from being empty; a task filed straight under it counts", () => {
		const r = new Reg().initiative(NOW - 30 * H, "ini").task(NOW - 20 * H, 1, { initiative: "ini" }, "working");
		r.fact(1, NOW - 20 * H, { progress: { text: "on it", at: NOW - 1 * H } });
		expect(twice(r).findings).toEqual([]);
		r.state(NOW - 3 * H, 1, NOW - 20 * H, "done");
		expect(flagged(twice(r).findings)).toEqual(["initiative:ini:empty"]);
		expect(twice(r).findings[0].since).toBe(NOW - 3 * H);
	});

	it("an initiative whose last active project closed starts its empty stretch then", () => {
		const r = new Reg().initiative(NOW - 30 * H, "ini").project(NOW - 30 * H, "p", "ops", "ini");
		r.task(NOW - 29 * H, 1, { project: "p" }, "working").state(NOW - 4 * H, 1, NOW - 29 * H, "done");
		r.change(NOW - 3 * H, "project", "p", { status: "dropped" });
		const { findings } = twice(r);
		expect(flagged(findings)).toEqual(["initiative:ini:empty"]);
		expect(findings[0].since).toBe(NOW - 3 * H);
		expect(findings[0].lastDone).toMatchObject({ task: 1, at: NOW - 4 * H });
	});

	it("an initiative's silent clock counts its lead's updates and its projects' events", () => {
		const r = new Reg().initiative(NOW - 60 * H, "ini").task(NOW - 50 * H, 1, { initiative: "ini" }, "working");
		expect(flagged(twice(r).findings)).toEqual(["initiative:ini:silent"]);
		expect(twice(r, NOW, S, [{ initiative: "ini", at: NOW - 2 * H }]).findings).toEqual([]);
		// An update after now (the backtest replays the past) doesn't count.
		const late = stallReview(r.page(), r.extra([{ initiative: "ini", at: NOW + H }], NOW), NOW, S);
		expect(flagged(late.findings)).toEqual(["initiative:ini:silent"]);
	});

	it("a status or lead change restarts the empty stretch", () => {
		const r = new Reg().project(NOW - 10 * H, "p");
		r.change(NOW - 1 * H, "project", "p", { lead: "design" });
		expect(twice(r).findings).toEqual([]);
		expect(twice(r).items[0]).toMatchObject({ state: "pending", since: NOW - 1 * H });
	});

	it("a resumed wait gives the full grace again; a running wait silences the silent rule too", () => {
		const r = new Reg().project(NOW - 10 * H, "p").wait(NOW - 9 * H, "project", "p", NOW + 5 * H);
		expect(twice(r).items[0].state).toBe("quiet");
		r.resume(NOW - 1 * H, "project", "p");
		expect(twice(r).items[0]).toMatchObject({ state: "pending", since: NOW - 1 * H });
		const s = new Reg().project(NOW - 60 * H, "q").task(NOW - 50 * H, 1, { project: "q" }, "working");
		s.wait(NOW - 49 * H, "project", "q", NOW + H);
		expect(twice(s).items[0].state).toBe("quiet");
		// Ran out an hour ago, silent long before: due at once.
		expect(flagged(twice(s, NOW + 2 * H).findings)).toEqual(["project:q:silent"]);
		expect(twice(s, NOW + 2 * H).findings[0].since).toBe(NOW + H);
	});

	it("a wait counts for at most 14 days from when it was recorded", () => {
		const r = new Reg().project(NOW - 20 * 24 * H, "p").wait(NOW - 15 * 24 * H, "project", "p", NOW + 30 * 24 * H);
		expect(flagged(twice(r).findings)).toEqual(["project:p:empty"]);
		expect(twice(r).findings[0].since).toBe(NOW - 24 * H);
	});

	it("a blocked task says what it waits on", () => {
		const r = new Reg().project(NOW - 60 * H, "p");
		r.ev(NOW - 50 * H, {
			op: "task.link",
			queue: Q,
			queueName: "ops",
			task: 1,
			added: 1,
			title: "T",
			parent: { project: "p" },
		});
		r.ev(NOW - 50 * H, {
			op: "task.state",
			queue: Q,
			task: 1,
			added: 1,
			status: "blocked",
			block: {
				on: ["temper #38"],
				need: "the deploy",
				lead: "temper",
				owes: "the deploy",
				reminders: 0,
				since: NOW - 50 * H,
			},
		});
		const f = twice(r).findings[0];
		expect(f.open).toEqual([
			{
				queue: "ops",
				task: 1,
				title: "T",
				status: "blocked",
				waitsOn: "temper #38; the deploy; temper owes the deploy",
			},
		]);
	});
});

describe("stall-watch dead-end rule (Ops #483, rule 30; each run twice)", () => {
	/** Project p, created 5 h ago, with task 1 working since then. */
	const base = () => new Reg().project(NOW - 5 * H, "p", "ops").task(NOW - 5 * H, 1, { project: "p" }, "working");
	const blockOn = (r: Reg, ts: number, task: number, added: number, b: { on?: string[]; need?: string }) =>
		r.ev(ts, { op: "task.state", queue: Q, task, added, status: "blocked", block: { ...b, reminders: 0, since: ts } });
	const rules = (r: Reg, now = NOW, page = r.page(now)) => {
		const a = stallReview(page, r.extra(), now, S);
		expect(stallReview(page, r.extra(), now, S)).toEqual(a);
		return a;
	};

	it("its last task dropped: flagged at once, not after the empty rule's 2 h", () => {
		const r = base().state(NOW - M, 1, NOW - 5 * H, "dropped");
		const { findings, items } = rules(r);
		expect(flagged(findings)).toEqual(["project:p:dead-end"]);
		expect(findings[0]).toMatchObject({
			since: NOW - M,
			stretch: `project:p:dead-end:${NOW - M}`,
			chain: ["ops", "owner"],
		});
		expect(items[0]).toMatchObject({ state: "flagged", rule: "dead-end", since: NOW - M });
		expect(items[0]!.why).toBe(`dead end since ${stallTime(NOW - M)}: no open task left`);
	});

	it("blocked on a need only, or on its own tasks only: flagged at once, once", () => {
		const r = blockOn(base(), NOW - 10 * M, 1, NOW - 5 * H, { need: "the deploy" });
		const { findings } = rules(r);
		expect(flagged(findings)).toEqual(["project:p:dead-end"]);
		expect(findings[0]!.since).toBe(NOW - 10 * M);
		expect(findings[0]!.open).toEqual([
			{ queue: "ops", task: 1, title: "Task 1", status: "blocked", waitsOn: "the deploy" },
		]);
		const own = base().task(NOW - 4 * H, 2, { project: "p" }, "ready");
		blockOn(own, NOW - 20 * M, 1, NOW - 5 * H, { on: ["#2"] });
		own.fact(2, NOW - 4 * H, { nextAction: { kind: "queue", after: ["#1"] } });
		expect(flagged(rules(own).findings)).toEqual(["project:p:dead-end"]);
	});

	it("moving: a ready, waiting or working task, a link to another queue's open task, an owner question", () => {
		const dead = () => blockOn(base(), NOW - 10 * M, 1, NOW - 5 * H, { need: "x" });
		const cases: [string, Reg, UiWorkPage?][] = [
			["ready", dead().task(NOW - 5 * M, 2, { project: "p" }, "ready")],
			["waiting", dead().task(NOW - 5 * M, 2, { project: "p" }, "waiting")],
			["working", dead().task(NOW - 5 * M, 2, { project: "p" }, "working")],
			["linked", blockOn(base(), NOW - 10 * M, 1, NOW - 5 * H, { on: ["temper #38"], need: "x" })],
			["needs you", dead().fact(1, NOW - 5 * H, { needsYou: { text: "Which key?" } })],
		];
		const asked = dead();
		cases.push(["owner ask", asked, { ...asked.page(), ownerAsks: [{ role: "ops", text: "Proj p: fund it?" }] }]);
		for (const [what, r, page] of cases) {
			expect(flagged(rules(r, NOW, page).findings), what).toEqual([]);
		}
	});

	it("quiet: a wait that holds, every open task paused, a stopped queue", () => {
		const wait = blockOn(base(), NOW - 10 * M, 1, NOW - 5 * H, { need: "x" }).wait(
			NOW - 5 * M,
			"project",
			"p",
			NOW + H,
		);
		expect(rules(wait).findings).toEqual([]);
		expect(rules(wait).items[0]!.state).toBe("quiet");
		const paused = blockOn(base(), NOW - 10 * M, 1, NOW - 5 * H, { need: "x" });
		paused.fact(1, NOW - 5 * H, { paused: { at: NOW - 5 * M, why: "owner: hold it" } });
		expect(rules(paused).findings).toEqual([]);
		expect(rules(paused).items[0]!.state).toBe("quiet");
		const stopped = blockOn(base(), NOW - 10 * M, 1, NOW - 5 * H, { need: "x" });
		stopped.fact(1, NOW - 5 * H, { queueStopped: true });
		expect(rules(stopped).findings).toEqual([]);
	});

	it("stays the same stretch every round while nothing moves; ends once a way out is taken", () => {
		const stretches = (r: Reg, now: number, page?: UiWorkPage) =>
			rules(r, now, page)
				.findings.filter((f) => f.rule === "dead-end")
				.map((f) => f.stretch);
		const dead = () => blockOn(base(), NOW - 10 * M, 1, NOW - 5 * H, { need: "x" });
		const one = [`project:p:dead-end:${NOW - 10 * M}`];
		// Rounds go by; the lead answered its wake, wrote a TL;DR line: still the same stretch.
		const r = dead();
		expect(stretches(r, NOW)).toEqual(one);
		expect(stretches(r, NOW + 3 * H)).toEqual(one);
		r.fact(1, NOW - 5 * H, { progress: { text: "still waiting", at: NOW + H } });
		expect(stretches(r, NOW + 3 * H)).toEqual(one);
		// A way out: the fix task, a link, an owner question.
		expect(stretches(dead().task(NOW + H, 2, { project: "p" }, "ready"), NOW + 2 * H)).toEqual([]);
		expect(stretches(blockOn(dead(), NOW + H, 1, NOW - 5 * H, { on: ["design #4"] }), NOW + 2 * H)).toEqual([]);
		const ask = dead();
		expect(
			stretches(ask, NOW + 2 * H, {
				...ask.page(NOW + 2 * H),
				ownerAsks: [{ role: "ops", text: "About p: drop it?" }],
			}),
		).toEqual([]);
		// Closing it, or a wait, ends it too.
		expect(stretches(dead().change(NOW + H, "project", "p", { status: "dropped" }), NOW + 2 * H)).toEqual([]);
		expect(stretches(dead().wait(NOW + H, "project", "p", NOW + 5 * H), NOW + 2 * H)).toEqual([]);
	});

	it("the page shows the last round's dead end only while it still holds", () => {
		const r = blockOn(base(), NOW - 10 * M, 1, NOW - 5 * H, { need: "x" });
		const { findings } = rules(r);
		const shown = (page: UiWorkPage) =>
			withStall(page, findings, () => [], NOW + M).projects.find((p) => p.id === "p")?.stall;
		expect(shown(r.page())).toEqual({ rule: "dead-end", since: NOW - 10 * M, asked: [] });
		// Between rounds the lead queued the fix task: the page doesn't show the old finding any more.
		expect(shown(r.task(NOW + 30_000, 2, { project: "p" }, "ready").page(NOW + M))).toBeUndefined();
	});
});

describe("stall-watch chains", () => {
	const chainOf = (r: Reg, id: string) => twice(r).findings.find((f) => f.id === id)?.chain;

	it("a project under an initiative with another lead: its lead, the initiative's lead, the owner", () => {
		const r = new Reg().initiative(NOW - 30 * H, "ini", "architecture").project(NOW - 5 * H, "p", "ops", "ini");
		expect(chainOf(r, "p")).toEqual(["ops", "architecture", "owner"]);
	});
	it("the same lead on both: once", () => {
		const r = new Reg().initiative(NOW - 30 * H, "ini", "ops").project(NOW - 5 * H, "p", "ops", "ini");
		expect(chainOf(r, "p")).toEqual(["ops", "owner"]);
	});
	it("lead owner: just the owner", () => {
		const r = new Reg().initiative(NOW - 30 * H, "ini", "design").project(NOW - 5 * H, "p", "owner", "ini");
		expect(chainOf(r, "p")).toEqual(["owner"]);
		const i = new Reg().initiative(NOW - 30 * H, "solo-ini", "owner");
		expect(chainOf(i, "solo-ini")).toEqual(["owner"]);
	});
	it("a standalone project: its lead, the owner; an initiative: its lead, the owner", () => {
		expect(chainOf(new Reg().project(NOW - 5 * H, "p", "design"), "p")).toEqual(["design", "owner"]);
		expect(chainOf(new Reg().initiative(NOW - 5 * H, "i", "qa"), "i")).toEqual(["qa", "owner"]);
	});
	it("a project's initiative lead named owner: the owner once, at the end", () => {
		const r = new Reg().initiative(NOW - 30 * H, "ini", "owner").project(NOW - 5 * H, "p", "ops", "ini");
		expect(chainOf(r, "p")).toEqual(["ops", "owner"]);
	});
});

describe("the wait field in the work page (pi-queue's wait and resume, Ops #282)", () => {
	it("keeps the wait on the record, adds no activity line and no unknown change; a resume or a close ends it", () => {
		const r = new Reg().project(NOW - 10 * H, "p").wait(NOW - 9 * H, "project", "p", NOW + H);
		const page = r.page();
		expect(page.problem).toBeUndefined();
		expect(page.projects[0].wait).toEqual({ until: NOW + H, why: "waits for the review", at: NOW - 9 * H, by: "ops" });
		expect(page.projects[0].updatedAt).toBe(NOW - 10 * H);
		expect(page.activity.map((a) => a.op)).toEqual(["project.create"]);
		expect(r.resume(NOW - 8 * H, "project", "p").page().projects[0].wait).toBeUndefined();
		const d = new Reg().project(NOW - 10 * H, "q").wait(NOW - 9 * H, "project", "q", NOW + H);
		expect(d.change(NOW - 8 * H, "project", "q", { status: "dropped" }).page().projects[0].wait).toBeUndefined();
		// A wait on a closed item, or without a why, is skipped like any change the store refuses.
		expect(d.wait(NOW - 7 * H, "project", "q", NOW + H).page().problem).toBe("unknown-change");
	});
});

describe("stall-watch extra times", () => {
	it("a task moved to another project leaves the first one then", () => {
		const r = new Reg().project(NOW - 10 * H, "a").project(NOW - 10 * H, "b");
		r.task(NOW - 9 * H, 1, { project: "a" }, "working");
		r.ev(NOW - 3 * H, {
			op: "task.link",
			queue: Q,
			queueName: "ops",
			task: 1,
			added: NOW - 9 * H,
			title: "T",
			parent: { project: "b" },
		});
		const t = stallTimesFrom(r.text());
		expect(t.get("project:a")?.leftAt).toBe(NOW - 3 * H);
		expect(t.get("project:b")?.eventAt).toBe(NOW - 3 * H);
		expect(twice(r).items.find((i) => i.id === "a")).toMatchObject({ state: "flagged", since: NOW - 3 * H });
		expect(twice(r, NOW - 2 * H).items.find((i) => i.id === "a")).toMatchObject({ state: "pending" });
	});

	it("a half-written last line and lines after upTo are left out", () => {
		const r = new Reg().project(NOW - 10 * H, "p").task(NOW - 9 * H, 1, { project: "p" }, "working");
		r.state(NOW - 2 * H, 1, NOW - 9 * H, "done");
		expect(stallTimesFrom(r.text(), NOW - 5 * H).get("project:p")?.leftAt).toBeUndefined();
		expect(stallTimesFrom(r.text()).get("project:p")?.leftAt).toBe(NOW - 2 * H);
		expect(stallTimesFrom(`${r.text()}{"v":1,"op":"task.st`).get("project:p")?.leftAt).toBe(NOW - 2 * H);
	});
});

describe("stall-watch lead updates: only the records file's new lines (H-STALL-COST-1)", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});
	const dir = () => {
		const d = mkdtempSync(join(tmpdir(), "stall-lu-"));
		dirs.push(d);
		return d;
	};
	/** A kept record's line, as DecisionRecords.append writes it. */
	const rec = (o: Record<string, unknown>) =>
		JSON.stringify({ v: 1, id: `r-${String(o.ref)}`, ...o, how: "live", seen: NOW }) + "\n";
	const upd = (ref: string, initiative: string | undefined, at: number, update: unknown = { changed: "x" }) =>
		rec({ source: "update", ref, ...(initiative ? { initiative } : {}), at, ...(update ? { update } : {}) });
	/** What the round read before: keptRecords()' list, filtered to lead updates. */
	const viaList = (d: string) =>
		leadUpdatesOf(
			new DecisionRecords(d)
				.list()
				.flatMap((r) =>
					r.source === "update" && r.initiative && r.update ? [{ initiative: r.initiative, at: r.at }] : [],
				),
		);

	it("gives the same answer as keptRecords()' list on a mixed file", async () => {
		const d = dir();
		const f = join(d, "records.jsonl");
		writeFileSync(
			f,
			[
				upd("u1", "ini-a", NOW - 5 * H),
				// The mark inside a text is escaped, so it isn't a lead update.
				rec({ source: "message", ref: "m1", at: NOW - 4 * H, initiative: "ini-b", text: 'quotes {"source":"update"}' }),
				// The mark in a nested object: read, then left out (not the record's own source).
				rec({ source: "board", ref: "b1", at: NOW - 3 * H, initiative: "ini-b", meta: { source: "update" } }),
				upd("u2", "ini-a", NOW - 2 * H),
				// The same ref again, later: the first record wins, so this time doesn't count.
				upd("u1", "ini-a", NOW - 1 * H),
				upd("u3", undefined, NOW - 1 * H),
				upd("u4", "ini-b", NOW - 90 * M, null),
				// A line cut off by a crash, ended later by DecisionRecords.load().
				'{"v":1,"id":"r-u5","source":"update","ref":"u5","initiative":"ini-c","at":\n',
				upd("u6", "ini-c", NOW - 30 * M),
			].join(""),
		);
		const want = new Map([
			["ini-a", NOW - 2 * H],
			["ini-c", NOW - 30 * M],
		]);
		for (let run = 0; run < 2; run++) {
			expect(viaList(d)).toEqual(want);
			expect(await new LeadUpdatesFile(() => f).get()).toEqual(want);
		}
	});

	it("reads what was added since its last look; a half-written last line waits for its newline", async () => {
		const d = dir();
		const f = join(d, "records.jsonl");
		writeFileSync(f, upd("u1", "ini-a", NOW - 5 * H) + rec({ source: "message", ref: "m1", at: NOW - 4 * H }));
		const lu = new LeadUpdatesFile(() => f);
		expect(await lu.get()).toEqual(new Map([["ini-a", NOW - 5 * H]]));
		appendFileSync(f, upd("u2", "ini-a", NOW - 2 * H));
		expect(await lu.get()).toEqual(new Map([["ini-a", NOW - 2 * H]]));
		const line = upd("u3", "ini-b", NOW - 10 * M);
		appendFileSync(f, line.slice(0, -1));
		expect((await lu.get()).has("ini-b")).toBe(false);
		appendFileSync(f, "\n");
		expect(await lu.get()).toEqual(
			new Map([
				["ini-a", NOW - 2 * H],
				["ini-b", NOW - 10 * M],
			]),
		);
		expect(await lu.get()).toEqual(viaList(d));
		// A ref it has seen already, appended again later, still doesn't count.
		appendFileSync(f, upd("u3", "ini-b", NOW - 1 * M));
		expect((await lu.get()).get("ini-b")).toBe(NOW - 10 * M);
		expect(await lu.get()).toEqual(viaList(d));
	});

	it("a replaced, shrunk or rewritten file is read again from the start", async () => {
		const d = dir();
		const f = join(d, "records.jsonl");
		writeFileSync(f, upd("u1", "ini-a", NOW - 5 * H));
		const lu = new LeadUpdatesFile(() => f);
		expect(await lu.get()).toEqual(new Map([["ini-a", NOW - 5 * H]]));
		// Replaced (a new file put in its place).
		writeFileSync(`${f}.new`, upd("x1", "ini-z", NOW - 1 * H));
		renameSync(`${f}.new`, f);
		expect(await lu.get()).toEqual(new Map([["ini-z", NOW - 1 * H]]));
		// Shrunk to nothing, then the same ref again: counted, since it starts over.
		writeFileSync(f, "");
		expect(await lu.get()).toEqual(new Map());
		appendFileSync(f, upd("x1", "ini-z", NOW - 1 * H));
		expect(await lu.get()).toEqual(new Map([["ini-z", NOW - 1 * H]]));
		// Rewritten in place, longer: the byte before its place isn't a line end any more.
		writeFileSync(f, upd("y1", "ini-y", NOW - 3 * H, { changed: "a much longer update text ".repeat(8) }));
		expect(await lu.get()).toEqual(new Map([["ini-y", NOW - 3 * H]]));
		expect(await lu.get()).toEqual(viaList(d));
	});

	it("no file: nothing, until there is one", async () => {
		const d = dir();
		const f = join(d, "records.jsonl");
		const lu = new LeadUpdatesFile(() => f);
		expect(await lu.get()).toEqual(new Map());
		writeFileSync(f, upd("u1", "ini-a", NOW - 5 * H));
		expect(await lu.get()).toEqual(new Map([["ini-a", NOW - 5 * H]]));
	});
});

describe("stall-watch: the newest overview's queue facts (H-STALL-COST-2)", () => {
	it("used up to 60 s old; not when older, missing, or ahead of the clock", () => {
		expect(STALL_OVERVIEW_MAX_AGE_MS).toBe(60_000);
		expect(youngEnough({ value: "ov", at: NOW - 15_000 }, NOW)).toBe("ov");
		expect(youngEnough({ value: "ov", at: NOW - 60_000 }, NOW)).toBe("ov");
		expect(youngEnough({ value: "ov", at: NOW }, NOW)).toBe("ov");
		expect(youngEnough({ value: "ov", at: NOW - 60_001 }, NOW)).toBeUndefined();
		expect(youngEnough({ value: "ov", at: NOW + 1_000 }, NOW)).toBeUndefined();
		expect(youngEnough(null, NOW)).toBeUndefined();
		expect(youngEnough(undefined, NOW)).toBeUndefined();
	});
	it("a task linked after the overview was made still counts as open: its state is the registry's", () => {
		const r = new Reg();
		r.project(NOW - 3 * H, "p", "ops").task(NOW - 10_000, 9, { project: "p" }, "ready");
		// The overview made before the link has no facts for task 9; the one after has its TL;DR line.
		const older = stallReview(workPageFrom(r.text(), [], NOW), r.extra(), NOW, S);
		r.fact(9, NOW - 10_000, { progress: { text: "started", at: NOW - 5_000 } });
		const newer = stallReview(r.page(), r.extra(), NOW, S);
		expect(older.findings).toEqual([]);
		expect(newer.findings).toEqual([]);
		const stateOf = (rv: typeof older) => rv.items.find((i) => i.id === "p")?.state;
		expect(stateOf(older)).toBe(stateOf(newer));
	});
});

describe("stall-watch settings", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
	});
	const file = (body: string) => {
		const d = mkdtempSync(join(tmpdir(), "stall-"));
		dirs.push(d);
		const f = join(d, "stall-watch.json");
		writeFileSync(f, body);
		return f;
	};

	it("defaults: dry, 2 h, 24 h, 2 h, 10 min", () => {
		expect(stallSettings("/nonexistent/stall-watch.json", {})).toEqual({
			mode: "dry",
			emptyHours: 2,
			silentHours: 24,
			gapHours: 2,
			everyMin: 10,
		});
	});
	it("the file's fields, each on its own; a bad one falls back", () => {
		const f = file(JSON.stringify({ mode: "off", emptyHours: 3, silentHours: -1, everyMin: "x" }));
		expect(stallSettings(f, {})).toEqual({ mode: "off", emptyHours: 3, silentHours: 24, gapHours: 2, everyMin: 10 });
		expect(stallSettings(file("{not json"), {})).toEqual(STALL_DEFAULTS);
		expect(stallSettings(file(JSON.stringify({ mode: "loud" })), {}).mode).toBe("dry");
	});
	it("env overrides for tests", () => {
		const f = file(JSON.stringify({ mode: "off" }));
		const env = { PI_WEB_STALL_FILE: f, PI_WEB_STALL_MODE: "dry", PI_WEB_STALL_EVERY_MIN: "0.01" };
		expect(stallSettings(undefined, env)).toMatchObject({ mode: "dry", everyMin: 0.01 });
		expect(stallSettings(undefined, { PI_WEB_STALL_FILE: f })).toMatchObject({ mode: "off" });
	});
});

describe("stall-watch dry run", () => {
	it("logs step 1 of a new stretch, later steps gapHours apart, each once", () => {
		const lines: string[] = [];
		const dry = new StallDryLog(
			(l) => lines.push(l),
			() => S,
		);
		const r = new Reg().initiative(NOW - 30 * H, "ini", "architecture").project(NOW - 5 * H, "p", "ops", "ini");
		const f = stallFindings(r.page(), r.extra(), NOW, S);
		void dry.act(f, NOW);
		void dry.act(f, NOW + 10 * M);
		expect(lines).toEqual([stallWakeLine(f[0], 1)]);
		expect(lines[0]).toBe(`stall: would wake ops about project p (empty since ${stallTime(NOW - 5 * H)}, step 1 of 3)`);
		void dry.act(f, NOW + 2 * H);
		void dry.act(f, NOW + 4 * H);
		void dry.act(f, NOW + 9 * H);
		expect(lines).toEqual([1, 2, 3].map((n) => stallWakeLine(f[0], n)));
	});

	it("StallWatch: hands each round's findings to act, logs a cleared stretch, keeps the list; sends nothing", async () => {
		const r = new Reg().project(NOW - 5 * H, "p");
		let reg = r;
		let now = NOW;
		const got: StallFinding[][] = [];
		const lines: string[] = [];
		const w = new StallWatch({
			read: () => ({ page: reg.page(now), extra: reg.extra() }),
			act: (f) => {
				got.push(f);
			},
			settings: () => S,
			now: () => now,
			log: (l) => lines.push(l),
		});
		await w.tick();
		expect(got[0].map((f) => f.id)).toEqual(["p"]);
		expect(w.list()).toMatchObject({ mode: "dry", rounds: 1, findings: [{ id: "p" }] });
		now = NOW + M;
		reg = new Reg().project(NOW - 5 * H, "p").task(NOW, 9, { project: "p" }, "working");
		await w.tick();
		expect(got[1]).toEqual([]);
		expect(lines).toEqual([`stall: p cleared (1 open, last recorded ${stallTime(NOW)})`]);
		expect(w.list().items).toMatchObject([{ id: "p", state: "fine" }]);
	});

	it("StallWatch: mode off stops it; an unreadable registry skips the round and keeps the findings", async () => {
		const lines: string[] = [];
		let s: StallSettings = S;
		let text = new Reg().project(NOW - 5 * H, "p").text();
		const w = new StallWatch({
			read: () => ({ page: workPageFrom(text, [], NOW), extra: stallExtraFrom(text) }),
			settings: () => s,
			now: () => NOW,
			log: (l) => lines.push(l),
			firstMs: 10,
		});
		await w.tick();
		expect(lines).toEqual([
			`stall: would wake ops about project p (empty since ${stallTime(NOW - 5 * H)}, step 1 of 2)`,
		]);
		text = "not json at all\n{}\n";
		const page = workPageFrom(text, [], NOW);
		if (page.problem === "unreadable") {
			await w.tick();
			expect(w.list().findings.map((f) => f.id)).toEqual(["p"]);
		}
		s = { ...S, mode: "off" };
		w.start();
		await w.tick();
		expect(w.running).toBe(false);
		expect(lines.at(-1)).toBe("stall: off (stall-watch.json mode off); stopped");
		const off = new StallWatch({
			read: () => ({ page, extra: stallExtraFrom("") }),
			settings: () => s,
			log: (l) => lines.push(l),
		});
		off.start();
		expect(off.running).toBe(false);
	});
});
