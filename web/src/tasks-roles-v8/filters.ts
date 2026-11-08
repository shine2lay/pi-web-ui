import type { UiRoleTask, UiTaskGroupRollup, UiTaskLifecycleStatus, V8DepartmentSummary, V8TagOption } from "./types";

export type V8StatusFilterId =
	| "all"
	| "needs_attention"
	| "needs_you"
	| "blocked"
	| "waiting"
	| "blocked_waiting"
	| "asking"
	| "working"
	| "landing_deploying"
	| "live_done";

export type V8DropdownKind = "dept" | "app" | "state" | "tag";

export interface TasksRolesV8FilterState {
	page: "initiatives" | "roles";
	theme: "dark" | "light";
	scheme?: "stone" | "slate" | "graphite";
	mode: "normal" | "loading" | "empty" | "error";
	touch: string;
	deptFilter: string;
	searchQuery: string;
	activeTagDag: string | null;
	selectedTags: string[];
	tagMatchMode: "any" | "all";
	openDropdown: V8DropdownKind | null;
	ddSearch: Record<V8DropdownKind, string>;
	statusFilter: V8StatusFilterId;
	handoffRoleFilter: Record<string, string | null>;
	collapsedAsks: Record<string, boolean>;
	expandedTasks: Record<number, boolean>;
	expandedRoles: Record<string, boolean>;
	idleExpanded: boolean;
	answeredTasks: Record<number, string>;
}

/**
 * Deterministic urgency rank across all 12 lifecycle states (`stuck` / `ON YOU` first,
 * then `blocked`, `waiting`, `asking`, `paused`, `deploying`, `landing`, `landed`,
 * `working`, `queued`, `live`, `done`, `dropped`) matching prototype.html v8.
 */
export const TASK_URGENCY_RANK: Readonly<Record<UiTaskLifecycleStatus, number>> = {
	stuck: 0,
	blocked: 1,
	waiting: 2,
	asking: 3,
	paused: 4,
	deploying: 5,
	landing: 6,
	landed: 7,
	working: 8,
	queued: 9,
	live: 10,
	done: 11,
	dropped: 12,
};

export function createInitialFilterState(overrides: Partial<TasksRolesV8FilterState> = {}): TasksRolesV8FilterState {
	return {
		page: "initiatives",
		theme: "dark",
		scheme: "stone",
		mode: "normal",
		touch: "all",
		deptFilter: "all",
		searchQuery: "",
		activeTagDag: null,
		selectedTags: [],
		tagMatchMode: "any",
		openDropdown: null,
		ddSearch: { dept: "", app: "", state: "", tag: "" },
		statusFilter: "all",
		handoffRoleFilter: {},
		collapsedAsks: {},
		expandedTasks: {},
		expandedRoles: {},
		idleExpanded: false,
		answeredTasks: {},
		...overrides,
	};
}

export function effectiveTaskLifecycleStatus(
	task: Pick<UiRoleTask, "id" | "lifecycleStatus">,
	answeredTasks?: Readonly<Record<number, string>>,
): UiTaskLifecycleStatus {
	if (task.lifecycleStatus === "stuck" && answeredTasks?.[task.id]) {
		return "working";
	}
	return task.lifecycleStatus;
}

export function sortTasksByUrgency<T extends Pick<UiRoleTask, "id" | "displayId" | "lifecycleStatus">>(
	tasks: ReadonlyArray<T>,
	answeredTasks?: Readonly<Record<number, string>>,
): T[] {
	if (!Array.isArray(tasks)) {
		throw new Error("sortTasksByUrgency requires an array of tasks.");
	}
	return [...tasks].sort((a, b) => {
		const effA = effectiveTaskLifecycleStatus(a, answeredTasks);
		const effB = effectiveTaskLifecycleStatus(b, answeredTasks);
		const rankA = TASK_URGENCY_RANK[effA] ?? 99;
		const rankB = TASK_URGENCY_RANK[effB] ?? 99;
		if (rankA !== rankB) return rankA - rankB;
		const dispA = a.displayId ?? a.id;
		const dispB = b.displayId ?? b.id;
		if (dispA !== dispB) return dispA - dispB;
		return a.id - b.id;
	});
}

export interface AttentionSummaryCounts {
	needsAttentionCount: number;
	onlyOnYouCount: number;
	needsYouCount: number;
	blockedWaitingCount: number;
	askingLeadCount: number;
	totalTasksCount: number;
}

export function computeAttentionSummary(
	tasks: ReadonlyArray<Pick<UiRoleTask, "id" | "lifecycleStatus">>,
	answeredTasks?: Readonly<Record<number, string>>,
): AttentionSummaryCounts {
	if (!Array.isArray(tasks)) {
		throw new Error("computeAttentionSummary requires an array of tasks.");
	}
	let needsYouCount = 0;
	let blockedWaitingCount = 0;
	let askingLeadCount = 0;

	for (const t of tasks) {
		const eff = effectiveTaskLifecycleStatus(t, answeredTasks);
		if (eff === "stuck") needsYouCount++;
		else if (eff === "blocked" || eff === "waiting") blockedWaitingCount++;
		else if (eff === "asking") askingLeadCount++;
	}

	const needsAttentionCount = needsYouCount + blockedWaitingCount + askingLeadCount;
	return {
		needsAttentionCount,
		onlyOnYouCount: needsYouCount,
		needsYouCount,
		blockedWaitingCount,
		askingLeadCount,
		totalTasksCount: tasks.length,
	};
}

export function toggleNeedsAttentionFilter(state: TasksRolesV8FilterState): TasksRolesV8FilterState {
	return {
		...state,
		statusFilter: state.statusFilter === "needs_attention" ? "all" : "needs_attention",
	};
}

export function toggleOnlyOnYouFilter(state: TasksRolesV8FilterState): TasksRolesV8FilterState {
	return {
		...state,
		statusFilter: state.statusFilter === "needs_you" ? "all" : "needs_you",
	};
}

export function toggleSelectedTag(state: TasksRolesV8FilterState, tagId: string): TasksRolesV8FilterState {
	const trimmed = tagId.trim().replace(/^#/, "");
	if (!trimmed) return state;
	const exists = state.selectedTags.includes(trimmed);
	return {
		...state,
		selectedTags: exists ? state.selectedTags.filter((t) => t !== trimmed) : [...state.selectedTags, trimmed],
	};
}

export function toggleTagMatchMode(state: TasksRolesV8FilterState): TasksRolesV8FilterState {
	return {
		...state,
		tagMatchMode: state.tagMatchMode === "any" ? "all" : "any",
	};
}

export function resetAllFilters(state: TasksRolesV8FilterState): TasksRolesV8FilterState {
	return {
		...state,
		deptFilter: "all",
		touch: "all",
		statusFilter: "all",
		selectedTags: [],
		searchQuery: "",
		openDropdown: null,
		handoffRoleFilter: {},
	};
}

export function matchesTaskFilters(
	task: UiRoleTask,
	state: Pick<
		TasksRolesV8FilterState,
		"deptFilter" | "touch" | "searchQuery" | "selectedTags" | "tagMatchMode" | "statusFilter" | "answeredTasks"
	>,
	askGroup?: Partial<UiTaskGroupRollup>,
): boolean {
	if (!task || typeof task !== "object") {
		throw new Error("matchesTaskFilters requires a valid task object.");
	}
	if (state.deptFilter && state.deptFilter !== "all" && task.role !== state.deptFilter) {
		return false;
	}
	const appOrSystem = task.appOrSystem ?? askGroup?.appOrSystem;
	if (state.touch && state.touch !== "all" && appOrSystem !== state.touch) {
		return false;
	}
	if (state.searchQuery && state.searchQuery.trim().length > 0) {
		const q = state.searchQuery.trim().toLowerCase();
		const taskTags = task.tags ?? askGroup?.tags ?? [];
		const tagTokens = taskTags.flatMap((t) => [t, `#${t}`]).join(" ");
		const touchesRaw = (task.touches ?? []).join(" ");
		const tldrText = task.latestTldr?.text ?? "";
		const unblockText =
			task.howToUnblock ?? task.blocked?.howToUnblock ?? task.blocked?.unblockSummary ?? task.wait?.what ?? "";
		const displayId = task.displayId ?? task.id;
		const haystack = [
			task.role ?? "",
			task.roleTitle ?? "",
			`#${displayId}`,
			String(displayId),
			`#${task.id}`,
			String(task.id),
			task.title ?? "",
			tagTokens,
			appOrSystem ?? "",
			task.appLabel ?? askGroup?.appLabel ?? "",
			touchesRaw,
			unblockText,
			tldrText,
			task.doneSummary ?? "",
		]
			.join(" ")
			.toLowerCase();
		if (!haystack.includes(q)) return false;
	}
	if (state.selectedTags && state.selectedTags.length > 0) {
		const taskTags = task.tags ?? askGroup?.tags ?? [];
		if (state.tagMatchMode === "all") {
			const hasAll = state.selectedTags.every((t) => taskTags.includes(t));
			if (!hasAll) return false;
		} else {
			const hasAny = state.selectedTags.some((t) => taskTags.includes(t));
			if (!hasAny) return false;
		}
	}
	if (state.statusFilter && state.statusFilter !== "all") {
		const effSt = effectiveTaskLifecycleStatus(task, state.answeredTasks);
		if (state.statusFilter === "needs_attention" && !["stuck", "blocked", "waiting", "asking"].includes(effSt)) {
			return false;
		}
		if (state.statusFilter === "needs_you" && effSt !== "stuck") return false;
		if (state.statusFilter === "blocked" && effSt !== "blocked") return false;
		if (state.statusFilter === "waiting" && !["waiting", "asking"].includes(effSt)) {
			return false;
		}
		if (state.statusFilter === "asking" && effSt !== "asking") return false;
		if (state.statusFilter === "blocked_waiting" && !["blocked", "waiting", "asking", "paused"].includes(effSt)) {
			return false;
		}
		if (state.statusFilter === "working" && !["working", "queued"].includes(effSt)) {
			return false;
		}
		if (state.statusFilter === "landing_deploying" && !["landing", "landed", "deploying"].includes(effSt)) {
			return false;
		}
		if (state.statusFilter === "live_done" && !["live", "done"].includes(effSt)) {
			return false;
		}
	}
	return true;
}

export interface DropdownOptionItem {
	id: string;
	label: string;
	count?: number;
	pressed: boolean;
	dagActive?: boolean;
}

export interface FilterDropdownModels {
	dept: {
		summaryText: string;
		active: boolean;
		query: string;
		options: DropdownOptionItem[];
	};
	app: {
		summaryText: string;
		active: boolean;
		query: string;
		options: DropdownOptionItem[];
	};
	state: {
		summaryText: string;
		active: boolean;
		query: string;
		options: DropdownOptionItem[];
	};
	tag: {
		summaryText: string;
		active: boolean;
		query: string;
		options: DropdownOptionItem[];
	};
}

export function buildFilterDropdownModels(params: {
	tasks: ReadonlyArray<UiRoleTask>;
	departments: ReadonlyArray<V8DepartmentSummary>;
	touchSystems: ReadonlyArray<{ id: string; label: string; count: number }>;
	allTags: ReadonlyArray<V8TagOption>;
	state: TasksRolesV8FilterState;
}): FilterDropdownModels {
	const { tasks, departments, touchSystems, allTags, state } = params;

	const deptAllOptions: DropdownOptionItem[] = [
		{
			id: "all",
			label: "All departments",
			count: tasks.length,
			pressed: (state.deptFilter || "all") === "all",
		},
		...departments.map((d) => ({
			id: d.id,
			label: d.title,
			count: tasks.filter((t) => t.role === d.id).length,
			pressed: state.deptFilter === d.id,
		})),
	];
	const curDept = deptAllOptions.find((d) => d.id === (state.deptFilter || "all")) ?? deptAllOptions[0];
	const deptQ = (state.ddSearch?.dept ?? "").trim().toLowerCase();
	const deptOptions = deptAllOptions.filter(
		(d) => !deptQ || d.label.toLowerCase().includes(deptQ) || d.id.toLowerCase().includes(deptQ),
	);

	const appAllOptions: DropdownOptionItem[] = touchSystems.map((sys) => ({
		id: sys.id,
		label: sys.label,
		count: sys.count,
		pressed: state.touch === sys.id,
	}));
	const curApp = appAllOptions.find((a) => a.id === state.touch) ?? appAllOptions[0];
	const appQ = (state.ddSearch?.app ?? "").trim().toLowerCase();
	const appOptions = appAllOptions.filter(
		(a) => !appQ || a.label.toLowerCase().includes(appQ) || a.id.toLowerCase().includes(appQ),
	);

	const att = computeAttentionSummary(tasks, state.answeredTasks);
	const workingQueuedCount = tasks.filter((t) =>
		["working", "queued"].includes(effectiveTaskLifecycleStatus(t, state.answeredTasks)),
	).length;
	const landingDeployingCount = tasks.filter((t) =>
		["landing", "landed", "deploying"].includes(effectiveTaskLifecycleStatus(t, state.answeredTasks)),
	).length;
	const liveDoneCount = tasks.filter((t) =>
		["live", "done"].includes(effectiveTaskLifecycleStatus(t, state.answeredTasks)),
	).length;

	const stateAllOptions: DropdownOptionItem[] = [
		{ id: "all", label: `All states (${tasks.length})`, pressed: state.statusFilter === "all" },
		{
			id: "needs_attention",
			label: `⚡ Needs attention (${att.needsAttentionCount})`,
			pressed: state.statusFilter === "needs_attention",
		},
		{
			id: "needs_you",
			label: `! Needs you (${att.needsYouCount})`,
			pressed: state.statusFilter === "needs_you",
		},
		{
			id: "blocked_waiting",
			label: `⊗ Blocked / Waiting (${att.blockedWaitingCount})`,
			pressed: state.statusFilter === "blocked_waiting",
		},
		{
			id: "asking",
			label: `? Asking lead (${att.askingLeadCount})`,
			pressed: state.statusFilter === "asking",
		},
		{
			id: "working",
			label: `● Working / Queued (${workingQueuedCount})`,
			pressed: state.statusFilter === "working",
		},
		{
			id: "landing_deploying",
			label: `↑ Landing / Deploying (${landingDeployingCount})`,
			pressed: state.statusFilter === "landing_deploying",
		},
		{
			id: "live_done",
			label: `✓✓ Live / Done (${liveDoneCount})`,
			pressed: state.statusFilter === "live_done",
		},
	];
	const curState = stateAllOptions.find((s) => s.id === state.statusFilter) ?? stateAllOptions[0];
	const stateQ = (state.ddSearch?.state ?? "").trim().toLowerCase();
	const stateOptions = stateAllOptions.filter(
		(s) => !stateQ || s.label.toLowerCase().includes(stateQ) || s.id.toLowerCase().includes(stateQ),
	);

	const visibleTags = allTags.filter((tg) => state.touch === "all" || tg.touches.includes(state.touch));
	const tagQ = (state.ddSearch?.tag ?? "").trim().toLowerCase();
	const tagOptions: DropdownOptionItem[] = visibleTags
		.filter((tg) => !tagQ || tg.label.toLowerCase().includes(tagQ) || tg.id.toLowerCase().includes(tagQ))
		.map((tg) => ({
			id: tg.id,
			label: tg.label,
			pressed: state.selectedTags.includes(tg.id),
			dagActive: state.activeTagDag === tg.id,
		}));

	const tagSummaryText =
		state.selectedTags.length > 0
			? `Tags: ${state.selectedTags.map((t) => `#${t}`).join(", ")}`
			: state.activeTagDag
				? `Tag DAG: #${state.activeTagDag}`
				: `Tag / DAG (All ${visibleTags.length})`;

	return {
		dept: {
			summaryText: `Dept: ${curDept?.label ?? "All departments"} (${curDept?.count ?? tasks.length})`,
			active: state.deptFilter !== "all",
			query: state.ddSearch?.dept ?? "",
			options: deptOptions,
		},
		app: {
			summaryText: `App: ${curApp?.label ?? "All apps"} (${curApp?.count ?? tasks.length})`,
			active: state.touch !== "all",
			query: state.ddSearch?.app ?? "",
			options: appOptions,
		},
		state: {
			summaryText: `State: ${curState?.label ?? `All states (${tasks.length})`}`,
			active: state.statusFilter !== "all",
			query: state.ddSearch?.state ?? "",
			options: stateOptions,
		},
		tag: {
			summaryText: tagSummaryText,
			active: state.selectedTags.length > 0 || Boolean(state.activeTagDag),
			query: state.ddSearch?.tag ?? "",
			options: tagOptions,
		},
	};
}
