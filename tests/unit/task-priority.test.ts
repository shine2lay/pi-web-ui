// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import type { UiRolesOverview, UiTaskQueue, UiTaskQueueTask } from "../../server/protocol.js";
import { resetAppGlobals, setAppGlobals } from "../../web/src/app-globals.js";
import { RolesExactView } from "../../web/src/components/RolesExactView.js";
import {
	DEFAULT_PRIORITY,
	PRIORITIES,
	PRIORITY_RANK,
	TASK_PRIORITY_BADGE_CSS,
	TaskPriorityBadge,
	checkPriority,
	formatTaskPriorityBadge,
	renderTaskPriorityBadgeHtml,
	taskPriority,
	type TaskPriority,
} from "../../web/src/components/TaskPriorityBadge.js";
import { TaskQueuePanel } from "../../web/src/components/TaskQueuePanel.js";
import { LanguageProvider } from "../../web/src/i18n.js";
import { receiveRoles, resetRolesState } from "../../web/src/roles-state.js";
import { renderUnifiedTaskCard } from "../../web/src/tasks-roles-v8/card-surface.js";
import { createInitialFilterState } from "../../web/src/tasks-roles-v8/filters.js";
import { buildLiveTasksRolesV8Dataset } from "../../web/src/tasks-roles-v8/live-adapter.js";
import { TASKS_ROLES_V8_CSS } from "../../web/src/tasks-roles-v8/styles.js";
import { taskOf } from "../../server/roles-task-next.js";
import { insertByPriority, normPriority, repositionReadyTaskByPriority } from "../../server/shared/task-priority.js";
import { TASK_QUEUE_ENTRY_TYPE, taskQueueFromEntries } from "../../server/task-queue.js";

const SAMPLE_PLAN = {
	title: "Sample task",
	goal: "Goal",
	doneWhen: "Done",
	decided: "Decided",
	steps: "Steps",
	verify: "Verify",
	mustNot: "Must not",
};

let clock = 1000;
function queueEntry(data: Record<string, unknown>) {
	return { type: "custom", customType: TASK_QUEUE_ENTRY_TYPE, data: { v: 1, ts: clock++, ...data } };
}

function makeUiTask(id: number, status: UiTaskQueueTask["status"] = "ready", priority?: TaskPriority): UiTaskQueueTask {
	return {
		id,
		status,
		addedAt: 1000 + id,
		plan: { ...SAMPLE_PLAN, title: `Task ${id}` },
		...(priority ? { priority } : {}),
	};
}

describe("Task priority P0–P3 in pi-web-ui (Task #805)", () => {
	it("exposes canonical PRIORITIES, DEFAULT_PRIORITY = P2, PRIORITY_RANK, checkPriority, and taskPriority", () => {
		expect(PRIORITIES).toEqual(["P0", "P1", "P2", "P3"]);
		expect(DEFAULT_PRIORITY).toBe("P2");
		expect(PRIORITY_RANK).toEqual({ P0: 0, P1: 1, P2: 2, P3: 3 });

		expect(checkPriority(undefined)).toEqual({ ok: true, value: undefined });
		for (const p of PRIORITIES) {
			expect(checkPriority(p)).toEqual({ ok: true, value: p });
			expect(normPriority(p)).toBe(p);
		}
		for (const bad of ["p0", "P4", "", null, 1]) {
			expect(checkPriority(bad).ok).toBe(false);
			expect(normPriority(bad)).toBeUndefined();
		}

		expect(taskPriority({})).toBe("P2");
		expect(taskPriority({ priority: "P0" })).toBe("P0");
		expect(taskPriority({ priority: "P3" })).toBe("P3");
	});

	it("orders ready tasks by priority tier (P0 -> P1 -> P2 -> P3) with FIFO within each tier in server/task-queue.ts", () => {
		const entries = [
			queueEntry({ op: "add", id: 1, at: 100, plan: { ...SAMPLE_PLAN, title: "Default P2 first" } }),
			queueEntry({ op: "add", id: 2, at: 200, priority: "P3", plan: { ...SAMPLE_PLAN, title: "Low P3" } }),
			queueEntry({ op: "add", id: 3, at: 300, priority: "P1", plan: { ...SAMPLE_PLAN, title: "High P1 first" } }),
			queueEntry({ op: "add", id: 4, at: 400, priority: "P0", plan: { ...SAMPLE_PLAN, title: "Urgent P0" } }),
			queueEntry({ op: "add", id: 5, at: 500, priority: "P1", plan: { ...SAMPLE_PLAN, title: "High P1 second" } }),
			queueEntry({ op: "add", id: 6, at: 600, priority: "P2", plan: { ...SAMPLE_PLAN, title: "Explicit P2 second" } }),
		];

		const q = taskQueueFromEntries(entries, true);
		expect(q?.tasks.map((t) => [t.id, t.priority ?? "P2"])).toEqual([
			[4, "P0"],
			[3, "P1"],
			[5, "P1"],
			[1, "P2"],
			[6, "P2"],
			[2, "P3"],
		]);

		// Updating task #2 from P3 to P0 repositions it to the tail of the P0 tier (after #4, before #3).
		const updated = taskQueueFromEntries([...entries, queueEntry({ op: "update", id: 2, priority: "P0" })], true);
		expect(updated?.tasks.map((t) => [t.id, t.priority ?? "P2"])).toEqual([
			[4, "P0"],
			[2, "P0"],
			[3, "P1"],
			[5, "P1"],
			[1, "P2"],
			[6, "P2"],
		]);
	});

	it("carries priority on assigned worker tasks and into taskOf / live-adapter", () => {
		const assigned = taskQueueFromEntries(
			[
				queueEntry({
					op: "assigned",
					id: 42,
					at: 1000,
					priority: "P1",
					plan: { ...SAMPLE_PLAN, title: "Worker task" },
					from: { queueId: "q1", file: "/tmp/lead.jsonl" },
				}),
			],
			true,
		);
		expect(assigned?.tasks[0]?.priority).toBe("P1");

		const roleTask = taskOf(makeUiTask(7, "ready", "P0"), "ops");
		expect(roleTask.priority).toBe("P0");

		const overview: UiRolesOverview = {
			at: 1_762_560_000_000,
			asks: [],
			paused: false,
			reportTz: "America/Los_Angeles",
			roles: [
				{
					id: "ops",
					title: "Ops",
					focus: "Tooling",
					workMode: "request-only",
					workModeFrom: "owner",
					goals: [],
					goalsFrom: "owner",
					status: "busy",
					homeChat: { file: "/tmp/ops.jsonl" },
					asks: [],
					tldr: [],
					spend: { state: "ok", line: "$0", spent: "$0", budget: "$0" },
					queue: {
						running: true,
						counts: { active: 1, queued: 3, done: 0 },
						lanes: { inUse: 1, atOnce: 2 },
						active: [
							{ id: 10, title: "Urgent fix", status: "working", priority: "P0", createdAt: 1000, updatedAt: 1000 },
						],
						queued: [
							{ id: 11, title: "High task", status: "ready", priority: "P1", createdAt: 1001, updatedAt: 1001 },
							{ id: 12, title: "Default task", status: "ready", createdAt: 1002, updatedAt: 1002 },
							{ id: 13, title: "Backlog task", status: "ready", priority: "P3", createdAt: 1003, updatedAt: 1003 },
						],
					},
					requests: { open: 0 },
					report: { state: "not-in-job" },
				},
			],
		};

		const adapted = buildLiveTasksRolesV8Dataset({ overview });
		expect(adapted.dataset.tasks.map((t) => [t.displayId, taskPriority(t)])).toEqual([
			[10, "P0"],
			[11, "P1"],
			[12, "P2"],
			[13, "P3"],
		]);
	});

	it("renders P0 / P1 / P2 / P3 priority badges in TaskQueuePanel and RolesExactView", () => {
		const queue: UiTaskQueue = {
			available: true,
			running: true,
			queueId: "q-test",
			tasks: [
				makeUiTask(1, "working", "P0"),
				makeUiTask(2, "ready", "P1"),
				makeUiTask(3, "ready"),
				makeUiTask(4, "ready", "P3"),
			],
		};
		const panelHtml = renderToStaticMarkup(
			createElement(LanguageProvider, null, createElement(TaskQueuePanel, { queue, onCommand: () => {} })),
		);
		expect(panelHtml).toContain('data-priority="P0"');
		expect(panelHtml).toContain('data-priority="P1"');
		expect(panelHtml).toContain('data-priority="P2"');
		expect(panelHtml).toContain('data-priority="P3"');

		// Direct helper & card-surface checks
		expect(formatTaskPriorityBadge(undefined)).toBe("P2");
		expect(renderTaskPriorityBadgeHtml("P0")).toContain('data-priority="P0"');
		const cardHtml = renderUnifiedTaskCard({
			task: {
				id: 99,
				displayId: 99,
				role: "ops",
				roleTitle: "Ops",
				title: "Critical P0 Card",
				priority: "P0",
				status: "working",
				lifecycleStatus: "working",
				statusTone: "working",
				createdAt: 1000,
				updatedAt: 1000,
			},
			state: createInitialFilterState(),
		});
		expect(cardHtml).toContain('data-priority="P0"');
		expect(cardHtml).toContain("task-priority-p0");

		// Mount RolesExactView with live overview containing P0, P1, P2, P3 tasks
		resetRolesState();
		resetAppGlobals();
		setAppGlobals({ status: "open" });
		const nowMs = Date.now();

		const host = document.createElement("div");
		document.body.appendChild(host);
		const root = createRoot(host);
		try {
			act(() => {
				root.render(
					createElement(RolesExactView, {
						active: true,
						onOpen: () => {},
						onAbout: () => {},
					}),
				);
			});
			act(() => {
				receiveRoles({
					type: "roles",
					asks: 0,
					overview: {
						at: nowMs,
						asks: [],
						paused: false,
						reportTz: "America/Los_Angeles",
						roles: [
							{
								id: "ops",
								title: "Ops",
								focus: "Tooling",
								workMode: "request-only",
								workModeFrom: "owner",
								goals: [],
								goalsFrom: "owner",
								status: "busy",
								homeChat: { file: "/tmp/ops.jsonl" },
								asks: [],
								tldr: [],
								spend: { state: "ok", line: "$0", spent: "$0", budget: "$0" },
								queue: {
									running: true,
									counts: { active: 1, queued: 3, done: 0 },
									lanes: { inUse: 1, atOnce: 2 },
									active: [
										{
											id: 101,
											title: "P0 active",
											status: "working",
											priority: "P0",
											createdAt: nowMs - 4000,
											updatedAt: nowMs - 4000,
										},
									],
									queued: [
										{
											id: 102,
											title: "P1 queued",
											status: "ready",
											priority: "P1",
											createdAt: nowMs - 3000,
											updatedAt: nowMs - 3000,
										},
										{
											id: 103,
											title: "P2 default",
											status: "ready",
											createdAt: nowMs - 2000,
											updatedAt: nowMs - 2000,
										},
										{
											id: 104,
											title: "P3 backlog",
											status: "ready",
											priority: "P3",
											createdAt: nowMs - 1000,
											updatedAt: nowMs - 1000,
										},
									],
								},
								requests: { open: 0 },
								report: { state: "not-in-job" },
							},
						],
					},
				});
			});
			const badges = [...host.querySelectorAll(".task-priority-badge")].map((el) => el.getAttribute("data-priority"));
			expect(badges).toEqual(["P0", "P1", "P2", "P3"]);
		} finally {
			act(() => root.unmount());
			host.remove();
			resetRolesState();
			resetAppGlobals();
		}

		// Direct unit check on insertByPriority & repositionReadyTaskByPriority
		const list: Array<{ id: number; status: string; priority?: TaskPriority }> = [
			{ id: 1, status: "working", priority: "P3" },
			{ id: 2, status: "ready", priority: "P2" },
		];
		insertByPriority(list, { id: 3, status: "ready", priority: "P0" });
		expect(list.map((x) => x.id)).toEqual([1, 3, 2]);
		list[2]!.priority = "P0";
		repositionReadyTaskByPriority(list, list[2]!);
		expect(list.map((x) => x.id)).toEqual([1, 3, 2]);
	});

	it("renders TaskPriorityBadge component directly and ships P0-P3 badge CSS in styles.css and TASKS_ROLES_V8_CSS", () => {
		expect(renderToStaticMarkup(createElement(TaskPriorityBadge, { priority: "P1" }))).toContain('data-priority="P1"');
		const stylesCss = readFileSync(join(process.cwd(), "web/src/styles.css"), "utf8");
		for (const cls of [
			".task-priority-badge",
			".task-priority-p0",
			".task-priority-p1",
			".task-priority-p2",
			".task-priority-p3",
		]) {
			expect(TASK_PRIORITY_BADGE_CSS).toContain(cls);
			expect(TASKS_ROLES_V8_CSS).toContain(cls);
			expect(stylesCss).toContain(cls);
		}
	});
});
