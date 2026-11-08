// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiRolesOverview, UiWorkPage } from "../../server/protocol.js";
import { InitiativesExactView } from "../../web/src/components/InitiativesExactView.js";
import { RolesExactView } from "../../web/src/components/RolesExactView.js";
import { buildLiveTasksRolesV8Dataset } from "../../web/src/tasks-roles-v8/live-adapter.js";

function sampleLiveOverview(): UiRolesOverview {
	return {
		at: 1_762_560_000_000,
		asks: [],
		paused: false,
		reportTz: "America/Los_Angeles",
		roles: [
			{
				id: "design",
				title: "Design",
				focus: "Product design",
				workMode: "request-only",
				workModeFrom: "owner",
				goals: [],
				goalsFrom: "owner",
				status: "needs-you",
				homeChat: { file: "/tmp/design-home.jsonl" },
				asks: [
					{
						key: "design:task:221",
						role: "design",
						kind: "task",
						text: "Approve v8 carbon + warm-gold palette for live build?",
						since: 1_762_559_400_000,
						focus: "task:221",
						chat: { file: "/tmp/design-221.jsonl", where: 221 },
					},
				],
				tldr: [
					{
						id: "tldr-1",
						text: "Awaiting v8 approval",
						ts: 1_762_559_400_000,
						needsYou: true,
						chat: { file: "/tmp/design-home.jsonl", where: "home" },
					},
				],
				spend: { state: "ok", line: "$410 / $2,000", spent: "$410", budget: "$2,000" },
				queue: {
					running: true,
					counts: { active: 1, queued: 0, done: 12 },
					lanes: { inUse: 1, atOnce: 2 },
					active: [
						{
							id: 221,
							title: "Tasks & Roles v8 prototype signoff",
							status: "stuck",
							lifecycleStatus: "stuck",
							statusTone: "needs_you",
							stuck: {
								question: "Approve v8 carbon + warm-gold palette for live build?",
								choices: ["Approve v8 (Recommended)", "Keep v7"],
								sinceAt: 1_762_559_400_000,
								tier: "owner",
							},
							tags: ["roles-initiatives-v8"],
							touches: ["pi-web-ui"],
							normalizedTouches: [{ raw: "pi-web-ui", appOrSystem: "pi-web-ui", kind: "repo", shareable: true }],
							howToUnblock: "Answer Design #221 in Details ▸",
							chat: { file: "/tmp/design-221.jsonl" },
						},
					],
					queued: [],
				},
				requests: { open: 0 },
				report: { state: "not-in-job" },
				problems: [],
			},
			{
				id: "backend",
				title: "Backend engineering",
				focus: "Server build",
				workMode: "request-only",
				workModeFrom: "rules",
				goals: [],
				goalsFrom: "rules",
				status: "busy",
				homeChat: { file: "/tmp/backend-home.jsonl" },
				asks: [],
				tldr: [
					{
						id: "tldr-2",
						text: "Delivered Track B2 resolver",
						ts: 1_762_559_800_000,
						chat: { file: "/tmp/backend-home.jsonl", where: "home" },
					},
				],
				spend: { state: "none", line: "No budget" },
				doneRecent: [
					{
						id: 120,
						title: "Track B2 lifecycle & delivery resolver",
						summary: "Shipped task-delivery-resolver and protocol rollups",
						at: 1_762_559_900_000,
					},
				],
				queue: {
					running: true,
					counts: { active: 0, queued: 0, done: 45 },
					lanes: { inUse: 0, atOnce: 3 },
					active: [
						{
							id: 120,
							title: "Track B2 lifecycle & delivery resolver",
							status: "done",
							lifecycleStatus: "live",
							statusTone: "live",
							tags: ["roles-initiatives-v8"],
							touches: ["pi-web-ui"],
							doneSummary: "Shipped task-delivery-resolver and protocol rollups",
							delivery: {
								repo: "pi-web-ui",
								deployableService: true,
								landedCommit: "44ea1c99",
								liveCommit: "44ea1c99",
								deployStatus: "succeeded",
							},
						},
					],
					queued: [],
				},
				requests: { open: 0 },
				report: { state: "not-in-job" },
				problems: [],
			},
			{
				id: "frontend",
				title: "Frontend engineering",
				focus: "Web UI",
				workMode: "request-only",
				workModeFrom: "rules",
				goals: [],
				goalsFrom: "rules",
				status: "busy",
				homeChat: { file: "/tmp/frontend-home.jsonl" },
				asks: [],
				tldr: [
					{
						id: "tldr-3",
						text: "Wiring live Roles & Initiatives v8",
						ts: 1_762_559_990_000,
						chat: { file: "/tmp/frontend-home.jsonl", where: "home" },
					},
				],
				spend: { state: "none", line: "No budget" },
				queue: {
					running: true,
					counts: { active: 1, queued: 0, done: 68 },
					lanes: { inUse: 1, atOnce: 3 },
					active: [
						{
							id: 241,
							title: "Wire live Roles & Initiatives v8 views",
							status: "blocked",
							lifecycleStatus: "blocked",
							statusTone: "blocked",
							tags: ["roles-initiatives-v8"],
							touches: ["pi-web-ui"],
							normalizedTouches: [{ raw: "pi-web-ui", appOrSystem: "pi-web-ui", kind: "repo", shareable: true }],
							dependsOnRefs: ["design #221", "backend #120"],
							howToUnblock: "Unblock design #221 (stuck on owner)",
							blocked: {
								on: ["design #221", "backend #120"],
								resolvedOn: [
									{
										ref: "design #221",
										role: "design",
										taskId: 221,
										title: "Tasks & Roles v8 prototype signoff",
										lifecycleStatus: "stuck",
										satisfied: false,
									},
									{
										ref: "backend #120",
										role: "backend",
										taskId: 120,
										title: "Track B2 lifecycle & delivery resolver",
										lifecycleStatus: "live",
										satisfied: true,
									},
								],
								unsatisfiedCount: 1,
								sinceAt: 1_762_559_500_000,
								checkpointOverdue: false,
								unblockSummary: "Waiting on design #221 (stuck)",
								howToUnblock: "Unblock design #221 (stuck on owner)",
							},
							delivery: {
								deployableService: true,
								repo: "pi-web-ui",
								landStatus: "running",
							},
							chat: { file: "/tmp/frontend-241.jsonl" },
						},
					],
					queued: [],
				},
				requests: { open: 0 },
				report: { state: "not-in-job" },
				problems: [],
			},
			...["qa", "architecture", "ops", "coo", "temper"].map((id, idx) => ({
				id,
				title: id.toUpperCase(),
				focus: id,
				workMode: "request-only" as const,
				workModeFrom: "rules" as const,
				goals: [],
				goalsFrom: "rules" as const,
				status: "idle" as const,
				homeChat: { file: `/tmp/${id}-home.jsonl` },
				asks: [],
				tldr: [
					{
						id: `tldr-${id}`,
						text: "All clear",
						ts: 1_762_550_000_000 - idx * 1000,
						chat: { file: `/tmp/${id}-home.jsonl`, where: "home" as const },
					},
				],
				spend: { state: "none" as const, line: "No budget" },
				queue: {
					running: true,
					counts: { active: 0, queued: 0, done: 5 },
					active: [],
					queued: [],
				},
				requests: { open: 0 },
				report: { state: "not-in-job" as const },
				problems: [],
			})),
		],
	};
}

function sampleLiveWorkPage(): UiWorkPage {
	return {
		at: 1_762_560_000_000,
		initiatives: [
			{
				id: "roles-initiatives-v8",
				name: "Tasks & Roles v8 Rework",
				outcome: "Deliver unified v8 Tasks & Roles and Initiatives pages",
				lead: "frontend",
				status: "active",
				createdAt: 1_762_550_000_000,
				createdBy: "owner",
				updatedAt: 1_762_560_000_000,
				doneWhen: [],
			},
		],
		projects: [],
		tasks: [],
		activity: [],
	};
}

describe("tasks-roles-v8 live adapter and component wiring (#241)", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("adapts UiRolesOverview and UiWorkPage v4 contract fields into TasksRolesV8Dataset", () => {
		const overview = sampleLiveOverview();
		const workPage = sampleLiveWorkPage();
		const res = buildLiveTasksRolesV8Dataset({
			overview,
			workPage,
			now: 1_762_560_000_000,
		});

		expect(res.mode).toBe("normal");
		expect(res.dataset.tasks.length).toBe(3);
		expect(res.dataset.departments.length).toBeGreaterThanOrEqual(6);
		expect(res.dataset.idleDepartments.length).toBe(2);

		const t221 = res.tasksById.get(221);
		expect(t221?.lifecycleStatus).toBe("stuck");
		expect(t221?.stuck?.choices).toEqual(["Approve v8 (Recommended)", "Keep v7"]);

		const t241 = res.tasksById.get(241);
		expect(t241?.lifecycleStatus).toBe("blocked");
		expect(t241?.dependsOnRefs).toEqual(["design #221", "backend #120"]);
		expect(t241?.howToUnblock).toContain("design #221");

		const t120 = res.tasksById.get(120);
		expect(t120?.lifecycleStatus).toBe("live");
		expect(t120?.delivery?.liveCommit).toBe("44ea1c99");

		const v8Group = res.dataset.askGroups.find((g) => g.key === "tag:roles-initiatives-v8");
		expect(v8Group).toBeDefined();
		expect(v8Group?.title).toBe("Tasks & Roles v8 Rework");
	});

	it("mounts RolesExactView in live v8 mode (without fonts), strips prototype demo chrome, and wires Escape + Open chat", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		const opened: unknown[] = [];

		await act(async () => {
			root.render(
				createElement(RolesExactView, {
					active: true,
					onOpen: (t) => opened.push(t),
					onAbout: vi.fn(),
				}),
			);
		});

		const shell = container.querySelector(".app-shell");
		expect(shell).not.toBeNull();
		// Prototype demo chrome must be completely absent in live mode
		expect(container.querySelector("#tab-roles")).toBeNull();
		expect(container.querySelector("#tab-initiatives")).toBeNull();
		expect(container.querySelector("[data-ui-mode]")).toBeNull();
		expect(container.querySelector("#why-modal-btn")).toBeNull();
		expect(container.querySelector("#why-modal")).toBeNull();
		expect(container.querySelector("#theme-toggle")).toBeNull();
		expect(container.querySelector("#restore-normal-btn")).toBeNull();

		expect(container.querySelectorAll("details.filter-dd[data-filter-dropdown]").length).toBe(4);
		expect(container.querySelector("#task-search-input")).not.toBeNull();

		// Open a filter dropdown and verify Escape closes it via shortcut-stack
		const deptDetails = container.querySelector<HTMLDetailsElement>('details.filter-dd[data-filter-dropdown="dept"]');
		expect(deptDetails).not.toBeNull();
		await act(async () => {
			if (deptDetails) {
				deptDetails.open = true;
				deptDetails.dispatchEvent(new Event("toggle"));
			}
		});
		expect(deptDetails?.open).toBe(true);

		await act(async () => {
			const evt = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
			window.dispatchEvent(evt);
		});
		expect(container.querySelector<HTMLDetailsElement>('details.filter-dd[data-filter-dropdown="dept"]')?.open).toBe(
			false,
		);

		await act(async () => {
			root.unmount();
		});
	});

	it("mounts InitiativesExactView in live v8 mode (without fonts) and renders DAG + Tier 3 drawers", async () => {
		const container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		const opened: unknown[] = [];

		await act(async () => {
			root.render(
				createElement(InitiativesExactView, {
					active: true,
					input: {
						page: { state: "live" },
						initiatives: [
							{
								id: "roles-initiatives-v8",
								name: "Tasks & Roles v8 Rework",
								goal: "Unified v8 Tasks & Roles surface",
								roles: [
									{
										name: "design",
										task: "#221",
										taskTitle: "Approve v8 specification",
										kind: "waiting",
									},
									{
										name: "frontend",
										task: "#241",
										taskTitle: "Wire live v8 views",
										kind: "blocked",
										wait: "design #221",
									},
								],
							},
						],
					},
					onOpen: (t) => opened.push(t),
					onRetry: vi.fn(),
				}),
			);
		});

		expect(container.querySelector("#tab-initiatives")).toBeNull();
		expect(container.querySelector("#tab-roles")).toBeNull();
		expect(container.querySelector("[data-ui-mode]")).toBeNull();
		expect(container.querySelector("#why-modal-btn")).toBeNull();
		expect(container.querySelector("#theme-toggle")).toBeNull();
		expect(container.querySelector(".unified-tasks-panel")).not.toBeNull();

		const dagPill = container.querySelector<HTMLButtonElement>('[data-open-tag-dag="roles-initiatives-v8"]');
		expect(dagPill).not.toBeNull();
		await act(async () => {
			dagPill?.click();
		});

		const dagRegion = container.querySelector<HTMLElement>("#tag-dag-region");
		expect(dagRegion?.hidden).toBe(false);
		expect(dagRegion?.querySelectorAll(".dag-stage-col").length).toBeGreaterThanOrEqual(1);

		const detailToggle = container.querySelector<HTMLButtonElement>('.task-detail-toggle-btn[data-task-id="221"]');
		expect(detailToggle).not.toBeNull();
		await act(async () => {
			detailToggle?.click();
		});
		const drawer = container.querySelector<HTMLElement>('.task-detail-drawer[data-task-detail="221"]');
		expect(drawer).not.toBeNull();
		expect(drawer?.querySelectorAll(".pipe-step").length).toBe(5);
		expect(drawer?.querySelector(".callout-box")).not.toBeNull();

		await act(async () => {
			root.unmount();
		});
	});

	it("preserves cross-department tasks that share the same numeric #id and skips synthetic 8001+ exactInput duplicates when live overview exists", () => {
		const overview = sampleLiveOverview();
		// Add a task #120 in frontend as well (colliding with backend #120)
		const feRole = overview.roles.find((r) => r.id === "frontend")!;
		feRole.queue?.active.push({
			id: 120,
			title: "Frontend task #120 (same number as Backend #120)",
			status: "working",
			lifecycleStatus: "working",
			statusTone: "working",
			tags: ["roles-initiatives-v8"],
			touches: ["pi-web-ui"],
			chat: { file: "/tmp/frontend-120.jsonl" },
		});

		const res = buildLiveTasksRolesV8Dataset({
			overview,
			workPage: sampleLiveWorkPage(),
			exactInput: {
				page: { state: "live" },
				initiatives: [
					{
						id: "roles-initiatives-v8",
						name: "Tasks & Roles v8 Rework",
						goal: "Unified v8 Tasks & Roles surface",
						roles: [
							{
								name: "design",
								taskTitle: "Role row without task number that previously synthesized #8001",
								kind: "working",
							},
						],
					},
				],
			},
			now: 1_762_560_000_000,
		});

		// Both backend #120 and frontend #120 exist without overwriting each other, and no synthetic 8001 task was created
		expect(res.dataset.tasks.length).toBe(4);
		const tasks120 = res.dataset.tasks.filter((t) => (t.displayId ?? t.id) === 120);
		expect(tasks120.length).toBe(2);
		expect(tasks120.map((t) => t.role).sort()).toEqual(["backend", "frontend"]);
		expect(tasks120[0]!.id).not.toBe(tasks120[1]!.id);
		expect(res.dataset.tasks.some((t) => (t.displayId ?? t.id) >= 8000)).toBe(false);
	});
});
