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
	["Running", "#7DB8FF", ["working", "asking", "asking-main", "asking-ops", "asking-lead"]],
	["Ready to start", "#D6D9DD", ["ready"]],
	["Waiting on something", "#F0B95A", ["ready-after", "blocked", "needs-decision", "on-hold"]],
	["Other reported tasks", "#C7B8FF", ["unknown"]],
	["Completed (latest)", "#9FD8B8", ["done"]],
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
	answer?(item: NeedsYouItem, from: HTMLElement): void;
	reload(): void;
}
type Selection = { kind: "you" } | { kind: "role"; id: string } | null;

function count(n: number | string): string {
	return typeof n === "number" ? String(n) : "Unknown";
}
function taskTitle(task: UsefulRecord | undefined): string {
	return task ? (task.name ?? `Task #${task.taskId}`) : NR;
}
function reportItems(text: string) {
	const lines = text.split("\n").filter(Boolean);
	const items = lines.slice(0, 200).map((t) => ({ t }));
	if (lines.length > 200)
		items.push({ t: `${lines.length - 200} more lines not shown here. Open the full report in the role’s chat.` });
	return items;
}
function acceptsHover(source: Event | Element): boolean {
	const el = "currentTarget" in source ? (source.currentTarget as Element | null) : source;
	return el?.ownerDocument?.defaultView?.matchMedia?.("(hover: hover)").matches !== false;
}
/** The source's owner-edge geometry, without message history, animations or invented kinds. */
function ownerEdges(model: ExactRoles, layout: ReturnType<typeof ringLayout>, hover: string | null): SurfaceValues[] {
	if (model.needs.tell !== "can-tell") return [];
	const end = layout.pos.get("you");
	if (!end) return [];
	const obstacles = [...layout.pos].map(([id, p]) => ({
		p,
		x: id === "you" ? 82 : layout.nodeW / 2 + 10,
		y: id === "you" ? 42 : 60,
	}));
	const clear = (p: number[]) =>
		obstacles.every((o) => Math.abs(p[0] - o.p[0]) > o.x + 70 || Math.abs(p[1] - o.p[1]) > o.y + 14);
	return model.roles
		.filter((r) => r.panel?.status === "needs-you" || model.needs.items.some((i) => i.roleId === r.row.roleId))
		.flatMap((r) => {
			const start = layout.pos.get(r.row.roleId);
			if (!start) return [];
			const dx = end[0] - start[0],
				dy = end[1] - start[1],
				length = Math.hypot(dx, dy) || 1;
			const ux = dx / length,
				uy = dy / length;
			const at = (t: number) => [start[0] + dx * t, start[1] + dy * t];
			const t = [0.5, 0.42, 0.58, 0.35, 0.65, 0.3, 0.7, 0.25, 0.75].find((t) => clear(at(t))) ?? 0.5;
			const point = at(t),
				label = clear(point) ? point : [point[0] - uy * 28, point[1] + ux * 28];
			const head = at(t <= 0.5 ? Math.min(0.88, t + 0.16) : Math.max(0.12, t - 0.16));
			const connected = !hover || hover === "you" || hover === r.row.roleId;
			return [
				{
					d: `M${start[0]} ${start[1]} Q${(start[0] + end[0]) / 2} ${(start[1] + end[1]) / 2} ${end[0]} ${end[1]}`,
					arrow: `M${head[0] + ux * 8} ${head[1] + uy * 8} L${head[0] - ux * 6 - uy * 6} ${head[1] - uy * 6 + ux * 6} L${head[0] - ux * 6 + uy * 6} ${head[1] - uy * 6 - ux * 6} Z`,
					stroke: "#B08433",
					sw: hover && connected ? "2.5" : "1.6",
					op: connected ? "0.95" : "0.08",
					lxp: `${(label[0] / layout.width) * 100}%`,
					lyp: `${(label[1] / layout.height) * 100}%`,
					chip: "Waiting on you",
					chipFg: "#F0B95A",
					chipBd: "#2F343A",
					glow: "none",
					aria: `${r.row.roleLabel}: waiting on you`,
				},
			];
		});
}
function report(panel: RolePanel | null): SurfaceValues {
	const r = panel?.report;
	const sections = r?.sections.length
		? r.sections.map((s) => ({
				label: s.heading,
				fg: "#9CC7FF",
				items: reportItems(s.text ?? "Report text unavailable"),
			}))
		: r?.text
			? [
					{
						label: "Report",
						fg: "#9CC7FF",
						items: reportItems(r.text),
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
		hover = null;
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
		hover = null;
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
		const canAnswer = !!item.answer && !!actions.answer && model.needs.tell === "can-tell";
		const choices: SurfaceValues[] = [];
		if (canAnswer)
			choices.push({
				label: "Answer",
				bg: "#ECEDEE",
				fg: "#0E0F11",
				bd: "#ECEDEE",
				op: "1",
				hasHint: false,
				pick: (source: Event | Element) => {
					const current = read();
					if (disposed || !item.answer || current.needs.tell !== "can-tell") return;
					const latest = current.needs.items.find(
						(candidate) => candidate.answer?.key === item.answer?.key && candidate.answer?.id === item.answer?.id,
					);
					const from = "currentTarget" in source ? source.currentTarget : source;
					if (latest && from && "focus" in from) actions.answer?.(latest, from as HTMLElement);
				},
			});
		if (item.link)
			choices.push({
				label: "Open chat",
				bg: canAnswer ? "transparent" : "#ECEDEE",
				fg: canAnswer ? "#ECEDEE" : "#0E0F11",
				bd: canAnswer ? "#3A3F46" : "#ECEDEE",
				op: "1",
				hasHint: false,
				pick: () => {
					if (!disposed && item.link) actions.open(item.link);
				},
			});
		return {
			kind: canAnswer ? "Needs your answer" : "Open item",
			kindFg: "#F0B95A",
			kindBg: "#2A2416",
			role: item.roleLabel ?? "Unknown role",
			age: exactAge(item.since, model.now),
			title: item.text ?? "Open the original item to read it",
			context: canAnswer
				? "Open the full prompt and answer here."
				: "Read the full question and answer in its original chat.",
			isOpen: choices.length > 0,
			isResolved: false,
			choices,
		};
	}
	function box(role: ExactRole, model: ExactRoles): SurfaceValues {
		const { row, panel, spend } = role;
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
		const omittedTasks =
			typeof row.counts.active === "number" && typeof row.counts.queued === "number"
				? Math.max(0, row.counts.active + row.counts.queued - tasks.length)
				: null;
		const taskOmission = omittedTasks
			? `${omittedTasks} more tasks not shown here. Open the full queue.`
			: row.active.notAllShown || row.queued.notAllShown
				? "Some tasks could not be shown. Open the full queue."
				: "";
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
			hoverOn: (e: Event | Element) => {
				if (!acceptsHover(e)) return;
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
			taskSrcFg: "#A9AEB6",
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
			hasTaskOmission: !!taskOmission,
			taskOmission,
			chatHref: "#exact-route:home",
			queueHref: "#exact-route:queue",
			instrLabel: MISSING,
			instrFg: "#C7B8FF",
			instr: { text: "Loaded instructions are not recorded" },
			model: MISSING,
			purpose: panel?.focus ?? NR,
			respList: (panel?.goals ?? []).map((g) => ({ t: `Goal: ${g.name ?? NR}${g.scope ? ` — ${g.scope}` : ""}` })),
			hasBudgetNote: true,
			budgetNote: `${model.lastReceived ? "Last received data. " : ""}${spend.note}`,
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
			]
				.filter((g) => g.items.length > 0)
				.map((g) => ({ ...g, items: g.items.map((t) => ({ ...t, srcFg: "#A9AEB6" })) })),
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
			spend: { own: spend.reported ? `${spend.amount} of ${spend.budget}` : NR, req: NR },
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
				? `${needs.total} waiting on you`
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
		const unavailable = model.source !== "connected-source-unverified" || needs.tell !== "can-tell";
		const failed = ["error", "cached-error", "disconnected", "cached"].includes(model.source);
		const stale = model.source === "stale";
		const palette = failed
			? { bg: "#221415", bd: "#5A2A2C", fg: "#FF8A80" }
			: stale || (unavailable && !loading)
				? { bg: "#1D1A12", bd: "#4D3F1F", fg: "#F0B95A" }
				: { bg: "#16181B", bd: "#2A2E34", fg: "#ECEDEE" };
		const freshText = unavailable
			? `${model.source === "connected-source-unverified" ? "Incomplete status" : source.label}${model.receivedAt !== null ? ` · last received ${exactClock(model.receivedAt)}${stale ? ` (${exactAge(model.receivedAt, model.now)} ago)` : ""}` : ""}`
			: `Live · updated ${exactClock(model.receivedAt)}`;
		const date = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(model.now);
		const spending = model.roles.filter((r) => r.spend.reported);
		const budgetRole = spending.length === 1 ? spending[0] : null;
		const budget = budgetRole?.spend;
		return {
			ready: !loading,
			loading,
			offline: model.source === "disconnected",
			lastKnown: model.lastReceived,
			isGlance: true,
			headingSummary:
				model.roster === "reported"
					? `${model.roles.length} departments${model.omitted ? " shown · some unavailable" : ""} · ${date}`
					: "Department list unavailable",
			fresh: { text: freshText, fg: unavailable ? palette.fg : "#9FD8B8", bd: unavailable ? palette.bd : "#2F4A3C" },
			banner: {
				show: unavailable,
				title: source.title || "Some owner asks could not be confirmed",
				body:
					source.body || "The received list may be incomplete. Open the original chats for anything not shown here.",
				...palette,
				hasAction: unavailable && !loading,
				action: stale ? "Refresh now" : "Retry now",
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
				edges: ownerEdges(model, layout, hover).map((edge) => ({
					...edge,
					chipClick: (e: Event | Element) => expand({ kind: "you" }, e),
				})),
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
			arrowMeaning: "Owner asks are shown. Between-department message tracking is not connected yet. The design’s key:",
			channelShown: false,
			contactChannelTitle: MISSING,
			contactChannelText: MISSING,
			youText,
			youBd: hover === "you" ? "#F0B95A" : "#6B5426",
			youOp: hover && hover !== "you" ? "0.38" : "1",
			youHoverOn: (e: Event | Element) => {
				if (!acceptsHover(e)) return;
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
			contactsHeading: "Your questions",
			roleContactsHeading: "Your questions to",
			spendPeriodText: "Own-work spending this week",
			spendRoleText:
				budgetRole?.row.roleLabel ??
				(spending.length ? `${spending.length} departments · see each role` : "No current tally available"),
			spendAmountText: budget?.amount ?? NR,
			spendBudgetText: budget ? `of ${budget.budget}` : "",
			spendAria: budget
				? `${budgetRole?.row.roleLabel} own-work tally: ${budget.amount} of ${budget.budget}`
				: "No spending total inferred",
			spendBarWidth: `${Math.round((budget?.ratio ?? 0) * 100_000) / 1000}%`,
			spendBarColor: budget
				? budget.over
					? "#FF8A80"
					: budget.stale || model.lastReceived
						? "#F0B95A"
						: "#7DB8FF"
				: "transparent",
			spendNoteText: budget
				? `${model.lastReceived ? "Last received data. " : ""}${budget.note}`
				: "No total is inferred. Missing spending data does not mean $0.",
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
