/**
 * queue-panel：右栏「队列」tab 的渲染（web/src/components/TaskQueuePanel.tsx）。
 * renderToStaticMarkup 在 node 里渲染；断言看结构和 class，文案只查英文里不会变的编号。
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import {
	TASK_QUEUE_DONE_SHOWN,
	TASK_QUEUE_PLAN_PARTS,
	TaskQueuePanel,
	taskQueueSections,
	taskQueueStatusKey,
} from "../../web/src/components/TaskQueuePanel.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import type { UiTaskQueue, UiTaskQueueTask } from "../../server/protocol.js";

const noop = () => {};
const render = (queue: UiTaskQueue | undefined, opts: { onCommand?: () => void; defaultOpen?: number[] } = {}) =>
	renderToStaticMarkup(createElement(LanguageProvider, null, createElement(TaskQueuePanel, { queue, ...opts })));

const task = (
	id: number,
	status: UiTaskQueueTask["status"],
	extra: Partial<UiTaskQueueTask> = {},
): UiTaskQueueTask => ({
	id,
	status,
	plan: {
		title: `Task ${id}`,
		goal: `goal ${id}`,
		doneWhen: `done-when ${id}`,
		decided: `decided ${id}`,
		steps: `steps ${id}`,
		verify: `verify ${id}`,
		mustNot: `must-not ${id}`,
	},
	addedAt: Date.parse("2026-09-25T10:00:00Z") + id,
	...extra,
});
const q = (tasks: UiTaskQueueTask[], extra: Partial<UiTaskQueue> = {}): UiTaskQueue => ({
	running: false,
	available: true,
	tasks,
	...extra,
});
const taskIds = (html: string, cls: string) =>
	[...html.matchAll(new RegExp(`<li class="task-queue-task ${cls}[^"]*" data-task-id="(\\d+)"`, "g"))].map((m) =>
		Number(m[1]),
	);

describe("TaskQueuePanel", () => {
	it("shows the empty state, and says when pi-queue isn't loaded", () => {
		expect(render(undefined)).toContain('class="task-queue-empty"');
		expect(render(q([]))).not.toContain("task-queue-note");
		expect(render(q([], { available: false }))).toContain('class="task-queue-note"');
	});

	it("splits the queue into now, up next (in order) and done (newest first)", () => {
		const html = render(
			q([
				task(1, "done", { doneAt: 100 }),
				task(2, "done", { doneAt: 300 }),
				task(3, "working", { startedAt: 400 }),
				task(5, "ready"),
				task(4, "ready"),
			]),
			{ onCommand: noop },
		);
		expect(taskIds(html, "current")).toEqual([3]);
		expect(taskIds(html, "ready")).toEqual([5, 4]);
		expect(taskIds(html, "done")).toEqual([2, 1]);
	});

	it("highlights a stuck task with its question", () => {
		const html = render(q([task(1, "stuck", { question: "Which port should it use?" })], { running: true }), {
			onCommand: noop,
		});
		expect(html).toContain('class="task-queue-task current needs-you"');
		expect(html).toContain('class="task-queue-badge"');
		expect(html).toContain("Which port should it use?");
		expect(html).toContain('class="task-queue-status needs-you"');
	});

	it("gives waiting tasks up, down and remove, with the ends disabled", () => {
		const html = render(q([task(1, "ready"), task(2, "ready"), task(3, "ready")]), { onCommand: noop });
		// Whole <button> tags, so the order of the attributes doesn't matter.
		const disabled = (cls: string) =>
			[...html.matchAll(new RegExp(`<button[^>]*class="${cls}"[^>]*>`, "g"))].map((m) => m[0].includes('disabled=""'));
		const ups = disabled("task-queue-up");
		const downs = disabled("task-queue-down");
		expect(ups).toEqual([true, false, false]);
		expect(downs).toEqual([false, false, true]);
		expect(html.match(/class="task-queue-remove"/g)).toHaveLength(3);
	});

	it("has no buttons without pi-queue or without a sender", () => {
		const tasks = [task(1, "ready"), task(2, "ready")];
		for (const html of [render(q(tasks, { available: false }), { onCommand: noop }), render(q(tasks))]) {
			expect(html).not.toContain("task-queue-toggle");
			expect(html).not.toContain("task-queue-controls");
		}
		expect(render(q(tasks, { available: false }), { onCommand: noop })).toContain("task-queue-note");
	});

	it("offers Start when something can run and Stop while running", () => {
		const start = render(q([task(1, "ready")]), { onCommand: noop });
		expect(start).toMatch(/class="task-queue-toggle start"(?![^>]*disabled)/);
		const nothing = render(q([task(1, "done", { doneAt: 5 })]), { onCommand: noop });
		expect(nothing).toMatch(/class="task-queue-toggle start"[^>]*disabled=""/);
		const stop = render(q([task(1, "working")], { running: true }), { onCommand: noop });
		expect(stop).toContain('class="task-queue-toggle stop"');
		expect(stop).toContain('data-running="true"');
	});

	it("shows the whole plan of an opened task, parts in pi-queue's order", () => {
		const html = render(q([task(1, "ready", { plan: { ...task(1, "ready").plan, decided: "" } })]), {
			defaultOpen: [1],
		});
		expect(html).toContain('class="task-queue-plan"');
		const parts = [...html.matchAll(/<dd>[\s\S]*?(goal|done-when|decided|steps|verify|must-not) 1/g)].map((m) => m[1]);
		expect(parts).toEqual(["goal", "done-when", "steps", "verify", "must-not"]);
		expect(render(q([task(1, "ready")]))).not.toContain("task-queue-plan");
		expect(TASK_QUEUE_PLAN_PARTS.map(([k]) => k)).toEqual([
			"goal",
			"doneWhen",
			"decided",
			"steps",
			"verify",
			"mustNot",
		]);
	});

	it("shows the latest few done tasks until expanded", () => {
		const done = Array.from({ length: TASK_QUEUE_DONE_SHOWN + 2 }, (_, i) => task(i + 1, "done", { doneAt: i + 1 }));
		const html = render(q(done));
		expect(taskIds(html, "done")).toHaveLength(TASK_QUEUE_DONE_SHOWN);
		expect(taskIds(html, "done")[0]).toBe(TASK_QUEUE_DONE_SHOWN + 2);
		expect(html).toContain('class="task-queue-more"');
	});
});

describe("taskQueueStatusKey", () => {
	const key = (queue: UiTaskQueue) => taskQueueStatusKey(queue, taskQueueSections(queue));
	it("says what the queue is doing", () => {
		expect(key(q([task(1, "stuck")], { running: true }))).toBe("taskQueueStatusStuck");
		expect(key(q([task(1, "stuck")]))).toBe("taskQueueStatusStuck");
		expect(key(q([task(1, "working")], { running: true }))).toBe("taskQueueStatusWorking");
		expect(key(q([task(1, "ready")], { running: true }))).toBe("taskQueueStatusRunning");
		expect(key(q([task(1, "ready")]))).toBe("taskQueueStatusIdle");
		expect(key(q([task(1, "ready")], { pausedReason: "user" }))).toBe("taskQueueStatusStopped");
		expect(key(q([task(1, "working")], { pausedReason: "stopped" }))).toBe("taskQueueStatusRunStopped");
		expect(key(q([task(1, "working")], { pausedReason: "error" }))).toBe("taskQueueStatusError");
		expect(key(q([task(1, "ready")], { pausedReason: "restart" }))).toBe("taskQueueStatusRestart");
		expect(key(q([task(1, "done", { doneAt: 1 })], { pausedReason: "finished" }))).toBe("taskQueueStatusFinished");
		// New tasks after it finished: not "all done".
		expect(key(q([task(1, "done", { doneAt: 1 }), task(2, "ready")], { pausedReason: "finished" }))).toBe(
			"taskQueueStatusIdle",
		);
	});
});
