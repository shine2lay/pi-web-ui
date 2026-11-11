import { renderTaskPriorityBadgeHtml, taskPriority } from "../components/TaskPriorityBadge";
import type { TaskDagNode } from "./dag";
import { effectiveTaskLifecycleStatus, type TasksRolesV8FilterState } from "./filters";
import { escapeHtml, ROLLUP_META, STATUS_META } from "./reference-data";
import {
	statusToneForLifecycle,
	type UiGroupRollupStatus,
	type UiRoleTask,
	type UiTaskGroupRollup,
	type UiTaskLifecycleStatus,
} from "./types";
import { renderAttentionNoteBar, renderCompactFilterBar, renderDepartmentStrip } from "./card-surface-chrome";

export { renderAttentionNoteBar, renderCompactFilterBar, renderDepartmentStrip };

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
	task: Pick<UiRoleTask, "pipelineStage" | "lifecycleStatus" | "delivery">,
	effectiveStatus?: UiTaskLifecycleStatus,
): string {
	const stageByStatus: Partial<Record<UiTaskLifecycleStatus | string, number>> = {
		working: 1,
		landing: 2,
		landed: 3,
		deploying: 4,
		live: 5,
		done: 5,
	};
	const st = effectiveStatus ?? task.lifecycleStatus;
	const deliveryStage =
		task.delivery?.deployStatus === "succeeded" || task.delivery?.liveCommit
			? 5
			: task.delivery?.deployStatus === "deploying"
				? 4
				: task.delivery?.landedCommit || task.delivery?.landStatus === "succeeded"
					? 3
					: task.delivery?.landStatus === "running" || task.delivery?.landStatus === "queued"
						? 2
						: undefined;
	const stage = stageByStatus[st] ?? deliveryStage ?? task.pipelineStage ?? 1;

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
	const displayId = task.displayId ?? task.id;

	if (task.lifecycleStatus === "stuck") {
		const answered = answeredTasks?.[task.id];
		if (answered) {
			parts.push(
				`<div class="callout-box"><strong>✓ Answered by you:</strong> "${escapeHtml(answered)}" — sent to ${escapeHtml(task.roleTitle ?? task.role ?? "Lead")} #${displayId}.</div>`,
			);
		} else if (task.stuck) {
			const choicesHtml = (task.stuck.choices ?? [])
				.map(
					(c, idx) =>
						`<button type="button" class="choice-btn ${idx === 0 ? "primary-cta" : ""} answer-choice-btn" data-task-id="${task.id}" data-choice="${escapeHtml(c)}" style="padding:5px 10px;">${idx === 0 ? "★ " : ""}${escapeHtml(c)}</button>`,
				)
				.join("");
			const openChatHtml = task.chat?.file
				? `<button type="button" class="choice-btn secondary open-chat-btn" data-task-id="${task.id}" data-chat-file="${escapeHtml(task.chat.file)}" style="padding:5px 10px;">Open chat</button>`
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

	if (!parts.some((p) => p.includes("callout-box"))) {
		const fallbackSummary =
			task.howToUnblock || task.doneSummary || task.latestTldr?.text || "Task is active in department queue.";
		parts.push(`<div class="callout-box">
      <div><strong>Status detail:</strong> ${escapeHtml(fallbackSummary)}</div>
    </div>`);
	}

	return parts.join("");
}

export function renderUnifiedTaskCard(params: {
	task: UiRoleTask;
	ask?: Partial<UiTaskGroupRollup>;
	dagNode?: Partial<TaskDagNode>;
	state: TasksRolesV8FilterState;
}): string {
	const { task, ask, dagNode, state } = params;
	const displayId = task.displayId ?? task.id;
	const effectiveStatus = effectiveTaskLifecycleStatus(task, state.answeredTasks);
	const tone = statusToneForLifecycle(effectiveStatus);
	const isTaskExpanded = Boolean(state.expandedTasks[task.id]);
	const dependsOnRefs = dagNode?.dependsOnRefs ?? task.dependsOnRefs ?? [];
	const unlocksRefs = dagNode?.unlocksRefs ?? [];
	const stepNumber = dagNode?.stepNumber ?? 1;
	const pipelineMeter = renderDeliveryPipelineMeter(task, effectiveStatus);

	let oneLineSummary = "";
	const cleanUnblock = task.howToUnblock ? task.howToUnblock.replace(/^(?:how to unblock:\s*)+/i, "").trim() : "";
	if (["stuck", "blocked", "waiting", "asking", "paused"].includes(effectiveStatus) && cleanUnblock) {
		oneLineSummary = `<strong>How to unblock:</strong> ${escapeHtml(cleanUnblock)}`;
	} else if (dependsOnRefs.length > 0 || unlocksRefs.length > 0) {
		const depParts: string[] = [];
		if (dependsOnRefs.length > 0) depParts.push(`Depends on: ${escapeHtml(dependsOnRefs.join(", "))}`);
		if (unlocksRefs.length > 0) depParts.push(`Unlocks → ${escapeHtml(unlocksRefs.join(", "))}`);
		oneLineSummary = depParts.join(" · ");
	} else if (task.latestTldr) {
		oneLineSummary = `${escapeHtml(task.latestTldr.text)} (${escapeHtml(task.latestTldr.age ?? "just now")})`;
	} else if (task.doneSummary) {
		oneLineSummary = escapeHtml(task.doneSummary);
	} else if (task.queuedDetail?.summary) {
		oneLineSummary = escapeHtml(task.queuedDetail.summary);
	} else {
		oneLineSummary = escapeHtml(STATUS_META[effectiveStatus]?.label ?? effectiveStatus);
	}

	const rawTaskTags = task.tags ?? ask?.tags ?? [];
	const prioritizedTags = [...rawTaskTags].sort((a, b) => {
		const aActive = state.activeTagDag === a || state.selectedTags.includes(a) ? 0 : 1;
		const bActive = state.activeTagDag === b || state.selectedTags.includes(b) ? 0 : 1;
		return aActive - bActive;
	});
	const visibleTaskTags = prioritizedTags.slice(0, 2);
	const tagDagButtonsHtml = visibleTaskTags
		.map((tg, idx) => {
			const isCurDag = state.activeTagDag === tg;
			const seqToggleCls = tg === "mobile-redesign" && idx === 0 && displayId === 221 ? "seq-toggle-btn" : "";
			const askAliasAttr =
				tg === "mobile-redesign" && idx === 0 && displayId === 221 ? `data-ask-id="tag:mobile-redesign"` : "";
			return `<button type="button" class="tag-dag-btn ${seqToggleCls}" data-open-tag-dag="${escapeHtml(tg)}" ${askAliasAttr} aria-pressed="${isCurDag ? "true" : "false"}" title="Open #${escapeHtml(tg)} implementation DAG & task states"><span>☍ #${escapeHtml(tg)} DAG</span></button>`;
		})
		.join("");

	const roleTitle = task.roleTitle ?? task.role ?? "Dept";
	const appLabel = task.appLabel ?? ask?.appLabel ?? task.appOrSystem ?? "App";
	const monogram = roleTitle.slice(0, 2).toUpperCase();
	const prio = taskPriority(task);
	const priorityBadgeHtml = renderTaskPriorityBadgeHtml(prio);

	return `
    <article class="unified-task-item unified-task-card task-row" data-task-id="${task.id}" data-display-task-id="${displayId}" data-priority="${escapeHtml(prio)}" data-status-tone="${escapeHtml(tone)}" data-task-expanded="${isTaskExpanded ? "true" : "false"}">
      <div class="unified-task-line">
        <div class="task-card-top">
          <div class="task-card-heading">
            <div class="task-col-dept">
              <div class="dept-identity-tile">
                <span class="dept-monogram" aria-hidden="true">${escapeHtml(monogram)}</span>
                <div class="dept-meta-stack">
                  <span class="dept-name-label">${escapeHtml(roleTitle)}</span>
                  <span class="task-id-keycap">#${displayId}</span>
                  ${priorityBadgeHtml}
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
                <span><strong>Stage ${stepNumber} in #${escapeHtml(rawTaskTags[0] || "workflow")}</strong></span>
                ${dependsOnRefs.length ? `<span class="seq-edge-pill">Depends on: ${escapeHtml(dependsOnRefs.join(", "))}</span>` : ""}
                ${unlocksRefs.length ? `<span class="seq-edge-pill">Unlocks → ${escapeHtml(unlocksRefs.join(", "))}</span>` : ""}
                ${pipelineMeter}
                ${task.chat?.file && effectiveStatus !== "stuck" ? `<button type="button" class="chip-btn open-chat-btn" data-task-id="${task.id}" data-chat-file="${escapeHtml(task.chat.file)}">Open chat →</button>` : ""}
              </div>
              ${task.latestTldr ? `<div class="task-subline"><span>Latest TL;DR: "${escapeHtml(task.latestTldr.text)}" · ${escapeHtml(task.latestTldr.age ?? "just now")}</span></div>` : ""}
              ${renderTaskCallouts(task, state.answeredTasks)}
            </div>`
					: ""
			}
    </article>
  `;
}
