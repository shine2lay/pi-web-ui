import type {
	UiRoleAsk as ProtocolUiRoleAsk,
	UiRoleOverview as ProtocolUiRoleOverview,
	UiWorkPageRecord as ProtocolUiWorkPageRecord,
	UiWorkPageTask as ProtocolUiWorkPageTask,
} from "../../../server/protocol.js";
import type { TaskPriority } from "../components/TaskPriorityBadge.js";
import {
	cleanTagSlug,
	formatAppDisplayLabel,
	formatRelativeAge,
	parseTaskNumberFromFocus,
	shortRoleTitle,
	type LiveChatTarget,
	type LiveTasksRolesAdaptedResult,
	type LiveTasksRolesAdapterInput,
} from "./live-adapter-helpers.js";
import {
	adaptInitiativesExactInput,
	adaptTagGroupTasks,
	adaptUnattachedAsks,
	adaptWorkPageTasks,
} from "./live-adapter-sources.js";
import { adaptSingleTask, type LiveAdapterTaskContext } from "./live-adapter-task.js";
import {
	computeGroupRollup,
	parseTimestampMs,
	type UiRoleTask,
	type UiTaskGroupRollup,
	type UiTaskLifecycleStatus,
	type V8DepartmentSummary,
	type V8TagOption,
} from "./types.js";

export {
	formatAppDisplayLabel,
	formatRelativeAge,
	shortRoleTitle,
	type LiveChatTarget,
	type LiveTasksRolesAdaptedResult,
	type LiveTasksRolesAdapterInput,
};

export function buildLiveTasksRolesV8Dataset(input: LiveTasksRolesAdapterInput): LiveTasksRolesAdaptedResult {
	const overview = input.overview ?? input.rolesState?.overview ?? null;
	const workPage = input.workPage ?? input.workState?.page ?? null;
	const now = input.now ?? overview?.at ?? workPage?.at ?? Date.now();

	const asksByTaskId = new Map<number, ProtocolUiRoleAsk>();
	const asksByRoleAndTaskKey = new Map<string, ProtocolUiRoleAsk>();
	const unattachedAsks: ProtocolUiRoleAsk[] = [];

	const registerAsk = (ask: ProtocolUiRoleAsk) => {
		const numId =
			parseTaskNumberFromFocus(ask.focus, ask.key) ??
			(typeof (ask as { id?: string }).id === "string" && /^\d+$/.test((ask as { id?: string }).id!)
				? Number((ask as { id?: string }).id)
				: null);
		const askRole = ask.role || (ask as { roleId?: string }).roleId || "workspace";
		if (numId !== null) {
			asksByTaskId.set(numId, ask);
			asksByRoleAndTaskKey.set(`${askRole}:#${numId}`, ask);
		} else {
			unattachedAsks.push(ask);
		}
	};

	for (const role of overview?.roles ?? []) {
		for (const ask of role.asks ?? []) {
			registerAsk(ask);
		}
	}
	const extraOverviewAsks = (overview as { asks?: ProtocolUiRoleAsk[] } | null)?.asks ?? [];
	for (const ask of extraOverviewAsks) {
		registerAsk(ask);
	}

	const projectMetaById = new Map<
		string,
		{ title: string; lead?: string; goal?: string; initiative?: string; appOrSystem?: string }
	>();
	const tagGroupMetaByTag = new Map<
		string,
		{
			title: string;
			whySummary?: string;
			howToUnblock?: string;
			roles: string[];
			touches: string[];
			handoff?: UiTaskGroupRollup["handoff"];
		}
	>();

	const registerRecord = (rec: ProtocolUiWorkPageRecord) => {
		const slug = cleanTagSlug(rec.id);
		if (!slug) return;
		projectMetaById.set(slug, {
			title: rec.name || rec.id,
			...(rec.lead ? { lead: rec.lead } : {}),
			...(rec.outcome ? { goal: rec.outcome } : {}),
			...(rec.initiative ? { initiative: rec.initiative } : {}),
		});
	};

	for (const init of workPage?.initiatives ?? []) registerRecord(init);
	for (const proj of workPage?.projects ?? []) registerRecord(proj);

	for (const tg of [...(overview?.tagGroups ?? []), ...(workPage?.tagGroups ?? [])]) {
		const rawKey = tg.key.replace(/^(?:tag|project|initiative):/, "");
		const slug = cleanTagSlug(rawKey);
		if (!slug) continue;
		const tgRich = tg as Partial<UiTaskGroupRollup>;
		tagGroupMetaByTag.set(slug, {
			title: tgRich.title ?? projectMetaById.get(slug)?.title ?? `#${slug}`,
			...(tgRich.whySummary ? { whySummary: tgRich.whySummary } : {}),
			...(tg.howToUnblock ? { howToUnblock: tg.howToUnblock } : {}),
			roles: tg.roles ?? [],
			touches: tg.appsOrSystems ?? [],
			...(tgRich.handoff ? { handoff: tgRich.handoff } : {}),
		});
	}

	const chatByTaskId = new Map<number, LiveChatTarget>();
	const chatByRoleId = new Map<string, string>();
	const tasksById = new Map<number, UiRoleTask>();
	const tasksByKey = new Map<string, UiRoleTask>();
	const ctx: LiveAdapterTaskContext = {
		now,
		asksByTaskId,
		asksByRoleAndTaskKey,
		chatByTaskId,
		tasksById,
		tasksByKey,
		projectMetaById,
		nextCollisionId: 100_001,
	};

	const departments: V8DepartmentSummary[] = [];
	const idleCandidates: Array<{
		id: string;
		title: string;
		note: string;
		inUse: number;
		atOnce: number;
		queueRunning: boolean;
		homeChat?: { file: string; title?: string };
		score: number;
	}> = [];

	// 1. Collect tasks and roles from UiRolesOverview when present
	for (const role of (overview?.roles ?? []) as ProtocolUiRoleOverview[]) {
		const homeChatObj = typeof role.homeChat === "string" ? { file: role.homeChat } : role.homeChat;
		if (homeChatObj?.file) {
			chatByRoleId.set(role.id, homeChatObj.file);
		}
		const roleTitle = shortRoleTitle(role.id, role.title);
		const q = role.queue;
		const queueStateRaw = (q as { state?: string } | undefined)?.state;
		const queueRunning = queueStateRaw !== undefined ? queueStateRaw === "running" : Boolean(q?.running ?? true);
		const inUse = Number(q?.lanes?.inUse ?? (typeof q?.running === "number" ? q.running : 0));
		const atOnce = Number(q?.lanes?.atOnce ?? (q?.lanes as { max?: number } | undefined)?.max ?? 2);

		const activeTasks = q?.active ?? [];
		const queuedTasks = q?.queued ?? [];
		const recentDoneSource =
			role.doneRecent ??
			(q as { recentDone?: Array<{ id: number; title: string; summary?: string; at?: number }> } | undefined)
				?.recentDone ??
			[];
		const recentDoneTasks = recentDoneSource.slice(0, 3);

		for (const t of [...activeTasks, ...queuedTasks]) {
			adaptSingleTask(ctx, t, role.id, roleTitle, queueRunning, homeChatObj);
		}
		for (const d of recentDoneTasks) {
			const doneLifecycle = (d as { lifecycleStatus?: UiTaskLifecycleStatus }).lifecycleStatus;
			if (!tasksByKey.has(`${role.id}:${d.id}`) && (!doneLifecycle || doneLifecycle === "done")) {
				continue;
			}
			const dUpdatedAt = parseTimestampMs(
				(d as { updatedAt?: unknown; updatedAtMs?: unknown }).updatedAtMs ?? (d as { updatedAt?: unknown }).updatedAt,
			);
			adaptSingleTask(
				ctx,
				{
					id: d.id,
					title: d.title,
					status: "done",
					...(doneLifecycle ? { lifecycleStatus: doneLifecycle } : {}),
					...(d.summary ? { doneSummary: d.summary } : {}),
					...(d.at ? { finishedAt: d.at } : {}),
					...(dUpdatedAt !== undefined ? { updatedAt: dUpdatedAt, updatedAtMs: dUpdatedAt } : {}),
				},
				role.id,
				roleTitle,
				queueRunning,
				homeChatObj,
			);
		}

		const hasDirectAsk = unattachedAsks.some((a) => (a.role || (a as { roleId?: string }).roleId) === role.id);
		const problemsList = role.problems ?? [];
		const isRoleActive =
			activeTasks.length > 0 ||
			queuedTasks.length > 0 ||
			role.status === "busy" ||
			role.status === "needs-you" ||
			(role.status as string) === "working" ||
			(role.status as string) === "blocked" ||
			(role.status as string) === "error" ||
			hasDirectAsk ||
			problemsList.length > 0;

		const doneCount =
			q?.counts?.done ?? (q as { doneCount?: number } | undefined)?.doneCount ?? recentDoneSource.length;
		const firstProblem = problemsList[0];
		const problemText =
			typeof firstProblem === "string" ? firstProblem : (firstProblem as { detail?: string } | undefined)?.detail;
		const latestNote =
			role.tldr?.[0]?.text ??
			problemText ??
			(doneCount > 0 ? `0 active tasks · ${doneCount} done` : "0 active tasks · All clear");

		if (isRoleActive) {
			departments.push({
				id: role.id,
				title: roleTitle,
				inUse,
				atOnce,
				queueRunning,
				...(homeChatObj ? { homeChat: homeChatObj } : {}),
				note: latestNote,
			});
		} else {
			idleCandidates.push({
				id: role.id,
				title: roleTitle,
				note: latestNote,
				inUse,
				atOnce,
				queueRunning,
				...(homeChatObj ? { homeChat: homeChatObj } : {}),
				score: (role.tldr?.[0]?.ts ?? 0) + doneCount * 1000,
			});
		}
	}

	// 2. Attach or synthesize tasks for any direct role asks
	adaptUnattachedAsks(ctx, unattachedAsks);

	// 3a. Adapt any rich tasks embedded in tagGroups
	adaptTagGroupTasks(ctx, [...(overview?.tagGroups ?? []), ...(workPage?.tagGroups ?? [])] as Array<
		Partial<UiTaskGroupRollup>
	>);

	// 3. Merge tasks from UiWorkPage.tasks (and any test-fixture workPage shapes)
	adaptWorkPageTasks(ctx, (workPage?.tasks ?? []) as Array<ProtocolUiWorkPageTask & { priority?: TaskPriority }>);

	// 3b. Adapt InitiativesExactInput metadata
	if (input.exactInput) {
		adaptInitiativesExactInput(ctx, input.exactInput, tasksByKey.size === 0 && !overview && !workPage);
	}

	// Ensure at least 6 department cards in the Bento grid when >= 6 roles exist
	idleCandidates.sort((a, b) => b.score - a.score);
	while (departments.length < 6 && idleCandidates.length > 0) {
		const next = idleCandidates.shift()!;
		departments.push({
			id: next.id,
			title: next.title,
			inUse: next.inUse,
			atOnce: next.atOnce,
			queueRunning: next.queueRunning,
			...(next.homeChat ? { homeChat: next.homeChat } : {}),
			note: next.note,
		});
	}

	const idleDepartments = idleCandidates.map((c) => ({
		id: c.id,
		title: c.title,
		note: c.note,
	}));

	// 4. Build askGroups (tag/project/initiative groups) from adapted tasks
	const allTasks = [...tasksById.values()];
	const tasksByPrimaryTag = new Map<string, UiRoleTask[]>();
	for (const slug of tagGroupMetaByTag.keys()) {
		if (!tasksByPrimaryTag.has(slug)) {
			tasksByPrimaryTag.set(slug, []);
		}
	}
	for (const task of allTasks) {
		const primaryTag = task.tags?.[0] ?? "general";
		const list = tasksByPrimaryTag.get(primaryTag) ?? [];
		list.push(task);
		tasksByPrimaryTag.set(primaryTag, list);
	}

	const askGroups: UiTaskGroupRollup[] = [];
	for (const [tag, groupTasks] of tasksByPrimaryTag.entries()) {
		if (groupTasks.length === 0) continue;
		const rollup = computeGroupRollup(groupTasks, { key: `tag:${tag}`, kind: "tag" });
		const meta = projectMetaById.get(tag);
		const tgMeta = tagGroupMetaByTag.get(tag);
		const first = groupTasks[0];
		const appOrSystem = first?.appOrSystem ?? "pi-web-ui";
		const appLabel = first?.appLabel ?? formatAppDisplayLabel(appOrSystem);

		const allGroupTags = Array.from(new Set(groupTasks.flatMap((t) => t.tags ?? [tag])));
		const handoff =
			tgMeta?.handoff ??
			rollup.roles.map((r) => {
				const roleTasks = groupTasks.filter((t) => t.role === r);
				const topTask = roleTasks[0];
				const roleTitle = topTask?.roleTitle ?? shortRoleTitle(r);
				return {
					role: r,
					roleTitle,
					status: topTask?.lifecycleStatus ?? "working",
					summary: topTask ? `#${topTask.displayId ?? topTask.id}` : roleTitle,
				};
			});

		askGroups.push({
			...rollup,
			title: meta?.title ?? tgMeta?.title ?? `#${tag}`,
			whySummary:
				tgMeta?.whySummary ??
				meta?.goal ??
				`Grouped by #${tag} across ${rollup.roles.map((r) => shortRoleTitle(r)).join(" → ")}.`,
			appOrSystem,
			appLabel,
			tags: allGroupTags,
			howToUnblock:
				tgMeta?.howToUnblock ??
				rollup.howToUnblock ??
				(meta?.goal ? `Goal: ${meta.goal}` : "All active stages running on schedule."),
			handoff,
			tasks: groupTasks,
		});
	}

	// 5. Build touchSystems and allTags options
	const appCounts = new Map<string, number>();
	for (const t of allTasks) {
		const app = t.appOrSystem ?? "pi-web-ui";
		appCounts.set(app, (appCounts.get(app) ?? 0) + 1);
	}
	const touchSystems = [
		{ id: "all", label: "All apps", count: allTasks.length },
		...[...appCounts.entries()].map(([id, count]) => ({
			id,
			label: formatAppDisplayLabel(id),
			count,
		})),
	];

	const tagTouchesMap = new Map<string, Set<string>>();
	for (const slug of tagGroupMetaByTag.keys()) {
		tagTouchesMap.set(slug, new Set<string>());
	}
	for (const t of allTasks) {
		const app = t.appOrSystem ?? "pi-web-ui";
		for (const tg of t.tags ?? []) {
			const set = tagTouchesMap.get(tg) ?? new Set<string>();
			set.add(app);
			tagTouchesMap.set(tg, set);
		}
	}
	const allTags: V8TagOption[] = [...tagTouchesMap.entries()]
		.filter(([, touchesSet]) => touchesSet.size > 0)
		.map(([id, touchesSet]) => ({
			id,
			label: `#${id}`,
			touches: [...touchesSet],
		}));

	const exactPageState =
		input.exactInput?.page?.state ?? (input.exactInput as { state?: string } | null | undefined)?.state;
	let mode: "normal" | "loading" | "empty" | "error" = "normal";
	if (!overview && !workPage && !input.exactInput) {
		if (input.rolesState?.status === "error" || input.workState?.status === "error") {
			mode = "error";
		} else if (input.rolesState?.status === "loading" || input.workState?.status === "loading") {
			mode = "loading";
		}
	} else if (exactPageState === "error") {
		mode = "error";
	} else if (exactPageState === "loading" && allTasks.length === 0) {
		mode = "loading";
	} else if (allTasks.length === 0 && departments.length === 0 && idleDepartments.length === 0) {
		mode = "empty";
	}

	return {
		dataset: {
			askGroups,
			tasks: allTasks,
			departments,
			idleDepartments,
			touchSystems,
			allTags,
			...(input.now !== undefined ? { nowMs: input.now } : {}),
		},
		mode,
		asksByTaskId,
		chatByTaskId,
		chatByRoleId,
		tasksById,
	};
}
