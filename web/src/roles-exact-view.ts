/** Presentation controller for the supplied template. This is not a tracking producer.
 * Its only inputs are the same closed models already used by the live Roles page.
 */
import { EXACT_SOURCE, exactAge, exactClock, type ExactRole, type ExactRoles } from "./roles-exact-model";
import type { NeedsYouItem } from "./roles-useful-model";
import type { PanelRoleStatus, RolePanel } from "./roles-panel-model";
import { ringAnchor, ringLayout } from "./roles-u0/layout";
import type { SurfaceValues } from "./roles-u0/types";
import type { RowState, UsefulOpenTarget, UsefulRecord } from "./roles-useful-model";

const NR = "Not recorded";
const MISSING = "Not connected yet";
const ROLE_STATE: Record<PanelRoleStatus, string> = {
	"needs-you": "waiting",
	busy: "working",
	paused: "paused",
	idle: "idle",
	"nothing-yet": "unknown",
	unknown: "unknown",
};
const GROUPS: readonly [string, string, readonly RowState[]][] = [
	["Working and asking", "#7DB8FF", ["working", "asking", "asking-main", "asking-ops", "asking-lead"]],
	["Ready to start", "#D6D9DD", ["ready"]],
	["Waiting on something", "#F0B95A", ["ready-after", "blocked", "needs-decision", "on-hold"]],
	["Other reported tasks", "#C7B8FF", ["unknown", "done"]],
];

export interface ExactViewClock {
	raf(fn: () => void): unknown;
	cancelRaf(handle: unknown): void;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}
export interface ExactViewActions {
	open(target: UsefulOpenTarget): void;
	about(roleId: string): void;
	reload(): void;
}
type Selection = { kind: "you" } | { kind: "role"; id: string } | null;

function count(n: number | string): string {
	return typeof n === "number" ? String(n) : "Unknown";
}
function taskTitle(task: UsefulRecord | undefined): string {
	return task ? (task.name ?? `Task #${task.taskId}`) : NR;
}
function report(panel: RolePanel | null): SurfaceValues {
	const r = panel?.report;
	const sections = r?.sections.length
		? r.sections.map((s) => ({
				label: s.heading,
				fg: "#9CC7FF",
				items: (s.text ?? "Report text unavailable")
					.split("\n")
					.filter(Boolean)
					.map((t) => ({ t })),
			}))
		: r?.text
			? [
					{
						label: "Report",
						fg: "#9CC7FF",
						items: r.text
							.split("\n")
							.filter(Boolean)
							.map((t) => ({ t })),
					},
				]
			: [];
	const available = r?.state === "report" && sections.length > 0;
	return {
		has: available,
		missing: !available,
		when: r?.date ?? NR,
		summary: r?.date ?? "Report date unknown",
		sections,
		reason:
			r?.state === "failed" || r?.state === "unavailable"
				? "The report could not be read."
				: r?.state === "not-active" || r?.state === "not-in-job"
					? "This role is not part of the current report job."
					: "No report is available in this snapshot.",
		last: r?.date ?? NR,
	};
}

export function createExactRolesView(
	read: () => ExactRoles,
	actions: ExactViewActions,
	clock: ExactViewClock,
	invalidate: () => void,
) {
	let selected: Selection = null;
	let hover: string | null = null;
	let graph: Element | null = null;
	let grown = false;
	let settled = false;
	let wrapHeight = 600;
	let from = { top: 0, left: 0, width: 0, height: 0 };
	let legend = false;
	let reportOpen = false;
	let tab: "work" | "config" = "work";
	let disposed = false;
	let generation = 0;
	let origin: HTMLElement | null = null;
	const rafs = new Set<unknown>();
	const timers = new Set<unknown>();
	const changed = () => {
		if (!disposed) invalidate();
	};
	function clearAnimation() {
		generation++;
		for (const h of rafs) clock.cancelRaf(h);
		for (const h of timers) clock.clearTimeout(h);
		rafs.clear();
		timers.clear();
	}
	function raf(fn: () => void) {
		const g = generation;
		const h = clock.raf(() => {
			if (!disposed && generation === g) fn();
		});
		rafs.add(h);
	}
	function later(fn: () => void, ms: number) {
		const g = generation;
		const h = clock.setTimeout(() => {
			if (!disposed && generation === g) fn();
		}, ms);
		timers.add(h);
	}
	function expand(next: Exclude<Selection, null>, source?: Event | Element) {
		if (disposed) return;
		clearAnimation();
		const el = source && "currentTarget" in source ? (source.currentTarget as Element | null) : source;
		const rect = el && "getBoundingClientRect" in el ? el.getBoundingClientRect() : graph?.getBoundingClientRect();
		const wrapper = el && "closest" in el ? el.closest("[data-boxgrid]") : graph;
		const wr = wrapper?.getBoundingClientRect();
		origin = el && "focus" in el ? (el as HTMLElement) : null;
		from = {
			top: (rect?.top ?? 0) - (wr?.top ?? 0),
			left: (rect?.left ?? 0) - (wr?.left ?? 0),
			width: rect?.width ?? 0,
			height: rect?.height ?? 0,
		};
		wrapHeight = wr?.height || 600;
		selected = next;
		grown = false;
		settled = false;
		reportOpen = false;
		tab = "work";
		changed();
		raf(() =>
			raf(() => {
				grown = true;
				changed();
				later(() => {
					settled = true;
					changed();
				}, 380);
			}),
		);
	}
	function close(immediate = false) {
		clearAnimation();
		grown = false;
		settled = false;
		const finish = () => {
			selected = null;
			changed();
			if (origin?.isConnected) origin.focus();
			origin = null;
		};
		if (immediate) finish();
		else {
			changed();
			later(finish, 350);
		}
	}
	function openRole(id: string, source?: Event | Element) {
		if (read().roles.some((r) => r.row.roleId === id)) expand({ kind: "role", id }, source);
	}
	function selectedRole() {
		if (disposed || selected?.kind !== "role") return null;
		const id = selected.id;
		return read().roles.find((r) => r.row.roleId === id) ?? null;
	}
	function routeTarget(route: string): UsefulOpenTarget | null {
		const role = selectedRole();
		if (!role?.panel?.home) return null;
		if (route === "home") return role.panel.home;
		if (route !== "queue") return null;
		// The full queue is in the role's HOME chat, never a started task's chat.
		// A known task uses the app's existing queue-focus route. With no known
		// task there is no such route yet: disable it instead of inventing #0.
		const first = role.row.active.records[0] ?? role.row.queued.records[0];
		return first ? { file: role.panel.home.file, focus: { kind: "task", id: String(first.taskId) } } : null;
	}
	function canNavigate(route: string) {
		return route === "about" ? selectedRole() !== null : routeTarget(route) !== null;
	}
	function navigate(route: string) {
		if (route === "about") {
			const role = selectedRole();
			if (!role) return false;
			actions.about(role.row.roleId);
			return true;
		}
		const target = routeTarget(route);
		if (!target) return false;
		actions.open(target);
		return true;
	}
	function question(item: NeedsYouItem, model: ExactRoles): SurfaceValues {
		return {
			kind: "Open item",
			kindFg: "#F0B95A",
			kindBg: "#2A2416",
			role: item.roleLabel ?? "Unknown role",
			age: exactAge(item.since, model.now),
			title: item.text ?? "Open the original item to read it",
			context: "Read the full question and answer in its original chat.",
			isOpen: !!item.link,
			isResolved: false,
			choices: item.link
				? [
						{
							label: "Open chat",
							bg: "#ECEDEE",
							fg: "#0E0F11",
							bd: "#ECEDEE",
							op: "1",
							hasHint: false,
							pick: () => {
								if (!disposed && item.link) actions.open(item.link);
							},
						},
					]
				: [],
		};
	}
	function box(role: ExactRole, model: ExactRoles): SurfaceValues {
		const { row, panel } = role;
		const tasks = [...row.active.records, ...row.queued.records];
		const lead = row.active.records.find((t) => t.busy) ?? row.active.records[0];
		const state = ROLE_STATE[panel?.status ?? "unknown"];
		const questions = model.needs.items.filter((item) => item.roleId === row.roleId);
		const onYou = model.needs.tell === "can-tell" && (panel?.status === "needs-you" || questions.length > 0);
		const blocked = tasks.find((t) => t.waitsOn !== null);
		const panelTasks = panel
			? [
					...panel.groups.flatMap((g) => [...g.tasks, ...g.projects.flatMap((p) => p.tasks)]),
					...panel.standalone,
					...panel.unrecorded,
				]
			: [];
		const owing = blocked ? panelTasks.find((t) => t.taskId === blocked.taskId)?.owing : null;
		const resolver =
			owing?.lead?.kind === "role"
				? owing.lead.label
				: owing?.lead?.kind === "owner"
					? "You"
					: owing?.lead?.kind === "other"
						? owing.lead.id
						: NR;
		const lines = panel?.lines ?? [];
		const acts = tab === "work" ? lines.map((l) => ({ at: exactClock(l.ts), text: l.text })) : [];
		return {
			id: row.roleId,
			name: row.roleLabel,
			state,
			onYou,
			ownPaused: false,
			hasRel: false,
			relText: "",
			lanes: [],
			lanesText: NR,
			lanesLabel: "Task-lane occupancy is not recorded",
			op: hover && hover !== row.roleId ? "0.38" : model.lastReceived ? "0.8" : "1",
			bdNow: hover === row.roleId ? "#9CC7FF" : onYou ? "#6B5426" : "#2A2E34",
			hoverOn: () => {
				hover = row.roleId;
				changed();
			},
			expand: (e: Event | Element) => openRole(row.roleId, e),
			glance: lead ? `#${lead.taskId} ${taskTitle(lead)}` : "Current task not recorded",
			modeLabel:
				panel?.workMode === "self-start"
					? "Starts own work"
					: panel?.workMode === "request-only"
						? "Starts work when asked"
						: "Work mode unknown",
			taskId: lead ? `#${lead.taskId}` : "",
			taskTitle: taskTitle(lead),
			taskSrc: "· requester not recorded",
			progressText: lead?.latest ?? lines[0]?.text ?? NR,
			progressAt: lead?.latest ? NR : exactClock(lines[0]?.ts ?? null),
			nextShort: NR,
			mix: "Reported status",
			updated: exactClock(lines[0]?.ts ?? null),
			outText: MISSING,
			reqInText:
				panel?.requests.open === null || panel?.requests.open === undefined ? NR : `${panel.requests.open} open`,
			hasBlocker: !!blocked,
			blocker: { waitingFor: blocked?.waitsOn ?? NR, resolver, check: exactClock(owing?.due ?? null) },
			boxBg: "#1B1912",
			boxBd: "#4D3F1F",
			boxFg: "#F0B95A",
			boxTitle: "What it’s waiting on",
			hasEvidence: true,
			ev: ["Built", "Checked", "Installed", "Live", "Confirmed"].map((label) => ({
				label,
				at: "Not connected",
				fg: "#C7B8FF",
				bg: "transparent",
				bd: "rgba(199,184,255,0.5)",
				bs: "dashed",
			})),
			queueText: `${count(row.counts.active)} active · ${count(row.counts.queued)} queued · ${count(row.counts.done)} done`,
			chatHref: "#exact-route:home",
			queueHref: "#exact-route:queue",
			instrLabel: MISSING,
			instrFg: "#C7B8FF",
			instr: { text: "Loaded instructions are not recorded" },
			model: MISSING,
			purpose: panel?.focus ?? NR,
			respList: (panel?.goals ?? []).map((g) => ({ t: `Goal: ${g.name ?? NR}${g.scope ? ` — ${g.scope}` : ""}` })),
			hasBudgetNote: true,
			budgetNote: "Spending data is not connected to this view yet. Missing does not mean $0.",
			taskGroups: [
				...GROUPS.map(([label, fg, states]) => ({
					label,
					fg,
					items: tasks
						.filter((t) => t.pause !== "reported-paused" && states.includes(t.state))
						.map((t) => ({
							id: `#${t.taskId}`,
							title: taskTitle(t),
							hasDep: !!t.waitsOn,
							dep: t.waitsOn ?? "",
							srcText: NR,
						})),
				})),
				{
					label: "Paused by you",
					fg: "#B9BEC5",
					items: tasks
						.filter((t) => t.pause === "reported-paused")
						.map((t) => ({
							id: `#${t.taskId}`,
							title: taskTitle(t),
							hasDep: !!t.waitsOn,
							dep: t.waitsOn ?? "",
							srcText: NR,
						})),
				},
			].filter((g) => g.items.length > 0),
			acts: acts.length
				? acts
				: [
						{
							at: "",
							text:
								tab === "config"
									? "Configuration history is not connected yet."
									: "No progress text is available in this snapshot.",
						},
					],
			actsEmpty: false,
			rep: report(panel),
			inits: (panel?.leads.initiatives ?? []).map((i) => ({
				name: i.name ?? i.id,
				status: i.status ?? "Unknown",
				fg: "#C7B8FF",
				goal: "",
				tasksText: i.items === null || i.met === null ? NR : `${i.met} of ${i.items} outcome checks met`,
			})),
			initEmpty: false,
			hasRegistryNote: panel?.work !== "ok" || panel.leads.initiatives.length === 0,
			registryNote:
				panel?.work === "ok" || panel?.work === "none"
					? "No led initiatives in the received registry."
					: "The initiative registry is unavailable in this snapshot.",
			initCount:
				panel?.work === "ok" || panel?.work === "none" ? `${panel.leads.initiatives.length} led initiatives` : NR,
			spend: { own: MISSING, req: MISSING },
			decisions: questions.map((item) => question(item, model)),
			hasDecisions: questions.length > 0,
			questions: [],
			hasQuestions: true,
			missingContacts: true,
		};
	}
	function values(width?: number, height?: number): SurfaceValues {
		const model = read();
		if (selected?.kind === "role") {
			const id = selected.id;
			if (!model.roles.some((r) => r.row.roleId === id)) {
				clearAnimation();
				selected = null;
				grown = false;
				settled = false;
				origin = null;
			}
		}
		const source = EXACT_SOURCE[model.source];
		const loading = model.source === "awaiting" && model.roster === "unavailable";
		const layout = ringLayout(
			model.roles.map((r) => ({ id: r.row.roleId, name: r.row.roleLabel })),
			width || graph?.clientWidth,
			height || graph?.clientHeight,
		);
		const boxes: SurfaceValues[] = model.roles.map((r) => ({ ...box(r, model), ...ringAnchor(layout, r.row.roleId) }));
		const selectedId = selected?.kind === "role" ? selected.id : null;
		const ex = selectedId ? boxes.find((b) => b.id === selectedId) : undefined;
		const exIsYou = selected?.kind === "you";
		const needs = model.needs;
		const youText =
			needs.tell === "can-tell"
				? `${needs.total} reported asks`
				: needs.total > 0
					? `${needs.total} received asks · current total unknown`
					: "Current asks unknown";
		const inbox: SurfaceValues[] = needs.items.map((item) => question(item, model));
		if (needs.more > 0)
			inbox.push({
				kind: "More items",
				kindFg: "#F0B95A",
				kindBg: "#2A2416",
				role: "",
				age: "time unknown",
				title: `${needs.more} more reported asks are not shown here`,
				context: "Open the relevant role’s chat to read them.",
				isOpen: false,
				isResolved: false,
				choices: [],
			});
		const unavailable = model.source !== "connected-source-unverified";
		return {
			ready: !loading,
			loading,
			offline: model.source === "disconnected",
			lastKnown: model.lastReceived,
			isGlance: true,
			headingSummary:
				model.roster === "reported"
					? `${model.roles.length} departments${model.omitted ? " shown · some unavailable" : ""}`
					: "Department list unavailable",
			fresh: { text: source.label, fg: unavailable ? "#C7B8FF" : "#9FD8B8", bd: unavailable ? "#43396A" : "#2F4A3C" },
			banner: {
				show: unavailable,
				title: source.title,
				body: source.body,
				bg: "#16181B",
				bd: "#2A2E34",
				fg: "#ECEDEE",
				hasAction: unavailable && !loading && model.source !== "disconnected",
				action: "Retry",
				retry: () => {
					if (!disposed) actions.reload();
				},
			},
			footerText: model.lastReceived
				? "Last received data · current state unconfirmed"
				: "Existing Roles feed · reported information",
			provenanceText: "Missing data is marked; lane and message tracking are not connected yet.",
			glance: { boxes },
			nodeW: `${layout.nodeW}px`,
			gw: layout.width,
			gh: layout.height,
			setGraphEl: (el: Event | Element) => {
				if ("getBoundingClientRect" in el && graph !== el) {
					graph = el;
					changed();
				}
			},
			graph: {
				edges: [],
				flights: [],
				tipOpen: false,
				tip: { x: "0%", y: "0%", tf: "none", title: "", hint: "", msgs: [] },
			},
			tipOff: () => {},
			hoverOff: () => {
				hover = null;
				changed();
			},
			legendOpen: legend,
			legendOpenStr: String(legend),
			legendLabel: legend ? "Hide legend" : "Legend",
			toggleLegend: () => {
				legend = !legend;
				changed();
			},
			arrowMeaning: "Message tracking is not connected yet. The design’s key:",
			channelShown: false,
			contactChannelTitle: MISSING,
			contactChannelText: MISSING,
			youText,
			youBd: hover === "you" ? "#F0B95A" : "#6B5426",
			youOp: hover && hover !== "you" ? "0.38" : "1",
			youHoverOn: () => {
				hover = "you";
				changed();
			},
			youExpand: (e: Event | Element) => expand({ kind: "you" }, e),
			inbox,
			inboxEmpty: inbox.length === 0,
			emptyInboxText:
				needs.tell === "can-tell" && needs.total === 0
					? `No owner asks reported at ${exactClock(needs.asOf)}.`
					: "Current owner asks could not be confirmed.",
			qs: [],
			qsEmpty: true,
			emptyContactsText: "Contact and reply tracking are not connected yet.",
			contactsHeading: "Your contacts",
			roleContactsHeading: "Your contacts with",
			spendPeriodText: "Individual spending",
			spendRoleText: MISSING,
			spendAmountText: MISSING,
			spendBudgetText: "",
			spendAria: "Spending is not connected yet",
			spendBarWidth: "0%",
			spendBarColor: "transparent",
			spendNoteText: "No total is inferred. Missing spending data does not mean $0.",
			exOpen: !!ex || exIsYou,
			ex: ex ?? {},
			exIsYou,
			exIsDept: !!ex,
			exLabel: exIsYou ? "Your decisions, questions and spending" : `${ex?.name ?? "Role"} details`,
			exPos: grown
				? {
						t: "0px",
						l: "0px",
						w: "100%",
						h: `${wrapHeight}px`,
						o: "1",
						y: "0px",
						d: "150ms",
						ov: settled ? "auto" : "hidden",
					}
				: {
						t: `${from.top}px`,
						l: `${from.left}px`,
						w: `${from.width}px`,
						h: `${from.height}px`,
						o: "0",
						y: "8px",
						d: "0ms",
						ov: "hidden",
					},
			exMinH: "0px",
			closeEx: () => close(),
			repOpen: reportOpen,
			repOpenStr: String(reportOpen),
			repChev: reportOpen ? "rotate(180deg)" : "none",
			toggleRep: () => {
				reportOpen = !reportOpen;
				changed();
			},
			drTabs: (["work", "config"] as const).map((value) => ({
				label: value === "work" ? "Work progress" : "Configuration",
				pressed: String(tab === value),
				bg: tab === value ? "#ECEDEE" : "transparent",
				fg: tab === value ? "#0E0F11" : "#D6D9DD",
				bd: tab === value ? "#ECEDEE" : "#3A3F46",
				pick: () => {
					tab = value;
					changed();
				},
			})),
		};
	}
	return {
		values,
		openRole,
		navigate,
		canNavigate,
		close,
		isOpen: () => selected !== null,
		dispose: () => {
			disposed = true;
			clearAnimation();
			selected = null;
			graph = null;
			origin = null;
		},
	};
}
