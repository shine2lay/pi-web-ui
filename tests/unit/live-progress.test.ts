// live-progress (Ops #270, docs/live-progress.md): the server fills the live-progress fields from records it
// already reads: the owner rule for a stuck task's question (withLead), a task's progress line, a role's newest done
// tasks and the Initiatives page's join. Fixed fixtures only: no live chat, no model.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Ask } from "../../server/asks.js";
import type { IdentityDef } from "../../server/identities.js";
import {
	clipText,
	doneRecentOf,
	LIVE_DONE_RECENT_MAX,
	LIVE_SUMMARY_MAX,
	progressOf,
	safeLine,
	stuckRouteOf,
	stuckWithLead,
	withLeadOf,
} from "../../server/live-progress.js";
import type { UiRolesOverview, UiTaskQueueTask, UiTldrLine } from "../../server/protocol.js";
import { RolesOverviewReader, type RolesOverviewHost } from "../../server/roles-overview.js";
import { workFactsFromOverview, workPageFrom } from "../../server/work-page.js";

const T0 = Date.parse("2026-10-19T14:00:00Z");
const MIN = 60_000;
let dir = "";
let sessions = "";
let n = 0;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "live-progress-unit-"));
	sessions = join(dir, "sessions");
	mkdirSync(sessions, { recursive: true });
	n = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ---- fixtures ----------------------------------------------------------------------------------------------
type Line = Record<string, unknown>;
const iso = (ms: number) => new Date(ms).toISOString();
const id8 = () => (++n).toString(16).padStart(8, "0");
function transcript(name: string, lines: Line[] = []): string {
	const file = join(sessions, `${name}.jsonl`);
	const head = { type: "session", version: 3, id: name, timestamp: iso(T0), cwd: dir };
	writeFileSync(file, `${[head, ...lines].map((l) => JSON.stringify(l)).join("\n")}\n`);
	return file;
}
const tldr = (text: string, ts: number, extra: Record<string, unknown> = {}): Line => ({
	type: "custom",
	customType: "tldr",
	data: { v: 1, text, needsYou: false, ts, ...extra },
	id: id8(),
	parentId: null,
	timestamp: iso(ts),
});
const plan = (title: string) => ({
	title,
	goal: "g",
	doneWhen: "d",
	decided: "x",
	steps: "s",
	verify: "v",
	mustNot: "m",
});
const queue = (op: Record<string, unknown>, ts = T0): Line => ({
	type: "custom",
	customType: "queue",
	data: { v: 1, ts, ...op },
	id: id8(),
	parentId: null,
	timestamp: iso(ts),
});
/** Task `id` added and started as a lane task (its own chat when `chat` is given). */
const started = (id: number, chat?: string): Line[] => [
	queue({ op: "add", id, plan: plan(`Task ${id}`) }, T0 + MIN),
	queue({ op: "start", id, lane: true }, T0 + MIN),
	...(chat ? [queue({ op: "chat", id, file: chat, title: `Task ${id}` }, T0 + MIN)] : []),
];
const role = (id: string, homeChat?: string): IdentityDef =>
	({
		id,
		title: id,
		homeChat,
		pastHomeChats: [],
		raw: {},
		dir: join(dir, "identities", id),
		role: { config: { workMode: null, goals: null }, problems: [] },
	}) as unknown as IdentityDef;

function host(roles: IdentityDef[], asks: Ask[] = []): RolesOverviewHost {
	return {
		identities: () => roles,
		chatState: () => "closed",
		asks: () => asks,
		openRequestsTo: () => ({ open: 0 }),
		latestReportTo: () => undefined,
		rolePaused: () => false,
		sessionRoots: () => [sessions],
		reportRunsFile: () => join(dir, "state", "role-reports", "runs.json"),
		schedulerJobsFile: () => join(dir, "scheduler", "jobs.json"),
		now: () => T0 + 60 * MIN,
	};
}
const read = (roles: IdentityDef[], asks: Ask[] = []) => new RolesOverviewReader(host(roles, asks)).read();
const byId = (o: UiRolesOverview, id: string) => {
	const r = o.roles.find((x) => x.id === id);
	if (!r) throw new Error(`no role ${id}`);
	return r;
};
const line = (text: string, ts: number): UiTldrLine => ({ id: id8(), text, needsYou: false, ts }) as UiTldrLine;
const task = (o: Partial<UiTaskQueueTask> & { id: number; status: UiTaskQueueTask["status"] }): UiTaskQueueTask =>
	({ plan: plan(`Task ${o.id}`), addedAt: T0, ...o }) as UiTaskQueueTask;

// ---- the owner rule -----------------------------------------------------------------------------------------
describe("the owner rule: a stuck task's question waits on the owner only once it reached him", () => {
	const homes = new Set(["arch", "design", "coo", "ops"]);
	it("reached him: no route (a direct path), passed, why, or the chain ended", () => {
		expect(stuckWithLead(undefined, homes)).toBeUndefined();
		expect(
			stuckWithLead(stuckRouteOf({ n: 1, at: T0, passed: true, to: "ops", lead: "design" }), homes),
		).toBeUndefined();
		expect(stuckWithLead(stuckRouteOf({ n: 1, at: T0, why: "timeout", lead: "design" }), homes)).toBeUndefined();
		expect(stuckWithLead(stuckRouteOf({ n: 1, at: T0, chain: ["design", "coo"], step: 3 }), homes)).toBeUndefined();
	});
	it("a lead the record names still holds it: ask.lead, or the chain's step", () => {
		expect(stuckWithLead(stuckRouteOf({ n: 1, at: T0, to: "ops", lead: "design", step: 0 }), homes)).toBe("design");
		expect(stuckWithLead(stuckRouteOf({ n: 1, at: T0, to: "ops", chain: ["design", "coo"], step: 2 }), homes)).toBe(
			"coo",
		);
		// lead is who has it now; it wins over the chain
		expect(stuckWithLead(stuckRouteOf({ lead: "coo", chain: ["design", "coo"], step: 1 }), homes)).toBe("coo");
	});
	it("on a doubt it stays the owner's: no lead named, the owner, a role without a home chat, a bad id", () => {
		expect(stuckWithLead(stuckRouteOf({ n: 1, at: T0, to: "ops" }), homes)).toBeUndefined();
		expect(stuckWithLead(stuckRouteOf({ n: 1, at: T0, step: 0 }), homes)).toBeUndefined();
		expect(stuckWithLead(stuckRouteOf({ lead: "owner" }), homes)).toBeUndefined();
		expect(stuckWithLead(stuckRouteOf({ lead: "solo" }), homes)).toBeUndefined();
		expect(stuckWithLead(stuckRouteOf({ lead: "Design Lead" }), new Set(["Design Lead"]))).toBeUndefined();
	});
	it("reads only well-formed route fields", () => {
		expect(stuckRouteOf(undefined)).toBeUndefined();
		expect(stuckRouteOf("passed")).toBeUndefined();
		expect(stuckRouteOf([])).toBeUndefined();
		expect(stuckRouteOf({ passed: "yes", why: "", step: 1.5, chain: ["design", 7], lead: 3 })).toEqual({
			chain: ["design"],
		});
		expect(
			stuckRouteOf({ passed: true, why: "limit", to: "ops", lead: "coo", step: 2, chain: ["design", "coo"] }),
		).toEqual({
			passed: true,
			why: "limit",
			to: "ops",
			lead: "coo",
			step: 2,
			chain: ["design", "coo"],
		});
	});
	it("an asking task: the decider the Queue tab names, when it is a role with a home chat", () => {
		const route = undefined;
		expect(withLeadOf(task({ id: 1, status: "asking", askOps: true, askLead: "design" }), route, "arch", homes)).toBe(
			"design",
		);
		expect(withLeadOf(task({ id: 1, status: "asking", askOps: true }), route, "arch", homes)).toBe("ops");
		expect(withLeadOf(task({ id: 1, status: "asking" }), route, "arch", homes)).toBe("arch");
		expect(
			withLeadOf(task({ id: 1, status: "asking", askOps: true, askLead: "solo" }), route, "arch", homes),
		).toBeUndefined();
		for (const status of ["ready", "working", "waiting", "blocked", "done"] as const) {
			expect(
				withLeadOf(task({ id: 1, status, askOps: true, askLead: "design" }), { lead: "design" }, "arch", homes),
			).toBeUndefined();
		}
	});
});

// ---- progress and done summaries -----------------------------------------------------------------------------
describe("progress picks the newest line a page may show", () => {
	it("newest by time, the later one on a tie, never one without a time or with an unsafe character", () => {
		expect(progressOf([])).toBeUndefined();
		expect(progressOf([line("one", T0), line("three", T0 + 2 * MIN), line("two", T0 + MIN)])).toEqual({
			text: "three",
			at: T0 + 2 * MIN,
		});
		expect(progressOf([line("first", T0), line("second", T0)])).toEqual({ text: "second", at: T0 });
		expect(progressOf([line("timed", T0), line("untimed", 0)])).toEqual({ text: "timed", at: T0 });
		for (const bad of ["right\u202Eleft", "bell\u0007", "line\u2028sep", "zero\u200Bwidth", "   "]) {
			expect(progressOf([line("safe", T0), line(bad, T0 + MIN)])).toEqual({ text: "safe", at: T0 });
		}
		// tabs and line breaks are spaces on the page: such a line shows, as it is
		expect(progressOf([line("two\nlines\tand a tab", T0)])).toEqual({ text: "two\nlines\tand a tab", at: T0 });
		expect(safeLine(42)).toBe(false);
	});
});

describe("doneRecent: a role's newest done tasks, clipped", () => {
	it("keeps the newest 10, newest first, clips summaries to 300 and leaves out one without a done time", () => {
		const tasks: UiTaskQueueTask[] = [];
		for (let i = 1; i <= 12; i++)
			tasks.push(task({ id: i, status: "done", doneAt: T0 + i * MIN, summary: `Did ${i}` }));
		tasks.push(task({ id: 13, status: "done", summary: "no time" }));
		tasks.push(task({ id: 14, status: "working" }));
		const long = `${"é".repeat(150)}${"😀".repeat(200)}`;
		tasks.push(task({ id: 15, status: "done", doneAt: T0 + 30 * MIN, summary: long }));
		tasks.push(task({ id: 16, status: "done", doneAt: T0 + 20 * MIN }));
		const out = doneRecentOf(tasks);
		expect(out).toHaveLength(LIVE_DONE_RECENT_MAX);
		expect(out.map((d) => d.id)).toEqual([15, 16, 12, 11, 10, 9, 8, 7, 6, 5]);
		expect(out[0].title).toBe("Task 15");
		expect(out[0].at).toBe(T0 + 30 * MIN);
		expect(Array.from(out[0].summary)).toHaveLength(LIVE_SUMMARY_MAX);
		expect(out[0].summary.endsWith("😀…")).toBe(true);
		expect(out[1].summary).toBe("");
		expect(out[2].summary).toBe("Did 12");
		expect(clipText("short")).toBe("short");
		expect(clipText("x".repeat(LIVE_SUMMARY_MAX))).toHaveLength(LIVE_SUMMARY_MAX);
		expect(doneRecentOf([])).toEqual([]);
	});
});

// ---- through the Roles overview's reader -----------------------------------------------------------------------
describe("the Roles overview fills the live fields from the queue records", () => {
	it("counts only the questions that reached the owner, names the lead holding the rest, and never hides a dialog", async () => {
		const t11 = transcript("task11", [tldr("Started", T0 + 2 * MIN), tldr("Half way", T0 + 5 * MIN)]);
		const ask = (o: Record<string, unknown>) => ({ n: 1, at: T0 + 2 * MIN, ...o });
		const home = transcript("arch-home", [
			...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].flatMap((id) => started(id)),
			...started(11, t11),
			queue({ op: "run" }, T0 + MIN),
			// 1: a direct path (a block no lead answered): no route
			queue({ op: "stuck", id: 1, question: "Q1?" }, T0 + 3 * MIN),
			// 2: a lead passed it on; 3: it went on without an answer
			queue(
				{ op: "stuck", id: 2, question: "Q2?", ask: ask({ passed: true, to: "ops", lead: "design" }) },
				T0 + 3 * MIN,
			),
			queue(
				{ op: "stuck", id: 3, question: "Q3?", ask: ask({ why: "timeout", to: "ops", lead: "design" }) },
				T0 + 3 * MIN,
			),
			// 4: the record names the lead still holding it
			queue({ op: "stuck", id: 4, question: "Q4?", ask: ask({ to: "ops", lead: "design", step: 0 }) }, T0 + 3 * MIN),
			// 5: its route's chain ended at the owner
			queue(
				{ op: "stuck", id: 5, question: "Q5?", ask: ask({ to: "ops", chain: ["design", "coo"], step: 3 }) },
				T0 + 3 * MIN,
			),
			// 6: with coo, then an escalate's delivery passed it on: the newest record decides
			queue(
				{
					op: "stuck",
					id: 6,
					question: "Q6?",
					ask: ask({ to: "ops", lead: "coo", step: 2, chain: ["design", "coo"] }),
				},
				T0 + 3 * MIN,
			),
			queue({ op: "stuck", id: 6, question: "Q6?", ask: ask({ passed: true }) }, T0 + 4 * MIN),
			// 7: stuck, then the owner paused it; 8: names a role without a home chat
			queue({ op: "stuck", id: 7, question: "Q7?" }, T0 + 3 * MIN),
			queue({ op: "hold", id: 7, why: "owner: pause it", by: "panel" }, T0 + 4 * MIN),
			queue({ op: "stuck", id: 8, question: "Q8?", ask: ask({ to: "ops", lead: "solo" }) }, T0 + 3 * MIN),
			// 9: asking temper's lead; 10: asking its main chat
			queue({ op: "ask", id: 9, n: 1, question: "Q9?", to: "ops", lead: "temper", step: 0 }, T0 + 3 * MIN),
			queue({ op: "ask", id: 10, n: 1, question: "Q10?" }, T0 + 3 * MIN),
		]);
		const roles = [
			role("arch", home),
			role("design", transcript("design-home")),
			role("coo", transcript("coo-home")),
			role("temper", transcript("temper-home")),
			role("solo"),
		];
		// an open dialog in the home chat: stays the owner's, as now
		const dialog = {
			kind: "question",
			title: "Approve?",
			fields: [],
			id: "q1",
			sessionFile: home,
			createdAt: T0 + 6 * MIN,
		} as unknown as Ask;
		const before = readFileSync(home, "utf8");
		const o = await read(roles, [dialog]);
		const r = byId(o, "arch");
		expect(r.asks.map((a) => a.focus).sort()).toEqual([
			"question:q1",
			"task:1",
			"task:2",
			"task:3",
			"task:5",
			"task:6",
			"task:8",
		]);
		const rows = new Map(r.queue?.active.map((t) => [t.id, t]));
		expect([...rows.keys()].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
		const leads = Object.fromEntries([...rows].filter(([, t]) => t.withLead).map(([id, t]) => [id, t.withLead]));
		expect(leads).toEqual({ 4: "design", 9: "temper", 10: "arch" });
		// the lead holding it answers it next, not the owner
		expect(rows.get(4)?.next).toEqual({ kind: "answer", who: "design" });
		// progress: the task chat's newest line with its time; none without a line
		expect(rows.get(11)?.progress).toEqual({ text: "Half way", at: T0 + 5 * MIN });
		expect(rows.get(11)?.latest?.text).toBe("Half way");
		for (const id of [1, 2, 4, 7, 9]) expect(rows.get(id)).not.toHaveProperty("progress");
		// read only
		expect(readFileSync(home, "utf8")).toBe(before);
	});

	it("doneRecent from the home queue's replay; absent when the queue wasn't read", async () => {
		const lines: Line[] = [];
		for (let id = 1; id <= 12; id++) {
			lines.push(
				...started(id),
				queue({ op: "done", id, summary: id === 12 ? "z".repeat(2000) : `Shipped ${id}` }, T0 + (10 + id) * MIN),
			);
		}
		lines.push(...started(13), queue({ op: "done", id: 13 }, T0 + 30 * MIN));
		const o = await read([
			role("docs", transcript("docs-home", lines)),
			role("empty", transcript("empty-home")),
			role("solo"),
		]);
		const d = byId(o, "docs").doneRecent ?? [];
		expect(d.map((x) => x.id)).toEqual([13, 12, 11, 10, 9, 8, 7, 6, 5, 4]);
		expect(d[0]).toEqual({ id: 13, title: "Task 13", summary: "", at: T0 + 30 * MIN });
		expect(d[1].summary).toHaveLength(LIVE_SUMMARY_MAX);
		expect(d[2]).toEqual({ id: 11, title: "Task 11", summary: "Shipped 11", at: T0 + 21 * MIN });
		// a home chat with nothing done: known, none; no home chat: not known
		expect(byId(o, "empty").doneRecent).toEqual([]);
		expect(byId(o, "solo")).not.toHaveProperty("doneRecent");
	});
});

// ---- the Initiatives page's join --------------------------------------------------------------------------------
describe("the Initiatives page's tasks get progress, withLead and doneSummary from the overview", () => {
	it("joins each task with its own queue's facts, and leaves out what isn't known", async () => {
		const t1 = transcript("ops-task1", [tldr("Building", T0 + 4 * MIN)]);
		const home = transcript("ops-home", [
			...started(1, t1),
			...started(2),
			...started(3),
			...started(4),
			queue({ op: "run" }, T0 + MIN),
			queue({ op: "ask", id: 2, n: 1, question: "Which port?", to: "ops", lead: "design", step: 0 }, T0 + 3 * MIN),
			queue({ op: "done", id: 3, summary: "Shipped the feed" }, T0 + 5 * MIN),
			queue({ op: "done", id: 4 }, T0 + 6 * MIN),
		]);
		const o = await read([role("ops", home), role("design", transcript("design-home"))]);
		const L = (seq: number, e: Record<string, unknown>) => JSON.stringify({ v: 1, seq, ts: seq, by: "ops", ...e });
		const link = (seq: number, task: number, added: number) =>
			L(seq, {
				op: "task.link",
				queue: home,
				queueName: "ops",
				task,
				added,
				title: `Task ${task}`,
				parent: { standalone: true },
			});
		const log = `${[link(1, 1, T0 + MIN), link(2, 2, T0 + MIN), link(3, 3, T0 + MIN), link(4, 4, T0 + MIN)].join("\n")}\n`;
		const page = workPageFrom(log, workFactsFromOverview(o));
		const byTask = new Map(page.tasks.map((t) => [t.task, t]));
		expect(byTask.get(1)?.progress).toEqual({ text: "Building", at: T0 + 4 * MIN });
		expect(byTask.get(1)).not.toHaveProperty("withLead");
		expect(byTask.get(2)?.withLead).toBe("design");
		expect(byTask.get(2)).not.toHaveProperty("progress");
		expect(byTask.get(3)?.doneSummary).toBe("Shipped the feed");
		expect(byTask.get(4)).not.toHaveProperty("doneSummary");
		for (const t of [byTask.get(3), byTask.get(4)]) {
			expect(t).not.toHaveProperty("progress");
			expect(t).not.toHaveProperty("withLead");
		}
		expect(byTask.get(1)).not.toHaveProperty("doneSummary");
		// the same number added at another time (another branch of the chat) doesn't take its summary
		const other = workPageFrom(`${link(5, 3, T0 + 9 * MIN)}\n`, workFactsFromOverview(o));
		expect(other.tasks[0]).not.toHaveProperty("doneSummary");
		// an overview made elsewhere (no records read with it) adds no done facts
		const copy: UiRolesOverview = JSON.parse(JSON.stringify(o));
		const copied = workPageFrom(log, workFactsFromOverview(copy));
		expect(copied.tasks.find((t) => t.task === 3)).not.toHaveProperty("doneSummary");
	});
});
