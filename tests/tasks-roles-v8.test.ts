// @vitest-environment jsdom
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildFilterDropdownModels,
	buildTaskDag,
	checkTags,
	computeAttentionSummary,
	computeBezierPath,
	computeGroupRollup,
	createInitialFilterState,
	createReferenceDataset,
	deriveV8DatasetFromRolesOverview,
	matchesTaskFilters,
	mountTasksRolesV8Surface,
	normalizeTouch,
	normalizeTouches,
	renderDeliveryPipelineMeter,
	renderStatusBadge,
	renderTaskCallouts,
	resolveBlockedDependencies,
	resolveQueueTaskTags,
	resolveTaskLifecycleStatus,
	sortTasksByUrgency,
	STATUS_META,
	TASKS_ROLES_V8_CSS,
	TASK_URGENCY_RANK,
	type UiRoleTask,
	type UiRolesOverview,
	type UiTaskLifecycleStatus,
	V8_REFERENCE_DATASET,
} from "../web/src/tasks-roles-v8/index.js";

const EXTERNAL_CONFORMANCE_PATH =
	"/home/shinelay/architecture-dept/work/roles-initiatives-rework/conformance-fixtures.json";

const INLINE_CONFORMANCE_FIXTURES = {
	version: "2026-11-07.v4",
	tagValidationFixtures: [
		{
			id: "tags-valid-multi-dedup",
			input: ["roles-rework", "multi-tag", "roles-rework", "  wt-deploy-v1  "],
			expectedOk: true,
			expectedValue: ["roles-rework", "multi-tag", "wt-deploy-v1"],
		},
		{
			id: "tags-valid-empty-clears",
			input: [],
			expectedOk: true,
			expectedValue: [],
		},
		{
			id: "tags-valid-undefined",
			input: undefined,
			expectedOk: true,
		},
		{
			id: "tags-invalid-uppercase",
			input: ["Roles-Rework"],
			expectedOk: false,
			expectedErrorContains: "lowercase letters, digits, and dashes",
		},
		{
			id: "tags-invalid-spaces-or-underscores",
			input: ["roles_rework", "roles rework"],
			expectedOk: false,
			expectedErrorContains: "lowercase letters, digits, and dashes",
		},
		{
			id: "tags-invalid-leading-hyphen",
			input: ["-bad-start"],
			expectedOk: false,
			expectedErrorContains: "lowercase letters, digits, and dashes",
		},
		{
			id: "tags-invalid-too-long",
			input: ["a234567890123456789012345678901234567890123456789012345678901"],
			expectedOk: false,
			expectedErrorContains: "at most 60",
		},
		{
			id: "tags-invalid-non-array",
			input: "roles-rework",
			expectedOk: false,
			expectedErrorContains: "must be an array",
		},
	],
	tagPropagationFixtures: [
		{
			id: "queue-add-create-inherits-from-origin-turn",
			isUpdate: false,
			explicitTags: undefined,
			originInputs: [{ kind: "role_message", id: "rm-101", tags: ["roles-rework", "glanceability"] }],
			existingTaskTags: undefined,
			expectedStoredTags: ["roles-rework", "glanceability"],
		},
		{
			id: "queue-add-create-explicit-empty-prevents-inheritance",
			isUpdate: false,
			explicitTags: [] as string[],
			originInputs: [{ kind: "role_message", id: "rm-101", tags: ["roles-rework"] }],
			existingTaskTags: undefined,
			expectedStoredTags: [] as string[],
		},
		{
			id: "queue-add-update-omitted-preserves-existing",
			isUpdate: true,
			explicitTags: undefined,
			originInputs: [{ kind: "role_message", id: "rm-102", tags: ["unrelated-tag"] }],
			existingTaskTags: ["roles-rework", "touch-filter"],
			expectedStoredTags: ["roles-rework", "touch-filter"],
		},
		{
			id: "queue-add-update-explicit-empty-clears-existing",
			isUpdate: true,
			explicitTags: [] as string[],
			originInputs: [],
			existingTaskTags: ["roles-rework", "touch-filter"],
			expectedStoredTags: [] as string[],
		},
	],
	touchNormalizationFixtures: [
		{
			raw: "rollcall repo",
			expected: {
				raw: "rollcall repo",
				appOrSystem: "rollcall",
				repo: "rollcall",
				kind: "repo",
				shareable: true,
			},
		},
		{
			raw: "inkflow repo",
			expected: {
				raw: "inkflow repo",
				appOrSystem: "inkflow",
				repo: "inkflow",
				kind: "repo",
				shareable: true,
			},
		},
		{
			raw: "pi-web-ui repo",
			expected: {
				raw: "pi-web-ui repo",
				appOrSystem: "pi-web-ui",
				repo: "pi-web-ui",
				kind: "repo",
				shareable: true,
			},
		},
		{
			raw: "pi-web-deploy",
			expected: {
				raw: "pi-web-deploy",
				appOrSystem: "pi-web-ui",
				repo: "pi-web-ui",
				kind: "deploy",
				shareable: true,
			},
		},
		{
			raw: "temper-ai repo",
			expected: {
				raw: "temper-ai repo",
				appOrSystem: "temper",
				repo: "temper-ai",
				kind: "repo",
				shareable: true,
			},
		},
		{
			raw: "standee",
			expected: {
				raw: "standee",
				appOrSystem: "standee",
				kind: "service",
				shareable: false,
			},
		},
		{
			raw: "pi settings.json",
			expected: {
				raw: "pi settings.json",
				appOrSystem: "pi-agent",
				kind: "config",
				shareable: false,
			},
		},
		{
			raw: "roles-initiatives-rework contract folder",
			expected: {
				raw: "roles-initiatives-rework contract folder",
				appOrSystem: "roles-initiatives-rework",
				kind: "artifact",
				shareable: false,
			},
		},
	],
	lifecycleResolutionFixtures: [
		{
			id: "lifecycle-working-active-land",
			task: {
				id: 210,
				role: "frontend",
				status: "waiting",
				touches: ["pi-web-ui repo"],
				wait: {
					what: "wt land land-88f2a1",
					check: "wt land-status land-88f2a1",
					since: 1762540000000,
				},
			},
			wtLandRecord: {
				id: "land-88f2a1",
				repo: "pi-web-ui",
				status: "running" as const,
				headSha: "a1b2c3d4",
			},
			wtDeployRecord: null,
			expectedLifecycleStatus: "landing",
			expectedStatusTone: "landed",
		},
		{
			id: "lifecycle-done-landed-pending-deploy",
			task: {
				id: 211,
				role: "backend",
				status: "done",
				touches: ["pi-web-ui repo"],
				doneSummary: "Implemented tag & touch rollup builder. Landed commit 9f8e7d6c on main.",
			},
			wtLandRecord: {
				id: "land-9f8e7d",
				repo: "pi-web-ui",
				status: "succeeded" as const,
				landedSha: "9f8e7d6c5b4a3210",
			},
			wtDeployRecord: {
				repo: "pi-web-ui",
				targetBranch: "main",
				status: "succeeded" as const,
				commit: "1122334455667788",
				healthOk: true,
			},
			isLandedCommitAncestorOfLive: false,
			expectedLifecycleStatus: "landed",
			expectedStatusTone: "landed",
			expectedDeployPendingReason: "commit_behind",
		},
		{
			id: "lifecycle-deploying",
			task: {
				id: 212,
				role: "frontend",
				status: "done",
				touches: ["inkflow repo"],
				doneSummary: "Landed 44556677 on inkflow main; deploying.",
			},
			wtLandRecord: {
				id: "land-445566",
				repo: "inkflow",
				status: "succeeded" as const,
				landedSha: "445566778899aabb",
			},
			wtDeployRecord: {
				repo: "inkflow",
				targetBranch: "main",
				status: "deploying" as const,
				commit: "445566778899aabb",
			},
			isLandedCommitAncestorOfLive: true,
			expectedLifecycleStatus: "deploying",
			expectedStatusTone: "deploying",
		},
		{
			id: "lifecycle-live-verified",
			task: {
				id: 213,
				role: "frontend",
				status: "done",
				touches: ["inkflow repo"],
				doneSummary: "Landed 44556677 and deployed to inkflow-prod.",
			},
			wtLandRecord: {
				id: "land-445566",
				repo: "inkflow",
				status: "succeeded" as const,
				landedSha: "445566778899aabb",
			},
			wtDeployRecord: {
				repo: "inkflow",
				targetBranch: "main",
				status: "succeeded" as const,
				commit: "445566778899aabb",
				healthOk: true,
				healthCommit: "445566778899aabb",
			},
			isLandedCommitAncestorOfLive: true,
			expectedLifecycleStatus: "live",
			expectedStatusTone: "live",
		},
		{
			id: "lifecycle-done-non-code-artifact",
			task: {
				id: 498,
				role: "architecture",
				status: "done",
				touches: ["roles-initiatives-rework contract folder"],
				doneSummary: "Wrote CONTRACT.md and conformance-fixtures.json.",
			},
			wtLandRecord: null,
			wtDeployRecord: null,
			expectedLifecycleStatus: "done",
			expectedStatusTone: "live",
		},
	],
	groupRollupFixtures: [
		{
			id: "rollup-needs-you-wins",
			memberLifecycleStatuses: ["live", "working", "blocked", "stuck"] as UiTaskLifecycleStatus[],
			expectedRollupStatus: "needs_you",
			expectedStatusTone: "needs_you",
			expectedHasBlockedPeers: false,
		},
		{
			id: "rollup-stalled-when-blocked-and-zero-active",
			memberLifecycleStatuses: ["live", "done", "blocked", "queued"] as UiTaskLifecycleStatus[],
			expectedRollupStatus: "stalled",
			expectedStatusTone: "blocked",
			expectedHasBlockedPeers: false,
		},
		{
			id: "rollup-working-with-blocked-peers",
			memberLifecycleStatuses: ["done", "blocked", "working"] as UiTaskLifecycleStatus[],
			expectedRollupStatus: "working",
			expectedStatusTone: "working",
			expectedHasBlockedPeers: true,
		},
		{
			id: "rollup-deploying-beats-working-and-landing",
			memberLifecycleStatuses: ["working", "landing", "deploying"] as UiTaskLifecycleStatus[],
			expectedRollupStatus: "deploying",
			expectedStatusTone: "deploying",
			expectedHasBlockedPeers: false,
		},
		{
			id: "rollup-landed-pending-deploy-when-code-not-yet-live",
			memberLifecycleStatuses: ["done", "landed"] as UiTaskLifecycleStatus[],
			expectedRollupStatus: "landed_pending_deploy",
			expectedStatusTone: "landed",
			expectedHasBlockedPeers: false,
		},
		{
			id: "rollup-live-when-all-done-and-at-least-one-live",
			memberLifecycleStatuses: ["done", "live"] as UiTaskLifecycleStatus[],
			expectedRollupStatus: "live",
			expectedStatusTone: "live",
			expectedHasBlockedPeers: false,
		},
	],
	blockerAndWaitResolutionFixtures: [
		{
			id: "resolve-cross-queue-blocked-and-deadlock",
			currentRole: "frontend",
			blocked: {
				on: ["backend #412", "design #205", "ops #999"],
				need: "API schema and mockups",
				lead: "design",
				owes: "Show&Tell prototype link",
				since: 1762538000000,
				checkpointDueAt: 1762541600000,
				remindersSent: 1,
				nextReminderAt: 1762548800000,
			},
			now: 1762542000000,
			queuesSnapshot: {
				backend: {
					queueRunning: true,
					tasks: [{ id: 412, title: "Implement tag & touch projections", status: "in_progress", paused: false }],
				},
				design: {
					queueRunning: false,
					tasks: [{ id: 205, title: "Prototype Roles & Initiatives filter bar", status: "queued", paused: false }],
				},
				ops: {
					queueRunning: true,
					tasks: [],
				},
			},
			expectedResolvedOn: [
				{
					ref: "backend #412",
					role: "backend",
					taskId: 412,
					title: "Implement tag & touch projections",
					lifecycleStatus: "working",
					satisfied: false,
					paused: false,
					queueStopped: false,
				},
				{
					ref: "design #205",
					role: "design",
					taskId: 205,
					title: "Prototype Roles & Initiatives filter bar",
					lifecycleStatus: "queued",
					satisfied: false,
					paused: false,
					queueStopped: true,
					deadlockReason: "queue_stopped",
				},
				{
					ref: "ops #999",
					role: "ops",
					taskId: 999,
					satisfied: false,
					deadlockReason: "target_not_found",
				},
			],
			expectedUnsatisfiedCount: 3,
			expectedCheckpointOverdue: true,
			expectedDependsOnRefs: ["backend #412", "design #205", "ops #999"],
			expectedHowToUnblock:
				"How to unblock: Resume design's queue so design #205 can run, and have design lead provide Show&Tell prototype link",
		},
	],
};

afterEach(() => {
	document.body.innerHTML = "";
	document.head.innerHTML = "";
});

describe("Tasks & Roles v8 client module (Task #240)", () => {
	it("completes the full happy-path journey across All Department Tasks, 4 filterable dropdowns, Tag DAG, Roles Bento view, Why modal, and Dark/Light themes", () => {
		const container = document.createElement("div");
		document.body.appendChild(container);

		const onAnswerQuestion = vi.fn();
		const controller = mountTasksRolesV8Surface(container, {
			dataset: createReferenceDataset(),
			syncDocumentTheme: true,
			onAnswerQuestion,
		});

		// 1. Global buildTaskDag attached to window
		expect(typeof (window as unknown as { buildTaskDag?: unknown }).buildTaskDag).toBe("function");

		// 2. Zero forbidden data-state or data-st-state attributes below html/body
		expect(container.querySelectorAll("[data-state], [data-st-state]").length).toBe(0);

		// 3. Attention note bar counts & 1-click toggles
		const noteBar = container.querySelector(".attention-note-bar");
		expect(noteBar).not.toBeNull();
		expect(noteBar?.textContent).toContain("4 tasks need attention:");
		expect(noteBar?.textContent).toContain("1 Needs you");
		expect(noteBar?.textContent).toContain("2 Blocked / Waiting");
		expect(noteBar?.textContent).toContain("1 Asking lead");

		// 4. All 14 tasks rendered as 2-tier cards in recessed .unified-task-list
		const initialRows = container.querySelectorAll(".unified-task-item");
		expect(initialRows.length).toBe(14);
		const firstRow = initialRows[0] as HTMLElement;
		expect(firstRow.getAttribute("data-task-id")).toBe("221");
		expect(firstRow.getAttribute("data-status-tone")).toBe("needs_you");
		expect(firstRow.querySelector(".dept-identity-tile")).not.toBeNull();
		expect(firstRow.querySelector(".dept-monogram")?.textContent).toBe("DE");
		expect(firstRow.querySelector(".task-id-keycap")?.textContent).toBe("#221");
		expect(firstRow.querySelector(".app-well-pill")?.textContent).toBe("RollCall");
		expect(firstRow.querySelector(".on-you-badge")?.textContent).toBe("ON YOU");
		expect(firstRow.querySelector(".status-badge svg")).not.toBeNull();
		expect(firstRow.querySelector(".task-card-bottom .task-col-summary")?.textContent).toContain("How to unblock:");

		// 5. Click 1-click "Filter to needs attention (4)"
		const attnBtn = container.querySelector<HTMLButtonElement>("#filter-needs-attention-btn");
		expect(attnBtn).not.toBeNull();
		attnBtn?.click();
		expect(container.querySelectorAll(".unified-task-item").length).toBe(4);

		// Click "Only Needs you (1)"
		const onlyOnYouBtn = container.querySelector<HTMLButtonElement>("#filter-only-on-you-btn");
		onlyOnYouBtn?.click();
		expect(container.querySelectorAll(".unified-task-item").length).toBe(1);

		// Clear attention filter back to all 14
		container.querySelector<HTMLButtonElement>("#clear-attention-filter-btn")?.click();
		expect(container.querySelectorAll(".unified-task-item").length).toBe(14);

		// 6. Verify 4 filterable dropdowns with in-menu search
		const dropdowns = container.querySelectorAll("details.filter-dd[data-filter-dropdown]");
		expect(dropdowns.length).toBe(4);
		const deptSearch = container.querySelector<HTMLInputElement>('.filter-dd-search[data-dd-search="dept"]');
		expect(deptSearch).not.toBeNull();
		if (deptSearch) {
			deptSearch.value = "front";
			deptSearch.dispatchEvent(new Event("input", { bubbles: true }));
		}
		const deptItems = container.querySelectorAll(".dept-filter-btn");
		expect(deptItems.length).toBe(1);
		expect(deptItems[0]?.getAttribute("data-dept-id")).toBe("frontend");

		// Select Frontend department filter -> 3 tasks
		(deptItems[0] as HTMLButtonElement).click();
		expect(container.querySelectorAll(".unified-task-item").length).toBe(3);

		// Reset filters -> back to 14 tasks
		container.querySelector<HTMLButtonElement>("#reset-all-filters-bar-btn")?.click();
		expect(container.querySelectorAll(".unified-task-item").length).toBe(14);

		// 7. Universal search input (#id, dept, app, tag, title)
		const searchInput = container.querySelector<HTMLInputElement>("#task-search-input");
		expect(searchInput).not.toBeNull();
		if (searchInput) {
			searchInput.value = "#224";
			searchInput.dispatchEvent(new Event("input", { bubbles: true }));
		}
		expect(container.querySelectorAll(".unified-task-item").length).toBe(1);
		expect(container.querySelector(".unified-task-item")?.getAttribute("data-task-id")).toBe("224");
		if (searchInput) {
			searchInput.value = "";
			searchInput.dispatchEvent(new Event("input", { bubbles: true }));
		}
		expect(container.querySelectorAll(".unified-task-item").length).toBe(14);

		// 8. Expand task details drawer & answer inline stuck question on #221
		const toggle221 = container.querySelector<HTMLButtonElement>('.task-detail-toggle-btn[data-task-id="221"]');
		toggle221?.click();
		const drawer221 = container.querySelector('[data-task-detail="221"]');
		expect(drawer221).not.toBeNull();
		expect(drawer221?.textContent).toContain("Waiting on your decision");
		const choiceBtn = drawer221?.querySelector<HTMLButtonElement>(".answer-choice-btn");
		expect(choiceBtn).not.toBeNull();
		choiceBtn?.click();
		expect(onAnswerQuestion).toHaveBeenCalledWith(221, "Group by ticker (Recommended)");
		expect(container.querySelector('[data-task-detail="221"]')?.textContent).toContain("Answered by you");

		// 9. Open 1-click Tag Implementation DAG (#mobile-redesign)
		const openDagBtn = container.querySelector<HTMLButtonElement>('[data-open-tag-dag="mobile-redesign"]');
		expect(openDagBtn).not.toBeNull();
		openDagBtn?.click();

		const dagRegion = container.querySelector("#tag-dag-region");
		expect(dagRegion).not.toBeNull();
		expect(dagRegion?.getAttribute("data-ask-card")).toBe("tag:mobile-redesign");
		expect(dagRegion?.querySelectorAll("[data-dag-stage-col]").length).toBe(3);
		expect(dagRegion?.textContent).toContain("Stage 1 · Root & Foundations");
		expect(dagRegion?.textContent).toContain("Stage 2 · Parallel Build & Rollout");
		expect(dagRegion?.textContent).toContain("Stage 3 · Verify & Ship");

		const dagEdges = dagRegion?.querySelectorAll("svg.dag-edges-svg path.dag-edge") ?? [];
		expect(dagEdges.length).toBeGreaterThanOrEqual(4);
		for (const edge of dagEdges) {
			const d = edge.getAttribute("d") ?? "";
			expect(d).toMatch(/^M\s+-?\d+.*C\s+/);
		}

		// Filter DAG by department station in handoff strip
		const feStation = dagRegion?.querySelector<HTMLButtonElement>('.handoff-step[data-step-role="frontend"]');
		feStation?.click();
		expect(container.querySelectorAll("#tag-dag-region [data-dag-node]").length).toBe(2);
		container.querySelector<HTMLButtonElement>(".clear-handoff-btn")?.click();
		expect(container.querySelectorAll("#tag-dag-region [data-dag-node]").length).toBe(7);

		// 10. Switch to Roles & Queues Bento view
		container.querySelector<HTMLButtonElement>("#tab-roles")?.click();
		const roleCards = container.querySelectorAll("[data-role-card]");
		expect(roleCards.length).toBe(6);
		expect(container.querySelectorAll("[data-role-card] .dept-monogram").length).toBe(6);
		expect(container.querySelectorAll(".roles-lane-pills").length).toBe(6);

		// Expand a department queue in Roles view
		container.querySelector<HTMLButtonElement>('.role-toggle-btn[data-role-id="frontend"]')?.click();
		expect(container.querySelector('[data-role-card="frontend"]')?.getAttribute("data-role-expanded")).toBe("true");

		// Expand idle departments footer bar
		const idleBtn = container.querySelector<HTMLButtonElement>("#toggle-idle-btn");
		expect(idleBtn?.getAttribute("aria-expanded")).toBe("false");
		idleBtn?.click();
		expect(container.querySelector(".idle-list")?.textContent).toContain("Product:");

		// 11. Why modal hidden by default, opens and closes cleanly
		const whyModal = container.querySelector("#why-modal");
		expect(whyModal?.hasAttribute("hidden")).toBe(true);
		container.querySelector<HTMLButtonElement>("#why-modal-btn")?.click();
		expect(container.querySelector("#why-modal")?.hasAttribute("hidden")).toBe(false);
		container.querySelector<HTMLButtonElement>("#why-modal-close-btn")?.click();
		expect(container.querySelector("#why-modal")?.hasAttribute("hidden")).toBe(true);

		// 12. Theme toggle switches dark <-> light and preserves zero forbidden attributes
		expect(controller.getState().theme).toBe("dark");
		container.querySelector<HTMLButtonElement>("#theme-toggle")?.click();
		expect(controller.getState().theme).toBe("light");
		expect(document.documentElement.getAttribute("data-theme")).toBe("light");
		expect(container.querySelectorAll("[data-state], [data-st-state]").length).toBe(0);

		// 13. Design token & font-floor / target-floor checks in TASKS_ROLES_V8_CSS
		expect(TASKS_ROLES_V8_CSS).toContain("--bg-canvas: #0E0F11");
		expect(TASKS_ROLES_V8_CSS).toContain("--card-well-bg: #101215");
		expect(TASKS_ROLES_V8_CSS).toContain("linear-gradient(180deg, #1A1D22 0%, #14171B 100%)");
		expect(TASKS_ROLES_V8_CSS).toContain("--on-you-bg: #F0B95A");
		expect(TASKS_ROLES_V8_CSS).toContain("min-height: 30px");

		controller.destroy();
	});

	it("passes 100% of Architecture CONTRACT.md v4 conformance-fixtures.json cases", () => {
		const fixtures = fs.existsSync(EXTERNAL_CONFORMANCE_PATH)
			? JSON.parse(fs.readFileSync(EXTERNAL_CONFORMANCE_PATH, "utf-8"))
			: INLINE_CONFORMANCE_FIXTURES;

		expect(fixtures.schemaVersion ?? fixtures.version).toBeTruthy();

		// 1. Tag validation fixtures (8 cases)
		for (const item of fixtures.tagValidationFixtures) {
			const rawInput = item.omitted ? undefined : item.input;
			const expectedOk = item.expected ? item.expected.ok : item.expectedOk;
			const expectedValue = item.expected ? item.expected.value : item.expectedValue;
			const expectedErr = item.expected ? item.expected.errorSubstring : item.expectedErrorContains;
			const res = checkTags(rawInput);
			expect(res.ok, item.id).toBe(expectedOk);
			if (expectedOk) {
				if (res.ok) {
					expect(res.value, item.id).toEqual(expectedValue);
				}
			} else if (!res.ok) {
				expect(res.error.toLowerCase(), item.id).toContain(String(expectedErr).toLowerCase());
			}
		}

		// 2. Tag propagation fixtures (4 cases)
		for (const item of fixtures.tagPropagationFixtures) {
			const isUpdate = item.isUpdate ?? Boolean(item.queueAddUpdateParams);
			const explicitTags =
				item.explicitTags !== undefined
					? item.explicitTags
					: (item.queueAddParams?.tags ?? item.queueAddUpdateParams?.tags);
			const stored = resolveQueueTaskTags({
				isUpdate,
				explicitTags,
				originInputs: item.originInputs,
				existingTaskTags: item.existingTaskTags,
			});
			expect(stored, item.id).toEqual(item.expectedStoredTags);
		}

		// 3. Touch normalization fixtures (8 cases)
		for (const item of fixtures.touchNormalizationFixtures) {
			const normalized = normalizeTouch(item.raw);
			expect(normalized, item.raw).toEqual(item.expected);
		}

		// 4. Lifecycle resolution fixtures (5 cases)
		for (const item of fixtures.lifecycleResolutionFixtures) {
			const resolved = resolveTaskLifecycleStatus({
				task: item.task,
				wtLandRecord: item.wtLandRecord,
				wtDeployRecord: item.wtDeployRecord,
				isLandedCommitAncestorOfLive: item.isLandedCommitAncestorOfLive,
			});
			expect(resolved.lifecycleStatus, item.id).toBe(item.expectedLifecycleStatus);
			if (item.expectedStatusTone) {
				expect(resolved.statusTone, item.id).toBe(item.expectedStatusTone);
			}
			if (item.expectedDeployPendingReason) {
				expect(resolved.delivery?.deployPendingReason, item.id).toBe(item.expectedDeployPendingReason);
			}
		}

		// 5. Group rollup fixtures (6 cases)
		for (const item of fixtures.groupRollupFixtures) {
			const tasks = item.memberLifecycleStatuses.map((lifecycleStatus: UiTaskLifecycleStatus, idx: number) => ({
				id: idx + 1,
				lifecycleStatus,
			}));
			const rollup = computeGroupRollup(tasks, { key: item.id, kind: "tag" });
			expect(rollup.rollupStatus, item.id).toBe(item.expectedRollupStatus);
			expect(rollup.statusTone, item.id).toBe(item.expectedStatusTone);
			if (item.expectedHasBlockedPeers !== undefined) {
				expect(rollup.hasBlockedPeers, item.id).toBe(item.expectedHasBlockedPeers);
			}
		}

		// 6. Blocker and wait resolution fixtures
		for (const item of fixtures.blockerAndWaitResolutionFixtures) {
			const resolved = resolveBlockedDependencies({
				currentRole: item.currentRole,
				blocked: item.blocked,
				now: item.now,
				queuesSnapshot: item.queuesSnapshot,
			});
			expect(resolved.resolvedOn, item.id).toEqual(item.expectedResolvedOn);
			expect(resolved.unsatisfiedCount, item.id).toBe(item.expectedUnsatisfiedCount);
			expect(resolved.checkpointOverdue, item.id).toBe(item.expectedCheckpointOverdue);
			expect(resolved.dependsOnRefs, item.id).toEqual(item.expectedDependsOnRefs);
			expect(resolved.howToUnblock, item.id).toBe(item.expectedHowToUnblock);
		}
	});

	it("reconstructs multi-stage DAG columns, reverse unlocksRefs, rootBlockerRefs, and cubic bezier paths in buildTaskDag", () => {
		const mobileAsk = V8_REFERENCE_DATASET.askGroups.find((g) => g.key === "tag:mobile-redesign")!;
		const allTasks = V8_REFERENCE_DATASET.tasks;
		const ops765 = allTasks.find((t) => t.id === 765)!;
		const dagTasks = [...(mobileAsk.tasks ?? []), ops765];

		const dag = buildTaskDag(dagTasks, allTasks);
		expect(dag.stages.length).toBe(3);
		expect(dag.stages[0]?.stageLabel).toBe("Stage 1 · Root & Foundations");
		expect(dag.stages[1]?.stageLabel).toBe("Stage 2 · Parallel Build & Rollout");
		expect(dag.stages[2]?.stageLabel).toBe("Stage 3 · Verify & Ship");

		// Stage 0 roots: #221 (stuck), #410 (live), #218 (done), #765 (paused)
		expect(dag.byId.get(221)?.stageIndex).toBe(0);
		expect(dag.byId.get(221)?.isRootBlocker).toBe(true);
		expect(dag.byId.get(221)?.unlocksRefs).toContain("frontend #231");

		// Stage 1: #230 (depends on #218, #410) and #231 (depends on #221, #765)
		expect(dag.byId.get(230)?.stageIndex).toBe(1);
		expect(dag.byId.get(230)?.unlocksRefs).toContain("qa #355");
		expect(dag.byId.get(231)?.stageIndex).toBe(1);
		expect(dag.byId.get(231)?.isRootBlocker).toBe(false);

		// Stage 2: #355 (depends on #230)
		expect(dag.byId.get(355)?.stageIndex).toBe(2);
		expect(dag.rootBlockerRefs).toEqual(["design #221", "ops #765"]);

		// Horizontal and vertical cubic bezier paths
		const horiz = computeBezierPath(
			{ left: 20, right: 220, top: 40, bottom: 120 },
			{ left: 300, right: 500, top: 60, bottom: 140 },
			{ left: 0, top: 0 },
		);
		expect(horiz).toMatch(/^M\s+220\s+66\s+C\s+\d+\s+66,\s+\d+\s+86,\s+300\s+86$/);

		const vert = computeBezierPath(
			{ left: 20, right: 220, top: 40, bottom: 120 },
			{ left: 20, right: 220, top: 180, bottom: 260 },
			{ left: 0, top: 0 },
		);
		expect(vert).toMatch(/^M\s+46\s+120\s+C\s+46\s+\d+,\s+46\s+\d+,\s+46\s+180$/);
	});

	it("renders all 12 UiTaskLifecycleStatus badges, callouts, and 5-step delivery pipeline meters", () => {
		const allTwelveStatuses: UiTaskLifecycleStatus[] = [
			"stuck",
			"asking",
			"blocked",
			"waiting",
			"paused",
			"queued",
			"working",
			"landing",
			"landed",
			"deploying",
			"live",
			"done",
		];

		for (const status of allTwelveStatuses) {
			const badgeHtml = renderStatusBadge(status, false);
			expect(badgeHtml).toContain(`data-task-status="${status}"`);
			expect(badgeHtml).toContain(STATUS_META[status].label);
			expect(badgeHtml).toContain("<svg");
		}

		// Verify urgency sorting order across all 12 states
		const shuffled: Array<{ id: number; lifecycleStatus: UiTaskLifecycleStatus }> = allTwelveStatuses
			.slice()
			.reverse()
			.map((lifecycleStatus, idx) => ({ id: idx + 1, lifecycleStatus }));
		const sorted = sortTasksByUrgency(shuffled);
		expect(sorted.map((s) => s.lifecycleStatus)).toEqual([
			"stuck",
			"blocked",
			"waiting",
			"asking",
			"paused",
			"deploying",
			"landing",
			"landed",
			"working",
			"queued",
			"live",
			"done",
		]);
		expect(Object.keys(TASK_URGENCY_RANK).length).toBe(13);

		// Verify callouts across reference tasks covering all 12 states
		const allCalloutHtml = V8_REFERENCE_DATASET.tasks.map((t) => renderTaskCallouts(t)).join("\n");
		expect(allCalloutHtml).toContain("Waiting on your decision");
		expect(allCalloutHtml).toContain("Asking Frontend Lead");
		expect(allCalloutHtml).toContain("To unblock:");
		expect(allCalloutHtml).toContain("Blocker ops #765 is in a paused queue");
		expect(allCalloutHtml).toContain("Waiting for:");
		expect(allCalloutHtml).toContain("Overdue (44m elapsed vs 30m expected)");
		expect(allCalloutHtml).toContain("Starts when:");
		expect(allCalloutHtml).toContain("⏸ Paused:");
		expect(allCalloutHtml).toContain("Landing on pi-web-ui:");
		expect(allCalloutHtml).toContain("Landed on master:");
		expect(allCalloutHtml).toContain("Deploying now:");
		expect(allCalloutHtml).toContain("Live in production:");
		expect(allCalloutHtml).toContain("Completed deliverable:");

		// 5-step delivery meter
		for (const st of ["working", "landing", "landed", "deploying", "live"] as const) {
			const meterHtml = renderDeliveryPipelineMeter({ lifecycleStatus: st });
			expect(meterHtml).toContain("1.Work");
			expect(meterHtml).toContain("2.Land");
			expect(meterHtml).toContain("3.Master");
			expect(meterHtml).toContain("4.Deploy");
			expect(meterHtml).toContain("5.Live");
			expect(meterHtml).toContain("pipe-step current");
		}
	});

	it("supports Match ANY / Match ALL multi-tag filtering, backward-compatible UiRolesOverview derivation, and fail-fast boundary validation", () => {
		const dataset = createReferenceDataset();
		const stateAny = createInitialFilterState({
			selectedTags: ["mobile-redesign", "alerts-tab"],
			tagMatchMode: "any",
		});
		const stateAll = createInitialFilterState({
			selectedTags: ["mobile-redesign", "alerts-tab"],
			tagMatchMode: "all",
		});

		const anyMatches = dataset.tasks.filter((t) => matchesTaskFilters(t, stateAny));
		const allMatches = dataset.tasks.filter((t) => matchesTaskFilters(t, stateAll));
		expect(anyMatches.length).toBe(7); // 6 mobile-redesign + 1 ops #765 (has alerts-tab)
		expect(allMatches.length).toBe(2); // #221 and #231 have both mobile-redesign and alerts-tab

		// Dropdown model in-place search filtering
		const dd = buildFilterDropdownModels({
			tasks: dataset.tasks,
			departments: dataset.departments,
			touchSystems: dataset.touchSystems,
			allTags: dataset.allTags,
			state: createInitialFilterState({
				ddSearch: { dept: "qa", app: "ink", state: "live", tag: "roles" },
			}),
		});
		expect(dd.dept.options.map((o) => o.id)).toEqual(["qa"]);
		expect(dd.app.options.map((o) => o.id)).toEqual(["inkflow"]);
		expect(dd.state.options.map((o) => o.id)).toEqual(["live_done"]);
		expect(dd.tag.options.map((o) => o.id)).toEqual(["roles-rework"]);

		// Backward-compatible fallback derivation from legacy UiRolesOverview
		const legacyOverview = {
			generatedAt: 1762542000000,
			roles: [
				{
					id: "frontend",
					title: "Frontend",
					status: "busy" as const,
					queue: {
						running: true,
						lanes: { inUse: 1, atOnce: 2 },
						active: [
							{
								id: 240,
								title: "Build Tasks & Roles v8 client module",
								status: "working" as const,
								waitsOn: "wt land",
							},
						],
						queued: [],
						counts: { active: 1, queued: 0, done: 0 },
					},
				},
			],
		};
		const derived = deriveV8DatasetFromRolesOverview(legacyOverview);
		expect(derived.tasks.length).toBe(1);
		expect(derived.tasks[0]?.lifecycleStatus).toBe("working");
		expect(derived.tasks[0]?.appOrSystem).toBe("pi-web-ui");
		expect(derived.tasks[0]?.tags).toEqual(["general"]);
		expect(normalizeTouches(["pi-web-ui repo", "pi-web-deploy"]).length).toBe(2);

		// Fail-fast boundary validation (Rule 36)
		expect(() => normalizeTouch("")).toThrow(/non-empty string/);
		expect(() => buildTaskDag("bad" as unknown as UiRoleTask[])).toThrow(/array/);
		expect(() => sortTasksByUrgency(null as unknown as UiRoleTask[])).toThrow(/array/);
		expect(() => computeAttentionSummary(null as unknown as UiRoleTask[])).toThrow(/array/);
		expect(() => mountTasksRolesV8Surface(null as unknown as HTMLElement)).toThrow(/HTMLElement/);
	});
});
