import { describe, expect, it } from "vitest";
import type { UiTaskQueueTask } from "../../server/protocol.js";
import { roleTaskNext } from "../../server/roles-task-next.js";
import { projectRolePanel } from "../../web/src/roles-panel-model.js";

const NOW = Date.parse("2026-10-18T05:00:00Z");
const plan = {
	title: "Work",
	goal: "g",
	doneWhen: "d",
	decided: "d",
	steps: "PROSE IS NOT A NEXT ACTION",
	verify: "v",
	mustNot: "m",
};
const task = (extra: Partial<UiTaskQueueTask> = {}): UiTaskQueueTask => ({
	id: 1,
	status: "ready",
	plan,
	addedAt: NOW - 5000,
	...extra,
});
const panelTask = (extra: Record<string, unknown>) => {
	const t = task();
	const row = { id: t.id, title: t.plan.title, status: t.status, ...roleTaskNext(t, "ops"), ...extra };
	return projectRolePanel(
		{
			overview: {
				roles: [
					{ id: "ops", title: "Ops", queue: { active: [row], queued: [], counts: { active: 1, queued: 0, done: 0 } } },
					{ id: "security", title: "Security" },
				],
			},
		},
		"ops",
	)?.unrecorded[0];
};

describe("Roles next action uses the native queue, not plans", () => {
	it("reads unresolved same-queue and outside dependencies without promising a start", () => {
		const t = task({
			waitingFor: [2, 3],
			outside: [
				{ file: "/private/never-display", name: "security", id: 4 },
				{ file: "/private/never-display", name: "security", id: 5, over: { at: NOW } },
			],
		});
		const before = JSON.stringify(t);
		expect(roleTaskNext(t, "ops")).toEqual({
			next: { kind: "queue", after: ["#2", "#3", "security #4"] },
			queueEvent: { kind: "added", at: NOW - 5000 },
		});
		expect(JSON.stringify(t)).toBe(before);
		expect(JSON.stringify(roleTaskNext(t, "ops"))).not.toMatch(/private|PROSE/);
	});
	it("does not expose the check command", () => {
		expect(
			roleTaskNext(
				task({
					status: "waiting",
					wait: { what: "deployment", check: "SECRET_COMMAND", everyMs: 30000, since: NOW, until: NOW + 60000 },
				}),
				"ops",
			),
		).toEqual({
			next: { kind: "check", what: "deployment", everyMs: 30000, until: NOW + 60000 },
			queueEvent: { kind: "waiting", at: NOW },
		});
	});
	it("uses the recorded lead, result owed, checkpoint and task references", () => {
		expect(
			roleTaskNext(
				task({
					status: "blocked",
					block: {
						since: NOW,
						start: NOW,
						tries: 0,
						lead: "security",
						owes: "review",
						need: "fallback",
						checkpoint: NOW + 60000,
						on: [{ file: "/private/x", name: "", id: 7 }],
					},
				}),
				"ops",
			),
		).toEqual({
			next: { kind: "blocked", who: "security", what: "review", until: NOW + 60000, after: ["#7"] },
			queueEvent: { kind: "blocked", at: NOW },
		});
	});
	it.each([
		[{ status: "asking" }, "ops"],
		[{ status: "asking", askOps: true }, "ops"],
		[{ status: "asking", askOps: true, askLead: "security" }, "security"],
		[{ status: "stuck" }, "owner"],
	] as const)("keeps the recorded answer destination (%j)", (extra, who) => {
		expect(roleTaskNext(task(extra), "ops")).toEqual({ next: { kind: "answer", who }, queueEvent: { kind: "answer" } });
	});
	it("never turns the owner pause into a suggested worker action", () => {
		expect(roleTaskNext(task({ status: "blocked" }), "ops", { at: NOW, why: "owner pause" })).toEqual({
			next: { kind: "resume", who: "owner" },
			queueEvent: { kind: "paused", at: NOW },
		});
	});
	it("keeps an unrecorded working step unknown and labels the older start as a start", () => {
		expect(roleTaskNext(task({ status: "working", startedAt: NOW }), "ops")).toEqual({
			next: { kind: "unrecorded" },
			queueEvent: { kind: "started", at: NOW },
		});
	});
	it.each(["done", "dropped"] as const)("does not suggest restarting an ended task (%s)", (status) => {
		expect(roleTaskNext(task({ status }), "ops", { at: NOW, why: "old pause" })?.next).toEqual({ kind: "none" });
	});
	it("does not invent timestamps or wait conditions for old records", () => {
		expect(roleTaskNext(task({ status: "waiting" }), "ops")).toEqual({
			next: { kind: "check" },
			queueEvent: { kind: "waiting" },
		});
	});
});

describe("Roles next-action closed presentation", () => {
	it("uses roster labels and records, not paths or inferred requesters", () => {
		const next = { kind: "blocked", who: "security", what: "review", after: ["#7"], until: NOW };
		expect(panelTask({ status: "blocked", next, queueEvent: { kind: "blocked", at: NOW } })).toMatchObject({
			next: { ...next, who: { kind: "role", id: "security", label: "Security" }, everyMs: null },
			queueEvent: { kind: "blocked", at: NOW },
		});
	});
	it.each([
		{ next: undefined },
		{ next: { kind: "invented" } },
		{ next: { kind: "check" } },
		{ next: { kind: "queue", who: "security\n" } },
		{ next: { kind: "queue", what: "x\u202e" } },
		{ next: { kind: "queue", what: "x".repeat(301) } },
		{ next: { kind: "queue", after: ["x\u0000"] } },
		{ next: { kind: "queue", after: Array(41).fill("#7") } },
		{ next: { kind: "queue", until: 1e20 } },
		{ next: { kind: "queue", everyMs: 0 } },
		{ paused: { at: NOW, why: "owner" }, next: { kind: "queue" } },
		{ paused: "broken", next: { kind: "queue" } },
		{ status: "asking", askOps: true, askLead: "security", next: { kind: "answer", who: "owner" } },
	])("refuses missing, mismatched or unsafe next actions (%j)", (extra) => {
		expect(panelTask(extra)?.next).toBeUndefined();
		expect(panelTask(extra)?.queueEvent).toBeUndefined();
	});
	it.each([
		{ kind: "done", at: NOW },
		{ kind: "added", at: -1 },
		{ kind: "added", at: 1e20 },
	])("does not invent an event time or accept an event from another state (%j)", (queueEvent) => {
		expect(panelTask({ queueEvent })?.queueEvent).toBeUndefined();
	});
});
