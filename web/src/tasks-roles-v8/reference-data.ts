import {
	statusToneForLifecycle,
	type TasksRolesV8Dataset,
	type UiGroupRollupStatus,
	type UiRoleTask,
	type UiTaskGroupRollup,
	type UiTaskLifecycleStatus,
	type V8DepartmentSummary,
	type V8TagOption,
} from "./types";

export interface StatusMetaEntry {
	label: string;
	icon: string;
	cls: string;
	family: "hold" | "exec";
}

export const STATUS_META: Readonly<Record<UiTaskLifecycleStatus, StatusMetaEntry>> = {
	stuck: { label: "Needs you", icon: "!", cls: "status-stuck", family: "hold" },
	asking: { label: "Asking lead", icon: "?", cls: "status-asking", family: "hold" },
	blocked: { label: "Blocked", icon: "⊗", cls: "status-blocked", family: "hold" },
	waiting: { label: "Waiting", icon: "◔", cls: "status-waiting", family: "hold" },
	paused: { label: "Paused by you", icon: "⏸", cls: "status-paused", family: "hold" },
	queued: { label: "Queued", icon: "○", cls: "status-queued", family: "hold" },
	working: { label: "Working", icon: "●", cls: "status-working", family: "exec" },
	landing: { label: "Landing", icon: "↑", cls: "status-landing", family: "exec" },
	landed: { label: "Landed · not deployed", icon: "✓·", cls: "status-landed", family: "exec" },
	deploying: { label: "Deploying", icon: "⚡", cls: "status-deploying", family: "exec" },
	live: { label: "Live / Deployed", icon: "✓✓", cls: "status-live", family: "exec" },
	done: { label: "Done (no deploy)", icon: "✓", cls: "status-done", family: "exec" },
	dropped: { label: "Dropped", icon: "✕", cls: "status-done", family: "hold" },
};

export const ROLLUP_META: Readonly<
	Record<UiGroupRollupStatus | "blocked" | "waiting", { label: string; icon: string; cls: string; tone: string }>
> = {
	needs_you: { label: "Needs you", icon: "!", cls: "status-needs_you", tone: "needs_you" },
	needs_lead: { label: "Asking lead", icon: "?", cls: "status-needs_lead", tone: "needs_lead" },
	blocked: { label: "Blocked", icon: "⊗", cls: "status-blocked", tone: "blocked" },
	waiting: { label: "Waiting", icon: "◔", cls: "status-waiting", tone: "waiting" },
	stalled: { label: "Waiting / Blocked", icon: "◔", cls: "status-waiting", tone: "waiting" },
	deploying: { label: "Deploying", icon: "⚡", cls: "status-deploying", tone: "active" },
	landing: { label: "Landing", icon: "↑", cls: "status-landing", tone: "active" },
	working: { label: "Working", icon: "●", cls: "status-working", tone: "active" },
	landed_pending_deploy: {
		label: "Landed · awaiting deploy",
		icon: "✓·",
		cls: "status-landed_pending_deploy",
		tone: "landed",
	},
	queued: { label: "Queued", icon: "○", cls: "status-queued", tone: "queued" },
	paused: { label: "Paused by you", icon: "⏸", cls: "status-paused", tone: "paused" },
	live: { label: "Live / Deployed", icon: "✓✓", cls: "status-live", tone: "live" },
	done: { label: "Done (no deploy)", icon: "✓", cls: "status-done", tone: "live" },
	dropped: { label: "Dropped", icon: "✕", cls: "status-done", tone: "dropped" },
};

export function escapeHtml(str: unknown): string {
	return String(str ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

const TOUCH_SYSTEMS = [
	{ id: "all", label: "All apps", count: 14 },
	{ id: "rollcall", label: "RollCall", count: 6 },
	{ id: "pi-web-ui", label: "Pi Web UI", count: 4 },
	{ id: "inkflow", label: "Inkflow", count: 3 },
	{ id: "temper", label: "Temper", count: 1 },
];

const ALL_TAGS: V8TagOption[] = [
	{ id: "mobile-redesign", label: "#mobile-redesign", touches: ["rollcall"] },
	{ id: "positions-card", label: "#positions-card", touches: ["rollcall"] },
	{ id: "alerts-tab", label: "#alerts-tab", touches: ["rollcall"] },
	{ id: "roles-rework", label: "#roles-rework", touches: ["pi-web-ui"] },
	{ id: "wt-deploy", label: "#wt-deploy", touches: ["pi-web-ui"] },
	{ id: "onboarding-flow", label: "#onboarding-flow", touches: ["inkflow"] },
	{ id: "app-screen-wf", label: "#app-screen-wf", touches: ["temper"] },
];

const DEPARTMENTS_META: V8DepartmentSummary[] = [
	{ id: "design", title: "Design", inUse: 2, atOnce: 2, queueRunning: true },
	{ id: "frontend", title: "Frontend", inUse: 2, atOnce: 2, queueRunning: true },
	{ id: "backend", title: "Backend", inUse: 1, atOnce: 2, queueRunning: true },
	{ id: "qa", title: "QA", inUse: 1, atOnce: 2, queueRunning: true },
	{ id: "ops", title: "Ops", inUse: 0, atOnce: 2, queueRunning: true },
	{ id: "architecture", title: "Architecture", inUse: 0, atOnce: 2, queueRunning: true },
];

const IDLE_DEPARTMENTS = [
	{ id: "product", title: "Product", note: "0 active tasks · All clear" },
	{ id: "marketing", title: "Marketing", note: "0 active tasks · All clear" },
	{ id: "docs", title: "Docs", note: "0 active tasks · All clear" },
	{ id: "data", title: "Data", note: "0 active tasks · All clear" },
	{ id: "security", title: "Security", note: "0 active tasks · All clear" },
	{ id: "systems", title: "Systems", note: "0 active tasks · All clear" },
	{ id: "coo", title: "COO", note: "0 active tasks · All clear" },
	{ id: "rollcall", title: "RollCall", note: "0 active tasks · All clear" },
];

export function createReferenceDataset(): TasksRolesV8Dataset {
	const askGroups: UiTaskGroupRollup[] = [
		{
			key: "tag:mobile-redesign",
			kind: "tag",
			title: "RollCall Mobile Positions & Alerts Redesign",
			whySummary:
				"Grouped automatically by shared #mobile-redesign tag so you can track Design -> Backend -> Frontend -> QA in one place.",
			appOrSystem: "rollcall",
			appLabel: "RollCall",
			tags: ["mobile-redesign", "positions-card", "alerts-tab"],
			rollupStatus: "needs_you",
			statusTone: "needs_you",
			hasBlockedPeers: true,
			rootBlockerRef: "design #221",
			howToUnblock: "Pick alert grouping on Design #221 above + resume paused Ops #765 → unlocks Frontend #231.",
			totalTasks: 6,
			countsByStatus: { stuck: 1, live: 1, deploying: 1, blocked: 1, queued: 1, done: 1 },
			roles: ["backend", "design", "frontend", "qa"],
			appsOrSystems: ["rollcall"],
			updatedAt: 1762542000000,
			handoff: [
				{ role: "design", roleTitle: "Design", status: "stuck", summary: "! Needs you (#221)" },
				{ role: "backend", roleTitle: "Backend", status: "live", summary: "✓✓ Live (91c4b102)" },
				{ role: "frontend", roleTitle: "Frontend", status: "deploying", summary: "⚡ Deploying (#230)" },
				{ role: "qa", roleTitle: "QA", status: "queued", summary: "○ Queued (#355)" },
			],
			tasks: [
				{
					id: 221,
					role: "design",
					roleTitle: "Design",
					title: "Alerts tab empty & triggered states prototype",
					status: "stuck",
					lifecycleStatus: "stuck",
					statusTone: statusToneForLifecycle("stuck"),
					appOrSystem: "rollcall",
					appLabel: "RollCall",
					tags: ["mobile-redesign", "alerts-tab"],
					dependsOnRefs: [],
					howToUnblock:
						"Pick alert grouping option in Details ▸ (Group by ticker recommended) to unblock Frontend #231",
					latestTldr: {
						text: "Need your pick on how triggered alerts group on phone",
						age: "12m ago",
					},
					stuck: {
						question:
							"When multiple price alerts trigger on the same ticker, should the phone card group them into one row or list each alert separately?",
						age: "12m ago",
						choices: ["Group by ticker (Recommended)", "List every alert row", "Group only after 3+ alerts"],
					},
					createdAt: 1762538000000,
					updatedAt: 1762542000000,
				},
				{
					id: 410,
					role: "backend",
					roleTitle: "Backend",
					title: "Positions summary & roll-up endpoint",
					status: "done",
					lifecycleStatus: "live",
					statusTone: statusToneForLifecycle("live"),
					pipelineStage: 5,
					appOrSystem: "rollcall",
					appLabel: "RollCall",
					tags: ["mobile-redesign", "positions-card"],
					dependsOnRefs: [],
					latestTldr: {
						text: "Live on rollcall service — verified response under 35ms",
						age: "28m ago",
					},
					delivery: {
						repo: "rollcall",
						deployableService: true,
						liveCommit: "91c4b102",
						deployedAge: "28m ago",
					},
					createdAt: 1762536000000,
					updatedAt: 1762541000000,
				},
				{
					id: 230,
					role: "frontend",
					roleTitle: "Frontend",
					title: "Build compact mobile positions card & drawer",
					status: "done",
					lifecycleStatus: "deploying",
					statusTone: statusToneForLifecycle("deploying"),
					pipelineStage: 4,
					appOrSystem: "rollcall",
					appLabel: "RollCall",
					tags: ["mobile-redesign", "positions-card"],
					dependsOnRefs: ["design #218", "backend #410"],
					latestTldr: { text: "Landed 45a2581e, rolling out to rollcall web", age: "3m ago" },
					delivery: {
						repo: "rollcall",
						deployableService: true,
						landedCommit: "45a2581e",
						deployingAge: "3m elapsed",
					},
					createdAt: 1762537000000,
					updatedAt: 1762541800000,
				},
				{
					id: 231,
					role: "frontend",
					roleTitle: "Frontend",
					title: "Wire triggered alert badges into mobile header",
					status: "blocked",
					lifecycleStatus: "blocked",
					statusTone: statusToneForLifecycle("blocked"),
					appOrSystem: "rollcall",
					appLabel: "RollCall",
					tags: ["mobile-redesign", "alerts-tab"],
					dependsOnRefs: ["design #221", "ops #765"],
					howToUnblock: "Answer Design #221 alert grouping choice + resume paused Ops #765 test fixture seed",
					latestTldr: { text: "Waiting on Design #221 alert grouping choice", age: "11m ago" },
					blocked: {
						unblockSummary: "Needs Design #221 approved layout + Ops #765 test fixture seed",
						howToUnblock: "Answer Design #221 alert grouping choice + resume paused Ops #765 test fixture seed",
						unsatisfiedCount: 2,
						sinceAt: 1762538000000,
						lead: "design",
						owes: "Approved alerts grouping spec",
						dueIn: "Due in 18m (1 reminder sent)",
						haltedWarning: "⚠ Blocker ops #765 is in a paused queue — cannot run until ops #765 is resumed.",
						resolvedOn: [
							{
								ref: "design #221",
								title: "Alerts tab prototype",
								status: "stuck",
								lifecycleStatus: "stuck",
								satisfied: false,
							},
							{
								ref: "ops #765",
								title: "Seed alert test account",
								status: "paused",
								lifecycleStatus: "paused",
								satisfied: false,
								halted: "Task paused by you",
							},
						],
					},
					createdAt: 1762537500000,
					updatedAt: 1762541500000,
				},
				{
					id: 355,
					role: "qa",
					roleTitle: "QA",
					title: "Phone viewport & touch-target verification on Positions card",
					status: "queued",
					lifecycleStatus: "queued",
					statusTone: statusToneForLifecycle("queued"),
					appOrSystem: "rollcall",
					appLabel: "RollCall",
					tags: ["mobile-redesign", "positions-card"],
					dependsOnRefs: ["frontend #230"],
					howToUnblock: "Starts automatically once Frontend #230 finishes deploying (45a2581e)",
					latestTldr: {
						text: "Queued next in line once Frontend #230 finishes deploying",
						age: "4m ago",
					},
					queuedDetail: {
						reason: "after",
						summary: "Starts when frontend #230 finishes deploying",
						resolvedAfter: [
							{
								ref: "frontend #230",
								title: "Mobile positions card",
								status: "deploying",
								lifecycleStatus: "deploying",
								satisfied: false,
							},
						],
					},
					createdAt: 1762538500000,
					updatedAt: 1762541600000,
				},
				{
					id: 218,
					role: "design",
					roleTitle: "Design",
					title: "Positions card visual hierarchy & token spec",
					status: "done",
					lifecycleStatus: "done",
					statusTone: statusToneForLifecycle("done"),
					appOrSystem: "rollcall",
					appLabel: "RollCall",
					tags: ["mobile-redesign", "positions-card"],
					dependsOnRefs: [],
					latestTldr: {
						text: "Spec handed off to Frontend; no service deploy needed",
						age: "1h ago",
					},
					doneSummary: "Completed design spec & Penpot tokens (design deliverable — no deploy step)",
					createdAt: 1762534000000,
					updatedAt: 1762539000000,
				},
			],
		},
		{
			key: "tag:roles-rework",
			kind: "tag",
			title: "Roles & Initiatives Glanceability Rework",
			whySummary:
				"Shows every stage from Architecture contract -> Design prototype -> Backend snapshot -> Frontend UI.",
			appOrSystem: "pi-web-ui",
			appLabel: "Pi Web UI",
			tags: ["roles-rework", "wt-deploy"],
			rollupStatus: "landing",
			statusTone: "landed",
			hasBlockedPeers: false,
			rootBlockerRef: null,
			howToUnblock:
				"Wait ~2m for Backend #512 merge check (7f8e9a0b), then pi-web-deploy ships Ops #760 + Backend #512.",
			totalTasks: 4,
			countsByStatus: { done: 1, working: 1, landing: 1, landed: 1 },
			roles: ["architecture", "backend", "design", "ops"],
			appsOrSystems: ["pi-web-ui"],
			updatedAt: 1762541900000,
			handoff: [
				{ role: "architecture", roleTitle: "Architecture", status: "done", summary: "✓ Done (#498)" },
				{ role: "design", roleTitle: "Design", status: "working", summary: "● Working (#225)" },
				{ role: "backend", roleTitle: "Backend", status: "landing", summary: "↑ Landing (#512)" },
				{ role: "ops", roleTitle: "Ops", status: "landed", summary: "✓· Landed (#760)" },
			],
			tasks: [
				{
					id: 498,
					role: "architecture",
					roleTitle: "Architecture",
					title: "12-state lifecycle & tag roll-up contract",
					status: "done",
					lifecycleStatus: "done",
					statusTone: statusToneForLifecycle("done"),
					appOrSystem: "pi-web-ui",
					appLabel: "Pi Web UI",
					tags: ["roles-rework"],
					dependsOnRefs: [],
					latestTldr: { text: "Contract & conformance fixtures delivered", age: "22m ago" },
					doneSummary: "Shared data contract complete (no deploy step)",
					createdAt: 1762535000000,
					updatedAt: 1762540000000,
				},
				{
					id: 225,
					role: "design",
					roleTitle: "Design",
					title: "Interactive prototype & visual spec for Roles and Initiatives",
					status: "in_progress",
					lifecycleStatus: "working",
					statusTone: statusToneForLifecycle("working"),
					pipelineStage: 1,
					appOrSystem: "pi-web-ui",
					appLabel: "Pi Web UI",
					tags: ["roles-rework"],
					dependsOnRefs: ["architecture #498"],
					latestTldr: { text: "Verifying desktop + mobile light/dark views", age: "2m ago" },
					createdAt: 1762536500000,
					updatedAt: 1762541900000,
				},
				{
					id: 512,
					role: "backend",
					roleTitle: "Backend",
					title: "Derive 12-state delivery status & live blocker resolution",
					status: "waiting",
					lifecycleStatus: "landing",
					statusTone: statusToneForLifecycle("landing"),
					pipelineStage: 2,
					appOrSystem: "pi-web-ui",
					appLabel: "Pi Web UI",
					tags: ["roles-rework", "wt-deploy"],
					dependsOnRefs: ["architecture #498", "ops #760"],
					latestTldr: { text: "wt land running full test suite before merge", age: "5m ago" },
					delivery: {
						repo: "pi-web-ui",
						deployableService: true,
						landId: "land-512",
						headCommit: "7f8e9a0b",
						landingAge: "5m in check gate",
					},
					createdAt: 1762536800000,
					updatedAt: 1762541700000,
				},
				{
					id: 760,
					role: "ops",
					roleTitle: "Ops",
					title: "Emit wt land & pi-web-deploy commit receipts to task store",
					status: "done",
					lifecycleStatus: "landed",
					statusTone: statusToneForLifecycle("landed"),
					pipelineStage: 3,
					appOrSystem: "pi-web-ui",
					appLabel: "Pi Web UI",
					tags: ["roles-rework", "wt-deploy"],
					dependsOnRefs: ["architecture #498"],
					howToUnblock: "Merged 687db82b to master; deploy with pi-web-deploy once Backend #512 lands",
					latestTldr: {
						text: "Merged 687db82b to master; waiting for next pi-web-deploy window",
						age: "9m ago",
					},
					delivery: {
						repo: "pi-web-ui",
						deployableService: true,
						landedCommit: "687db82b",
						landedAge: "9m ago",
						pendingReason: "On master · not deployed to live service yet",
					},
					createdAt: 1762536200000,
					updatedAt: 1762541200000,
				},
			],
		},
		{
			key: "proj:inkflow-onboarding",
			kind: "project",
			title: "Inkflow Guided First-Sketch Onboarding",
			whySummary: "Demonstrates Asking Lead, Overdue Waiting check, and Paused by You states.",
			appOrSystem: "inkflow",
			appLabel: "Inkflow",
			tags: ["onboarding-flow"],
			rollupStatus: "stalled",
			statusTone: "waiting",
			hasBlockedPeers: true,
			rootBlockerRef: "qa #358",
			howToUnblock:
				"Fix Inkflow staging CDN bundle for overdue QA #358 (44m/30m), answer FE Lead #234, and resume Ops #765.",
			totalTasks: 3,
			countsByStatus: { asking: 1, waiting: 1, paused: 1 },
			roles: ["frontend", "ops", "qa"],
			appsOrSystems: ["inkflow"],
			updatedAt: 1762541400000,
			handoff: [
				{ role: "frontend", roleTitle: "Frontend", status: "asking", summary: "? Asking lead (#234)" },
				{ role: "qa", roleTitle: "QA", status: "waiting", summary: "◔ Waiting overdue (#358)" },
				{ role: "ops", roleTitle: "Ops", status: "paused", summary: "⏸ Paused by you (#765)" },
			],
			tasks: [
				{
					id: 234,
					role: "frontend",
					roleTitle: "Frontend",
					title: "Canvas gesture coachmark overlay",
					status: "asking",
					lifecycleStatus: "asking",
					statusTone: statusToneForLifecycle("asking"),
					appOrSystem: "inkflow",
					appLabel: "Inkflow",
					tags: ["onboarding-flow"],
					dependsOnRefs: [],
					howToUnblock: "Frontend Lead: reply on #234 (reuse PopoverCard vs canvas-anchored variant)",
					latestTldr: {
						text: "Asked Frontend Lead whether to reuse tooltip animation module",
						age: "6m ago",
					},
					askingLead: {
						leadRole: "Frontend Lead",
						question: "Should coachmark use existing PopoverCard or add a canvas-anchored variant?",
						age: "6m ago",
					},
					createdAt: 1762537200000,
					updatedAt: 1762541400000,
				},
				{
					id: 358,
					role: "qa",
					roleTitle: "QA",
					title: "Wait for Inkflow staging asset bundle build",
					status: "waiting",
					lifecycleStatus: "waiting",
					statusTone: statusToneForLifecycle("waiting"),
					appOrSystem: "inkflow",
					appLabel: "Inkflow",
					tags: ["onboarding-flow"],
					dependsOnRefs: ["frontend #234", "ops #765"],
					howToUnblock: "Fix Inkflow staging CDN build so curl health check exits 0 (overdue 44m vs 30m expected)",
					latestTldr: {
						text: "External staging bundle check still returning exit 1",
						age: "44m ago",
					},
					wait: {
						what: "Inkflow staging CDN bundle ready",
						checkCmd: "curl -sf https://staging.inkflow.local/health",
						sinceAt: 1762539360000,
						everyMs: 120000,
						expectByAt: 1762541160000,
						giveUpAt: 1762625760000,
						elapsedMin: 44,
						expectMin: 30,
						everyMin: 2,
						overdue: true,
						overdueNote: "⚠ Overdue (44m elapsed vs 30m expected) · QA chat woken at 30m to inspect",
						howToUnblock: "Fix Inkflow staging CDN build so curl health check exits 0 (overdue 44m vs 30m expected)",
					},
					createdAt: 1762537400000,
					updatedAt: 1762541300000,
				},
				{
					id: 765,
					role: "ops",
					roleTitle: "Ops",
					title: "Reset shared demo account fixtures",
					status: "paused",
					lifecycleStatus: "paused",
					statusTone: statusToneForLifecycle("paused"),
					paused: true,
					appOrSystem: "inkflow",
					appLabel: "Inkflow",
					tags: ["onboarding-flow", "alerts-tab"],
					dependsOnRefs: [],
					howToUnblock: "Resume paused Ops #765 demo fixture reset after checking staging logs",
					latestTldr: {
						text: "Paused at your request while inspecting staging logs",
						age: "1h ago",
					},
					pausedReason: "Paused by you 1h ago: 'Hold fixture reset until I check staging logs'",
					createdAt: 1762536000000,
					updatedAt: 1762538400000,
				},
			],
		},
		{
			key: "tag:app-screen-wf",
			kind: "tag",
			title: "Temper App-Screen Workflow Verification",
			whySummary: "Completed end-to-end workflow proof on temper-dev.",
			appOrSystem: "temper",
			appLabel: "Temper",
			tags: ["app-screen-wf"],
			rollupStatus: "live",
			statusTone: "live",
			hasBlockedPeers: false,
			rootBlockerRef: null,
			howToUnblock: "All steps complete & deployed live (3480264f on temper-dev).",
			totalTasks: 1,
			countsByStatus: { live: 1 },
			roles: ["design"],
			appsOrSystems: ["temper"],
			updatedAt: 1762539300000,
			handoff: [{ role: "design", roleTitle: "Design", status: "live", summary: "✓✓ Live (3480264f)" }],
			tasks: [
				{
					id: 224,
					role: "design",
					roleTitle: "Design",
					title: "Prove design_app_screen_v1 all 8 stages on temper-dev",
					status: "done",
					lifecycleStatus: "live",
					statusTone: statusToneForLifecycle("live"),
					pipelineStage: 5,
					appOrSystem: "temper",
					appLabel: "Temper",
					tags: ["app-screen-wf"],
					dependsOnRefs: [],
					latestTldr: {
						text: "All 8 stages + W5 gates verified live on temper-dev",
						age: "45m ago",
					},
					delivery: {
						repo: "temper-ai",
						deployableService: true,
						liveCommit: "3480264f",
						deployedAge: "45m ago",
					},
					createdAt: 1762534000000,
					updatedAt: 1762539300000,
				},
			],
		},
	];

	const tasks: UiRoleTask[] = askGroups.flatMap((g) => g.tasks ?? []);

	return {
		askGroups,
		tasks,
		departments: DEPARTMENTS_META.map((d) => ({ ...d })),
		idleDepartments: IDLE_DEPARTMENTS.map((d) => ({ ...d })),
		touchSystems: TOUCH_SYSTEMS.map((t) => ({ ...t })),
		allTags: ALL_TAGS.map((t) => ({ ...t, touches: [...t.touches] })),
	};
}

export const V8_REFERENCE_DATASET: TasksRolesV8Dataset = createReferenceDataset();

/**
 * Builds a live-protocol-shaped `{ overview, workPage }` pair from the v8 reference dataset
 * so tests and verification harnesses can feed `receiveRoles` / `receiveWorkPage` or
 * `buildLiveTasksRolesV8Dataset` end-to-end.
 */
export function createReferenceOverviewAndWorkPage() {
	const ref = createReferenceDataset();
	const activeByRole = new Map<string, UiRoleTask[]>();
	const queuedByRole = new Map<string, UiRoleTask[]>();
	const doneByRole = new Map<string, Array<{ id: number; title: string; summary?: string; at?: number }>>();
	const asksByRole = new Map<
		string,
		Array<{
			key: string;
			role: string;
			kind: "question" | "task" | "tldr";
			text: string;
			since: number;
			focus: string;
			choices?: string[];
			chat: { file: string; title?: string; where?: number };
		}>
	>();

	for (const task of ref.tasks) {
		const taskRole = task.role ?? "frontend";
		if (task.lifecycleStatus === "done" || task.lifecycleStatus === "landed" || task.lifecycleStatus === "live") {
			const list = doneByRole.get(taskRole) ?? [];
			list.push({
				id: task.id,
				title: task.title,
				...(task.doneSummary ? { summary: task.doneSummary } : {}),
				at: task.updatedAt,
			});
			doneByRole.set(taskRole, list);
		} else if (task.status === "ready" || task.lifecycleStatus === "queued" || task.lifecycleStatus === "paused") {
			const list = queuedByRole.get(taskRole) ?? [];
			list.push(task);
			queuedByRole.set(taskRole, list);
		} else {
			const list = activeByRole.get(taskRole) ?? [];
			list.push(task);
			activeByRole.set(taskRole, list);
		}

		if (task.lifecycleStatus === "stuck" && task.stuck) {
			const list = asksByRole.get(taskRole) ?? [];
			list.push({
				key: `${taskRole}:task:${task.id}`,
				role: taskRole,
				kind: "task",
				text: task.stuck.question,
				since: task.stuck.sinceAt ?? task.updatedAt,
				focus: `task:${task.id}`,
				...(task.stuck.choices ? { choices: [...task.stuck.choices] } : {}),
				chat: {
					file: `/tmp/${taskRole}-task-${task.id}.jsonl`,
					title: `${task.roleTitle} #${task.id}`,
					where: task.id,
				},
			});
			asksByRole.set(taskRole, list);
		}
	}

	const roles = [
		...ref.departments.map((d) => {
			const active = activeByRole.get(d.id) ?? [];
			const queued = queuedByRole.get(d.id) ?? [];
			const asks = asksByRole.get(d.id) ?? [];
			const doneRecent = doneByRole.get(d.id) ?? [];
			return {
				id: d.id,
				title: d.title,
				focus: d.note ?? "",
				status: asks.length > 0 ? ("needs-you" as const) : active.length > 0 ? ("busy" as const) : ("idle" as const),
				homeChat: d.homeChat ?? { file: `/tmp/${d.id}-home.jsonl`, title: `${d.title} lead` },
				tldr: d.note ? [{ text: d.note, ts: 1762541500000 }] : [],
				asks,
				queue: {
					running: d.queueRunning,
					autoApprove: true,
					lanes: { inUse: d.inUse, atOnce: d.atOnce },
					counts: {
						working: active.filter((t) => t.status === "working").length,
						waiting: active.filter((t) => t.status === "waiting").length,
						blocked: active.filter((t) => t.status === "blocked").length,
						stuck: active.filter((t) => t.status === "stuck").length,
						asking: active.filter((t) => t.status === "asking").length,
						ready: queued.length,
						paused: [...active, ...queued].filter((t) => t.paused).length,
						done: doneRecent.length,
						dropped: 0,
					},
					active,
					queued,
				},
				doneRecent,
				requestsToIt: [],
				sentRequests: [],
				boardOrdersOpen: [],
				problems: [],
			};
		}),
		...ref.idleDepartments.map((d) => ({
			id: d.id,
			title: d.title,
			focus: d.note,
			status: "idle" as const,
			homeChat: { file: `/tmp/${d.id}-home.jsonl`, title: `${d.title} lead` },
			tldr: [{ text: d.note, ts: 1762535000000 }],
			asks: [],
			queue: {
				running: true,
				autoApprove: true,
				lanes: { inUse: 0, atOnce: 2 },
				counts: {
					working: 0,
					waiting: 0,
					blocked: 0,
					stuck: 0,
					asking: 0,
					ready: 0,
					paused: 0,
					done: 0,
					dropped: 0,
				},
				active: [],
				queued: [],
			},
			doneRecent: doneByRole.get(d.id) ?? [],
			requestsToIt: [],
			sentRequests: [],
			boardOrdersOpen: [],
			problems: [],
		})),
	];

	const overview = {
		at: 1762541760000,
		roles,
		asks: [...asksByRole.values()].flat(),
		boardOrders: [],
		tagGroups: ref.askGroups,
	};

	const workPage = {
		at: 1762541760000,
		initiatives: [],
		projects: ref.askGroups.map((g) => ({
			id: (g.tags ?? [])[0] ?? g.key.replace(/^tag:/, ""),
			name: g.title,
			status: "active" as const,
			lead: g.roles[0] ?? "frontend",
			outcome: g.whySummary,
			doneWhen: [],
		})),
		tasks: ref.tasks.map((t) => ({
			queue: t.roleTitle,
			queueName: t.role,
			task: t.id,
			title: t.title,
			state: t.status,
			lifecycleStatus: t.lifecycleStatus,
			statusTone: t.statusTone,
			...(t.pipelineStage !== undefined ? { pipelineStage: t.pipelineStage } : {}),
			...(t.howToUnblock ? { howToUnblock: t.howToUnblock } : {}),
			dependsOnRefs: t.dependsOnRefs,
			tags: t.tags,
			...(t.touches ? { touches: t.touches } : {}),
			...(t.normalizedTouches ? { normalizedTouches: t.normalizedTouches } : {}),
			...(t.delivery ? { delivery: t.delivery } : {}),
			...(t.wait ? { wait: t.wait } : {}),
			...(t.blocked ? { blockedDetail: t.blocked } : {}),
			...(t.queuedDetail ? { queuedDetail: t.queuedDetail } : {}),
			...(t.paused ? { paused: { why: t.pausedReason ?? "Paused" } } : {}),
			...(t.latestTldr ? { progress: { text: t.latestTldr.text, at: t.updatedAt } } : {}),
			...(t.doneSummary ? { doneSummary: t.doneSummary } : {}),
			added: t.createdAt,
			stateAt: t.updatedAt,
		})),
		updates: {},
		tagGroups: ref.askGroups,
	};

	return { overview, workPage };
}
