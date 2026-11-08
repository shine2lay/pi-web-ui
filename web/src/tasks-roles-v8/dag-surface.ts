import {
	renderDeliveryPipelineMeter,
	renderStatusBadge,
	renderTaskCallouts,
	renderUnifiedTaskCard,
} from "./card-surface";
import { buildTaskDag, computeBezierPath, type TaskDagNode, type TaskDagResult } from "./dag";
import {
	effectiveTaskLifecycleStatus,
	matchesTaskFilters,
	sortTasksByUrgency,
	type TasksRolesV8FilterState,
} from "./filters";
import { escapeHtml, STATUS_META } from "./reference-data";
import {
	statusToneForLifecycle,
	type TasksRolesV8Dataset,
	type UiRoleTask,
	type UiTaskGroupRollup,
	type UiTaskLifecycleStatus,
} from "./types";

export const DAG_STAGE_CARD_CEILING = 8;

export const DAG_SHORT_STATUS_LABEL: Readonly<Record<UiTaskLifecycleStatus, string>> = {
	stuck: "Needs you",
	asking: "Asking lead",
	blocked: "Blocked",
	waiting: "Waiting",
	paused: "Paused",
	queued: "Queued",
	working: "Working",
	landing: "Landing",
	landed: "Landed",
	deploying: "Deploying",
	live: "Live",
	done: "Done",
	dropped: "Dropped",
};

export const DAG_STAGE_PRIORITY: Readonly<Record<UiTaskLifecycleStatus, number>> = {
	stuck: 1,
	blocked: 2,
	waiting: 3,
	asking: 4,
	paused: 5,
	deploying: 6,
	landing: 7,
	working: 8,
	landed: 9,
	queued: 10,
	live: 11,
	done: 12,
	dropped: 13,
};

export function sortStageNodesForCeiling(
	nodes: ReadonlyArray<TaskDagNode>,
	answeredTasks?: Readonly<Record<number, string>>,
): TaskDagNode[] {
	return [...nodes].sort((a, b) => {
		if (Boolean(a.isRootBlocker) !== Boolean(b.isRootBlocker)) {
			return a.isRootBlocker ? -1 : 1;
		}
		const effA = effectiveTaskLifecycleStatus(a.task, answeredTasks);
		const effB = effectiveTaskLifecycleStatus(b.task, answeredTasks);
		const pa = DAG_STAGE_PRIORITY[effA] ?? 99;
		const pb = DAG_STAGE_PRIORITY[effB] ?? 99;
		if (pa !== pb) return pa - pb;
		const dispA = a.task.displayId ?? a.task.id;
		const dispB = b.task.displayId ?? b.task.id;
		if (dispA !== dispB) return dispA - dispB;
		return a.task.id - b.task.id;
	});
}

export function renderTaskNode(dagNode: TaskDagNode, state: TasksRolesV8FilterState): string {
	const task = dagNode.task;
	const stepNum = dagNode.stepNumber || 1;
	const stageIndex = dagNode.stageIndex ?? stepNum - 1;
	const isRootBlocker = Boolean(dagNode.isRootBlocker);
	const hasInPort = (dagNode.inSetParentCount || 0) > 0;
	const hasOutPort = (dagNode.inSetChildCount || 0) > 0;
	const isDetailOpen = state.activeDagDetailTaskId === task.id;

	const effectiveStatus = effectiveTaskLifecycleStatus(task, state.answeredTasks);
	const tone = statusToneForLifecycle(effectiveStatus);
	const meta = STATUS_META[effectiveStatus] ?? STATUS_META.working;
	const shortStatus = DAG_SHORT_STATUS_LABEL[effectiveStatus] ?? meta.label;
	const role = task.role ?? "dept";
	const roleTitle = task.roleTitle ?? task.role ?? "Dept";
	const displayId = task.displayId ?? task.id;

	return `
    <article class="dag-node-card task-node task-row" data-task-id="${task.id}" data-display-task-id="${displayId}" data-dag-node="${task.id}" data-dag-stage="${stageIndex}" data-seq-step="${stepNum}" data-dept-role="${escapeHtml(role)}" data-status-tone="${escapeHtml(tone)}" data-root-blocker-node="${isRootBlocker ? "true" : "false"}" data-task-expanded="${isDetailOpen ? "true" : "false"}">
      ${hasInPort ? `<span class="dag-port dag-port-in" aria-hidden="true"></span>` : ""}
      ${hasOutPort ? `<span class="dag-port dag-port-out" aria-hidden="true"></span>` : ""}
      ${isRootBlocker ? `<span class="dag-root-marker" data-root-blocker="true" title="Root blocker" aria-hidden="true"></span>` : ""}
      <div class="dag-node-top">
        <span class="task-id"><span class="dag-dept-dot" data-dept-swatch="${escapeHtml(role)}" aria-hidden="true"></span>${escapeHtml(roleTitle)} #${displayId}</span>
        <button type="button" class="status-badge dag-node-status-btn task-detail-toggle-btn ${meta.cls}" data-task-id="${task.id}" data-dag-detail-btn="${task.id}" data-task-status="${escapeHtml(effectiveStatus)}" data-status-tone="${escapeHtml(tone)}" aria-expanded="${isDetailOpen ? "true" : "false"}" aria-label="${escapeHtml(meta.label)} — Details for ${escapeHtml(roleTitle)} #${displayId}"><span class="dag-status-dot" aria-hidden="true"></span><span>${escapeHtml(shortStatus)} ${isDetailOpen ? "▾" : "▸"}</span></button>
      </div>
      <div class="dag-node-title">${escapeHtml(task.title)}</div>
    </article>
  `;
}

export function renderDagDetailPanel(dag: TaskDagResult, state: TasksRolesV8FilterState): string {
	if (!state.activeDagDetailTaskId) return "";
	const dagNode = (dag.nodes ?? []).find((n) => n.id === state.activeDagDetailTaskId);
	if (!dagNode) return "";
	const task = dagNode.task;
	const role = task.role ?? "dept";
	const roleTitle = task.roleTitle ?? task.role ?? "Dept";
	const displayId = task.displayId ?? task.id;
	const effectiveStatus = effectiveTaskLifecycleStatus(task, state.answeredTasks);
	const tagsHtml = (task.tags ?? [])
		.slice(0, 3)
		.map((tg) => `<span class="tag-pill">#${escapeHtml(tg)}</span>`)
		.join("");
	const pipelineMeter = renderDeliveryPipelineMeter(task, effectiveStatus);
	const dependsOnRefs = dagNode.dependsOnRefs ?? task.dependsOnRefs ?? [];
	const unlocksRefs = dagNode.unlocksRefs ?? [];
	const depEdges: string[] = [];
	if (dependsOnRefs.length > 0) {
		depEdges.push(`<span class="seq-edge-pill">Depends on: ${escapeHtml(dependsOnRefs.join(", "))}</span>`);
	}
	if (unlocksRefs.length > 0) {
		depEdges.push(`<span class="seq-edge-pill">Unlocks → ${escapeHtml(unlocksRefs.join(", "))}</span>`);
	}

	return `
    <aside class="dag-detail-panel" data-dag-detail-panel="${task.id}" data-task-detail="${task.id}" role="region" aria-label="Task details for ${escapeHtml(roleTitle)} #${displayId}">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
        <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap;">
          <span class="task-id"><span class="dag-dept-dot" data-dept-swatch="${escapeHtml(role)}" aria-hidden="true"></span>${escapeHtml(roleTitle)} #${displayId}</span>
          ${renderStatusBadge(effectiveStatus, false)}
        </div>
        <button type="button" class="chip-btn dag-detail-close-btn" data-close-dag-detail="${task.id}" aria-label="Close task details">Close ✕</button>
      </div>
      <div style="font-size:15px; font-weight:700; color:var(--text-primary);">${escapeHtml(task.title)}</div>
      <div class="task-subline">${tagsHtml}${depEdges.join("")}${pipelineMeter}</div>
      ${task.latestTldr ? `<div class="task-subline"><span>Latest TL;DR: "${escapeHtml(task.latestTldr.text)}" · ${escapeHtml(task.latestTldr.age ?? "just now")}</span></div>` : ""}
      ${renderTaskCallouts(task, state.answeredTasks)}
    </aside>
  `;
}

export function renderDagBoard(params: {
	tasks: ReadonlyArray<UiRoleTask>;
	boardId: string;
	contextTasks?: ReadonlyArray<UiRoleTask>;
	state: TasksRolesV8FilterState;
	activeDagBoards?: Map<string, TaskDagResult>;
	legendHtml?: string;
}): string {
	const { tasks, boardId, contextTasks, state, activeDagBoards, legendHtml = "" } = params;
	const dag = buildTaskDag(tasks, contextTasks);
	activeDagBoards?.set(boardId, dag);
	const colCount = Math.max(1, dag.stages.length);

	const columnsHtml = dag.stages
		.map((stage) => {
			const sortedNodes = sortStageNodesForCeiling(stage.nodes, state.answeredTasks);
			const stageKey = `${boardId}:${stage.stageIndex}`;
			const isColExpanded = Boolean(state.expandedDagStageCols?.[stageKey]);
			const visibleNodes = isColExpanded ? sortedNodes : sortedNodes.slice(0, DAG_STAGE_CARD_CEILING);
			const hiddenCount = Math.max(0, sortedNodes.length - DAG_STAGE_CARD_CEILING);
			const overflowBtnHtml =
				sortedNodes.length > DAG_STAGE_CARD_CEILING
					? `<button type="button" class="chip-btn dag-col-overflow-btn" data-stage-overflow-toggle="${escapeHtml(stageKey)}" data-dag-stage-col-btn="${stage.stageIndex}" aria-expanded="${isColExpanded ? "true" : "false"}">${isColExpanded ? `Show top ${DAG_STAGE_CARD_CEILING} ▴` : `+${hiddenCount} more (${sortedNodes.length} total) ▸`}</button>`
					: "";
			return `
        <div class="dag-stage-col seq-stage-block" data-sequence-stage="${stage.stepNumber}" data-dag-stage-col="${stage.stageIndex}" data-total-stage-nodes="${sortedNodes.length}">
          <div class="dag-stage-header dept-stage-header">
            <span class="seq-stage-pill">${escapeHtml(stage.stageLabel)}</span>
            <span style="font-size:14px; font-weight:700; color:var(--text-secondary);">${sortedNodes.length} ${sortedNodes.length === 1 ? "task" : "tasks"}</span>
          </div>
          <div class="dag-stage-nodes">
            ${visibleNodes.map((n) => renderTaskNode(n, state)).join("")}
            ${overflowBtnHtml}
          </div>
        </div>
      `;
		})
		.join("");

	return `
    <div class="dag-board" data-dag-board="${escapeHtml(boardId)}" style="--dag-cols:${colCount};">
      ${legendHtml}
      <svg class="dag-edges-svg" data-dag-svg="${escapeHtml(boardId)}" aria-hidden="true"></svg>
      <div class="dag-columns">
        ${columnsHtml}
      </div>
      ${renderDagDetailPanel(dag, state)}
    </div>
  `;
}

export function renderTagDagRegion(params: {
	dataset: TasksRolesV8Dataset;
	state: TasksRolesV8FilterState;
	activeDagBoards?: Map<string, TaskDagResult>;
}): string {
	const { dataset, state, activeDagBoards } = params;
	if (!state.activeTagDag) return "";

	const tagId = state.activeTagDag;
	const parentAsk = dataset.askGroups.find((a) => (a.tags ?? []).includes(tagId)) ?? dataset.askGroups[0];
	if (!parentAsk) return "";

	const askIdForAttr = tagId === "mobile-redesign" ? "tag:mobile-redesign" : `tag:${tagId}`;
	const activeRoleFilter = state.handoffRoleFilter[askIdForAttr] ?? null;

	const allTasksWithContext: Array<{ task: UiRoleTask; ask?: UiTaskGroupRollup }> = [];
	const seenTaskIds = new Set<number>();
	for (const ask of dataset.askGroups) {
		for (const t of ask.tasks ?? []) {
			allTasksWithContext.push({ task: t, ask });
			seenTaskIds.add(t.id);
		}
	}
	for (const t of dataset.tasks) {
		if (!seenTaskIds.has(t.id)) {
			allTasksWithContext.push({ task: t });
			seenTaskIds.add(t.id);
		}
	}

	const directTaggedTasks = allTasksWithContext
		.filter(({ task, ask }) => (task.tags ?? ask?.tags ?? []).includes(tagId))
		.map(({ task }) => task);
	const allTasksRaw = allTasksWithContext.map(({ task }) => task);
	const byRef = new Map(allTasksRaw.map((t) => [`${t.role} #${t.displayId ?? t.id}`, t]));
	const tagTaskMap = new Map<number, UiRoleTask>();

	for (const t of directTaggedTasks) {
		tagTaskMap.set(t.id, t);
		for (const ref of t.dependsOnRefs ?? []) {
			const p = byRef.get(ref);
			if (p) tagTaskMap.set(p.id, p);
		}
	}

	const fullTagTasks = [...tagTaskMap.values()];
	let dagTasks = fullTagTasks;
	if (activeRoleFilter) {
		dagTasks = dagTasks.filter((t) => t.role === activeRoleFilter);
	}

	const boardId = tagId === "mobile-redesign" ? "ask-tag-mobile-redesign" : `tag-dag-${tagId}`;
	const dagPreview = buildTaskDag(dagTasks, fullTagTasks);
	const stageCount = dagPreview.stages.length;
	const effectiveRollupStatus = fullTagTasks.some(
		(t) => effectiveTaskLifecycleStatus(t, state.answeredTasks) === "stuck",
	)
		? "needs_you"
		: parentAsk.rollupStatus;
	const effectiveRollupTone = effectiveRollupStatus === "needs_you" ? "needs_you" : parentAsk.statusTone || "working";

	const deptRolesInDag: Array<{ role: string; roleTitle: string }> = [];
	const seenDeptRoles = new Set<string>();
	for (const step of parentAsk.handoff ?? []) {
		if (step.role && !seenDeptRoles.has(step.role)) {
			seenDeptRoles.add(step.role);
			deptRolesInDag.push({ role: step.role, roleTitle: step.roleTitle || step.role });
		}
	}
	for (const t of fullTagTasks) {
		const role = t.role || "dept";
		if (!seenDeptRoles.has(role)) {
			seenDeptRoles.add(role);
			deptRolesInDag.push({ role, roleTitle: t.roleTitle ?? role });
		}
	}

	const legendHtml = `
    <div class="dag-dept-legend" role="group" aria-label="Departments in DAG (node color legend)">
      ${deptRolesInDag
				.map((d) => {
					const pressed = activeRoleFilter === d.role ? "true" : "false";
					return `<button type="button" class="dag-dept-chip handoff-step" data-ask-id="${escapeHtml(askIdForAttr)}" data-step-role="${escapeHtml(d.role)}" aria-pressed="${pressed}">
          <span class="dag-dept-dot" data-dept-swatch="${escapeHtml(d.role)}" aria-hidden="true"></span>
          <span>${escapeHtml(d.roleTitle)}</span>
        </button>`;
				})
				.join("")}
      ${activeRoleFilter ? `<button type="button" class="chip-btn clear-handoff-btn" data-ask-id="${escapeHtml(askIdForAttr)}">All depts</button>` : ""}
    </div>
  `;

	const dagBoardHtml = renderDagBoard({
		tasks: dagTasks,
		boardId,
		contextTasks: fullTagTasks,
		state,
		activeDagBoards,
		legendHtml,
	});

	const tagSelectOptionsHtml = dataset.allTags
		.map((tg) => {
			const isCur = tg.id === tagId;
			return `<option value="${escapeHtml(tg.id)}" ${isCur ? "selected" : ""}>☍ ${escapeHtml(tg.label)}</option>`;
		})
		.join("");

	const askTitle =
		parentAsk.title && parentAsk.title !== `#${tagId}` && parentAsk.title !== tagId
			? parentAsk.title
			: tagId
					.split("-")
					.filter(Boolean)
					.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
					.join(" ");

	const cleanUnblockText = (parentAsk.howToUnblock ?? "").replace(/^(?:how to unblock:\s*)+/i, "").trim();

	return `
    <section id="tag-dag-region" class="ask-card" data-ask-card="${escapeHtml(askIdForAttr)}" data-system-section="${escapeHtml(parentAsk.appOrSystem ?? "pi-web-ui")}" data-status-tone="${escapeHtml(effectiveRollupTone)}" data-dag-stages="${stageCount}" data-ask-expanded="true" aria-label="Tag Implementation DAG for #${escapeHtml(tagId)}" style="margin-bottom:14px;">
      <div class="dag-header-row ask-card-header">
        <h3 class="ask-title dag-header-title">
          <span>#${escapeHtml(tagId)} — ${escapeHtml(askTitle)}</span>
          <span class="dag-header-meta">· ${fullTagTasks.length} ${fullTagTasks.length === 1 ? "task" : "tasks"} · ${stageCount} ${stageCount === 1 ? "stage" : "stages"} · ${dagPreview.edges.length} ${dagPreview.edges.length === 1 ? "edge" : "edges"}</span>
        </h3>
        <div class="dag-header-controls">
          ${renderStatusBadge(effectiveRollupStatus, true)}
          <select class="dag-tag-select" data-dag-tag-select aria-label="Switch tag DAG">
            ${tagSelectOptionsHtml}
          </select>
          <button type="button" class="chip-btn seq-toggle-btn" data-ask-id="${escapeHtml(askIdForAttr)}" data-open-tag-dag="${escapeHtml(tagId)}" aria-expanded="true" style="padding:3px 10px;">
            Close DAG ✕
          </button>
        </div>
      </div>

      ${dagBoardHtml}

      <div class="how-to-unblock-banner dag-footer-unblock tone-${escapeHtml(effectiveRollupTone)}" data-unblock-banner="${escapeHtml(askIdForAttr)}">
        <div>
          <strong>How to unblock:</strong> ${escapeHtml(cleanUnblockText)}${dagPreview.rootBlockerRefs.length ? ` <span style="font-weight:700; color:var(--text-primary);" data-root-blocker="true">(Root: ${escapeHtml(dagPreview.rootBlockerRefs.join(", "))})</span>` : ""}
        </div>
      </div>
    </section>
  `;
}

export function renderUnifiedTasksPanel(params: {
	dataset: TasksRolesV8Dataset;
	state: TasksRolesV8FilterState;
	activeDagBoards?: Map<string, TaskDagResult>;
}): string {
	const { dataset, state, activeDagBoards } = params;
	const allTasksWithContext: Array<{ task: UiRoleTask; ask: UiTaskGroupRollup }> = [];
	for (const ask of dataset.askGroups) {
		for (const t of ask.tasks ?? []) {
			allTasksWithContext.push({ task: t, ask });
		}
	}

	const matchingItems = allTasksWithContext.filter(({ task, ask }) => matchesTaskFilters(task, state, ask));

	if (matchingItems.length === 0) {
		return `
      <div class="state-card">
        <h2 style="margin-top:0;">No tasks match your current filter</h2>
        <p>Try clearing one of the selected department, state, or tag filters.</p>
        <button type="button" class="choice-btn" id="empty-reset-btn">Reset all filters</button>
      </div>
    `;
	}

	const tagDagDrawerHtml = renderTagDagRegion({ dataset, state, activeDagBoards });
	const fullAllTasks = allTasksWithContext.map(({ task }) => task);
	const globalDag = buildTaskDag(fullAllTasks, fullAllTasks);
	const dagNodeById = globalDag.byId;

	const sortedTasks = sortTasksByUrgency(
		matchingItems.map((m) => m.task),
		state.answeredTasks,
	);
	const askByTaskId = new Map(allTasksWithContext.map((m) => [m.task.id, m.ask]));

	const rowsHtml = sortedTasks
		.map((task) =>
			renderUnifiedTaskCard({
				task,
				ask: askByTaskId.get(task.id),
				dagNode: dagNodeById.get(task.id),
				state,
			}),
		)
		.join("");

	const allDetailsOpen = sortedTasks.every((task) => Boolean(state.expandedTasks[task.id]));

	return `
    ${tagDagDrawerHtml}
    <section class="unified-tasks-panel" aria-label="All available tasks across all departments">
      <div class="unified-tasks-header">
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <h2 style="margin:0; font-size:15px; font-weight:800; color:var(--text-primary);">All Available Tasks Across Departments</h2>
          <span class="tier-count-pill">${sortedTasks.length} of ${allTasksWithContext.length} tasks</span>
        </div>
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          ${
						state.selectedTags.length === 1
							? `<button type="button" class="tag-dag-btn" data-open-tag-dag="${escapeHtml(state.selectedTags[0])}" aria-pressed="${state.activeTagDag === state.selectedTags[0] ? "true" : "false"}">
                  <span>☍ ${state.activeTagDag === state.selectedTags[0] ? `Hide #${escapeHtml(state.selectedTags[0])} DAG` : `View #${escapeHtml(state.selectedTags[0])} Implementation DAG & Task States`}</span>
                </button>`
							: ""
					}
          <button type="button" class="chip-btn" id="toggle-all-task-details-btn" aria-expanded="${allDetailsOpen ? "true" : "false"}">
            ${allDetailsOpen ? "Collapse all task details ▴" : "Expand all task details ▾"}
          </button>
        </div>
      </div>
      <div class="unified-task-list">
        ${rowsHtml}
      </div>
    </section>
  `;
}

export function drawAllDagEdges(rootEl: ParentNode, activeDagBoards: ReadonlyMap<string, TaskDagResult>): void {
	rootEl.querySelectorAll<HTMLElement>("[data-dag-board]").forEach((boardEl) => {
		const boardId = boardEl.getAttribute("data-dag-board") ?? "";
		const svgEl = boardEl.querySelector<SVGSVGElement>("[data-dag-svg]");
		const dag = activeDagBoards.get(boardId);
		if (!svgEl || !dag) return;

		const r = boardEl.getBoundingClientRect();
		const boardRect = {
			left: r.left,
			top: r.top,
			right: r.right,
			bottom: r.bottom,
			width: r.width > 0 ? r.width : 960,
			height: r.height > 0 ? r.height : 320,
		};

		svgEl.setAttribute("viewBox", `0 0 ${Math.round(boardRect.width)} ${Math.round(boardRect.height)}`);
		const markerDef = `
      <defs>
        <marker id="dag-arrow-${escapeHtml(boardId)}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--accent-bg)"></path>
        </marker>
        <marker id="dag-arrow-crit-${escapeHtml(boardId)}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9 z" fill="var(--warn-box-border)"></path>
        </marker>
      </defs>
    `;

		const stageByNodeId = new Map<number, number>();
		const rowByNodeId = new Map<number, number>();
		for (const st of dag.stages) {
			st.nodes.forEach((n, idx) => {
				stageByNodeId.set(n.id, st.stageIndex);
				rowByNodeId.set(n.id, idx);
			});
		}

		const paths: string[] = [];
		for (const edge of dag.edges) {
			const fromEl = boardEl.querySelector<HTMLElement>(`[data-dag-node="${edge.from}"]`);
			const toEl = boardEl.querySelector<HTMLElement>(`[data-dag-node="${edge.to}"]`);
			if (!fromEl || !toEl) continue;

			let fRect = fromEl.getBoundingClientRect();
			let tRect = toEl.getBoundingClientRect();

			// Fallback synthetic layout rects for headless/jsdom environments where getBoundingClientRect returns 0x0
			if (fRect.width === 0 && tRect.width === 0) {
				const fStage = stageByNodeId.get(edge.from) ?? 0;
				const tStage = stageByNodeId.get(edge.to) ?? 1;
				const fRow = rowByNodeId.get(edge.from) ?? 0;
				const tRow = rowByNodeId.get(edge.to) ?? 0;
				fRect = {
					left: fStage * 300 + 16,
					right: fStage * 300 + 260,
					top: fRow * 110 + 40,
					bottom: fRow * 110 + 120,
					width: 244,
					height: 80,
					x: fStage * 300 + 16,
					y: fRow * 110 + 40,
					toJSON: () => ({}),
				};
				tRect = {
					left: tStage * 300 + 16,
					right: tStage * 300 + 260,
					top: tRow * 110 + 40,
					bottom: tRow * 110 + 120,
					width: 244,
					height: 80,
					x: tStage * 300 + 16,
					y: tRow * 110 + 40,
					toJSON: () => ({}),
				};
			}

			const d = computeBezierPath(fRect, tRect, boardRect);
			const stroke = edge.critical ? "var(--warn-box-border)" : "var(--accent-bg)";
			const dash = edge.critical ? `stroke-dasharray="5 3"` : "";
			const marker = edge.critical
				? `url(#dag-arrow-crit-${escapeHtml(boardId)})`
				: `url(#dag-arrow-${escapeHtml(boardId)})`;
			paths.push(
				`<path class="dag-edge" data-from="${edge.from}" data-to="${edge.to}" data-critical="${edge.critical ? "true" : "false"}" d="${d}" fill="none" stroke="${stroke}" stroke-width="2.25" ${dash} marker-end="${marker}"></path>`,
			);
		}

		svgEl.innerHTML = markerDef + paths.join("");
	});
}
