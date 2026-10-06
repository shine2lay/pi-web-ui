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
const render = (
	queue: UiTaskQueue | undefined,
	opts: {
		onCommand?: () => void;
		onAnswer?: (taskId: number, text: string) => void;
		onOpenChat?: (file: string) => void;
		defaultOpen?: number[];
	} = {},
) => renderToStaticMarkup(createElement(LanguageProvider, null, createElement(TaskQueuePanel, { queue, ...opts })));

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

	// telegram-answers: a stuck task can be answered from the tab: its choices, or typed words.
	it("offers a stuck task's choices and a typed answer when it can be answered here", () => {
		const stuck = q([task(1, "stuck", { question: "Which port?", choices: ["8080", "9090"] })]);
		const html = render(stuck, { onAnswer: noop });
		expect(html).toContain('class="task-queue-answer"');
		expect([...html.matchAll(/class="task-queue-choice"[^>]*>([^<]+)</g)].map((m) => m[1])).toEqual(["8080", "9090"]);
		expect(html).toContain('class="task-queue-answer-input"');
		expect(html).toContain("into this chat");
		// A lane task's answer goes into its own chat.
		const lane = render(q([task(2, "stuck", { lane: true, question: "Q?", chat: { file: "/t.jsonl" } })]), {
			onAnswer: noop,
		});
		expect(lane).toContain("task&#x27;s own chat");
		expect(lane).not.toContain("task-queue-choice");
		// No way to answer (or no pi-queue): the old hint only.
		expect(render(stuck)).not.toContain("task-queue-answer");
		expect(render(q(stuck.tasks, { available: false }), { onAnswer: noop })).not.toContain("task-queue-answer");
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

	it("shows tasks on hold in their own section, with what they wait on and the check", () => {
		const wait = {
			what: "temper restart",
			check: "test -f /tmp/flag && echo <ok>",
			everyMs: 120_000,
			since: Date.parse("2026-09-26T10:00:00Z"),
			until: Date.parse("2026-09-27T10:00:00Z"),
		};
		const html = render(
			q([task(1, "waiting", { startedAt: 50, wait }), task(2, "working", { startedAt: 60 }), task(3, "ready")], {
				running: true,
			}),
			{ onCommand: noop },
		);
		expect(taskIds(html, "current")).toEqual([2]);
		expect(taskIds(html, "waiting")).toEqual([1]);
		expect(taskIds(html, "ready")).toEqual([3]);
		expect(html).toContain('class="task-queue-wait"');
		expect(html).toContain("temper restart");
		// The check command is shown as code, escaped.
		expect(html).toContain('<code class="task-queue-check">test -f /tmp/flag &amp;&amp; echo &lt;ok&gt;</code>');
		// No reorder or remove buttons on a task on hold (/queue remove still works from the chat).
		const waitingRow = html.slice(html.indexOf('data-task-id="1"'), html.indexOf('data-task-id="3"'));
		expect(waitingRow).not.toContain("task-queue-controls");
	});

	it("says when a wait ended, and marks a wait that gave up", () => {
		const wait = { what: "CI", check: "true", everyMs: 1, since: 1, until: 2 };
		const over = render(q([task(1, "waiting", { wait: { ...wait, overAt: Date.parse("2026-09-26T11:00:00Z") } })]));
		expect(over).toContain('class="task-queue-wait over"');
		expect(over).not.toContain("wait-failed");
		const failed = render(q([task(1, "waiting", { wait: { ...wait, overAt: 3, failed: "Gave up after 1 day" } })]));
		expect(failed).toContain('class="task-queue-task waiting wait-failed"');
		expect(failed).toContain('class="task-queue-wait failed"');
		expect(failed).toContain("Gave up after 1 day");
	});

	it("offers Start when only a task on hold is left", () => {
		const wait = { what: "CI", check: "true", everyMs: 1, since: 1, until: 2 };
		const html = render(q([task(1, "waiting", { wait })], { pausedReason: "user" }), { onCommand: noop });
		expect(html).toMatch(/class="task-queue-toggle start"(?![^>]*disabled)/);
	});

	it("shows the latest few done tasks until expanded", () => {
		const done = Array.from({ length: TASK_QUEUE_DONE_SHOWN + 2 }, (_, i) => task(i + 1, "done", { doneAt: i + 1 }));
		const html = render(q(done));
		expect(taskIds(html, "done")).toHaveLength(TASK_QUEUE_DONE_SHOWN);
		expect(taskIds(html, "done")[0]).toBe(TASK_QUEUE_DONE_SHOWN + 2);
		expect(html).toContain('class="task-queue-more"');
	});
});

describe("TaskQueuePanel (lanes)", () => {
	const laneQueue = () =>
		q(
			[
				task(1, "working", {
					lane: true,
					touches: ["pi-web-ui repo"],
					startedAt: 10,
					chat: { file: "/s/one.jsonl", title: "Queue #1: Task 1" },
				}),
				task(2, "stuck", { lane: true, touches: ["temper"], question: "Which port?", startedAt: 20 }),
				task(3, "ready", { touches: ["pi-web-ui repo"] }),
				task(4, "ready", { touches: [] }),
			],
			{
				running: true,
				lanes: [
					{ n: 1, touches: ["pi-web-ui repo"], alone: false, taskIds: [1, 3] },
					{ n: 2, touches: ["temper"], alone: false, taskIds: [2] },
					{ n: 3, touches: [], alone: true, taskIds: [4] },
				],
			},
		);

	it("lists tasks running in chats of their own, with their lane, touches and a link to the chat", () => {
		const html = render(laneQueue(), { onCommand: noop, onOpenChat: noop });
		expect(taskIds(html, "lane")).toEqual([1, 2]);
		expect(taskIds(html, "current")).toEqual([]);
		expect(taskIds(html, "ready")).toEqual([3, 4]);
		expect(html).toContain('class="task-queue-lane" data-lane="1"');
		expect(html).toContain('class="task-queue-lane" data-lane="2"');
		expect(html).toContain("pi-web-ui repo");
		// Task 1's chat is known: a link; task 2's isn't yet: none.
		expect(html.match(/class="task-queue-open-chat"/g)).toHaveLength(1);
		expect(html).toContain('title="Queue #1: Task 1"');
		// The stuck lane task shows its question, and it's answered in its own chat.
		expect(html).toContain('class="task-queue-task lane needs-you"');
		expect(html).toContain("Which port?");
	});

	it("shows no chat links without a way to open them", () => {
		expect(render(laneQueue(), { onCommand: noop })).not.toContain("task-queue-open-chat");
	});

	// queue-main-chat: the task asked its main chat: one plain line and its chat's link; nothing for the user.
	it("shows a task asking its main chat plainly, with its chat's link and no answer buttons", () => {
		const asking = task(1, "asking", {
			lane: true,
			touches: ["pi-web-ui repo"],
			question: "Which port?",
			choices: ["8080", "9090"],
			startedAt: 10,
			chat: { file: "/s/one.jsonl", title: "Queue #1: Task 1" },
		});
		const queue = q([asking, task(3, "ready")], {
			running: true,
			lanes: [{ n: 1, touches: ["pi-web-ui repo"], alone: false, taskIds: [1, 3] }],
		});
		const html = render(queue, { onCommand: noop, onOpenChat: noop, onAnswer: noop });
		expect(taskIds(html, "lane")).toEqual([1]);
		expect(html).toContain('class="task-queue-task lane asking"');
		expect(html).toContain('class="task-queue-asking"');
		expect(html).toContain("Asking the main chat");
		expect(html).toContain('title="Queue #1: Task 1"');
		expect(html).not.toContain("needs-you");
		expect(html).not.toContain("task-queue-badge");
		expect(html).not.toContain("task-queue-answer");
		expect(html).not.toContain("task-queue-choice");
		expect(taskQueueStatusKey(queue, taskQueueSections(queue))).toBe("taskQueueStatusLane");
		// In the task's own chat it is the current task, shown the same way.
		const own = render(
			q([task(5, "asking", { question: "Which port?", choices: ["8080", "9090"], startedAt: 1 })], {
				running: true,
				from: { file: "/s/queue.jsonl", title: "tooling" },
			}),
			{ onCommand: noop, onOpenChat: noop, onAnswer: noop },
		);
		expect(taskIds(own, "current")).toEqual([5]);
		expect(own).toContain("Asking the main chat");
		expect(own).not.toContain("needs-you");
		expect(own).not.toContain("task-queue-answer");
	});

	it("shows the lanes-at-once setting, with buttons only for the queue's own controls", () => {
		const html = render(laneQueue(), { onCommand: noop });
		expect(html).toContain('class="task-queue-lanes-at-once"');
		expect(html).toMatch(/class="task-queue-lanes-n">2</);
		expect(html).toContain('class="task-queue-lanes-fewer"');
		expect(html).toContain('class="task-queue-lanes-more"');
		const one = render({ ...laneQueue(), lanesAtOnce: 1 }, { onCommand: noop });
		expect(one).toMatch(/class="task-queue-lanes-fewer"[^>]*disabled/);
		expect(one).not.toMatch(/class="task-queue-lanes-more"[^>]*disabled/);
		const eight = render({ ...laneQueue(), lanesAtOnce: 8 }, { onCommand: noop });
		expect(eight).toMatch(/class="task-queue-lanes-more"[^>]*disabled/);
		// No controls: the number only.
		const ro = render(laneQueue());
		expect(ro).toContain('class="task-queue-lanes-at-once"');
		expect(ro).not.toContain("task-queue-lanes-more");
		// An old queue (nothing declared) doesn't show it.
		expect(render(q([task(1, "ready")]), { onCommand: noop })).not.toContain("task-queue-lanes-at-once");
	});

	it("in a task's own chat, says which queue it came from and links back to it", () => {
		const html = render(
			q([task(5, "working", { touches: ["a"], startedAt: 1 })], {
				running: true,
				from: { file: "/s/queue.jsonl", title: "tooling" },
			}),
			{ onCommand: noop, onOpenChat: noop },
		);
		expect(html).toContain('class="task-queue-from"');
		expect(html).toContain("tooling");
		expect(taskIds(html, "current")).toEqual([5]);
		expect(html).not.toContain("task-queue-lanes-at-once");
	});
});

/** queue-paused: the owner's Pause / Resume on a task and on the whole queue, and how a paused task looks. */
describe("TaskQueuePanel (paused by you)", () => {
	const at = Date.parse("2026-10-06T19:10:00Z");
	const hold = { at, why: "pressed Pause in the Queue panel" };
	const lane = (id: number, status: UiTaskQueueTask["status"], extra: Partial<UiTaskQueueTask> = {}) =>
		task(id, status, { lane: true, touches: ["a"], chat: { file: `/t${id}.jsonl` }, ...extra });
	const buttons = (html: string, cls: string) =>
		[...html.matchAll(new RegExp(`<button[^>]*class="${cls} (pause|resume)"[^>]*>([^<]*)<`, "g"))].map((m) => [
			m[1],
			m[2],
		]);

	it("gives every open task Pause, and a paused one Resume; never a done task or someone else's queue", () => {
		const queue = q(
			[
				lane(1, "working"),
				lane(2, "blocked", { hold, block: { need: "a login", since: 1, start: 1, tries: 0 } }),
				task(3, "ready"),
				task(4, "done", { doneAt: 1 }),
			],
			{ running: true },
		);
		const html = render(queue, { onCommand: noop });
		expect(buttons(html, "task-queue-pause")).toEqual([
			["pause", "Pause"],
			["resume", "Resume"],
			["pause", "Pause"],
		]);
		expect([...html.matchAll(/data-pause-task="(\d+)"/g)].map((m) => Number(m[1]))).toEqual([1, 2, 3]);
		// The header: Pause queue (the queue isn't paused).
		expect(buttons(html, "task-queue-pause-queue")).toEqual([["pause", "Pause queue"]]);
		// The paused task: its line says so, with since when and why; it's marked paused.
		expect(html).toMatch(/<li class="task-queue-task lane[^"]* paused[^"]*" data-task-id="2"/);
		expect(html).toContain('data-paused="task"');
		expect(html).toContain("Paused by you");
		expect(html).toContain("pressed Pause in the Queue panel");
		// Without the controls (no pi-queue, a task chat's view of its queue): no buttons, the line stays.
		const noButtons = /class="task-queue-pause(-queue)? (pause|resume)"/;
		expect(render(queue)).not.toMatch(noButtons);
		expect(render(queue)).toContain('data-paused="task"');
		expect(render(q(queue.tasks, { from: { file: "/main.jsonl", title: "main" } }), { onCommand: noop })).not.toMatch(
			noButtons,
		);
		expect(render(q(queue.tasks, { available: false }), { onCommand: noop })).not.toMatch(noButtons);
	});

	it("a task paused on its own inside a paused queue: Resume lifts its own pause, Resume queue the queue's", () => {
		// (The clicks themselves are checked in the browser: tests/queue-paused-test.mjs.)
		const html = render(q([task(1, "ready", { hold }), task(2, "ready")], { hold }), { onCommand: noop });
		expect(buttons(html, "task-queue-pause")).toEqual([
			["resume", "Resume"],
			["pause", "Pause"],
		]);
		expect(buttons(html, "task-queue-pause-queue")).toEqual([["resume", "Resume queue"]]);
		// Task 1's line names its own pause; task 2's says it's paused with the queue.
		expect(html).toMatch(/data-task-id="1"[^]*?data-paused="task"[^]*?data-task-id="2"[^]*?data-paused="queue"/);
	});

	it("a paused queue: a banner with since when and why, every open task marked paused with the queue", () => {
		const queue = q([lane(1, "working"), task(2, "ready"), task(3, "done", { doneAt: 1 })], { running: true, hold });
		const html = render(queue, { onCommand: noop });
		expect(html).toContain('class="task-queue-paused-banner"');
		expect(html).toContain('data-paused="true"');
		expect(buttons(html, "task-queue-pause-queue")).toEqual([["resume", "Resume queue"]]);
		// Each open task: paused with the whole queue (its own button still says Pause: its own pause is separate).
		expect([...html.matchAll(/data-paused="queue"/g)]).toHaveLength(2);
		expect(html).toContain("with the whole queue");
		expect(buttons(html, "task-queue-pause")).toEqual([
			["pause", "Pause"],
			["pause", "Pause"],
		]);
		expect(html).toContain('data-paused="banner"');
		expect(taskIds(html, "done")).toEqual([3]);
		expect(taskQueueStatusKey(queue, taskQueueSections(queue))).toBe("taskQueueStatusPausedByYou");
	});

	it("a paused stuck task doesn't need you: no needs-you, no answer box, its question still shown", () => {
		const stuck = lane(1, "stuck", { hold, question: "Which port?", choices: ["8080", "9090"] });
		const html = render(q([stuck], { running: true }), { onCommand: noop, onAnswer: noop });
		expect(html).not.toContain("needs-you");
		expect(html).not.toContain('class="task-queue-badge"');
		expect(html).not.toContain("task-queue-answer");
		expect(html).toContain("Which port?");
		expect(html).toContain("Resume it to answer.");
		const queue = q([stuck], { running: true });
		expect(taskQueueStatusKey(queue, taskQueueSections(queue))).not.toBe("taskQueueStatusStuck");
		// Resumed: it needs you again.
		const back = render(q([{ ...stuck, hold: undefined }], { running: true }), { onCommand: noop, onAnswer: noop });
		expect(back).toContain("needs-you");
	});

	it("a paused waiting task says its give-up clock is stopped; a blocked task waiting on a paused one says so", () => {
		const wait = { what: "CI", check: "true", everyMs: 60_000, since: at - 60_000, until: at + 3_600_000 };
		const html = render(q([task(1, "waiting", { hold, wait })], { running: true }), { onCommand: noop });
		expect(html).toContain("its give-up time moves later by as long as it stays paused");
		expect(render(q([task(1, "waiting", { wait })], { running: true }), { onCommand: noop })).not.toContain(
			"its give-up time moves later",
		);
		const ref = { file: "/main.jsonl", name: "this queue", id: 1, status: "stuck" as const, held: true };
		const blocked = lane(2, "blocked", { block: { on: [ref], since: 1, start: 1, tries: 0 } });
		const b = render(q([blocked], { running: true }), { onCommand: noop });
		expect(b).toContain("paused by you");
		expect(b).not.toContain("needs-you");
	});
});

describe("taskQueueStatusKey", () => {
	const key = (queue: UiTaskQueue) => taskQueueStatusKey(queue, taskQueueSections(queue));
	it("queue-lanes: counts tasks running in chats of their own", () => {
		const lane = (id: number, status: UiTaskQueueTask["status"]) => task(id, status, { lane: true, touches: ["a"] });
		// One task in a chat of its own is named ("#1 is working in its own chat"); more are counted.
		expect(key(q([lane(1, "working"), task(2, "ready")], { running: true }))).toBe("taskQueueStatusLane");
		expect(key(q([lane(1, "working"), lane(2, "working")], { running: true }))).toBe("taskQueueStatusLanes");
		expect(key(q([lane(1, "working"), lane(2, "stuck")], { running: true }))).toBe("taskQueueStatusStuck");
		// This chat's own task comes first.
		expect(key(q([lane(1, "working"), task(2, "working")], { running: true }))).toBe("taskQueueStatusWorking");
		// Stopped: the lane tasks keep going, but no new ones start.
		expect(key(q([lane(1, "working"), task(2, "ready")], { pausedReason: "user" }))).toBe("taskQueueStatusStopped");
		// Not "all done" while a lane task is still going.
		expect(key(q([lane(1, "working")], { pausedReason: "finished" }))).not.toBe("taskQueueStatusFinished");
		expect(taskQueueSections(q([lane(1, "working"), task(2, "working")])).current?.id).toBe(2);
	});

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
		// Only tasks on hold: running, but on hold (not "all done", not "running" with nothing to show).
		const hold = task(1, "waiting", { wait: { what: "CI", check: "true", everyMs: 1, since: 1, until: 2 } });
		expect(key(q([hold], { running: true }))).toBe("taskQueueStatusOnHold");
		expect(key(q([hold, task(2, "working")], { running: true }))).toBe("taskQueueStatusWorking");
		expect(key(q([hold], { pausedReason: "finished" }))).not.toBe("taskQueueStatusFinished");
		// New tasks after it finished: not "all done".
		expect(key(q([task(1, "done", { doneAt: 1 }), task(2, "ready")], { pausedReason: "finished" }))).toBe(
			"taskQueueStatusIdle",
		);
	});
});
