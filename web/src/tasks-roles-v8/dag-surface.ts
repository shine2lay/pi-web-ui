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
import { escapeHtml } from "./reference-data";
import { statusToneForLifecycle, type TasksRolesV8Dataset, type UiRoleTask, type UiTaskGroupRollup } from "./types";

export function renderTaskNode(dagNode: TaskDagNode, state: TasksRolesV8FilterState): string {
	const task = dagNode.task;
	const stepNum = dagNode.stepNumber || 1;
	const stageIndex = dagNode.stageIndex ?? stepNum - 1;
	const isRootBlocker = Boolean(dagNode.isRootBlocker);
	const dependsOnRefs = dagNode.dependsOnRefs ?? task.dependsOnRefs ?? [];
	const unlocksRefs = dagNode.unlocksRefs ?? [];
	const hasInPort = (dagNode.inSetParentCount || 0) > 0;
	const hasOutPort = (dagNode.inSetChildCount || 0) > 0;
	const isTaskExpanded = Boolean(state.expandedTasks[task.id]);

	const effectiveStatus = effectiveTaskLifecycleStatus(task, state.answeredTasks);
	const tone = statusToneForLifecycle(effectiveStatus);
	const tagsHtml = (task.tags ?? [])
		.slice(0, 2)
		.map((tg) => `<span class="tag-pill">#${escapeHtml(tg)}</span>`)
		.join("");
	const rootBadge = isRootBlocker ? `<span class="seq-root-badge" data-root-blocker="true">Root blocker</span>` : "";
	const depEdges: string[] = [];
	if (dependsOnRefs.length > 0) {
		depEdges.push(`<span class="seq-edge-pill">Depends on: ${escapeHtml(dependsOnRefs.join(", "))}</span>`);
	}
	if (unlocksRefs.length > 0) {
		depEdges.push(`<span class="seq-edge-pill">Unlocks → ${escapeHtml(unlocksRefs.join(", "))}</span>`);
	}
	const pipelineMeter = renderDeliveryPipelineMeter(task, effectiveStatus);
	const roleTitle = task.roleTitle ?? task.role ?? "Dept";
	const displayId = task.displayId ?? task.id;

	return `
    <article class="dag-node-card task-row" data-task-id="${task.id}" data-display-task-id="${displayId}" data-dag-node="${task.id}" data-dag-stage="${stageIndex}" data-seq-step="${stepNum}" data-status-tone="${escapeHtml(tone)}" data-root-blocker-node="${isRootBlocker ? "true" : "false"}" data-task-expanded="${isTaskExpanded ? "true" : "false"}">
      ${hasInPort ? `<span class="dag-port dag-port-in" aria-hidden="true"></span>` : ""}
      ${hasOutPort ? `<span class="dag-port dag-port-out" aria-hidden="true"></span>` : ""}
      <div class="task-main-line">
        <div class="task-id-title">
          ${rootBadge}
          <span class="task-id">${escapeHtml(roleTitle)} #${displayId}</span>
          <span>${escapeHtml(task.title)}</span>
        </div>
        <div class="ask-meta-row">
          ${renderStatusBadge(effectiveStatus, false)}
        </div>
      </div>
      <div class="task-subline" style="justify-content:space-between; align-items:center;">
        <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
          ${depEdges.join("")}
          ${!depEdges.length ? `<span style="font-size:14px; color:var(--text-secondary);">Direct task</span>` : ""}
        </div>
        <button type="button" class="chip-btn task-detail-toggle-btn" data-task-id="${task.id}" aria-expanded="${isTaskExpanded ? "true" : "false"}" style="min-height:28px; padding:2px 8px;">
          ${isTaskExpanded ? "Hide details ▴" : "Details ▸"}
        </button>
      </div>
      ${
				isTaskExpanded
					? `<div class="task-detail-drawer" data-task-detail="${task.id}" style="display:flex; flex-direction:column; gap:6px; padding-top:6px; border-top:1px solid var(--border-subtle);">
              <div class="task-subline">${tagsHtml}${pipelineMeter}</div>
              ${task.latestTldr ? `<div class="task-subline"><span>Latest TL;DR: "${escapeHtml(task.latestTldr.text)}" · ${escapeHtml(task.latestTldr.age ?? "just now")}</span></div>` : ""}
              ${renderTaskCallouts(task, state.answeredTasks)}
            </div>`
					: ""
			}
    </article>
  `;
}

export function renderDagBoard(params: {
	tasks: ReadonlyArray<UiRoleTask>;
	boardId: string;
	contextTasks?: ReadonlyArray<UiRoleTask>;
	state: TasksRolesV8FilterState;
	activeDagBoards?: Map<string, TaskDagResult>;
}): string {
	const { tasks, boardId, contextTasks, state, activeDagBoards } = params;
	const dag = buildTaskDag(tasks, contextTasks);
	activeDagBoards?.set(boardId, dag);
	const colCount = Math.max(1, dag.stages.length);

	const columnsHtml = dag.stages
		.map((stage) => {
			const deptsInStage = [...new Set(stage.nodes.map((n) => n.task.roleTitle ?? n.task.role ?? "Dept"))].join(" + ");
			return `
        <div class="dag-stage-col seq-stage-block" data-sequence-stage="${stage.stepNumber}" data-dag-stage-col="${stage.stageIndex}">
          <div class="dag-stage-header dept-stage-header">
            <span class="seq-stage-pill">${escapeHtml(stage.stageLabel)}</span>
            <span style="font-size:14px; font-weight:700; color:var(--text-secondary);">${escapeHtml(deptsInStage)} (${stage.nodes.length})</span>
          </div>
          <div class="dag-stage-nodes">
            ${stage.nodes.map((n) => renderTaskNode(n, state)).join("")}
          </div>
        </div>
      `;
		})
		.join("");

	return `
    <div class="dag-board" data-dag-board="${escapeHtml(boardId)}" style="--dag-cols:${colCount};">
      <svg class="dag-edges-svg" data-dag-svg="${escapeHtml(boardId)}" aria-hidden="true"></svg>
      <div class="dag-columns">
        ${columnsHtml}
      </div>
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

	const allTasksWithContext: Array<{ task: UiRoleTask; ask: UiTaskGroupRollup }> = [];
	for (const ask of dataset.askGroups) {
		for (const t of ask.tasks ?? []) {
			allTasksWithContext.push({ task: t, ask });
		}
	}

	const directTaggedTasks = allTasksWithContext
		.filter(({ task, ask }) => (task.tags ?? ask.tags ?? []).includes(tagId))
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
	const dagBoardHtml = renderDagBoard({
		tasks: dagTasks,
		boardId,
		contextTasks: fullTagTasks,
		state,
		activeDagBoards,
	});

	const handoffStepsHtml = (parentAsk.handoff ?? [])
		.map((step, idx, arr) => {
			const stepTone = statusToneForLifecycle(step.status);
			const pressed = activeRoleFilter === step.role ? "true" : "false";
			const arrow =
				idx < arr.length - 1
					? `<svg class="handoff-connector-svg" viewBox="0 0 18 14" aria-hidden="true" style="width:12px; height:12px;">
              <line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="1.75"></line>
              <polygon points="11,3 17,7 11,11" fill="currentColor"></polygon>
            </svg>`
					: "";
			return `
        <button type="button" class="handoff-step handoff-node tone-${escapeHtml(stepTone)}" data-ask-id="${escapeHtml(askIdForAttr)}" data-step-role="${escapeHtml(step.role)}" aria-pressed="${pressed}">
          <span class="status-dot tone-${escapeHtml(stepTone)}" aria-hidden="true"></span>
          <span>${escapeHtml(step.roleTitle)} (${escapeHtml(step.summary)})</span>
        </button>
        ${arrow}
      `;
		})
		.join("");

	const tagSwitcherHtml = dataset.allTags
		.map((tg) => {
			const isCur = tg.id === tagId;
			return `<button type="button" class="tag-dag-btn" data-open-tag-dag="${escapeHtml(tg.id)}" aria-pressed="${isCur ? "true" : "false"}"><span>☍ ${escapeHtml(tg.label)}</span></button>`;
		})
		.join("");

	return `
    <section id="tag-dag-region" class="ask-card" data-ask-card="${escapeHtml(askIdForAttr)}" data-system-section="${escapeHtml(parentAsk.appOrSystem ?? "pi-web-ui")}" data-status-tone="${escapeHtml(parentAsk.statusTone || "working")}" data-dag-stages="${stageCount}" data-ask-expanded="true" aria-label="Tag Implementation DAG for #${escapeHtml(tagId)}" style="margin-bottom:14px;">
      <div class="ask-card-header" style="gap:10px; align-items:flex-start;">
        <div class="ask-title-group" style="gap:4px;">
          <div class="ask-meta-row" style="font-size:14px; color:var(--text-muted);">
            <span style="font-weight:700; color:var(--text-secondary);">Tag Implementation DAG &amp; Task States</span>
            <span>· #${escapeHtml(tagId)} (${fullTagTasks.length} tasks across ${stageCount} ${stageCount === 1 ? "stage" : "stages"} · ${dagPreview.edges.length} dependency ${dagPreview.edges.length === 1 ? "edge" : "edges"})</span>
          </div>
          <h3 class="ask-title" style="margin:0; font-size:17px;">#${escapeHtml(tagId)} — ${escapeHtml(
						parentAsk.title && parentAsk.title !== `#${tagId}` && parentAsk.title !== tagId
							? parentAsk.title
							: tagId
									.split("-")
									.filter(Boolean)
									.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
									.join(" "),
					)}</h3>
        </div>
        <div class="ask-meta-row" style="flex-shrink:0;">
          ${renderStatusBadge(parentAsk.rollupStatus, true)}
          <button type="button" class="chip-btn seq-toggle-btn" data-ask-id="${escapeHtml(askIdForAttr)}" data-open-tag-dag="${escapeHtml(tagId)}" aria-expanded="true" style="padding:3px 10px;">
            Close DAG ✕
          </button>
        </div>
      </div>

      <div class="how-to-unblock-banner tone-${escapeHtml(parentAsk.statusTone || "working")}" data-unblock-banner="${escapeHtml(askIdForAttr)}">
        <div>
          <strong>How to unblock:</strong> ${escapeHtml((parentAsk.howToUnblock ?? "").replace(/^(?:how to unblock:\s*)+/i, "").trim())}${dagPreview.rootBlockerRefs.length ? ` <span style="font-weight:700; color:var(--text-primary);" data-root-blocker="true">(Root: ${escapeHtml(dagPreview.rootBlockerRefs.join(", "))})</span>` : ""}
        </div>
      </div>

      <div class="handoff-bar handoff-graph" role="group" aria-label="Switch tag DAG or filter department station">
        <span class="handoff-label">Switch tag DAG:</span>
        ${tagSwitcherHtml}
      </div>

      <div class="handoff-bar handoff-graph" role="group" aria-label="Related department handoff items">
        <span class="handoff-label">Departments in DAG:</span>
        ${handoffStepsHtml}
        ${activeRoleFilter ? `<button type="button" class="chip-btn clear-handoff-btn" data-ask-id="${escapeHtml(askIdForAttr)}">Show all stations</button>` : ""}
        <button type="button" class="chip-btn expand-ask-tasks-btn" data-ask-id="${escapeHtml(parentAsk.key)}" style="margin-left:auto;">
          ${dagTasks.every((t) => state.expandedTasks[t.id]) ? "Collapse node details ▴" : "Expand all node details ▾"}
        </button>
      </div>

      <div class="sequence-section" style="margin-top:4px;">
        ${dagBoardHtml}
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
