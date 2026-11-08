import type { TaskDagNode } from "./dag";
import {
	buildFilterDropdownModels,
	computeAttentionSummary,
	effectiveTaskLifecycleStatus,
	type TasksRolesV8FilterState,
} from "./filters";
import { escapeHtml, ROLLUP_META, STATUS_META } from "./reference-data";
import {
	statusToneForLifecycle,
	type TasksRolesV8Dataset,
	type UiGroupRollupStatus,
	type UiRoleTask,
	type UiTaskGroupRollup,
	type UiTaskLifecycleStatus,
} from "./types";

export function renderStatusBadge(
	statusKey: UiTaskLifecycleStatus | UiGroupRollupStatus | string,
	isRollup: boolean = false,
): string {
	const meta =
		(isRollup ? ROLLUP_META[statusKey as UiGroupRollupStatus] : STATUS_META[statusKey as UiTaskLifecycleStatus]) ??
		STATUS_META.working;
	const tone = isRollup
		? (ROLLUP_META[statusKey as UiGroupRollupStatus]?.tone ?? "active")
		: statusToneForLifecycle((statusKey as UiTaskLifecycleStatus) || "working");

	let svgIcon = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="8" cy="8" r="6"></circle><circle cx="8" cy="8" r="2.6" fill="currentColor" stroke="none"></circle></svg>`;
	if (statusKey === "stuck" || statusKey === "needs_you" || statusKey === "waiting" || statusKey === "stalled") {
		svgIcon = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M4.5 2h7M4.5 14h7"></path><path d="M5.2 2c0 3.2 5.6 3 5.6 6s-5.6 2.8-5.6 6M10.8 2c0 3.2-5.6 3-5.6 6s5.6 2.8 5.6 6"></path></svg>`;
	} else if (statusKey === "blocked") {
		svgIcon = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="8" cy="8" r="6"></circle><path d="M3.8 3.8l8.4 8.4"></path></svg>`;
	} else if (statusKey === "asking" || statusKey === "needs_lead") {
		svgIcon = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6"></circle><path d="M8 4.8V8l2.2 1.5"></path></svg>`;
	} else if (statusKey === "paused") {
		svgIcon = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M5.5 3.5v9M10.5 3.5v9"></path></svg>`;
	} else if (statusKey === "queued") {
		svgIcon = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M3 4.5h10M3 8h10M3 11.5h6"></path></svg>`;
	} else if (
		statusKey === "live" ||
		statusKey === "done" ||
		statusKey === "landed" ||
		statusKey === "landed_pending_deploy"
	) {
		svgIcon = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"></path></svg>`;
	}

	return `<span class="status-badge ${meta.cls}" data-task-status="${escapeHtml(statusKey)}" data-status-tone="${escapeHtml(tone)}">${svgIcon}<span>${escapeHtml(meta.label)}</span></span>`;
}

export function renderDeliveryPipelineMeter(
	task: Pick<UiRoleTask, "pipelineStage" | "lifecycleStatus">,
	effectiveStatus?: UiTaskLifecycleStatus,
): string {
	const stageByStatus: Partial<Record<UiTaskLifecycleStatus, number>> = {
		working: 1,
		landing: 2,
		landed: 3,
		deploying: 4,
		live: 5,
	};
	const st = effectiveStatus ?? task.lifecycleStatus;
	const stage = stageByStatus[st] ?? task.pipelineStage ?? 0;
	if (!stage) return "";

	const steps = [
		{ n: 1, label: "1.Work" },
		{ n: 2, label: "2.Land" },
		{ n: 3, label: "3.Master" },
		{ n: 4, label: "4.Deploy" },
		{ n: 5, label: "5.Live" },
	];
	const nodes = steps
		.map((s) => {
			const cls = s.n < stage ? "pipe-step done" : s.n === stage ? "pipe-step current" : "pipe-step";
			const dot = s.n < stage ? "✓" : s.n === stage ? "●" : "○";
			return `<span class="${cls}">${dot} ${s.label}</span>`;
		})
		.join(`<span aria-hidden="true" style="color:var(--text-muted);">→</span>`);
	return `<div class="pipeline-meter" aria-label="5-stage code delivery pipeline">${nodes}</div>`;
}

export function renderTaskCallouts(task: UiRoleTask, answeredTasks?: Readonly<Record<number, string>>): string {
	const parts: string[] = [];

	if (task.lifecycleStatus === "stuck") {
		const answered = answeredTasks?.[task.id];
		if (answered) {
			parts.push(
				`<div class="callout-box"><strong>✓ Answered by you:</strong> "${escapeHtml(answered)}" — sent to ${escapeHtml(task.roleTitle ?? task.role ?? "Lead")} #${task.id}.</div>`,
			);
		} else if (task.stuck) {
			const choicesHtml = (task.stuck.choices ?? [])
				.map(
					(c, idx) =>
						`<button type="button" class="choice-btn ${idx === 0 ? "primary-cta" : ""} answer-choice-btn" data-task-id="${task.id}" data-choice="${escapeHtml(c)}" style="padding:5px 10px;">${idx === 0 ? "★ " : ""}${escapeHtml(c)}</button>`,
				)
				.join("");
			const openChatHtml = task.chat?.file
				? `<button type="button" class="choice-btn secondary open-chat-btn" data-chat-file="${escapeHtml(task.chat.file)}" style="padding:5px 10px;">Open chat</button>`
				: "";
			const ageStr = task.stuck.age ?? "just now";
			parts.push(`<div class="callout-box danger">
        <div><strong>! Waiting on your decision (${escapeHtml(ageStr)}):</strong> ${escapeHtml(task.stuck.question)}</div>
        ${task.howToUnblock ? `<div><strong>How to unblock:</strong> ${escapeHtml(task.howToUnblock)}</div>` : ""}
        <div class="choice-row" style="margin-top:4px;">${choicesHtml}${openChatHtml}</div>
      </div>`);
		}
	}

	if (task.lifecycleStatus === "asking") {
		const leadRole = task.askingLead?.leadRole ?? `${task.roleTitle ?? task.role ?? "Department"} Lead`;
		const question = task.askingLead?.question ?? task.stuck?.question ?? "";
		const age = task.askingLead?.age ?? task.stuck?.age ?? "just now";
		if (question) {
			parts.push(`<div class="callout-box ask-tone">
        <div><strong>? Asking ${escapeHtml(leadRole)} (${escapeHtml(age)}):</strong> "${escapeHtml(question)}"</div>
        ${task.howToUnblock ? `<div><strong>How to unblock:</strong> ${escapeHtml(task.howToUnblock)}</div>` : ""}
      </div>`);
		}
	}

	if (task.lifecycleStatus === "blocked" && task.blocked) {
		const depChips = (task.blocked.resolvedOn ?? [])
			.map((dep) => {
				const stKey = (dep.lifecycleStatus ?? dep.status ?? "working") as UiTaskLifecycleStatus;
				const stMeta = STATUS_META[stKey] ?? STATUS_META.working;
				return `<span class="dep-chip">
          <span>${escapeHtml(dep.ref)}${dep.title ? ` · ${escapeHtml(dep.title)}` : ""}</span>
          <span class="status-badge ${stMeta.cls}">${stMeta.icon} ${stMeta.label}</span>
        </span>`;
			})
			.join("");

		const warnings: string[] = [];
		if (task.blocked.haltedWarning) {
			warnings.push(task.blocked.haltedWarning);
		} else {
			for (const dep of task.blocked.resolvedOn ?? []) {
				if (dep.deadlockReason === "queue_stopped") {
					warnings.push(
						`⚠ Blocker ${dep.ref} is in a stopped queue — cannot start until ${dep.role ?? "target"} queue is resumed.`,
					);
				} else if (dep.deadlockReason === "target_paused") {
					warnings.push(`⚠ Blocker ${dep.ref} is in a paused queue — cannot run until ${dep.ref} is resumed.`);
				} else if (dep.deadlockReason === "target_not_found") {
					warnings.push(
						`⚠ Blocker ${dep.ref} does not exist in ${dep.role ?? "target"} queue — lead must update blocker ref.`,
					);
				}
			}
			if (task.blocked.checkpointOverdue) {
				const rem = task.blocked.remindersSent ?? 1;
				warnings.push(
					`⚠ Lead checkpoint overdue (${rem} reminder${rem === 1 ? "" : "s"} sent to ${task.blocked.lead ?? "department"} lead).`,
				);
			}
		}

		const leadLine =
			task.blocked.lead && task.blocked.owes
				? `<div><strong>Accountable lead:</strong> ${escapeHtml(task.blocked.lead)} owes "${escapeHtml(task.blocked.owes)}"${task.blocked.dueIn ? ` · ${escapeHtml(task.blocked.dueIn)}` : ""}</div>`
				: "";

		parts.push(`<div class="callout-box warn">
      <div><strong>How to unblock:</strong> ${escapeHtml(task.howToUnblock || task.blocked.howToUnblock || task.blocked.unblockSummary)}</div>
      <div><strong>To unblock:</strong> ${escapeHtml(task.blocked.unblockSummary)}</div>
      ${depChips ? `<div class="dep-chip-row">${depChips}</div>` : ""}
      ${leadLine}
      ${warnings.map((w) => `<div style="font-weight:700;">${escapeHtml(w)}</div>`).join("")}
    </div>`);
	}

	if (task.lifecycleStatus === "waiting" && task.wait) {
		const elapsedMin =
			task.wait.elapsedMin ?? Math.max(1, Math.round((Date.now() - (task.wait.sinceAt || Date.now())) / 60000));
		const expectMin =
			task.wait.expectMin ?? Math.max(1, Math.round(((task.wait.expectByAt || 0) - (task.wait.sinceAt || 0)) / 60000));
		const everyMin = task.wait.everyMin ?? Math.max(1, Math.round((task.wait.everyMs || 120000) / 60000));
		const overdueNote =
			task.wait.overdueNote ??
			(task.wait.overdue
				? `⚠ Overdue (${elapsedMin}m elapsed vs ${expectMin}m expected) · queue woke chat to inspect`
				: "");

		parts.push(`<div class="callout-box wait-tone">
      ${task.howToUnblock || task.wait.howToUnblock ? `<div><strong>How to unblock:</strong> ${escapeHtml(task.howToUnblock || task.wait.howToUnblock)}</div>` : ""}
      <div><strong>Waiting for:</strong> ${escapeHtml(task.wait.what)}</div>
      <div><strong>Timing:</strong> Elapsed ${elapsedMin}m of ${expectMin}m expected · checks every ${everyMin}m</div>
      ${task.wait.overdue && overdueNote ? `<div style="font-weight:700;">${escapeHtml(overdueNote)}</div>` : ""}
    </div>`);
	}

	if (task.lifecycleStatus === "queued" && task.queuedDetail) {
		const afterChips = (task.queuedDetail.resolvedAfter ?? [])
			.map((dep) => {
				const stKey = (dep.lifecycleStatus ?? dep.status ?? "working") as UiTaskLifecycleStatus;
				const stMeta = STATUS_META[stKey] ?? STATUS_META.working;
				return `<span class="dep-chip">
          <span>${escapeHtml(dep.ref)}${dep.title ? ` · ${escapeHtml(dep.title)}` : ""}</span>
          <span class="status-badge ${stMeta.cls}">${stMeta.icon} ${stMeta.label}</span>
        </span>`;
			})
			.join("");
		parts.push(`<div class="callout-box">
      <div><strong>Starts when:</strong> ${escapeHtml(task.queuedDetail.summary)}</div>
      ${afterChips ? `<div class="dep-chip-row">${afterChips}</div>` : ""}
    </div>`);
	}

	if (task.lifecycleStatus === "paused") {
		const reason = task.pausedReason ?? "Paused by you";
		parts.push(`<div class="callout-box">
      <div><strong>⏸ Paused:</strong> ${escapeHtml(reason)}</div>
      ${task.howToUnblock ? `<div><strong>How to unblock:</strong> ${escapeHtml(task.howToUnblock)}</div>` : ""}
    </div>`);
	}

	if (task.delivery) {
		const d = task.delivery;
		if (task.lifecycleStatus === "landing") {
			parts.push(`<div class="task-subline">
        <span><strong>Landing on ${escapeHtml(d.repo)}:</strong> running merge &amp; test checks (${escapeHtml(d.landingAge ?? "in check gate")})</span>
        ${d.headCommit ? `<span>· Commit <span class="code-sha">${escapeHtml(d.headCommit)}</span></span>` : ""}
      </div>`);
		} else if (task.lifecycleStatus === "landed") {
			const pendingText =
				d.pendingReason ??
				(d.deployPendingReason === "commit_behind"
					? "Live service is on an older commit"
					: d.deployPendingReason === "last_deploy_failed"
						? "Last deploy attempt failed"
						: "On master · not deployed to live service yet");
			parts.push(`<div class="task-subline">
        <span><strong>Landed on master:</strong> <span class="code-sha">${escapeHtml(d.landedCommit ?? "")}</span> (${escapeHtml(d.repo)}, ${escapeHtml(d.landedAge ?? "just now")})</span>
        <span>· <strong>${escapeHtml(pendingText)}</strong></span>
      </div>`);
		} else if (task.lifecycleStatus === "deploying") {
			parts.push(`<div class="task-subline">
        <span><strong>Deploying now:</strong> commit <span class="code-sha">${escapeHtml(d.landedCommit ?? "")}</span> → <strong>${escapeHtml(d.repo)}</strong> (${escapeHtml(d.deployingAge ?? "in progress")})</span>
      </div>`);
		} else if (task.lifecycleStatus === "live") {
			parts.push(`<div class="task-subline">
        <span><strong>Live in production:</strong> commit <span class="code-sha">${escapeHtml(d.liveCommit ?? d.landedCommit ?? "")}</span> on <strong>${escapeHtml(d.repo)}</strong> · deployed ${escapeHtml(d.deployedAge ?? "just now")}</span>
      </div>`);
		}
	}

	if (task.lifecycleStatus === "done" && task.doneSummary) {
		parts.push(`<div class="task-subline">
      <span><strong>Completed deliverable:</strong> ${escapeHtml(task.doneSummary)}</span>
    </div>`);
	}

	return parts.join("");
}

export function renderAttentionNoteBar(tasks: ReadonlyArray<UiRoleTask>, state: TasksRolesV8FilterState): string {
	if (state.mode !== "normal") return "";
	const att = computeAttentionSummary(tasks, state.answeredTasks);
	const isAttentionFiltered = state.statusFilter === "needs_attention";
	const isStuckFiltered = state.statusFilter === "needs_you";

	return `
    <div class="attention-note-bar" style="padding:8px 14px;">
      <div style="display:flex; flex-wrap:wrap; align-items:center; gap:8px;">
        <span class="on-you-badge">ATTENTION</span>
        <span style="font-size:14px; font-weight:650; color:var(--text-primary);">
          ${att.needsAttentionCount} tasks need attention:
        </span>
        <span class="attention-stat-pill"><span style="width:7px;height:7px;border-radius:999px;background:var(--on-you-bg);display:inline-block;"></span> ${att.needsYouCount} Needs you</span>
        <span class="attention-stat-pill"><span style="width:7px;height:7px;border-radius:999px;background:var(--st-blocked-text);display:inline-block;"></span> ${att.blockedWaitingCount} Blocked / Waiting</span>
        <span class="attention-stat-pill"><span style="width:7px;height:7px;border-radius:999px;background:var(--st-asking-text);display:inline-block;"></span> ${att.askingLeadCount} Asking lead</span>
      </div>
      <div style="display:flex; flex-wrap:wrap; align-items:center; gap:6px;">
        <button type="button" class="choice-btn ${isAttentionFiltered ? "primary-cta" : ""}" id="filter-needs-attention-btn" aria-pressed="${isAttentionFiltered ? "true" : "false"}" style="padding:5px 12px; box-shadow:var(--keycap-shadow);">
          ${isAttentionFiltered ? `✓ Filtering needs attention (${att.needsAttentionCount})` : `Filter to needs attention (${att.needsAttentionCount})`}
        </button>
        <button type="button" class="chip-btn" id="filter-only-on-you-btn" aria-pressed="${isStuckFiltered ? "true" : "false"}" style="box-shadow:var(--keycap-shadow);">
          ${isStuckFiltered ? `✓ Only Needs you (${att.onlyOnYouCount})` : `Only Needs you (${att.onlyOnYouCount})`}
        </button>
        ${
					isAttentionFiltered || isStuckFiltered
						? `<button type="button" class="chip-btn" id="clear-attention-filter-btn">Show all ${att.totalTasksCount}</button>`
						: ""
				}
      </div>
    </div>
  `;
}

export function renderCompactFilterBar(dataset: TasksRolesV8Dataset, state: TasksRolesV8FilterState): string {
	if (state.mode === "loading" || state.mode === "error") return "";

	const dd = buildFilterDropdownModels({
		tasks: dataset.tasks,
		departments: dataset.departments,
		touchSystems: dataset.touchSystems,
		allTags: dataset.allTags,
		state,
	});

	const deptMenuItems = dd.dept.options
		.map(
			(d) =>
				`<button type="button" class="filter-dd-item dept-filter-btn" data-dept-id="${escapeHtml(d.id)}" aria-pressed="${d.pressed ? "true" : "false"}"><span>${escapeHtml(d.label)}</span><span class="chip-count">(${d.count ?? 0})</span></button>`,
		)
		.join("");

	const appMenuItems = dd.app.options
		.map(
			(sys) =>
				`<button type="button" class="filter-dd-item touch-filter-btn" data-touch-id="${escapeHtml(sys.id)}" aria-pressed="${sys.pressed ? "true" : "false"}"><span>${escapeHtml(sys.label)}</span><span class="chip-count">(${sys.count ?? 0})</span></button>`,
		)
		.join("");

	const statusMenuItems = dd.state.options
		.map(
			(st) =>
				`<button type="button" class="filter-dd-item status-filter-btn" data-status-filter="${escapeHtml(st.id)}" aria-pressed="${st.pressed ? "true" : "false"}"><span>${escapeHtml(st.label)}</span></button>`,
		)
		.join("");

	const tagMenuItems = dd.tag.options
		.map(
			(tg) => `<div style="display:flex; align-items:center; gap:6px;">
        <button type="button" class="filter-dd-item tag-filter-btn" data-tag-id="${escapeHtml(tg.id)}" aria-pressed="${tg.pressed ? "true" : "false"}" style="flex:1 1 auto;">
          <span>${escapeHtml(tg.label)}</span>
          <span>${tg.pressed ? "✓" : ""}</span>
        </button>
        <button type="button" class="tag-dag-btn" data-open-tag-dag="${escapeHtml(tg.id)}" aria-pressed="${tg.dagActive ? "true" : "false"}" title="Open ${escapeHtml(tg.label)} DAG">
          <span>☍ DAG</span>
        </button>
      </div>`,
		)
		.join("");

	const tagControls =
		state.selectedTags.length > 0
			? `<button type="button" class="chip-btn" id="toggle-tag-match-btn" aria-pressed="${state.tagMatchMode === "all" ? "true" : "false"}">Mode: ${state.tagMatchMode === "all" ? "Match ALL" : "Match ANY"}</button>
         <button type="button" class="chip-btn" id="clear-tags-btn">Clear tags (${state.selectedTags.length})</button>`
			: "";

	const hasAnyFilter =
		(state.deptFilter && state.deptFilter !== "all") ||
		state.touch !== "all" ||
		state.statusFilter !== "all" ||
		state.selectedTags.length > 0 ||
		Boolean((state.searchQuery || "").trim());

	return `
    <div class="compact-filter-bar" role="region" aria-label="Filter tasks by department, app, state, tag, or keyword">
      <div class="filter-dropdowns-group">
        <details class="filter-dd" data-filter-dropdown="dept" data-active-filter="${dd.dept.active ? "true" : "false"}" ${state.openDropdown === "dept" ? "open" : ""}>
          <summary aria-label="Filter by department">
            <span>${escapeHtml(dd.dept.summaryText)}</span>
            <span aria-hidden="true">▾</span>
          </summary>
          <div class="filter-dd-menu">
            <input type="search" class="filter-dd-search" data-dd-search="dept" placeholder="Filter departments…" aria-label="Filter department options" value="${escapeHtml(dd.dept.query)}" />
            <div class="filter-dd-list">${deptMenuItems}</div>
          </div>
        </details>

        <details class="filter-dd" data-filter-dropdown="app" data-active-filter="${dd.app.active ? "true" : "false"}" ${state.openDropdown === "app" ? "open" : ""}>
          <summary aria-label="Filter by app or system">
            <span>${escapeHtml(dd.app.summaryText)}</span>
            <span aria-hidden="true">▾</span>
          </summary>
          <div class="filter-dd-menu">
            <input type="search" class="filter-dd-search" data-dd-search="app" placeholder="Filter apps…" aria-label="Filter app options" value="${escapeHtml(dd.app.query)}" />
            <div class="filter-dd-list">${appMenuItems}</div>
          </div>
        </details>

        <details class="filter-dd" data-filter-dropdown="state" data-active-filter="${dd.state.active ? "true" : "false"}" ${state.openDropdown === "state" ? "open" : ""}>
          <summary aria-label="Filter by task state">
            <span>${escapeHtml(dd.state.summaryText)}</span>
            <span aria-hidden="true">▾</span>
          </summary>
          <div class="filter-dd-menu">
            <input type="search" class="filter-dd-search" data-dd-search="state" placeholder="Filter states…" aria-label="Filter state options" value="${escapeHtml(dd.state.query)}" />
            <div class="filter-dd-list">${statusMenuItems}</div>
          </div>
        </details>

        <details class="filter-dd" data-filter-dropdown="tag" data-active-filter="${dd.tag.active ? "true" : "false"}" ${state.openDropdown === "tag" ? "open" : ""}>
          <summary aria-label="Filter by tag or open Tag DAG">
            <span>${escapeHtml(dd.tag.summaryText)}</span>
            <span aria-hidden="true">▾</span>
          </summary>
          <div class="filter-dd-menu">
            <input type="search" class="filter-dd-search" data-dd-search="tag" placeholder="Filter #tags…" aria-label="Filter tag options" value="${escapeHtml(dd.tag.query)}" />
            <div class="filter-dd-list">${tagMenuItems}</div>
          </div>
        </details>

        ${tagControls}
        ${
					hasAnyFilter
						? `<button type="button" class="chip-btn" id="reset-all-filters-bar-btn">Reset filters ✕</button>`
						: ""
				}
      </div>

      <div style="display:flex; align-items:center; gap:8px; flex:1 1 220px; justify-content:flex-end;">
        <input type="search" id="task-search-input" class="search-input" style="width:100%; max-width:290px;" placeholder="Filter by anything (#id, dept, app, tag, title)…" aria-label="Filter by anything: ID, department, app, state, tag, or title" value="${escapeHtml(state.searchQuery)}" />
      </div>
    </div>
  `;
}

export function renderUnifiedTaskCard(params: {
	task: UiRoleTask;
	ask?: Partial<UiTaskGroupRollup>;
	dagNode?: Partial<TaskDagNode>;
	state: TasksRolesV8FilterState;
}): string {
	const { task, ask, dagNode, state } = params;
	const effectiveStatus = effectiveTaskLifecycleStatus(task, state.answeredTasks);
	const tone = statusToneForLifecycle(effectiveStatus);
	const isTaskExpanded = Boolean(state.expandedTasks[task.id]);
	const dependsOnRefs = dagNode?.dependsOnRefs ?? task.dependsOnRefs ?? [];
	const unlocksRefs = dagNode?.unlocksRefs ?? [];
	const stepNumber = dagNode?.stepNumber ?? 1;
	const pipelineMeter = renderDeliveryPipelineMeter(task, effectiveStatus);

	let oneLineSummary = "";
	if (["stuck", "blocked", "waiting", "asking", "paused"].includes(effectiveStatus) && task.howToUnblock) {
		oneLineSummary = `<strong>How to unblock:</strong> ${escapeHtml(task.howToUnblock)}`;
	} else if (dependsOnRefs.length > 0 || unlocksRefs.length > 0) {
		const depParts: string[] = [];
		if (dependsOnRefs.length > 0) depParts.push(`Depends on: ${escapeHtml(dependsOnRefs.join(", "))}`);
		if (unlocksRefs.length > 0) depParts.push(`Unlocks → ${escapeHtml(unlocksRefs.join(", "))}`);
		oneLineSummary = depParts.join(" · ");
	} else if (task.latestTldr) {
		oneLineSummary = `${escapeHtml(task.latestTldr.text)} (${escapeHtml(task.latestTldr.age ?? "just now")})`;
	}

	const taskTags = task.tags ?? ask?.tags ?? [];
	const tagDagButtonsHtml = taskTags
		.map((tg, idx) => {
			const isCurDag = state.activeTagDag === tg;
			const seqToggleCls = tg === "mobile-redesign" && idx === 0 && task.id === 221 ? "seq-toggle-btn" : "";
			const askAliasAttr =
				tg === "mobile-redesign" && idx === 0 && task.id === 221 ? `data-ask-id="tag:mobile-redesign"` : "";
			return `<button type="button" class="tag-dag-btn ${seqToggleCls}" data-open-tag-dag="${escapeHtml(tg)}" ${askAliasAttr} aria-pressed="${isCurDag ? "true" : "false"}" title="Open #${escapeHtml(tg)} implementation DAG & task states"><span>☍ #${escapeHtml(tg)} DAG</span></button>`;
		})
		.join("");

	const roleTitle = task.roleTitle ?? task.role ?? "Dept";
	const appLabel = task.appLabel ?? ask?.appLabel ?? task.appOrSystem ?? "App";
	const monogram = roleTitle.slice(0, 2).toUpperCase();

	return `
    <article class="unified-task-item task-row" data-task-id="${task.id}" data-status-tone="${escapeHtml(tone)}" data-task-expanded="${isTaskExpanded ? "true" : "false"}">
      <div class="unified-task-line">
        <div class="task-card-top">
          <div class="task-card-heading">
            <div class="task-col-dept">
              <div class="dept-identity-tile">
                <span class="dept-monogram" aria-hidden="true">${escapeHtml(monogram)}</span>
                <div class="dept-meta-stack">
                  <span class="dept-name-label">${escapeHtml(roleTitle)}</span>
                  <span class="task-id-keycap">#${task.id}</span>
                  <span class="app-well-pill">${escapeHtml(appLabel)}</span>
                </div>
              </div>
            </div>
            <div class="task-col-title">${escapeHtml(task.title)}</div>
          </div>
          <div class="task-col-actions">
            <div class="task-col-state">
              ${effectiveStatus === "stuck" ? `<span class="on-you-badge">ON YOU</span>` : ""}
              ${renderStatusBadge(effectiveStatus, false)}
            </div>
            <button type="button" class="chip-btn task-detail-toggle-btn" data-task-id="${task.id}" aria-expanded="${isTaskExpanded ? "true" : "false"}" style="min-height:28px; padding:2px 10px; box-shadow:var(--keycap-shadow);">
              ${isTaskExpanded ? "Hide details ▴" : "Details ▸"}
            </button>
          </div>
        </div>
        <div class="task-card-bottom">
          <div class="task-col-summary">${oneLineSummary}</div>
          <div class="task-col-actions">
            ${tagDagButtonsHtml}
          </div>
        </div>
      </div>
      ${
				isTaskExpanded
					? `<div class="task-detail-drawer" data-task-detail="${task.id}" style="display:flex; flex-direction:column; gap:6px; padding:8px 14px 12px 14px; border-top:1px solid var(--border-subtle); background:var(--bg-subtle);">
              <div class="task-subline">
                <span><strong>Stage ${stepNumber} in #${escapeHtml(taskTags[0] || "workflow")}</strong></span>
                ${dependsOnRefs.length ? `<span class="seq-edge-pill">Depends on: ${escapeHtml(dependsOnRefs.join(", "))}</span>` : ""}
                ${unlocksRefs.length ? `<span class="seq-edge-pill">Unlocks → ${escapeHtml(unlocksRefs.join(", "))}</span>` : ""}
                ${pipelineMeter}
              </div>
              ${task.latestTldr ? `<div class="task-subline"><span>Latest TL;DR: "${escapeHtml(task.latestTldr.text)}" · ${escapeHtml(task.latestTldr.age ?? "just now")}</span></div>` : ""}
              ${renderTaskCallouts(task, state.answeredTasks)}
            </div>`
					: ""
			}
    </article>
  `;
}
