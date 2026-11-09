// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiRolesOverview, UiWorkPage } from "../../server/protocol.js";
import { InitiativesExactView } from "../../web/src/components/InitiativesExactView.js";
import { RolesExactView } from "../../web/src/components/RolesExactView.js";
import {
	applyFilters,
	createInitialFilterState,
	DEFAULT_TIME_WINDOW_MS,
	mountTasksRolesV8Surface,
	PAGE_SIZE,
	resetAllFilters,
	toggleNeedsAttentionFilter,
	toggleOnlyOnYouFilter,
	toggleSelectedTag,
} from "../../web/src/tasks-roles-v8/index.js";
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
		expect(dagRegion?.querySelectorAll(".handoff-bar").length).toBe(0);

		const dagDetailToggle = container.querySelector<HTMLButtonElement>(
			'#tag-dag-region .task-detail-toggle-btn[data-task-id="221"]',
		);
		expect(dagDetailToggle).not.toBeNull();
		await act(async () => {
			dagDetailToggle?.click();
		});
		const dagPanel = container.querySelector<HTMLElement>('.dag-detail-panel[data-dag-detail-panel="221"]');
		expect(dagPanel).not.toBeNull();
		expect(dagPanel?.querySelectorAll(".pipe-step").length).toBe(5);
		expect(dagPanel?.querySelector(".callout-box")).not.toBeNull();

		const listDetailToggle = container.querySelector<HTMLButtonElement>(
			'.unified-tasks-panel .task-detail-toggle-btn[data-task-id="221"]',
		);
		expect(listDetailToggle).not.toBeNull();
		await act(async () => {
			listDetailToggle?.click();
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

	it("excludes historical done/removed tasks from workPage & doneRecent, preserves blocked lifecycle across workPage merge, and sanitizes howToUnblock", () => {
		const overview = sampleLiveOverview();
		// Add historical doneRecent tasks that are not in active/queued/tagGroups
		const opsRole = overview.roles.find((r) => r.id === "ops")!;
		opsRole.doneRecent = [
			{ id: 901, title: "Old finished ops task #901", summary: "Done last week", at: 1_762_000_000_000 },
		];
		opsRole.queue?.active.push({
			id: 765,
			title: "Ops task #765 blocked on architecture #450",
			status: "blocked",
			lifecycleStatus: "blocked",
			statusTone: "blocked",
			howToUnblock: "How to unblock: Answer architecture #450's owner question",
			wait: {
				what: "deploy check",
				checkCmd: "bash -c 'for f in /tmp/test; do echo $f; done'",
				sinceAt: 1_762_559_000_000,
				everyMs: 120_000,
				expectByAt: 1_762_560_800_000,
				giveUpAt: 1_762_640_000_000,
				overdue: false,
				howToUnblock: "Wait on 'bash -c \"for f in /tmp/test; do echo $f; done\"' (16m / 30m expected)",
			},
		});

		const workPage = sampleLiveWorkPage();
		workPage.tasks = [
			// Historical done & removed tasks in workPage must be excluded
			{
				queue: "ops",
				queueName: "ops",
				task: 901,
				title: "Old finished ops task #901",
				state: "done",
				parent: { standalone: true },
				added: 1_762_000_000_000,
			},
			{
				queue: "ops",
				queueName: "ops",
				task: 902,
				title: "Removed ops task #902",
				state: "removed",
				parent: { standalone: true },
				added: 1_762_000_000_000,
			},
			// Active blocked task #765 also has paused metadata in workPage without lifecycleStatus
			{
				queue: "ops",
				queueName: "ops",
				task: 765,
				title: "Ops task #765 blocked on architecture #450",
				state: "blocked",
				paused: { why: "Hold while blocked", at: 1_762_559_100_000 },
				parent: { standalone: true },
				added: 1_762_559_000_000,
			},
		];

		const res = buildLiveTasksRolesV8Dataset({
			overview,
			workPage,
			now: 1_762_560_000_000,
		});

		// Historical done #901 and removed #902 should not be included
		expect(res.dataset.tasks.some((t) => (t.displayId ?? t.id) === 901)).toBe(false);
		expect(res.dataset.tasks.some((t) => (t.displayId ?? t.id) === 902)).toBe(false);

		// Ops #765 must keep its "blocked" lifecycleStatus from overview (not overwritten with "paused")
		const t765 = res.dataset.tasks.find((t) => t.role === "ops" && (t.displayId ?? t.id) === 765);
		expect(t765).toBeDefined();
		expect(t765?.lifecycleStatus).toBe("blocked");
		expect(t765?.howToUnblock).toBe("Answer architecture #450's owner question");
		expect(t765?.howToUnblock?.toLowerCase().startsWith("how to unblock:")).toBe(false);
		expect(t765?.wait?.howToUnblock).toBe("Waiting on deploy check");
	});

	it("enforces 1-week default window across all 3 adaptation paths while keeping older tasks searchable", () => {
		const nowMs = 1_762_560_000_000;
		const recentEpochMs = nowMs - 2 * 86_400_000; // 2 days ago
		const olderEpochMs = nowMs - 10 * 86_400_000; // 10 days ago (> 7d cutoff)
		const olderIso = new Date(nowMs - 14 * 86_400_000).toISOString(); // 14 days ago ISO

		const overview = sampleLiveOverview();
		// 1) Role queue task (section 1/2): older deployed task #501 with ISO updatedAt
		const beRole = overview.roles.find((r) => r.id === "backend")!;
		beRole.queue?.active.push({
			id: 501,
			title: "Legacy auth migration #501 from two weeks ago",
			status: "done",
			lifecycleStatus: "live",
			statusTone: "live",
			tags: ["roles-initiatives-v8"],
			touches: ["pi-web-ui"],
			updatedAt: olderIso as unknown as number,
		});
		// Recent role queue task #502 within 7 days
		beRole.queue?.active.push({
			id: 502,
			title: "Recent auth polish #502 from two days ago",
			status: "done",
			lifecycleStatus: "live",
			statusTone: "live",
			tags: ["roles-initiatives-v8"],
			touches: ["pi-web-ui"],
			updatedAt: recentEpochMs,
		});

		// 2) tagGroups task (section 3a): older landed task #503
		const tagGroups = ((overview as unknown as { tagGroups?: Array<Record<string, unknown>> }).tagGroups ??= []);
		tagGroups.push({
			key: "tag:legacy-initiative",
			kind: "tag",
			title: "#legacy-initiative",
			tags: ["legacy-initiative"],
			rollupStatus: "live",
			statusTone: "live",
			totalTasks: 1,
			countsByStatus: { live: 1 },
			hasBlockedPeers: false,
			roles: ["ops"],
			appsOrSystems: ["pi-web-ui"],
			updatedAt: olderEpochMs,
			tasks: [
				{
					id: 503,
					role: "ops",
					roleTitle: "Ops",
					title: "Ancient tagGroup deploy #503",
					status: "done",
					lifecycleStatus: "live",
					statusTone: "live",
					paused: false,
					appOrSystem: "pi-web-ui",
					appLabel: "pi-web-ui",
					tags: ["legacy-initiative"],
					normalizedTouches: [],
					dependsOnRefs: [],
					createdAt: olderEpochMs,
					updatedAt: olderEpochMs,
				},
			],
		});

		// 3) workPage.tasks (section 3b): older landed task #504
		const workPage = sampleLiveWorkPage();
		workPage.tasks.push({
			queue: "frontend",
			queueName: "frontend",
			task: 504,
			title: "Old workPage landed card #504",
			state: "done",
			lifecycleStatus: "landed",
			statusTone: "landed",
			tags: ["roles-initiatives-v8"],
			touches: ["pi-web-ui"],
			parent: { standalone: true },
			added: olderEpochMs,
			stateAt: olderEpochMs,
			...({ updatedAt: olderEpochMs } as Record<string, unknown>),
		});

		const res = buildLiveTasksRolesV8Dataset({
			overview,
			workPage,
			now: nowMs,
		});

		// Verify updatedAtMs populated across all 3 adaptation paths and >7d tasks remain in dataset.tasks
		const t501 = res.dataset.tasks.find((t) => (t.displayId ?? t.id) === 501);
		const t502 = res.dataset.tasks.find((t) => (t.displayId ?? t.id) === 502);
		const t503 = res.dataset.tasks.find((t) => (t.displayId ?? t.id) === 503);
		const t504 = res.dataset.tasks.find((t) => (t.displayId ?? t.id) === 504);
		expect(t501?.updatedAtMs).toBe(Date.parse(olderIso));
		expect(t502?.updatedAtMs).toBe(recentEpochMs);
		expect(t503?.updatedAtMs).toBe(olderEpochMs);
		expect(t504?.updatedAtMs).toBe(olderEpochMs);
		expect(DEFAULT_TIME_WINDOW_MS).toBe(7 * 86_400_000);

		// When search is empty: default 1-week window excludes #501, #503, #504 and keeps #502 + recent tasks
		const defaultVisible = applyFilters(res.dataset, createInitialFilterState({ search: "" }), nowMs);
		const defaultIds = defaultVisible.map((t) => t.displayId ?? t.id);
		expect(defaultIds).toContain(502);
		expect(defaultIds).toContain(221);
		expect(defaultIds).not.toContain(501);
		expect(defaultIds).not.toContain(503);
		expect(defaultIds).not.toContain(504);

		// When search is non-empty: searches all tasks in dataset.tasks including >7d tasks
		const search501 = applyFilters(res.dataset, createInitialFilterState({ search: "Legacy auth" }), nowMs);
		expect(search501.map((t) => t.displayId ?? t.id)).toEqual([501]);

		const search503 = applyFilters(res.dataset, createInitialFilterState({ search: "Ancient tagGroup" }), nowMs);
		expect(search503.map((t) => t.displayId ?? t.id)).toEqual([503]);

		const search504 = applyFilters(res.dataset, createInitialFilterState({ search: "#504" }), nowMs);
		expect(search504.map((t) => t.displayId ?? t.id)).toEqual([504]);

		// Mount surface and verify DOM count pill and live search input behavior
		const host = document.createElement("div");
		document.body.appendChild(host);
		const ctrl = mountTasksRolesV8Surface(host, {
			dataset: res.dataset,
			initialState: { page: "initiatives", nowMs },
			showPrototypeChrome: false,
		});

		const countPill = host.querySelector<HTMLElement>(".unified-tasks-header .tier-count-pill");
		expect(countPill?.getAttribute("data-window-mode")).toBe("7d");
		expect(countPill?.textContent).toContain("4 of 4 tasks (7d · +3 older searchable)");
		expect(host.querySelectorAll(".unified-task-card").length).toBe(4);
		expect(host.textContent).not.toContain("Legacy auth migration #501");

		const searchInput = host.querySelector<HTMLInputElement>("#task-search-input")!;
		searchInput.value = "Legacy auth";
		searchInput.dispatchEvent(new Event("input", { bubbles: true }));

		const countPillAfterSearch = host.querySelector<HTMLElement>(".unified-tasks-header .tier-count-pill");
		expect(countPillAfterSearch?.getAttribute("data-window-mode")).toBe("all-time");
		expect(countPillAfterSearch?.textContent).toContain("1 of 7 tasks · All-time search");
		expect(host.querySelectorAll(".unified-task-card").length).toBe(1);
		expect(host.textContent).toContain("Legacy auth migration #501");

		ctrl.destroy();
	});

	it("paginates Unified Tasks View at 20 tasks/page, navigates via Prev/Next, and resets to page 1 on filter or search changes", () => {
		const nowMs = 1_762_560_000_000;
		const overview = sampleLiveOverview();
		const feRole = overview.roles.find((r) => r.id === "frontend")!;

		// Add 42 recent tasks so total recent tasks = 45 (3 pages: 20, 20, 5) + 2 older tasks (>7d)
		for (let i = 1; i <= 42; i++) {
			feRole.queue?.queued.push({
				id: 1000 + i,
				title: `Paginated recent task #${1000 + i}`,
				status: "ready",
				lifecycleStatus: "queued",
				statusTone: "queued",
				tags: ["roles-initiatives-v8"],
				touches: ["pi-web-ui"],
				updatedAt: nowMs - i * 60_000,
			});
		}
		feRole.queue?.active.push({
			id: 2001,
			title: "Searchable archive task #2001",
			status: "done",
			lifecycleStatus: "live",
			statusTone: "live",
			tags: ["roles-initiatives-v8"],
			touches: ["pi-web-ui"],
			updatedAt: nowMs - 20 * 86_400_000,
		});

		const res = buildLiveTasksRolesV8Dataset({
			overview,
			workPage: sampleLiveWorkPage(),
			now: nowMs,
		});

		expect(PAGE_SIZE).toBe(20);

		const host = document.createElement("div");
		document.body.appendChild(host);
		const ctrl = mountTasksRolesV8Surface(host, {
			dataset: res.dataset,
			initialState: { page: "initiatives", nowMs },
			showPrototypeChrome: false,
		});

		// Page 1: 20 cards, Prev disabled, Next enabled
		expect(host.querySelectorAll(".unified-task-card").length).toBe(20);
		const status1 = host.querySelector<HTMLElement>("[data-pagination-status]");
		expect(status1?.textContent).toContain("Page 1 of 3 · Showing 1–20 of 45 tasks");
		const prev1 = host.querySelector<HTMLButtonElement>("[data-page-prev]")!;
		const next1 = host.querySelector<HTMLButtonElement>("[data-page-next]")!;
		expect(prev1.disabled).toBe(true);
		expect(next1.disabled).toBe(false);

		// Navigate to Page 2
		next1.click();
		expect(ctrl.getState().currentPage).toBe(2);
		expect(host.querySelectorAll(".unified-task-card").length).toBe(20);
		expect(host.querySelector<HTMLElement>("[data-pagination-status]")?.textContent).toContain(
			"Page 2 of 3 · Showing 21–40 of 45 tasks",
		);
		expect(host.querySelector<HTMLButtonElement>("[data-page-prev]")?.disabled).toBe(false);
		expect(host.querySelector<HTMLButtonElement>("[data-page-next]")?.disabled).toBe(false);

		// Navigate to Page 3 (last page: 5 tasks, Next disabled)
		host.querySelector<HTMLButtonElement>("[data-page-next]")!.click();
		expect(ctrl.getState().currentPage).toBe(3);
		expect(host.querySelectorAll(".unified-task-card").length).toBe(5);
		expect(host.querySelector<HTMLElement>("[data-pagination-status]")?.textContent).toContain(
			"Page 3 of 3 · Showing 41–45 of 45 tasks",
		);
		expect(host.querySelector<HTMLButtonElement>("[data-page-prev]")?.disabled).toBe(false);
		expect(host.querySelector<HTMLButtonElement>("[data-page-next]")?.disabled).toBe(true);

		// Navigate back to Page 2 via Previous
		host.querySelector<HTMLButtonElement>("[data-page-prev]")!.click();
		expect(ctrl.getState().currentPage).toBe(2);
		expect(host.querySelector<HTMLElement>("[data-pagination-status]")?.textContent).toContain(
			"Page 2 of 3 · Showing 21–40 of 45 tasks",
		);

		// Changing department filter resets page to 1
		host.querySelector<HTMLButtonElement>('.dept-filter-btn[data-dept-id="frontend"]')?.click();
		expect(ctrl.getState().currentPage).toBe(1);
		expect(host.querySelector<HTMLElement>("[data-pagination-status]")?.textContent).toContain(
			"Page 1 of 3 · Showing 1–20 of 43 tasks",
		);

		// Advance to page 2 again, then type in search input -> resets to page 1 and finds >7d task #2001
		host.querySelector<HTMLButtonElement>("[data-page-next]")!.click();
		expect(ctrl.getState().currentPage).toBe(2);

		const searchInput = host.querySelector<HTMLInputElement>("#task-search-input")!;
		searchInput.value = "Searchable archive task #2001";
		searchInput.dispatchEvent(new Event("input", { bubbles: true }));
		expect(ctrl.getState().currentPage).toBe(1);
		expect(host.querySelectorAll(".unified-task-card").length).toBe(1);
		expect(host.querySelector<HTMLElement>("[data-pagination-status]")?.textContent).toContain(
			"Page 1 of 1 · Showing 1–1 of 1 task",
		);

		// Pure state helper resets also reset currentPage to 1
		const page2State = createInitialFilterState({ currentPage: 2 });
		expect(toggleNeedsAttentionFilter(page2State).currentPage).toBe(1);
		expect(toggleOnlyOnYouFilter(page2State).currentPage).toBe(1);
		expect(toggleSelectedTag(page2State, "roles-initiatives-v8").currentPage).toBe(1);
		expect(resetAllFilters(page2State).currentPage).toBe(1);

		ctrl.destroy();
	});
});
