import { userInfo } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	consumeOwnerSetting,
	hasQueueEntries,
	issueOwnerSetting,
	ownerQueueMatches,
	parseOwnerSetting,
} from "../../server/queue-owner.js";
import { taskQueueCommandLine, taskQueueFromEntries } from "../../server/task-queue.js";
import { TaskQueuePanel } from "../../web/src/components/TaskQueuePanel.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

afterEach(() => vi.useRealTimers());
describe("owner-panel authorization", () => {
	it("does not treat an empty opted-in queue as a reusable blank chat", () => {
		expect(hasQueueEntries([])).toBe(false);
		expect(hasQueueEntries([{ type: "custom", customType: "other" }])).toBe(false);
		expect(hasQueueEntries([{ type: "custom", customType: "queue" }])).toBe(true);
	});
	it("accepts only a known setting and an actual boolean", () => {
		expect(parseOwnerSetting("autoApprove", true)).toEqual({ setting: "autoApprove", value: true });
		expect(parseOwnerSetting("autoStart", false)).toEqual({ setting: "autoStart", value: false });
		for (const value of [undefined, "true", "false", 0, 1, null, {}])
			expect(parseOwnerSetting("autoApprove", value)).toBeUndefined();
		expect(parseOwnerSetting("other", true)).toBeUndefined();
		// The public slash-command builder (also used by model-facing commands) has no enabling action.
		expect(taskQueueCommandLine("autoApprove", 1)).toBeNull();
		expect(taskQueueCommandLine("autoStart", 1)).toBeNull();
	});
	it("requires both current conversation and session fences", () => {
		expect(ownerQueueMatches("c1", "s1", "c1", "s1")).toBe(true);
		for (const [conv, queue] of [
			[undefined, "s1"],
			["c1", undefined],
			["c2", "s1"],
			["c1", "s2"],
			["", ""],
		]) {
			expect(ownerQueueMatches(conv, queue, "c1", "s1")).toBe(false);
		}
	});
	it("consumes an unguessable ticket just once and only while the owner target remains current", () => {
		const change = { setting: "autoStart" as const, value: true };
		const ticket = issueOwnerSetting("s1", change, () => true);
		expect(ticket.token).toMatch(/^[a-f0-9]{64}$/);
		expect(consumeOwnerSetting("made-up", "s1")).toBeUndefined();
		expect(consumeOwnerSetting(ticket.token, "s1")).toEqual(change);
		expect(consumeOwnerSetting(ticket.token, "s1")).toBeUndefined();
		const wrong = issueOwnerSetting("s1", change, () => true);
		expect(consumeOwnerSetting(wrong.token, "s2")).toBeUndefined();
		expect(consumeOwnerSetting(wrong.token, "s1")).toBeUndefined();
		const switched = issueOwnerSetting("s1", change, () => false);
		expect(consumeOwnerSetting(switched.token, "s1")).toBeUndefined();
		const disposed = issueOwnerSetting("s1", change, () => true);
		disposed.dispose();
		expect(consumeOwnerSetting(disposed.token, "s1")).toBeUndefined();
		vi.useFakeTimers();
		const expired = issueOwnerSetting("s1", change, () => true);
		vi.advanceTimersByTime(5001);
		expect(consumeOwnerSetting(expired.token, "s1")).toBeUndefined();
	});
});

const plan = {
	title: "Fixture",
	goal: "A complete goal",
	doneWhen: "A complete finish",
	decided: "All choices settled",
	steps: "Do the fixture steps",
	verify: "Check the fixture result",
	mustNot: "No real task changes",
};
const entry = (op: Record<string, unknown>) => ({
	type: "custom",
	customType: "queue",
	data: { v: 1, ts: 100, ...op },
});

describe("queue autonomy replay parity and panel", () => {
	it("matches extension replay at every prefix, with missing/malformed flags, Stop, forks and assigned chats", async () => {
		const pkg = process.env.PI_QUEUE_PKG ?? join(userInfo().homedir, "projects", "pi-queue");
		const pq = await import(/* @vite-ignore */ pathToFileURL(join(pkg, "queue.ts")).href);
		const ops = [
			{ op: "add", id: 1, plan },
			{ op: "autonomy", queueId: "s1", setting: "autoApprove", value: true },
			{ op: "autonomy", queueId: "s1", setting: "autoStart", value: true },
			{ op: "run", queueId: "s1" },
			{ op: "update", id: 1, plan, approval: "auto" },
			{ op: "pause", reason: "user" },
			{ op: "autonomy", queueId: "s1", setting: "autoStart", value: true },
			{ op: "autonomy", queueId: "s1", setting: "autoApprove", value: "true" },
			{ op: "autonomy", queueId: "s1", setting: "autoStart", value: 1 },
			{ op: "autonomy", queueId: "s1", setting: "unknown", value: true },
			{ op: "autonomy", queueId: "s2", setting: "autoApprove", value: true },
			{ op: "update", id: 1, plan, approval: "dialog" },
			{ op: "assigned", id: 2, plan, from: { file: "/fixture/parent.jsonl" } },
			{ op: "autonomy", queueId: "s1", setting: "autoApprove", value: true },
		];
		for (const sid of ["s1", "fresh-fork", undefined])
			for (let i = 0; i <= ops.length; i++) {
				const es = ops.slice(0, i).map(entry);
				const ui = taskQueueFromEntries(es, true, undefined, undefined, sid);
				const actual = pq.replay(es, sid);
				expect(ui.autoApprove).toBe(actual.autoApprove);
				expect(ui.autoStart).toBe(actual.autoStart);
				expect(ui.running).toBe(actual.running);
				expect(ui.pausedReason).toBe(actual.pausedReason);
				expect(ui.tasks.map((t) => t.approval)).toEqual(actual.tasks.map((t: { approval?: string }) => t.approval));
				if (sid !== "s1") expect([ui.autoApprove, ui.autoStart]).toEqual([false, false]);
			}
	});
	it("shows two accessible default-off switches on an empty queue; read-only and task chats cannot change them", () => {
		const queue = taskQueueFromEntries([], true, undefined, undefined, "s1");
		const html = renderToStaticMarkup(
			createElement(LanguageProvider, null, createElement(TaskQueuePanel, { queue, onCommand: () => {} })),
		);
		expect(html.match(/role="switch"/g)).toHaveLength(2);
		expect(html.match(/aria-checked="false"/g)).toHaveLength(2);
		expect(html).toContain('aria-label="Auto approve"');
		expect(html).toContain('aria-label="Auto start"');
		expect(html).toContain('role="group" aria-label="This queue only"');
		expect(html).toContain(">Auto approve</span>");
		expect(html).toContain(">Auto start</span>");
		expect(html).not.toContain(">This queue only<");
		expect(html).not.toContain("task-queue-setting-hint");
		expect(html).not.toContain("Accept complete plans");
		expect(html).not.toContain("Start eligible work");
		expect(html).toContain("The queue is empty.");
		expect(html).not.toContain("Plan a complete task");
		expect(html).not.toContain("aria-describedby");
		const readOnly = renderToStaticMarkup(
			createElement(LanguageProvider, null, createElement(TaskQueuePanel, { queue })),
		);
		expect(readOnly.match(/disabled=""/g)).toHaveLength(2);
		const own = taskQueueFromEntries(
			[entry({ op: "assigned", id: 1, plan, from: { file: "/fixture/parent.jsonl" } })],
			true,
			undefined,
			undefined,
			"s2",
		);
		const task = renderToStaticMarkup(
			createElement(LanguageProvider, null, createElement(TaskQueuePanel, { queue: own, onCommand: () => {} })),
		);
		expect(task).not.toContain('role="switch"');
	});
});
