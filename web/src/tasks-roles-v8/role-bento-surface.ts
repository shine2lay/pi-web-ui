import { renderStatusBadge } from "./card-surface";
import type { TaskDagResult } from "./dag";
import { renderDagBoard } from "./dag-surface";
import { effectiveTaskLifecycleStatus, matchesTaskFilters, type TasksRolesV8FilterState } from "./filters";
import { escapeHtml, STATUS_META } from "./reference-data";
import {
	statusToneForLifecycle,
	type TasksRolesV8Dataset,
	type UiRoleTask,
	type UiTaskGroupRollup,
	type V8DepartmentSummary,
} from "./types";

export function renderSvgDonut(pct: number, strokeVar: string, labelText: string): string {
	const r = 18;
	const c = Number((2 * Math.PI * r).toFixed(1));
	const clamped = Math.max(0, Math.min(100, pct));
	const offset = (c * (1 - clamped / 100)).toFixed(1);
	return `<span class="pulse-ring-wrap" aria-hidden="true">
    <svg width="46" height="46" viewBox="0 0 44 44" aria-hidden="true">
      <circle cx="22" cy="22" r="${r}" fill="none" stroke="var(--border-default)" stroke-width="4.5"></circle>
      <circle cx="22" cy="22" r="${r}" fill="none" stroke="${escapeHtml(strokeVar)}" stroke-width="4.5"
        stroke-dasharray="${c}" stroke-dashoffset="${offset}" stroke-linecap="round"
        transform="rotate(-90 22 22)"></circle>
    </svg>
    <span class="pulse-ring-label">${escapeHtml(labelText)}</span>
  </span>`;
}

export function renderWhyModal(isOpen: boolean = false): string {
	return `
    <div class="why-modal-backdrop" id="why-modal" role="dialog" aria-modal="true" aria-label="Why this rework is designed this way" ${isOpen ? "" : "hidden"}>
      <div class="why-modal-dialog">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:10px;">
          <strong style="font-size:16px;">Why this rework is designed this way (4 plain-English choices)</strong>
          <button type="button" class="chip-btn" id="why-modal-close-btn">Close ✕</button>
        </div>
        <details class="why-details" open>
          <summary>
            <span>Why this rework is designed this way — 4 plain-English choices (tap to hide or show)</span>
          </summary>
          <div class="why-grid">
            <div class="callout-box">
              <strong>1. Unified All-Department Task Triage Table as the First View (Linear / GitHub Projects pattern)</strong>
              <div><strong>Problem:</strong> Grouping the landing page into big Initiative/Ask cards hid individual tasks across departments and made manual task triage harder.</div>
              <div><strong>Why this choice works best:</strong> The default first view lists all available tasks across every department in one scannable table sorted by urgency (<em>! Needs you → ⊗ Blocked → ◔ Waiting → ? Asking lead → ⏸ Paused → ⚡ Deploying → ↑ Landing → ✓· Landed → ● Working → ○ Queued → ✓✓ Live → ✓ Done</em>).</div>
              <div><strong>Option rejected:</strong> Multi-card Bento overview of Initiative/Ask containers as the landing page.</div>
            </div>
            <div class="callout-box">
              <strong>2. Direct Manual Filtering by Department, App, State, Tag, or Search</strong>
              <div><strong>Problem:</strong> Hiding filters inside a secondary toggle or forcing you into one fixed grouping slowed down manual triage.</div>
              <div><strong>Why this choice works best:</strong> Every filter bar row is visible up front — click any <em>Dept</em> (Design, Frontend, Backend, QA, Ops, Architecture), <em>App</em> (RollCall, Pi Web UI, Inkflow, Temper), <em>State</em>, <em>Tag</em>, or type in the search box to slice the task list immediately.</div>
              <div><strong>Option rejected:</strong> Hidden filter drawers or automatic card grouping without direct manual controls.</div>
            </div>
            <div class="callout-box">
              <strong>3. 1-Click Tag Implementation DAG &amp; Task States (Dagster / Prefect pattern)</strong>
              <div><strong>Problem:</strong> Showing all DAGs at once creates visual clutter, while hiding dependencies completely makes it hard to see how a tag's implementation fits together.</div>
              <div><strong>Why this choice works best:</strong> Every tag in the filter bar and on every task row has a 1-click <strong>☍ #tag DAG</strong> button. Clicking it opens that specific tag's multi-stage Implementation DAG (<em>Stage 1 → Stage 2 → Stage 3</em>) with SVG dependency arrows, cross-department handoff stations, and each task's live state.</div>
              <div><strong>Option rejected:</strong> Rendering multiple expanded DAGs simultaneously on initial page load.</div>
            </div>
            <div class="callout-box">
              <strong>4. Full 12-Step State Hierarchy + Plain-English "How to Unblock"</strong>
              <div><strong>Problem:</strong> "Done" did not tell you whether code was still merging, sitting on master undeployed, or live, and blocked tasks did not state what would unblock them.</div>
              <div><strong>Why this choice works best:</strong> Separates attention states (<em>Needs you, Asking lead, Blocked, Waiting, Paused, Queued</em>) from delivery states (<em>Working → Landing → Landed · not deployed → Deploying → Live / Deployed</em> vs <em>Done (no deploy)</em>), with a 1-line <strong>How to unblock:</strong> summary directly in the row.</div>
              <div><strong>Option rejected:</strong> A flat 3-state badge (<em>Queued / Working / Done</em>) or raw shell check strings.</div>
            </div>
          </div>
        </details>
      </div>
    </div>
  `;
}

export function renderRolesBentoView(params: {
	dataset: TasksRolesV8Dataset;
	state: TasksRolesV8FilterState;
	activeDagBoards?: Map<string, TaskDagResult>;
}): string {
	const { dataset, state, activeDagBoards } = params;
	const activeDeptCards: Array<{
		dept: V8DepartmentSummary;
		askBuckets: Array<{ ask: UiTaskGroupRollup; deptTasks: UiRoleTask[] }>;
	}> = [];

	for (const dept of dataset.departments) {
		const askBuckets: Array<{ ask: UiTaskGroupRollup; deptTasks: UiRoleTask[] }> = [];
		for (const ask of dataset.askGroups) {
			const deptTasks = (ask.tasks ?? []).filter((t) => t.role === dept.id && matchesTaskFilters(t, state, ask));
			if (deptTasks.length > 0) {
				askBuckets.push({ ask, deptTasks });
			}
		}
		if (askBuckets.length > 0) {
			activeDeptCards.push({ dept, askBuckets });
		}
	}

	if (activeDeptCards.length === 0) {
		return `
      <div class="state-card">
        <h2 style="margin-top:0;">No departments have tasks matching this filter</h2>
        <p>Reset the active tag or status filter to see all active department queues.</p>
        <button type="button" class="choice-btn" id="empty-reset-btn">Reset all filters</button>
      </div>
    `;
	}

	const renderRoleCard = ({
		dept,
		askBuckets,
	}: {
		dept: V8DepartmentSummary;
		askBuckets: Array<{ ask: UiTaskGroupRollup; deptTasks: UiRoleTask[] }>;
	}) => {
		const allDeptTasks = askBuckets.flatMap((b) => b.deptTasks);
		const heldTask = allDeptTasks.find((t) => {
			const eff = effectiveTaskLifecycleStatus(t, state.answeredTasks);
			return ["stuck", "blocked", "waiting", "asking"].includes(eff);
		});
		const topTask = heldTask ?? allDeptTasks[0];
		const topTaskStatus = topTask ? effectiveTaskLifecycleStatus(topTask, state.answeredTasks) : "working";
		const roleTone = statusToneForLifecycle(topTaskStatus);
		const isRoleExpanded = Boolean(state.expandedRoles[dept.id]);

		const roleSummaryLine = heldTask
			? `<strong style="color:var(--text-primary);">How to unblock:</strong> (#${heldTask.displayId ?? heldTask.id}) ${escapeHtml(heldTask.howToUnblock ?? "")}`
			: topTask
				? `<span style="color:var(--text-muted);">Top task (#${topTask.displayId ?? topTask.id}): ${escapeHtml(topTask.title)}</span>`
				: "";

		const relatedTaskChips = allDeptTasks
			.map((t, idx) => {
				const effSt = effectiveTaskLifecycleStatus(t, state.answeredTasks);
				const tone = statusToneForLifecycle(effSt);
				const arrow =
					idx < allDeptTasks.length - 1
						? `<svg class="handoff-connector-svg" viewBox="0 0 18 14" aria-hidden="true" style="width:12px; height:12px;">
                <line x1="1" y1="7" x2="13" y2="7" stroke="currentColor" stroke-width="1.75"></line>
                <polygon points="11,3 17,7 11,11" fill="currentColor"></polygon>
              </svg>`
						: "";
				return `<span style="display:inline-flex; align-items:center; gap:5px; font-size:14px; color:var(--text-secondary); padding:2px 4px;">
          <span class="status-dot tone-${escapeHtml(tone)}" aria-hidden="true"></span>
          <strong style="color:var(--text-primary);">#${t.displayId ?? t.id}</strong>
          <span>${escapeHtml(t.appOrSystem ?? "app")}</span>
        </span>${arrow}`;
			})
			.join("");

		const groupsHtml = askBuckets
			.map(({ ask, deptTasks }) => {
				const miniHandoff = (ask.handoff ?? [])
					.map((h) => `${h.roleTitle} (${STATUS_META[h.status]?.icon ?? "●"})`)
					.join(" → ");
				const roleBoardId = `role-${dept.id}-${ask.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
				return `
          <div class="role-ask-group">
            <div class="ask-main-line" style="display:flex; flex-wrap:wrap; justify-content:space-between; gap:6px; align-items:center;">
              <div style="font-weight:700; font-size:15px;">
                <span class="touch-pill">${escapeHtml(ask.appLabel ?? ask.appOrSystem ?? "App")}</span>
                <span style="margin-left:6px;">${escapeHtml(ask.title ?? ask.key)}</span>
              </div>
              <div>
                ${(ask.tags ?? [])
									.slice(0, 2)
									.map((tg) => `<span class="tag-pill">#${escapeHtml(tg)}</span>`)
									.join(" ")}
              </div>
            </div>
            <div style="font-size:14px; color:var(--text-secondary);">
              <strong>Ask pipeline:</strong> ${escapeHtml(miniHandoff)}
            </div>
            <div style="font-size:14px; color:var(--text-secondary);">
              <strong>How to unblock ask:</strong> ${escapeHtml(ask.howToUnblock ?? "")}
            </div>
            ${renderDagBoard({
							tasks: deptTasks,
							boardId: roleBoardId,
							contextTasks: ask.tasks ?? deptTasks,
							state,
							activeDagBoards,
						})}
          </div>
        `;
			})
			.join("");

		const lanePillsHtml = Array.from({ length: dept.atOnce }, (_, i) => {
			const isBusy = i < dept.inUse;
			const pillCls = isBusy
				? heldTask && i === 0
					? "roles-lane-pill blocked"
					: "roles-lane-pill busy"
				: "roles-lane-pill free";
			return `<span class="${pillCls}" aria-hidden="true"></span>`;
		}).join("");

		const monogram = (dept.title || dept.id).slice(0, 2).toUpperCase();

		return {
			isHeld: Boolean(heldTask),
			html: `
        <section class="role-card" data-role-card="${escapeHtml(dept.id)}" data-status-tone="${escapeHtml(roleTone)}" data-role-expanded="${isRoleExpanded ? "true" : "false"}" aria-label="${escapeHtml(dept.title)} department" style="position:relative; padding:14px 16px; gap:8px;">
          ${topTaskStatus === "stuck" ? `<span class="on-you-badge" style="position:absolute; top:-9px; right:12px;">ON YOU</span>` : ""}
          <div class="role-card-header">
            <div style="display:flex; align-items:center; gap:10px;">
              <span class="dept-monogram" aria-hidden="true">${escapeHtml(monogram)}</span>
              <div>
                <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:14px; color:var(--text-secondary);">
                  <span>Task lanes</span>
                  <span class="roles-lane-pills" role="img" aria-label="${dept.inUse} of ${dept.atOnce} lanes busy">${lanePillsHtml}</span>
                  <span style="font-family:'Geist Mono', ui-monospace, monospace; font-weight:600; color:var(--text-primary);">${dept.inUse}/${dept.atOnce} active</span>
                  <span>· ${allDeptTasks.length} queued/active</span>
                </div>
                <h2 class="role-name" style="font-size:18px; margin-top:4px;">${escapeHtml(dept.title)}</h2>
              </div>
            </div>
            <div class="ask-meta-row">
              ${renderStatusBadge(topTaskStatus, false)}
            </div>
          </div>
          ${roleSummaryLine ? `<div style="font-size:14px; color:var(--text-secondary);">${roleSummaryLine}</div>` : ""}
          <div style="display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; padding-top:8px; border-top:1px solid var(--border-subtle);">
            <div class="dep-chip-row" style="flex:1 1 auto; gap:8px;">
              <span style="font-size:14px; font-weight:600; color:var(--text-muted);">Related:</span>
              ${relatedTaskChips}
            </div>
            <button type="button" class="chip-btn role-toggle-btn" data-role-id="${escapeHtml(dept.id)}" aria-expanded="${isRoleExpanded ? "true" : "false"}" style="padding:3px 10px;">
              ${isRoleExpanded ? "Close queue ▴" : `Open queue (${allDeptTasks.length}) ▸`}
            </button>
          </div>
          ${isRoleExpanded ? groupsHtml : ""}
        </section>
      `,
		};
	};

	const builtRoles = activeDeptCards.map(renderRoleCard);
	const heldRoleCards = builtRoles.filter((r) => r.isHeld).map((r) => r.html);
	const trackRoleCards = builtRoles.filter((r) => !r.isHeld).map((r) => r.html);

	const idleDepts = dataset.idleDepartments;
	const idleDrawerHtml = `
    <section class="idle-drawer" aria-label="Idle departments">
      <div style="display:flex; flex-wrap:wrap; justify-content:space-between; align-items:center; gap:8px;">
        <div>
          <strong>${idleDepts.length} idle departments — all clear</strong>
          <span style="color:var(--text-secondary); margin-left:6px;">
            (${escapeHtml(idleDepts.map((d) => d.title).join(", "))})
          </span>
        </div>
        <button type="button" class="chip-btn" id="toggle-idle-btn" aria-expanded="${state.idleExpanded ? "true" : "false"}">
          ${state.idleExpanded ? "Hide idle departments" : `Show all ${idleDepts.length} idle departments`}
        </button>
      </div>
      ${
				state.idleExpanded
					? `<div class="idle-list">
              ${idleDepts
								.map(
									(d) => `<span class="dep-chip"><strong>${escapeHtml(d.title)}:</strong> ${escapeHtml(d.note)}</span>`,
								)
								.join("")}
            </div>`
					: ""
			}
    </section>
  `;

	return `
    <div class="roles-grid">
      ${
				heldRoleCards.length > 0
					? `<div class="tier-section-header">
              <h2 class="tier-section-title">
                <span>Needs Attention &amp; Held</span>
                <span class="tier-count-pill">${heldRoleCards.length}</span>
              </h2>
            </div>
            ${heldRoleCards.join("")}`
					: ""
			}
      ${
				trackRoleCards.length > 0
					? `<div class="tier-section-header" style="margin-top:10px;">
              <h2 class="tier-section-title muted">
                <span>On Track &amp; Idle</span>
                <span class="tier-count-pill">${trackRoleCards.length} active · ${idleDepts.length} idle</span>
              </h2>
            </div>
            ${trackRoleCards.join("")}`
					: ""
			}
    </div>
    ${idleDrawerHtml}
  `;
}
