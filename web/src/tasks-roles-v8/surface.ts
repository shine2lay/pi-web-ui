import {
	renderAttentionNoteBar,
	renderCompactFilterBar,
	renderDeliveryPipelineMeter,
	renderDepartmentStrip,
	renderStatusBadge,
	renderTaskCallouts,
	renderUnifiedTaskCard,
} from "./card-surface";
import { buildTaskDag, installGlobalBuildTaskDag, type TaskDagResult } from "./dag";
import {
	DAG_SHORT_STATUS_LABEL,
	DAG_STAGE_CARD_CEILING,
	DAG_STAGE_PRIORITY,
	drawAllDagEdges,
	renderDagBoard,
	renderDagDetailPanel,
	renderTagDagRegion,
	renderTaskNode,
	renderUnifiedTasksPanel,
	sortStageNodesForCeiling,
} from "./dag-surface";
import {
	createInitialFilterState,
	resetAllFilters,
	toggleNeedsAttentionFilter,
	toggleOnlyOnYouFilter,
	toggleSelectedTag,
	toggleTagMatchMode,
	type TasksRolesV8FilterState,
	type V8DropdownKind,
	type V8StatusFilterId,
} from "./filters";
import { createReferenceDataset, escapeHtml, ROLLUP_META, STATUS_META, V8_REFERENCE_DATASET } from "./reference-data";
import { renderRolesBentoView, renderSvgDonut, renderWhyModal } from "./role-bento-surface";
import { injectTasksRolesV8Styles, TASKS_ROLES_V8_CSS } from "./styles";
import type { TasksRolesV8Dataset } from "./types";

export {
	createReferenceDataset,
	DAG_SHORT_STATUS_LABEL,
	DAG_STAGE_CARD_CEILING,
	DAG_STAGE_PRIORITY,
	drawAllDagEdges,
	escapeHtml,
	renderAttentionNoteBar,
	renderCompactFilterBar,
	renderDagBoard,
	renderDagDetailPanel,
	renderDeliveryPipelineMeter,
	renderDepartmentStrip,
	renderRolesBentoView,
	renderStatusBadge,
	renderSvgDonut,
	renderTagDagRegion,
	renderTaskCallouts,
	renderTaskNode,
	renderUnifiedTaskCard,
	renderUnifiedTasksPanel,
	renderWhyModal,
	ROLLUP_META,
	sortStageNodesForCeiling,
	STATUS_META,
	V8_REFERENCE_DATASET,
};

export function renderViewRegion(params: {
	dataset: TasksRolesV8Dataset;
	state: TasksRolesV8FilterState;
	activeDagBoards?: Map<string, TaskDagResult>;
	showPrototypeChrome?: boolean;
}): string {
	const { dataset, state, activeDagBoards, showPrototypeChrome = true } = params;
	if (state.mode === "loading") {
		return `
      <div class="state-card" aria-busy="true" aria-live="polite">
        <strong style="display:block; margin-bottom:12px;">Loading live tasks, git land checks, and service health…</strong>
        <div class="skeleton-line" style="width:72%;"></div>
        <div class="skeleton-line" style="width:90%;"></div>
        <div class="skeleton-line" style="width:60%;"></div>
      </div>
    `;
	}
	if (state.mode === "error") {
		return `
      <div class="state-card" role="alert">
        <h2 style="margin-top:0;">Unable to refresh Roles &amp; Initiatives snapshot</h2>
        <p style="color:var(--text-secondary);">Showing last known state from 14s ago. The local pi-web-ui WebSocket disconnected temporarily.</p>
        <button type="button" class="choice-btn primary-cta" id="retry-load-btn">Retry connection now</button>
      </div>
    `;
	}
	if (state.mode === "empty") {
		return `
      <div class="state-card">
        <h2 style="margin-top:0;">All queues are clear — 0 active or held tasks</h2>
        <p style="color:var(--text-secondary);">All 14 departments are idle and all recent code changes are deployed live.</p>
        ${showPrototypeChrome ? `<button type="button" class="choice-btn" id="restore-normal-btn">Restore sample tasks</button>` : ""}
      </div>
    `;
	}

	if (state.page === "initiatives") {
		return renderUnifiedTasksPanel({ dataset, state, activeDagBoards });
	}
	return renderRolesBentoView({ dataset, state, activeDagBoards });
}

export function renderTasksRolesV8Shell(params: {
	dataset: TasksRolesV8Dataset;
	state: TasksRolesV8FilterState;
	activeDagBoards?: Map<string, TaskDagResult>;
	whyModalOpen?: boolean;
	showPrototypeChrome?: boolean;
}): string {
	const { dataset, state, activeDagBoards, whyModalOpen = false, showPrototypeChrome = true } = params;
	const activeDeptCount = dataset.departments.length;
	const onYouCount = dataset.tasks.filter((t) => t.lifecycleStatus === "stuck").length;
	const subtitleSummary = `${dataset.tasks.length} tasks across ${activeDeptCount} active departments · ${onYouCount} on you`;

	const primaryTabsHtml = showPrototypeChrome
		? `<nav class="seg-group" aria-label="Primary views">
            <button type="button" class="seg-btn" id="tab-initiatives" aria-pressed="${state.page === "initiatives" ? "true" : "false"}">
              All Department Tasks
            </button>
            <button type="button" class="seg-btn" id="tab-roles" aria-pressed="${state.page === "roles" ? "true" : "false"}">
              Roles &amp; Queues
            </button>
          </nav>`
		: "";

	const protoControlsHtml = showPrototypeChrome
		? `<div class="seg-group" role="group" aria-label="Prototype data mode">
            <button type="button" class="seg-btn mode-btn" data-mode="normal" data-ui-mode="normal" aria-pressed="${state.mode === "normal" ? "true" : "false"}">Live (12 states)</button>
            <button type="button" class="seg-btn mode-btn" data-mode="loading" data-ui-mode="loading" aria-pressed="${state.mode === "loading" ? "true" : "false"}">Loading</button>
            <button type="button" class="seg-btn mode-btn" data-mode="empty" data-ui-mode="empty" aria-pressed="${state.mode === "empty" ? "true" : "false"}">Empty</button>
            <button type="button" class="seg-btn mode-btn" data-mode="error" data-ui-mode="error" aria-pressed="${state.mode === "error" ? "true" : "false"}">Error</button>
          </div>
          <button type="button" class="chip-btn" id="why-modal-btn" aria-haspopup="dialog" aria-controls="why-modal" aria-expanded="${whyModalOpen ? "true" : "false"}">
            Why this design
          </button>
          <button type="button" class="chip-btn" id="theme-toggle" aria-label="Switch color theme">
            Theme: <span id="theme-toggle-label">${state.theme === "dark" ? "Dark" : "Light"}</span>
          </button>`
		: "";

	return `
    <div class="app-shell" data-tasks-roles-v8-theme="${escapeHtml(state.theme)}">
      <header class="topbar" role="banner">
        <div class="brand-group">
          <div style="display:flex; align-items:baseline; gap:10px; flex-wrap:wrap;">
            <h1 class="brand-title" id="page-main-title">Tasks &amp; Roles</h1>
            <span class="brand-subtitle">${escapeHtml(subtitleSummary)}</span>
          </div>
          ${primaryTabsHtml}
        </div>

        <div class="controls-right">
          <span class="roles-live-pill" role="status">
            <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><circle cx="5" cy="5" r="4" fill="currentColor"></circle></svg>
            <span>Live · updated just now</span>
          </span>
          ${protoControlsHtml}
        </div>
      </header>

      ${showPrototypeChrome ? renderWhyModal(whyModalOpen) : ""}

      <main id="main-content">
        <section id="hero-region" aria-label="Attention summary">
          ${renderAttentionNoteBar(dataset.tasks, state)}
        </section>
        <section id="filter-region" aria-label="System and tag filters">
          ${renderCompactFilterBar(dataset, state)}
        </section>
        <section id="view-region" aria-live="polite">
          ${renderViewRegion({ dataset, state, activeDagBoards, showPrototypeChrome })}
        </section>
      </main>
    </div>
  `;
}

export interface MountTasksRolesV8Options {
	dataset?: TasksRolesV8Dataset;
	initialState?: Partial<TasksRolesV8FilterState>;
	injectStyles?: boolean;
	syncDocumentTheme?: boolean;
	showPrototypeChrome?: boolean;
	exposeWindowGlobals?: boolean;
	onAnswerQuestion?: (taskId: number, choice: string) => void;
	onOpenChat?: (chatFile: string) => void;
	onRetryLoad?: () => void;
	onOverlayChange?: (open: boolean) => void;
}

export interface MountedTasksRolesV8Controller {
	getState: () => TasksRolesV8FilterState;
	setState: (patch: Partial<TasksRolesV8FilterState>) => void;
	getDataset: () => TasksRolesV8Dataset;
	setDataset: (dataset: TasksRolesV8Dataset) => void;
	getActiveDagBoards: () => ReadonlyMap<string, TaskDagResult>;
	drawDagEdges: () => void;
	hasOpenOverlay: () => boolean;
	closeTopOverlay: () => boolean;
	refresh: () => void;
	destroy: () => void;
}

export function mountTasksRolesV8Surface(
	container: HTMLElement,
	options: MountTasksRolesV8Options = {},
): MountedTasksRolesV8Controller {
	if (!container || typeof container.querySelector !== "function") {
		throw new Error("mountTasksRolesV8Surface requires a valid HTMLElement container.");
	}

	const doc = container.ownerDocument ?? document;
	if (options.injectStyles !== false) {
		injectTasksRolesV8Styles(doc);
	}
	installGlobalBuildTaskDag();

	let dataset = options.dataset ?? createReferenceDataset();
	const urlInitPatch: Partial<TasksRolesV8FilterState> = { ...options.initialState };
	if (typeof window !== "undefined" && typeof window.location?.search === "string" && window.location.search) {
		const params = new URLSearchParams(window.location.search);
		const pageParam = params.get("page");
		if (pageParam === "roles" || pageParam === "initiatives") {
			urlInitPatch.page = pageParam;
		}
		const themeParam = params.get("theme");
		if (themeParam === "light" || themeParam === "dark") {
			urlInitPatch.theme = themeParam;
		}
		const modeParam = params.get("mode");
		if (modeParam === "normal" || modeParam === "loading" || modeParam === "empty" || modeParam === "error") {
			urlInitPatch.mode = modeParam;
		}
		const touchParam = params.get("touch");
		if (touchParam) {
			urlInitPatch.touch = touchParam;
		}
		const deptParam = params.get("dept");
		if (deptParam) {
			urlInitPatch.deptFilter = deptParam;
		}
		const expandParam = params.get("expand") || "";
		const tagDagParam = params.get("tagDag");
		if (expandParam === "all") {
			const expandedTasks: Record<number, boolean> = {};
			for (const t of dataset.tasks) {
				expandedTasks[t.id] = true;
			}
			const expandedRoles: Record<string, boolean> = {};
			for (const d of dataset.departments) {
				expandedRoles[d.id] = true;
			}
			urlInitPatch.expandedTasks = expandedTasks;
			urlInitPatch.expandedRoles = expandedRoles;
			urlInitPatch.activeTagDag = tagDagParam || "mobile-redesign";
		} else if (expandParam === "dag") {
			urlInitPatch.activeTagDag = tagDagParam || "mobile-redesign";
		} else if (tagDagParam) {
			urlInitPatch.activeTagDag = tagDagParam;
		}
	}
	let state = createInitialFilterState(urlInitPatch);
	const showPrototypeChrome = options.showPrototypeChrome ?? true;
	let whyModalOpen = false;
	const activeDagBoards = new Map<string, TaskDagResult>();

	function syncThemeAttributes(): void {
		if (showPrototypeChrome) {
			doc.documentElement.setAttribute("data-theme", state.theme);
			if (options.syncDocumentTheme && state.scheme) {
				doc.documentElement.setAttribute("data-scheme", state.scheme);
			}
		} else {
			const hostTheme = doc.documentElement.getAttribute("data-theme");
			if (hostTheme === "light" || hostTheme === "dark") {
				state.theme = hostTheme;
			}
		}
		const shell = container.querySelector<HTMLElement>(".app-shell");
		if (shell) {
			shell.setAttribute("data-tasks-roles-v8-theme", state.theme);
		}
	}

	function bindDynamicEvents(): void {
		const heroRegion = container.querySelector<HTMLElement>("#hero-region");
		const filterRegion = container.querySelector<HTMLElement>("#filter-region");
		const viewRegion = container.querySelector<HTMLElement>("#view-region");

		container.querySelector<HTMLButtonElement>("#tab-initiatives")?.addEventListener("click", () => {
			state = { ...state, page: "initiatives" };
			refresh();
		});

		container.querySelector<HTMLButtonElement>("#tab-roles")?.addEventListener("click", () => {
			state = { ...state, page: "roles" };
			refresh();
		});

		container.querySelectorAll<HTMLButtonElement>(".mode-btn").forEach((btn) => {
			btn.addEventListener("click", () => {
				const mode = (btn.getAttribute("data-mode") as TasksRolesV8FilterState["mode"]) || "normal";
				state = { ...state, mode };
				refresh();
			});
		});

		container.querySelector<HTMLButtonElement>("#theme-toggle")?.addEventListener("click", () => {
			state = { ...state, theme: state.theme === "dark" ? "light" : "dark" };
			refresh();
		});

		container.querySelector<HTMLButtonElement>("#why-modal-btn")?.addEventListener("click", () => {
			whyModalOpen = true;
			const modal = container.querySelector<HTMLElement>("#why-modal");
			modal?.removeAttribute("hidden");
			options.onOverlayChange?.(hasOpenOverlay());
		});

		container.querySelector<HTMLButtonElement>("#why-modal-close-btn")?.addEventListener("click", () => {
			whyModalOpen = false;
			const modal = container.querySelector<HTMLElement>("#why-modal");
			modal?.setAttribute("hidden", "");
			options.onOverlayChange?.(hasOpenOverlay());
		});

		container.querySelector<HTMLElement>("#why-modal")?.addEventListener("click", (ev: Event) => {
			if (ev.target === ev.currentTarget) {
				whyModalOpen = false;
				(ev.currentTarget as HTMLElement).setAttribute("hidden", "");
				options.onOverlayChange?.(hasOpenOverlay());
			}
		});

		heroRegion?.querySelector<HTMLButtonElement>("#filter-needs-attention-btn")?.addEventListener("click", () => {
			state = toggleNeedsAttentionFilter(state);
			refresh();
		});

		heroRegion?.querySelector<HTMLButtonElement>("#filter-only-on-you-btn")?.addEventListener("click", () => {
			state = toggleOnlyOnYouFilter(state);
			refresh();
		});

		heroRegion?.querySelector<HTMLButtonElement>("#clear-attention-filter-btn")?.addEventListener("click", () => {
			state = { ...state, statusFilter: "all" };
			refresh();
		});

		filterRegion?.querySelectorAll<HTMLDetailsElement>("details.filter-dd").forEach((detailsEl) => {
			detailsEl.addEventListener("toggle", () => {
				const ddName = detailsEl.getAttribute("data-filter-dropdown") as V8DropdownKind | null;
				if (detailsEl.open && ddName) {
					state.openDropdown = ddName;
					filterRegion.querySelectorAll<HTMLDetailsElement>("details.filter-dd").forEach((other) => {
						if (other !== detailsEl && other.open) other.open = false;
					});
				} else if (!detailsEl.open && state.openDropdown === ddName) {
					state.openDropdown = null;
				}
				options.onOverlayChange?.(hasOpenOverlay());
			});
		});

		filterRegion?.querySelectorAll<HTMLInputElement>(".filter-dd-search").forEach((inp) => {
			inp.addEventListener("input", (e) => {
				const dd = inp.getAttribute("data-dd-search") as V8DropdownKind | null;
				if (!dd) return;
				const val = (e.target as HTMLInputElement).value || "";
				state = {
					...state,
					openDropdown: dd,
					ddSearch: { ...state.ddSearch, [dd]: val },
				};
				refresh();
				const nextInp = container.querySelector<HTMLInputElement>(`.filter-dd-search[data-dd-search="${dd}"]`);
				if (nextInp) {
					nextInp.focus();
					const len = nextInp.value.length;
					nextInp.setSelectionRange(len, len);
				}
			});
		});

		filterRegion?.querySelectorAll<HTMLButtonElement>(".dept-filter-btn").forEach((btn) => {
			btn.addEventListener("click", () => {
				state = {
					...state,
					deptFilter: btn.getAttribute("data-dept-id") || "all",
					openDropdown: null,
				};
				refresh();
			});
		});

		filterRegion?.querySelectorAll<HTMLButtonElement>(".touch-filter-btn").forEach((btn) => {
			btn.addEventListener("click", () => {
				const touch = btn.getAttribute("data-touch-id") || "all";
				const validTagIds = new Set(
					dataset.allTags.filter((tg) => touch === "all" || tg.touches.includes(touch)).map((tg) => tg.id),
				);
				state = {
					...state,
					touch,
					openDropdown: null,
					selectedTags: state.selectedTags.filter((id) => validTagIds.has(id)),
				};
				refresh();
			});
		});

		filterRegion?.querySelectorAll<HTMLButtonElement>(".status-filter-btn").forEach((btn) => {
			btn.addEventListener("click", () => {
				const sf = (btn.getAttribute("data-status-filter") || "all") as V8StatusFilterId;
				state = {
					...state,
					statusFilter: state.statusFilter === sf && sf !== "all" ? "all" : sf,
					openDropdown: null,
				};
				refresh();
			});
		});

		filterRegion?.querySelectorAll<HTMLButtonElement>(".tag-filter-btn").forEach((btn) => {
			btn.addEventListener("click", () => {
				const id = btn.getAttribute("data-tag-id") || "";
				state = toggleSelectedTag(state, id);
				refresh();
			});
		});

		filterRegion?.querySelector<HTMLButtonElement>("#toggle-tag-match-btn")?.addEventListener("click", () => {
			state = toggleTagMatchMode(state);
			refresh();
		});

		filterRegion?.querySelector<HTMLButtonElement>("#clear-tags-btn")?.addEventListener("click", () => {
			state = { ...state, selectedTags: [] };
			refresh();
		});

		filterRegion?.querySelector<HTMLButtonElement>("#reset-all-filters-bar-btn")?.addEventListener("click", () => {
			state = resetAllFilters(state);
			refresh();
		});

		const searchInput = filterRegion?.querySelector<HTMLInputElement>("#task-search-input");
		searchInput?.addEventListener("input", (e) => {
			state = { ...state, searchQuery: (e.target as HTMLInputElement).value || "" };
			if (viewRegion) {
				activeDagBoards.clear();
				viewRegion.innerHTML = renderViewRegion({ dataset, state, activeDagBoards, showPrototypeChrome });
				bindViewRegionEvents();
				drawAllDagEdges(container, activeDagBoards);
			}
		});

		filterRegion?.querySelectorAll<HTMLButtonElement>("[data-open-tag-dag]").forEach((btn) => {
			btn.addEventListener("click", () => {
				const tagId = btn.getAttribute("data-open-tag-dag") || "";
				const nextActiveTagDag = state.activeTagDag === tagId ? null : tagId;
				state = {
					...state,
					openDropdown: null,
					activeTagDag: nextActiveTagDag,
					activeDagDetailTaskId: null,
				};
				refresh();
				if (nextActiveTagDag) {
					const regionEl = container.querySelector<HTMLElement>("#tag-dag-region");
					if (regionEl && typeof regionEl.scrollIntoView === "function") {
						regionEl.scrollIntoView({ block: "start" });
					}
				}
			});
		});

		bindViewRegionEvents();
	}

	function bindViewRegionEvents(): void {
		const viewRegion = container.querySelector<HTMLElement>("#view-region");
		if (!viewRegion) return;

		viewRegion.querySelectorAll<HTMLButtonElement>(".dept-strip-btn").forEach((btn) => {
			btn.addEventListener("click", () => {
				const clickedDept = btn.getAttribute("data-dept-strip-id") || "all";
				const nextDept = clickedDept === "all" || state.deptFilter === clickedDept ? "all" : clickedDept;
				state = {
					...state,
					deptFilter: nextDept,
					openDropdown: null,
				};
				refresh();
			});
		});

		viewRegion.querySelectorAll<HTMLButtonElement>("[data-open-tag-dag]").forEach((btn) => {
			btn.addEventListener("click", () => {
				const tagId = btn.getAttribute("data-open-tag-dag") || "";
				const nextActiveTagDag = state.activeTagDag === tagId ? null : tagId;
				state = {
					...state,
					openDropdown: null,
					activeTagDag: nextActiveTagDag,
					activeDagDetailTaskId: null,
				};
				refresh();
				if (nextActiveTagDag) {
					const regionEl = container.querySelector<HTMLElement>("#tag-dag-region");
					if (regionEl && typeof regionEl.scrollIntoView === "function") {
						regionEl.scrollIntoView({ block: "start" });
					}
				}
			});
		});

		viewRegion.querySelectorAll<HTMLSelectElement>("[data-dag-tag-select]").forEach((sel) => {
			sel.addEventListener("change", (e) => {
				const nextTag = (e.target as HTMLSelectElement).value || null;
				state = {
					...state,
					activeTagDag: nextTag,
					activeDagDetailTaskId: null,
				};
				refresh();
			});
		});

		viewRegion.querySelectorAll<HTMLButtonElement>("[data-stage-overflow-toggle]").forEach((btn) => {
			btn.addEventListener("click", () => {
				const key = btn.getAttribute("data-stage-overflow-toggle") || "";
				if (!key) return;
				state = {
					...state,
					expandedDagStageCols: {
						...state.expandedDagStageCols,
						[key]: !state.expandedDagStageCols[key],
					},
				};
				refresh();
			});
		});

		viewRegion.querySelectorAll<HTMLButtonElement>("[data-close-dag-detail]").forEach((btn) => {
			btn.addEventListener("click", () => {
				state = {
					...state,
					activeDagDetailTaskId: null,
				};
				refresh();
			});
		});

		viewRegion.querySelectorAll<HTMLButtonElement>(".handoff-step").forEach((btn) => {
			btn.addEventListener("click", () => {
				const askId = btn.getAttribute("data-ask-id") || "";
				const role = btn.getAttribute("data-step-role") || "";
				const cur = state.handoffRoleFilter[askId];
				state = {
					...state,
					handoffRoleFilter: {
						...state.handoffRoleFilter,
						[askId]: cur === role ? null : role,
					},
				};
				refresh();
			});
		});

		viewRegion.querySelectorAll<HTMLButtonElement>(".clear-handoff-btn").forEach((btn) => {
			btn.addEventListener("click", () => {
				const askId = btn.getAttribute("data-ask-id") || "";
				state = {
					...state,
					handoffRoleFilter: {
						...state.handoffRoleFilter,
						[askId]: null,
					},
				};
				refresh();
			});
		});

		viewRegion.querySelectorAll<HTMLButtonElement>(".task-detail-toggle-btn").forEach((btn) => {
			btn.addEventListener("click", () => {
				const taskId = Number(btn.getAttribute("data-task-id"));
				if (btn.hasAttribute("data-dag-detail-btn") || btn.closest("[data-dag-board]")) {
					state = {
						...state,
						activeDagDetailTaskId: state.activeDagDetailTaskId === taskId ? null : taskId,
					};
				} else {
					state = {
						...state,
						expandedTasks: {
							...state.expandedTasks,
							[taskId]: !state.expandedTasks[taskId],
						},
					};
				}
				refresh();
			});
		});

		viewRegion.querySelector<HTMLButtonElement>("#toggle-all-task-details-btn")?.addEventListener("click", () => {
			const allTasks = dataset.askGroups.flatMap((a) => a.tasks ?? []);
			const allOpen = allTasks.every((t) => Boolean(state.expandedTasks[t.id]));
			const nextExpanded: Record<number, boolean> = { ...state.expandedTasks };
			for (const t of allTasks) {
				nextExpanded[t.id] = !allOpen;
			}
			state = { ...state, expandedTasks: nextExpanded };
			refresh();
		});

		viewRegion.querySelectorAll<HTMLButtonElement>(".expand-ask-tasks-btn").forEach((btn) => {
			btn.addEventListener("click", () => {
				const askId = btn.getAttribute("data-ask-id") || "";
				const ask = dataset.askGroups.find((a) => a.key === askId);
				if (!ask) return;
				const tasks = ask.tasks ?? [];
				const allOpen = tasks.every((t) => Boolean(state.expandedTasks[t.id]));
				const nextExpanded: Record<number, boolean> = { ...state.expandedTasks };
				for (const t of tasks) {
					nextExpanded[t.id] = !allOpen;
				}
				state = { ...state, expandedTasks: nextExpanded };
				refresh();
			});
		});

		viewRegion.querySelectorAll<HTMLButtonElement>(".role-toggle-btn").forEach((btn) => {
			btn.addEventListener("click", () => {
				const roleId = btn.getAttribute("data-role-id") || "";
				state = {
					...state,
					expandedRoles: {
						...state.expandedRoles,
						[roleId]: !state.expandedRoles[roleId],
					},
				};
				refresh();
			});
		});

		viewRegion.querySelectorAll<HTMLButtonElement>(".answer-choice-btn").forEach((btn) => {
			btn.addEventListener("click", () => {
				const taskId = Number(btn.getAttribute("data-task-id"));
				const choice = btn.getAttribute("data-choice") || "";
				state = {
					...state,
					answeredTasks: {
						...state.answeredTasks,
						[taskId]: choice,
					},
				};
				options.onAnswerQuestion?.(taskId, choice);
				refresh();
			});
		});

		viewRegion.querySelectorAll<HTMLButtonElement>(".open-chat-btn").forEach((btn) => {
			btn.addEventListener("click", () => {
				const file = btn.getAttribute("data-chat-file") || "";
				if (file) options.onOpenChat?.(file);
			});
		});

		viewRegion.querySelector<HTMLButtonElement>("#toggle-idle-btn")?.addEventListener("click", () => {
			state = { ...state, idleExpanded: !state.idleExpanded };
			refresh();
		});

		viewRegion.querySelector<HTMLButtonElement>("#empty-reset-btn")?.addEventListener("click", () => {
			state = resetAllFilters(state);
			refresh();
		});

		viewRegion.querySelector<HTMLButtonElement>("#retry-load-btn")?.addEventListener("click", () => {
			state = { ...state, mode: "normal" };
			options.onRetryLoad?.();
			refresh();
		});

		viewRegion.querySelector<HTMLButtonElement>("#restore-normal-btn")?.addEventListener("click", () => {
			state = { ...state, mode: "normal" };
			refresh();
		});
	}

	function hasOpenOverlay(): boolean {
		return Boolean(whyModalOpen || state.openDropdown || state.activeDagDetailTaskId !== null);
	}

	function closeTopOverlay(): boolean {
		if (whyModalOpen) {
			whyModalOpen = false;
			const modal = container.querySelector<HTMLElement>("#why-modal");
			modal?.setAttribute("hidden", "");
			options.onOverlayChange?.(hasOpenOverlay());
			return true;
		}
		if (state.openDropdown) {
			state = { ...state, openDropdown: null };
			refresh();
			options.onOverlayChange?.(hasOpenOverlay());
			return true;
		}
		if (state.activeDagDetailTaskId !== null) {
			state = { ...state, activeDagDetailTaskId: null };
			refresh();
			options.onOverlayChange?.(hasOpenOverlay());
			return true;
		}
		return false;
	}

	function refresh(): void {
		const activeEl = doc.activeElement as HTMLInputElement | null;
		const focusSelector =
			activeEl && container.contains(activeEl)
				? activeEl.id === "task-search-input"
					? "#task-search-input"
					: activeEl.getAttribute("data-dd-search")
						? `.filter-dd-search[data-dd-search="${activeEl.getAttribute("data-dd-search")}"]`
						: null
				: null;
		const selStart = focusSelector && typeof activeEl?.selectionStart === "number" ? activeEl.selectionStart : null;
		const selEnd = focusSelector && typeof activeEl?.selectionEnd === "number" ? activeEl.selectionEnd : null;

		activeDagBoards.clear();
		container.innerHTML = renderTasksRolesV8Shell({
			dataset,
			state,
			activeDagBoards,
			whyModalOpen,
			showPrototypeChrome,
		});
		syncThemeAttributes();
		bindDynamicEvents();
		drawAllDagEdges(container, activeDagBoards);
		options.onOverlayChange?.(hasOpenOverlay());

		if (focusSelector) {
			const restored = container.querySelector<HTMLInputElement>(focusSelector);
			if (restored) {
				restored.focus();
				if (selStart !== null && selEnd !== null) {
					try {
						restored.setSelectionRange(selStart, selEnd);
					} catch {
						// Ignore selection range errors on unsupported input types.
					}
				}
			}
		}
	}

	const onWindowResize = () => {
		drawAllDagEdges(container, activeDagBoards);
	};
	const onWindowKeyDown = (ev: KeyboardEvent) => {
		if (ev.key === "Escape" && !ev.defaultPrevented && hasOpenOverlay()) {
			if (closeTopOverlay()) {
				ev.preventDefault();
			}
		}
	};
	if (typeof window !== "undefined") {
		window.addEventListener("resize", onWindowResize);
		window.addEventListener("keydown", onWindowKeyDown);
	}

	const themeObserver =
		typeof MutationObserver !== "undefined" && doc?.documentElement
			? new MutationObserver(() => {
					const attrTheme = doc.documentElement.getAttribute("data-theme");
					if ((attrTheme === "light" || attrTheme === "dark") && attrTheme !== state.theme) {
						state = { ...state, theme: attrTheme };
						const shell = container.querySelector<HTMLElement>(".app-shell");
						if (shell) {
							shell.setAttribute("data-tasks-roles-v8-theme", state.theme);
						}
						const lbl = container.querySelector<HTMLElement>("#theme-toggle-label");
						if (lbl) {
							lbl.textContent = state.theme === "dark" ? "Dark" : "Light";
						}
						drawAllDagEdges(container, activeDagBoards);
					}
				})
			: null;
	themeObserver?.observe(doc.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

	refresh();

	return {
		getState: () => ({ ...state }),
		setState: (patch) => {
			state = { ...state, ...patch };
			refresh();
		},
		getDataset: () => dataset,
		setDataset: (nextDataset) => {
			dataset = nextDataset;
			refresh();
		},
		getActiveDagBoards: () => activeDagBoards,
		drawDagEdges: () => drawAllDagEdges(container, activeDagBoards),
		hasOpenOverlay,
		closeTopOverlay,
		refresh,
		destroy: () => {
			if (typeof window !== "undefined") {
				window.removeEventListener("resize", onWindowResize);
				window.removeEventListener("keydown", onWindowKeyDown);
			}
			themeObserver?.disconnect();
			activeDagBoards.clear();
			container.innerHTML = "";
		},
	};
}

export { TASKS_ROLES_V8_CSS, injectTasksRolesV8Styles, buildTaskDag };
