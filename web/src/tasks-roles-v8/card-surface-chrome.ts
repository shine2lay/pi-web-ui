import {
	buildFilterDropdownModels,
	computeAttentionSummary,
	effectiveTaskLifecycleStatus,
	type TasksRolesV8FilterState,
} from "./filters";
import { escapeHtml } from "./reference-data";
import { statusToneForLifecycle, type TasksRolesV8Dataset, type UiRoleTask } from "./types";

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

export function renderDepartmentStrip(dataset: TasksRolesV8Dataset, state: TasksRolesV8FilterState): string {
	if (state.mode !== "normal" || (dataset.departments.length === 0 && dataset.idleDepartments.length === 0)) {
		return "";
	}

	const allPressed = !state.deptFilter || state.deptFilter === "all";
	const pillsHtml = dataset.departments
		.map((dept) => {
			const deptTasks = dataset.tasks.filter((t) => t.role === dept.id);
			const heldTask = deptTasks.find((t) => {
				const eff = effectiveTaskLifecycleStatus(t, state.answeredTasks);
				return ["stuck", "blocked", "waiting", "asking"].includes(eff);
			});
			const topTask = heldTask ?? deptTasks[0];
			const topStatus = topTask ? effectiveTaskLifecycleStatus(topTask, state.answeredTasks) : "working";
			const deptTone = deptTasks.length > 0 ? statusToneForLifecycle(topStatus) : "done";
			const isSelected = state.deptFilter === dept.id;
			const monogram = (dept.title || dept.id).slice(0, 2).toUpperCase();
			const chatBtn = dept.homeChat?.file
				? `<button type="button" class="dept-strip-chat-btn open-chat-btn" data-chat-file="${escapeHtml(dept.homeChat.file)}" aria-label="Open ${escapeHtml(dept.title)} home chat" title="Open ${escapeHtml(dept.title)} home chat">↗</button>`
				: "";

			return `<div class="dept-strip-pill" data-dept-pill="${escapeHtml(dept.id)}" data-selected="${isSelected ? "true" : "false"}">
        <button type="button" class="dept-strip-btn" data-dept-strip-id="${escapeHtml(dept.id)}" aria-pressed="${isSelected ? "true" : "false"}">
          <span class="dept-strip-monogram" aria-hidden="true">${escapeHtml(monogram)}</span>
          <span class="status-dot tone-${escapeHtml(deptTone)}" aria-hidden="true"></span>
          <span class="dept-strip-title">${escapeHtml(dept.title)}</span>
          <span class="dept-strip-lanes">${dept.inUse}/${dept.atOnce} · ${deptTasks.length}</span>
        </button>
        ${chatBtn}
      </div>`;
		})
		.join("");

	const idleCount = dataset.idleDepartments.length;
	const idleToggleHtml =
		idleCount > 0
			? `<button type="button" class="chip-btn" id="toggle-idle-btn" aria-expanded="${state.idleExpanded ? "true" : "false"}" style="padding:3px 10px;">
          ${state.idleExpanded ? `Hide ${idleCount} idle ▴` : `+${idleCount} idle depts ▾`}
        </button>`
			: "";

	const idleListHtml =
		state.idleExpanded && idleCount > 0
			? `<div class="idle-list" style="width:100%; padding-top:6px; border-top:1px solid var(--border-subtle);">
          ${dataset.idleDepartments
						.map((d) => `<span class="dep-chip"><strong>${escapeHtml(d.title)}:</strong> ${escapeHtml(d.note)}</span>`)
						.join("")}
        </div>`
			: "";

	return `
    <section class="dept-queues-strip" aria-label="Department queues">
      <div class="dept-queues-strip-row">
        <button type="button" class="dept-strip-all-btn dept-strip-btn" data-dept-strip-id="all" aria-pressed="${allPressed ? "true" : "false"}">
          <span>All queues (${dataset.tasks.length})</span>
        </button>
        ${pillsHtml}
        ${idleToggleHtml}
      </div>
      ${idleListHtml}
    </section>
  `;
}
