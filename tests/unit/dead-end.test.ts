/**
 * dead-end (Ops #483, AGENTS.md rule 30; docs/stall-watch.md "Dead end"): the one test of whether an active
 * project has nothing moving (server/dead-end.ts), on fixed registries whose right answers are known, each run
 * twice. The cases it must catch, the cases it must pass, the quiet ones, and the queue host's answer for
 * pi-queue's drop and reply results. Fixed fixtures only: never the live registry.
 */
import { describe, expect, it } from "vitest";
import { deadEndAnswer, deadEndOf, deadEndWaysOut, namesRecord, projectDeadEnd } from "../../server/dead-end.js";
import type { UiWorkOwnerAsk, UiWorkPage } from "../../server/protocol.js";
import { workPageFrom, type WorkTaskFacts } from "../../server/work-page.js";

const H = 3_600_000;
const M = 60_000;
const NOW = Date.UTC(2026, 9, 23, 18, 0);
const OPS = "/home/u/.pi/agent/sessions/ops-home.jsonl";
const DESIGN = "/home/u/.pi/agent/sessions/design-home.jsonl";
const NAMES: Record<string, string> = { [OPS]: "ops", [DESIGN]: "design" };

/** A registry built line by line, as the store writes it, plus the queues' facts. */
class Reg {
	private lines: string[] = [];
	private seq = 0;
	private facts = new Map<string, Map<number, WorkTaskFacts>>();
	asks: UiWorkOwnerAsk[] = [];

	ev(ts: number, e: Record<string, unknown>): this {
		this.lines.push(JSON.stringify({ v: 1, seq: ++this.seq, ts, by: "ops", ...e }));
		return this;
	}
	initiative(ts: number, id: string, name = `Ini ${id}`): this {
		return this.ev(ts, { op: "initiative.create", id, name, outcome: "o", doneWhen: ["d"], lead: "ops" });
	}
	project(ts: number, id: string, initiative: string | null = null, name = `Proj ${id}`): this {
		return this.ev(ts, { op: "project.create", id, name, outcome: "o", doneWhen: ["d"], lead: "ops", initiative });
	}
	/** A task linked at ts (added = ts) under project p, in the ops queue unless given. */
	task(ts: number, task: number, p: string, status?: string, queue = OPS): this {
		this.ev(ts, {
			op: "task.link",
			queue,
			queueName: NAMES[queue],
			task,
			added: ts,
			title: `Task ${task}`,
			parent: { project: p },
		});
		if (status) this.state(ts, task, ts, status, queue);
		return this;
	}
	state(ts: number, task: number, added: number, status: string, queue = OPS, block?: Record<string, unknown>): this {
		return this.ev(ts, { op: "task.state", queue, task, added, status, ...(block ? { block } : {}) });
	}
	/** Blocked at ts on `on` (task refs as people write them) and/or a need. */
	block(ts: number, task: number, added: number, b: { on?: string[]; need?: string }, queue = OPS): this {
		return this.state(ts, task, added, "blocked", queue, { ...b, reminders: 0, since: ts });
	}
	wait(ts: number, id: string, until: number): this {
		return this.ev(ts, { op: "project.wait", id, until, why: "waits for the review" });
	}
	change(ts: number, id: string, changes: Record<string, unknown>): this {
		return this.ev(ts, { op: "project.change", id, changes });
	}
	fact(task: number, added: number, f: WorkTaskFacts, queue = OPS): this {
		let m = this.facts.get(queue);
		if (!m) this.facts.set(queue, (m = new Map()));
		m.set(task, { added, ...f });
		return this;
	}
	page(now = NOW): UiWorkPage {
		const facts = [...this.facts].map(([file, tasks]) => ({ file, tasks }));
		const page = workPageFrom(this.lines.map((l) => `${l}\n`).join(""), facts, now);
		return this.asks.length ? { ...page, ownerAsks: this.asks } : page;
	}
}

/** The verdict for project p, worked out twice from the text up (rule 16: steady on known cases). */
function verdict(r: Reg, p = "p", now = NOW) {
	const a = projectDeadEnd(r.page(now), p, now);
	const b = projectDeadEnd(r.page(now), p, now);
	expect(b).toEqual(a);
	return a;
}

const T = NOW - 5 * H;

describe("dead-end: must catch (each run twice)", () => {
	it("its last task dropped: nothing left, dead at once, since the drop", () => {
		const r = new Reg()
			.project(T, "p")
			.task(T, 1, "p", "working")
			.state(NOW - 10 * M, 1, T, "dropped");
		expect(verdict(r)).toEqual({ state: "dead", since: NOW - 10 * M, why: "no open task left" });
	});

	it("its last task removed: the same", () => {
		const r = new Reg()
			.project(T, "p")
			.task(T, 1, "p", "ready")
			.state(NOW - 5 * M, 1, T, "removed");
		expect(verdict(r)).toMatchObject({ state: "dead", since: NOW - 5 * M });
	});

	it("blocked on a need only: dead, since the block", () => {
		const r = new Reg()
			.project(T, "p")
			.task(T, 1, "p", "working")
			.block(NOW - 20 * M, 1, T, { need: "the deploy" });
		expect(verdict(r)).toEqual({ state: "dead", since: NOW - 20 * M, why: "nothing moving: ops #1 blocked" });
	});

	it("blocked with nothing recorded about it: dead", () => {
		const r = new Reg().project(T, "p").task(T, 1, "p", "blocked");
		expect(verdict(r)).toMatchObject({ state: "dead", since: T });
	});

	it("blocked only on its own project's tasks, themselves stuck on a need: dead", () => {
		const r = new Reg().project(T, "p").task(T, 1, "p", "working").task(T, 2, "p", "working");
		r.block(NOW - 30 * M, 1, T, { need: "a key" });
		// #1 in its own queue, and the same task by its queue's name.
		r.block(NOW - 20 * M, 2, T, { on: ["#1", "ops #1"] });
		expect(verdict(r)).toEqual({
			state: "dead",
			since: NOW - 20 * M,
			why: "nothing moving: ops #1 blocked, ops #2 blocked",
		});
	});

	it("ready, but only after its own project's blocked task: dead", () => {
		const r = new Reg().project(T, "p").task(T, 1, "p", "working").task(T, 2, "p", "ready");
		r.block(NOW - 30 * M, 1, T, { need: "a key" });
		r.fact(2, T, { nextAction: { kind: "queue", after: ["#1"] } });
		expect(verdict(r).state).toBe("dead");
	});

	it("blocked on another queue's task that is done: dead (the link is over)", () => {
		const r = new Reg().project(T, "p").project(T, "q").task(T, 4, "q", "working", DESIGN);
		r.state(NOW - 2 * H, 4, T, "done", DESIGN);
		r.task(T, 1, "p", "working").block(NOW - H, 1, T, { on: ["design #4"] });
		expect(verdict(r)).toMatchObject({ state: "dead", since: NOW - H });
	});

	it("an owner question about another project doesn't count", () => {
		const r = new Reg()
			.project(T, "p")
			.project(T, "other")
			.task(T, 1, "p", "working")
			.block(NOW - H, 1, T, { need: "x" });
		r.asks = [{ role: "ops", text: "Close project other? It is finished." }];
		expect(verdict(r).state).toBe("dead");
	});

	it("a wait that ran out: dead again, from its end", () => {
		const r = new Reg()
			.project(T, "p")
			.task(T, 1, "p", "working")
			.block(T + H, 1, T, { need: "x" });
		r.wait(T + 2 * H, "p", NOW - H);
		expect(verdict(r)).toMatchObject({ state: "dead", since: NOW - H });
	});
});

describe("dead-end: must pass (moving, each run twice)", () => {
	const blocked = () =>
		new Reg()
			.project(T, "p")
			.task(T, 1, "p", "working")
			.block(NOW - H, 1, T, { need: "x" });

	it("a task at work, a ready task, a task waiting on a check, a question with its lead", () => {
		for (const [status, why] of [
			["working", "ops #2 is at work"],
			["ready", "ops #2 is ready to start"],
			["waiting", "ops #2 waits on a check"],
			["asking", "ops #2's question is with its lead"],
		] as const) {
			const r = blocked().task(NOW - 5 * M, 2, "p", status);
			expect(verdict(r)).toEqual({ state: "moving", why });
		}
	});

	it("a fix task queued after the drop: moving", () => {
		const r = new Reg()
			.project(T, "p")
			.task(T, 1, "p", "working")
			.state(NOW - 10 * M, 1, T, "dropped");
		expect(verdict(r).state).toBe("dead");
		r.task(NOW - 5 * M, 2, "p", "ready");
		expect(verdict(r)).toEqual({ state: "moving", why: "ops #2 is ready to start" });
	});

	it("blocked on an open task in another queue (linked, or not in the registry): moving", () => {
		const r = new Reg().project(T, "p").project(T, "q").task(T, 4, "q", "working", DESIGN);
		r.task(T, 1, "p", "working").block(NOW - H, 1, T, { on: ["design #4"], need: "its review" });
		expect(verdict(r)).toEqual({ state: "moving", why: "ops #1 waits on design #4" });
		const s = blocked().block(NOW - 30 * M, 1, T, { on: ["temper #38"] });
		expect(verdict(s)).toEqual({ state: "moving", why: "ops #1 waits on temper #38" });
	});

	it("blocked on a task of its own queue outside the project: moving", () => {
		const r = blocked().block(NOW - 30 * M, 1, T, { on: ["#77"] });
		expect(verdict(r)).toEqual({ state: "moving", why: "ops #1 waits on #77" });
	});

	it("ready after another queue's open task: moving", () => {
		const r = blocked().task(NOW - 5 * M, 2, "p", "ready");
		r.fact(2, NOW - 5 * M, { nextAction: { kind: "queue", after: ["#1", "temper #38"] } });
		expect(verdict(r)).toEqual({ state: "moving", why: "ops #2 starts after temper #38" });
	});

	it("a blocked task its queue let go (an answer, or what it waited on is over): moving", () => {
		const r = blocked().fact(1, T, { poked: NOW - M });
		expect(verdict(r)).toEqual({ state: "moving", why: "ops #1 was let go and comes back to work next" });
	});

	it("an owner question: the task's own, a stuck task, or one naming the project or its initiative", () => {
		expect(verdict(blocked().fact(1, T, { needsYou: { text: "Which port?" } }))).toEqual({
			state: "moving",
			why: "ops #1 waits on the owner",
		});
		expect(verdict(blocked().task(NOW - 5 * M, 2, "p", "stuck")).state).toBe("moving");
		const byId = blocked();
		byId.asks = [{ role: "ops", text: "Project p: drop it or fund the key?" }];
		expect(verdict(byId)).toEqual({ state: "moving", why: "a question to the owner (ops) names it" });
		const byIni = new Reg().initiative(T, "team", "Team in Temper").project(T, "p", "team").task(T, 1, "p", "blocked");
		byIni.asks = [{ role: "design", text: "For team in temper: which page first?" }];
		expect(verdict(byIni).state).toBe("moving");
	});
});

describe("dead-end: quiet (each run twice)", () => {
	it("a recorded wait that holds", () => {
		const r = new Reg()
			.project(T, "p")
			.task(T, 1, "p", "blocked")
			.wait(NOW - H, "p", NOW + H);
		expect(verdict(r)).toEqual({ state: "quiet", why: "waits on purpose: waits for the review" });
	});

	it("every open task paused by the owner, or in a stopped queue", () => {
		const paused = new Reg().project(T, "p").task(T, 1, "p", "blocked").task(T, 2, "p", "ready");
		paused.fact(1, T, { paused: { at: T, why: "owner: hold it" } }).fact(2, T, { paused: { at: T, why: "owner" } });
		expect(verdict(paused)).toEqual({
			state: "quiet",
			why: "every open task is paused by the owner or in a stopped queue: ops #1, ops #2",
		});
		const stopped = new Reg().project(T, "p").task(T, 1, "p", "blocked").fact(1, T, { queueStopped: true });
		expect(verdict(stopped).state).toBe("quiet");
		// One paused, one blocked on a need in a running queue: dead.
		const half = new Reg().project(T, "p").task(T, 1, "p", "blocked").task(T, 2, "p", "ready");
		half.fact(2, T, { paused: { at: T, why: "owner" } });
		expect(verdict(half).state).toBe("dead");
	});

	it("no task linked yet, its last task done, not active, not in the registry", () => {
		expect(verdict(new Reg().project(T, "p")).state).toBe("quiet");
		const done = new Reg()
			.project(T, "p")
			.task(T, 1, "p", "working")
			.state(NOW - H, 1, T, "done");
		expect(verdict(done)).toEqual({ state: "quiet", why: "its last task ops #1 is done" });
		const closed = new Reg()
			.project(T, "p")
			.task(T, 1, "p", "blocked")
			.change(NOW - H, "p", { status: "dropped" });
		expect(verdict(closed)).toEqual({ state: "quiet", why: "status dropped" });
		expect(verdict(new Reg().project(T, "q"), "p")).toEqual({ state: "quiet", why: "not in the registry" });
	});
});

describe("dead-end: the queue host's answer (pi-queue's drop and reply results)", () => {
	it("takes the task pi-queue just changed at its new status, before the registry has it", () => {
		const r = new Reg().project(T, "p").task(T, 1, "p", "ready");
		const page = r.page();
		expect(deadEndAnswer(page, { project: "p" }, NOW)).toEqual({
			state: "moving",
			why: "ops #1 is ready to start",
			name: "Proj p",
		});
		const dropped = deadEndAnswer(page, { project: "p", file: OPS, id: 1, state: "dropped" }, NOW);
		expect(dropped).toEqual({ state: "dead", why: "no open task left", name: "Proj p", waysOut: deadEndWaysOut("p") });
		// Another queue's task with the same number is another task.
		expect(deadEndAnswer(page, { project: "p", file: DESIGN, id: 1, state: "dropped" }, NOW).state).toBe("moving");
	});

	it("a let-go block answered with a new status loses its old facts", () => {
		const r = new Reg()
			.project(T, "p")
			.task(T, 1, "p", "working")
			.block(NOW - H, 1, T, { need: "x" });
		r.fact(1, T, { poked: NOW - M });
		expect(deadEndAnswer(r.page(), { project: "p" }, NOW).state).toBe("moving");
		expect(deadEndAnswer(r.page(), { project: "p", file: OPS, id: 1, state: "blocked" }, NOW).state).toBe("dead");
		expect(deadEndAnswer(r.page(), { project: "p", file: OPS, id: 1, state: "ready" }, NOW).state).toBe("moving");
	});

	it("names the project; a project it doesn't know is quiet", () => {
		const page = new Reg().project(T, "p", null, "Team page truth").page();
		expect(deadEndAnswer(page, { project: "nope" }, NOW)).toEqual({
			state: "quiet",
			why: "not in the work registry",
			name: "nope",
		});
	});

	it("says the three ways out, and closing it when its work is finished", () => {
		const w = deadEndWaysOut("team-page-truth");
		expect(w).toContain("queue the fix task (queue_add with project team-page-truth)");
		expect(w).toContain("queue_blocked on");
		expect(w).toContain("queue_stuck needs_owner");
		expect(w).toContain("close it with work_project");
	});

	it("deadEndOf and projectDeadEnd agree", () => {
		const r = new Reg().project(T, "p").task(T, 1, "p", "blocked");
		const page = r.page();
		expect(deadEndOf(page.projects[0]!, page, NOW)).toEqual(projectDeadEnd(page, "p", NOW));
	});
});

describe("dead-end: naming a record", () => {
	it("its id as a whole word, or its whole name, in any case", () => {
		const r = { id: "team-page", name: "Team page truth" };
		expect(namesRecord("Drop TEAM-PAGE now?", r)).toBe(true);
		expect(namesRecord("about the team   page truth work", r)).toBe(true);
		expect(namesRecord("team-pages and team-page-2", r)).toBe(false);
		expect(namesRecord("the team page", { id: "x", name: "abc" })).toBe(false);
	});
});
