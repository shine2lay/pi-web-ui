/**
 * stall-watch (Ops #283, docs/stall-watch.md): the stall check's rules on fixed registries whose right answers
 * are known: the cases it must catch fire, the cases it must pass don't, each run twice with the same result;
 * whom it would wake, in turn; the settings; the dry run's log lines; the extra times from the registry's text.
 * Fixed fixtures only: never the live registry.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UiWorkPage } from "../../server/protocol.js";
import { workPageFrom, type WorkQueueFacts, type WorkTaskFacts } from "../../server/work-page.js";
import {
	STALL_DEFAULTS,
	StallDryLog,
	StallWatch,
	stallExtraFrom,
	stallFindings,
	stallReview,
	stallSettings,
	stallTime,
	stallTimesFrom,
	stallWakeLine,
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
	// 4. Open tasks, nothing recorded for 25 h.
	r.project(NOW - 30 * H, "silent-25h", "ops").task(NOW - 25 * H, 2, { project: "silent-25h" }, "blocked");
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
	"project:silent-25h:silent",
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
