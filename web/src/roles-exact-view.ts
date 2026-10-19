/** Presentation controller for the supplied template. This is not a tracking producer.
 * Its only inputs are the same closed models already used by the live Roles page.
 */
import {
	EXACT_SOURCE,
	exactAge,
	exactClock,
	exactWhen,
	type ExactApprovalsOff,
	type ExactContact,
	type ExactInstructions,
	type ExactPair,
	type ExactRole,
	type ExactRoles,
} from "./roles-exact-model";
import type { NeedsYouItem } from "./roles-useful-model";
import { CONFIG_NOT_RECORDED, configHistoryActs } from "./roles-config-history";
import type { PanelRoleStatus, PanelTask, PanelTaskEvent, RolePanel } from "./roles-panel-model";
import { ringAnchor, ringLayout, stackLayout } from "./roles-u0/layout";
import type { SurfaceValues } from "./roles-u0/types";
import type { RowState, TellState, UsefulLinks, UsefulOpenTarget, UsefulRecord } from "./roles-useful-model";
import { EVIDENCE_STEPS, type UsefulEvidence } from "./roles-useful-model";

const NR = "Not recorded";
const MISSING = "Not connected yet";

/** ladder-alarm: the amber chip's words, and its tooltip: fixed words around the start's own reason (projected
 *  plain text) and when this server started. */
export const APPROVALS_OFF_TEXT = "Message approvals off";
export function approvalsTip(off: ExactApprovalsOff, now: number): string {
	const reason = off.reason?.replace(/[.\s]+$/u, "") || "not recorded";
	const since = off.since !== null ? ` at ${exactWhen(off.since, now)}` : "";
	return `Chains between roles stop at 6 messages and nobody can approve more. Reason: ${reason}. Off since this server started${since}.`;
}
/** roles-evidence: the supplied design's evidence styles (its EV map): done, not yet; plus the page's
 *  missing-data style for a step with no record or not tracked for the repo. */
const EV_DONE = { fg: "#9FD8B8", bg: "rgba(159,216,184,0.08)", bd: "#2F4A3C", bs: "solid" };
const EV_PENDING = { fg: "#A9AEB6", bg: "transparent", bd: "#3A3F46", bs: "dashed" };
const EV_MISSING = { fg: "#C7B8FF", bg: "transparent", bd: "rgba(199,184,255,0.5)", bs: "dashed" };

/** roles-evidence (task #207): the Completion evidence row for a task: each step's time, "not yet", "Not
 *  recorded" (no record links it to a branch, or no task), or "Not tracked for <repo>". */
export function exactEvidence(
	evidence: UsefulEvidence | undefined,
	now: number,
): { label: string; at: string; fg: string; bg: string; bd: string; bs: string }[] {
	return EVIDENCE_STEPS.map((label, i) => {
		const step = evidence?.steps[i];
		if (step && "at" in step) return { label, at: exactWhen(step.at, now), ...EV_DONE };
		if (step?.not === "yet") return { label, at: "not yet", ...EV_PENDING };
		if (step?.not === "tracked")
			return { label, at: evidence?.repo ? `Not tracked for ${evidence.repo}` : "Not tracked", ...EV_MISSING };
		return { label, at: NR, ...EV_MISSING };
	});
}
/** roles-small-fixes N2: why a connected feed's owner asks can't be confirmed (fixed words only). */
const ASKS_UNCONFIRMED: Partial<Record<TellState, { label: string; body: string }>> = {
	partial: {
		label: "Asks unconfirmed: some roles not read",
		body: "Not every role\u2019s open asks were read, so this list may be missing some. Open the original chats for anything not shown here.",
	},
	decision: {
		label: "Asks unconfirmed: a stuck task\u2019s question is missing",
		body: "A stuck task is waiting on you, but its question isn\u2019t in this list. Open that role\u2019s chat to answer it.",
	},
	awaiting: {
		label: "Asks unconfirmed: still checking",
		body: "The server hasn\u2019t confirmed the current asks since this page connected. The list below is the last one received.",
	},
};
/** roles-lanes: the supplied design's lane pills (its LS map): a lane in use is "working", a free one "free". */
const LANE_BUSY = { bg: "#7DB8FF", bd: "#7DB8FF", bs: "solid" };
const LANE_IDLE = { bg: "transparent", bd: "#4A4F57", bs: "solid" };

/** roles-links (Ops #222): the panel's Linked work line, like "5 in projects · 1 under an initiative · 2 standalone
 *  · 3 not recorded" with zero parts left out; "No open tasks" when there are none; not recorded without a
 *  readable queue's counts (an older server, or a queue that couldn't be read). */
export function exactLinks(links: UsefulLinks | null | undefined): string {
	if (!links) return NR;
	const parts: [number, string][] = [
		[links.project, links.project === 1 ? "1 in a project" : `${links.project} in projects`],
		[links.initiative, links.initiative === 1 ? "1 under an initiative" : `${links.initiative} under initiatives`],
		[links.standalone, `${links.standalone} standalone`],
		[links.unrecorded, `${links.unrecorded} not recorded`],
	];
	const shown = parts.filter(([n]) => n > 0).map(([, text]) => text);
	return shown.length ? shown.join(" · ") : "No open tasks";
}
/** roles-lanes: a card's lane pills and sentence; not recorded without a readable queue's lanes. */
export function exactLanes(lanes: { atOnce: number; inUse: number } | null | undefined): {
	lanes: { bg: string; bd: string; bs: string }[];
	lanesText: string;
	lanesLabel: string;
} {
	if (!lanes) return { lanes: [], lanesText: NR, lanesLabel: "Task-lane occupancy is not recorded" };
	const text = `${lanes.inUse} of ${lanes.atOnce} ${lanes.atOnce === 1 ? "lane" : "lanes"} in use`;
	return {
		lanes: Array.from({ length: lanes.atOnce }, (_, i) => (i < lanes.inUse ? LANE_BUSY : LANE_IDLE)),
		lanesText: text,
		lanesLabel: text,
	};
}
/**
 * roles-instructions (Ops #208): the panel's Instructions line, in the supplied design's label colours (its
 * INSTR map: active green, saved-not-confirmed amber, not reported violet).
 */
export function instructionsOf(
	instr: ExactInstructions,
	now: number,
): { instrLabel: string; instrFg: string; instr: { text: string } } {
	if (instr.state === "current")
		return {
			instrLabel: "Current",
			instrFg: "#9FD8B8",
			instr: { text: `Loaded ${exactWhen(instr.loadedAt, now)} · up to date` },
		};
	if (instr.state === "outdated")
		return {
			instrLabel: "Outdated",
			instrFg: "#F0B95A",
			instr: { text: `Loaded ${exactWhen(instr.loadedAt, now)} · ${instr.changed.join(", ")} changed since` },
		};
	return { instrLabel: NR, instrFg: "#C7B8FF", instr: { text: "what its home chat loaded is not recorded" } };
}
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
/** Fixed language around checked queue fields; no inferred plan steps or imperative actions. */
function nextText(task: PanelTask | undefined): string {
	const next = task?.next;
	if (!next) return NR;
	const actor =
		next.who?.kind === "owner"
			? "you"
			: next.who?.kind === "role"
				? next.who.label
				: next.who?.kind === "other"
					? next.who.id
					: null;
	const due = next.until === null ? "" : ` · checkpoint ${new Date(next.until).toLocaleString("en-US")}`;
	switch (next.kind) {
		case "queue":
			return next.after.length
				? `Waiting for tasks: ${next.after.join(", ")}`
				: "Queued; starts when the queue can run it";
		case "check":
			return `${next.what ? `Recorded wait: ${next.what}` : "Waiting for its recorded check"}${next.everyMs === null ? "" : ` · checked every ${next.everyMs / 60_000} min`}${next.until === null ? "" : ` · until ${new Date(next.until).toLocaleString("en-US")}`}`;
		case "blocked":
			return `${actor ? `Waiting for ${actor}` : "Waiting on a recorded blocker"}${next.what ? ` — ${next.what}` : ""}${next.after.length ? ` · tasks ${next.after.join(", ")}` : ""}${due}`;
		case "answer":
			return actor === "you" ? "Awaiting your answer" : `Awaiting ${actor ?? "the recorded lead"} to answer`;
		case "resume":
			return "Paused by you; awaits your resume";
		case "unrecorded":
			return "Next step not recorded";
		case "none":
			return "No next action: task ended";
	}
}
const QUEUE_EVENT: Record<PanelTaskEvent["kind"], string> = {
	added: "Queue recorded: task added",
	started: "Queue recorded: task started",
	waiting: "Queue recorded: waiting for a check",
	blocked: "Queue recorded: blocked",
	answer: "Queue status: awaiting an answer",
	paused: "Queue recorded: paused by you",
	done: "Queue recorded: task completed",
	dropped: "Queue recorded: task dropped",
};
function acceptsHover(source: Event | Element): boolean {
	const el = "currentTarget" in source ? (source.currentTarget as Element | null) : source;
	if (!el) return false;
	// Restored mouse focus is not a hover. Keep the spotlight for visible keyboard focus.
	if ("type" in source && (source.type === "focus" || source.type === "focusin")) return el.matches(":focus-visible");
	return el.ownerDocument?.defaultView?.matchMedia?.("(hover: hover)").matches !== false;
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
/** roles-sent: a role's label on the page (its id when it isn't shown). */
function roleName(model: ExactRoles, id: string): string {
	return model.roles.find((r) => r.row.roleId === id)?.row.roleLabel ?? id;
}
/** roles-sent: the panel's "Asked of others" line, written like "Requests in"; not recorded from an older server. */
export function exactSentText(sent: RolePanel["sent"] | undefined, now: number): string {
	if (!sent || sent.open === null) return NR;
	const n = sent.newest;
	if (sent.open === 0 || !n) return `${sent.open} open`;
	const age = n.at === null ? "" : `, ${exactAge(n.at, now)} ago`;
	return `${sent.open} open · newest to ${n.to ?? NR}${age}: ${n.text ?? NR}`;
}
/** roles-sent: the card's line saying who the role is waiting on ("Waiting on Temper", "Waiting on 2 roles"). */
export function exactWaitingOn(model: ExactRoles, id: string): string {
	const to = (model.pairs ?? []).filter((p) => p.from === id);
	if (to.length === 0) return "";
	return to.length === 1 ? `Waiting on ${roleName(model, to[0].to)}` : `Waiting on ${to.length} roles`;
}
const LABEL_AT = [0.5, 0.42, 0.58, 0.35, 0.65, 0.3, 0.7, 0.25, 0.75];
/**
 * roles-sent: the design's between-department edges (its "dept" kind), one per sender → receiver pair with
 * open requests or questions: curved toward the centre, split apart when both directions are open, the head
 * pointing at the receiver. Same hover rules as the owner edges.
 */
export function roleEdges(
	model: ExactRoles,
	layout: ReturnType<typeof ringLayout>,
	hover: string | null,
): { edge: SurfaceValues; pair: ExactPair }[] {
	const pairs = model.pairs ?? [];
	const centre = layout.pos.get("you");
	if (!pairs.length || !centre) return [];
	const obstacles = [...layout.pos].map(([id, p]) => ({
		p,
		x: id === "you" ? 82 : layout.nodeW / 2 + 10,
		y: id === "you" ? 42 : 60,
	}));
	const clear = (p: number[]) =>
		obstacles.every((o) => Math.abs(p[0] - o.p[0]) > o.x + 70 || Math.abs(p[1] - o.p[1]) > o.y + 14);
	const open = new Set(pairs.map((p) => `${p.from}>${p.to}`));
	return pairs.flatMap((pair) => {
		const p1 = layout.pos.get(pair.from),
			p2 = layout.pos.get(pair.to);
		if (!p1 || !p2) return [];
		const mx = (p1[0] + p2[0]) / 2,
			my = (p1[1] + p2[1]) / 2;
		let c = [mx + (centre[0] - mx) * 0.38, my + (centre[1] - my) * 0.38];
		if (open.has(`${pair.to}>${pair.from}`)) {
			const dx = p2[0] - p1[0],
				dy = p2[1] - p1[1],
				L = Math.hypot(dx, dy) || 1;
			c = [c[0] - (dy / L) * 30, c[1] + (dx / L) * 30];
		}
		const at = (t: number) => {
			const u = 1 - t;
			return [u * u * p1[0] + 2 * u * t * c[0] + t * t * p2[0], u * u * p1[1] + 2 * u * t * c[1] + t * t * p2[1]];
		};
		const lt = LABEL_AT.find((t) => clear(at(t))) ?? 0.5;
		const aT = lt <= 0.5 ? Math.min(0.88, lt + 0.16) : Math.max(0.12, lt - 0.16);
		const ah = at(aT);
		const tv = [
			2 * (1 - aT) * (c[0] - p1[0]) + 2 * aT * (p2[0] - c[0]),
			2 * (1 - aT) * (c[1] - p1[1]) + 2 * aT * (p2[1] - c[1]),
		];
		const tl = Math.hypot(tv[0], tv[1]) || 1,
			ux = tv[0] / tl,
			uy = tv[1] / tl;
		const lp0 = at(lt);
		const lp = clear(lp0) ? lp0 : [lp0[0] - uy * 28, lp0[1] + ux * 28];
		const connected = !hover || hover === pair.from || hover === pair.to;
		const what = `${pair.count} open ${pair.count === 1 ? "request or question" : "requests or questions"}`;
		const newest = pair.at === null ? "" : `, newest ${exactAge(pair.at, model.now)} ago`;
		return [
			{
				pair,
				edge: {
					d: `M${p1[0]} ${p1[1]} Q${c[0]} ${c[1]} ${p2[0]} ${p2[1]}`,
					arrow: `M${ah[0] + ux * 8} ${ah[1] + uy * 8} L${ah[0] - ux * 6 - uy * 6} ${ah[1] - uy * 6 + ux * 6} L${ah[0] - ux * 6 + uy * 6} ${ah[1] - uy * 6 - ux * 6} Z`,
					stroke: "#4A82C0",
					sw: hover && connected ? "2.5" : "1.6",
					op: connected ? (model.lastReceived ? "0.55" : "0.95") : "0.08",
					lxp: `${(lp[0] / layout.width) * 100}%`,
					lyp: `${(lp[1] / layout.height) * 100}%`,
					chip: `${pair.count} open`,
					chipFg: "#9CC7FF",
					chipBd: "#2F343A",
					glow: "none",
					aria: `${roleName(model, pair.from)} waiting on ${roleName(model, pair.to)}: ${what}${newest}`,
				},
			},
		];
	});
}
/** roles-phone: the same items at the same heights, within a pixel. */
function sameHeights(a: readonly number[], b: readonly number[]): boolean {
	return a.length === b.length && a.every((h, i) => Math.abs(h - b[i]) <= 1);
}

export function createExactRolesView(
	read: () => ExactRoles,
	actions: ExactViewActions,
	clock: ExactViewClock,
	invalidate: () => void,
	/** roles-phone: true below 1024 px (the host's viewport); one column replaces the ring. */
	narrow: () => boolean = () => false,
) {
	let selected: Selection = null;
	let hover: string | null = null;
	let graph: Element | null = null;
	let chrome: Element | null = null;
	let grown = false;
	let settled = false;
	let from = { top: 0, left: 0, width: 0, height: 0 };
	let legend = false;
	let tab: "work" | "config" = "work";
	let disposed = false;
	let generation = 0;
	let origin: HTMLElement | null = null;
	let quietFocusRestore = false;
	/** owner-contacts: the message whose reply is open. */
	let openContact: string | null = null;
	/** roles-small-fixes: the header height and graph height the last plan was made for.
	 * roles-phone: in a column, also the width and item heights it was made for. */
	let planned: {
		chrome: number;
		height: number;
		stack: { width: number; heights: number[] } | null;
	} | null = null;
	/** roles-phone: the last values were a column; panels then open as full-width sheets. */
	let stacked = false;
	/** roles-phone: the rendered height of the You pill and each card, in the template's (the model's) order. */
	function measureStack(): number[] {
		if (!graph) return [];
		const items = [
			graph.querySelector(":scope > [data-roles-you]"),
			...graph.querySelectorAll(":scope > div > button[aria-haspopup]"),
		];
		return items.map((el) => Math.ceil(el?.getBoundingClientRect().height ?? 0));
	}
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
		// roles-phone: a sheet is fixed to the viewport, so it grows from the card's viewport box.
		const wr = stacked ? undefined : wrapper?.getBoundingClientRect();
		origin = el && "focus" in el ? (el as HTMLElement) : null;
		from = {
			top: (rect?.top ?? 0) - (wr?.top ?? 0),
			left: (rect?.left ?? 0) - (wr?.left ?? 0),
			width: rect?.width ?? 0,
			height: rect?.height ?? 0,
		};
		selected = next;
		hover = null;
		grown = false;
		settled = false;
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
	function close(immediate = false, keyboard = false) {
		clearAnimation();
		hover = null;
		grown = false;
		settled = false;
		const finish = () => {
			selected = null;
			changed();
			// Browsers can retain :focus-visible after a mouse click on an already focused node.
			// Keep the focus return, but do not let it restart the spotlight for a pointer close.
			quietFocusRestore = !keyboard;
			try {
				if (origin?.isConnected) origin.focus();
			} finally {
				quietFocusRestore = false;
				origin = null;
			}
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
	/** owner-contacts (Roles D3): how far one of his messages got, in fixed words. A stage without a record
	 *  is "not recorded", never "didn't happen"; "failed" only with a failure record. */
	function contactStatus(c: ExactContact, now: number): { text: string; fg: string } {
		if (c.outcome === "error")
			return { text: "The turn that took it failed. Open the chat to see why.", fg: "#FF8A80" };
		if (c.outcome === "noText") return { text: "It finished without writing a reply.", fg: "#F0B95A" };
		if (c.outcome === "text") {
			if (c.channel === "browser") return { text: "Replied in the chat.", fg: "#9FD8B8" };
			if (c.sentAt !== null) return { text: "Replied and sent to your Telegram.", fg: "#9FD8B8" };
			if (c.sendFailedAt !== null) return { text: "Replied, but sending it to your Telegram failed.", fg: "#FF8A80" };
			return { text: "Replied. Sending it to your Telegram is not recorded.", fg: "#F0B95A" };
		}
		if (now - c.askedAt > 6 * 60 * 60_000) return { text: "No later stage recorded.", fg: "#A9AEB6" };
		if (c.takenAt !== null) return { text: "In its chat: working on it.", fg: "#7DB8FF" };
		return { text: "Waiting for its chat to take it.", fg: "#F0B95A" };
	}
	function contactSteps(c: ExactContact, now: number) {
		const step = (label: string, sub: string, state: "done" | "fail" | "none") => ({
			label,
			sub,
			fg: state === "fail" ? "#FF8A80" : state === "done" ? "#ECEDEE" : "#A9AEB6",
			bar: state === "fail" ? "#FF8A80" : state === "done" ? "#9FD8B8" : "#2A2E34",
		});
		const at = (t: number | null) => (t === null ? NR : exactWhen(t, now));
		const replied = c.outcome === "text";
		return [
			step("Asked", `${exactWhen(c.askedAt, now)} · ${c.channel === "telegram" ? "Telegram" : "browser"}`, "done"),
			step("In its chat", at(c.takenAt), c.takenAt !== null ? "done" : "none"),
			step(
				c.outcome === "error" ? "Failed" : c.outcome === "noText" ? "No reply text" : "Replied",
				at(c.settledAt),
				c.outcome === "error" ? "fail" : c.outcome ? "done" : "none",
			),
			c.channel === "telegram"
				? step(
						"Sent to Telegram",
						c.sentAt !== null ? at(c.sentAt) : c.sendFailedAt !== null ? `failed ${at(c.sendFailedAt)}` : NR,
						c.sentAt !== null ? "done" : c.sendFailedAt !== null ? "fail" : "none",
					)
				: step("Reply in the chat", replied ? "no delivery check" : NR, replied ? "done" : "none"),
		];
	}
	function contactItem(c: ExactContact, model: ExactRoles): SurfaceValues {
		const status = contactStatus(c, model.now);
		const open = openContact === c.id;
		const canRead = c.reply !== null;
		return {
			to: model.roles.find((r) => r.row.roleId === c.role)?.row.roleLabel ?? c.role,
			askedAt: exactWhen(c.askedAt, model.now),
			text: c.text ?? "Message text not recorded",
			status: status.text,
			statusFg: status.fg,
			steps: contactSteps(c, model.now),
			canRead,
			canReadElsewhere: false,
			readLabel: open ? "Hide reply" : "Read reply",
			expanded: String(open && canRead),
			isOpen: open && canRead,
			answer: c.reply ?? "",
			repliedAt: exactWhen(c.settledAt, model.now),
			toggle: () => {
				openContact = openContact === c.id ? null : c.id;
				changed();
			},
		};
	}
	function box(role: ExactRole, model: ExactRoles): SurfaceValues {
		const { row, panel, spend } = role;
		const tasks = [...row.active.records, ...row.queued.records];
		const lead = row.active.records.find((t) => t.busy) ?? row.active.records[0];
		const state = ROLE_STATE[panel?.status ?? "unknown"];
		const questions = model.needs.items.filter((item) => item.roleId === row.roleId);
		const roleContacts = (model.contacts ?? []).filter((c) => c.role === row.roleId);
		const onYou = model.needs.tell === "can-tell" && (panel?.status === "needs-you" || questions.length > 0);
		// roles-sent: who it waits on, and (the design's hover) a card linked to the hovered one by an open pair.
		const relText = exactWaitingOn(model, row.roleId);
		const linked =
			!!hover &&
			hover !== row.roleId &&
			(model.pairs ?? []).some(
				(p) => (p.from === hover && p.to === row.roleId) || (p.from === row.roleId && p.to === hover),
			);
		const blocked = tasks.find((t) => t.waitsOn !== null);
		const panelTasks = panel
			? [
					...panel.groups.flatMap((g) => [...g.tasks, ...g.projects.flatMap((p) => p.tasks)]),
					...panel.standalone,
					...panel.unrecorded,
				]
			: [];
		const ownTask = lead ? panelTasks.find((t) => t.taskId === lead.taskId) : undefined;
		const queueEvent = ownTask?.queueEvent;
		const rowDetail = (task: UsefulRecord) => {
			const detail = panelTasks.find((t) => t.taskId === task.taskId);
			const next = nextText(detail);
			return {
				srcText: detail?.requester ? `From ${detail.requester}` : NR,
				srcFg: detail?.requester ? "#9CC7FF" : "#A9AEB6",
				hasDep: next === NR && !!task.waitsOn,
				dep: task.waitsOn ?? "",
				hasNext: next !== NR,
				nextText: next === NR ? "" : next,
			};
		};
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
		// roles-config-history (Ops #209): Config lists the recorded settings changes, newest first.
		const acts =
			tab === "work"
				? lines.map((l) => ({ at: exactClock(l.ts), text: l.text }))
				: configHistoryActs(role.configHistory, (at) => exactWhen(at, model.now));
		const omittedTasks =
			typeof row.counts.active === "number" && typeof row.counts.queued === "number"
				? Math.max(0, row.counts.active + row.counts.queued - tasks.length)
				: null;
		// roles-small-fixes N3: counts both cuts (20 active, 20 queued), in plain words for one task too.
		const taskOmission = omittedTasks
			? `${omittedTasks} more ${omittedTasks === 1 ? "task" : "tasks"} not shown here. Open the full queue.`
			: row.active.notAllShown || row.queued.notAllShown
				? "Some tasks could not be shown. Open the full queue."
				: "";
		return {
			id: row.roleId,
			name: row.roleLabel,
			state,
			onYou,
			ownPaused: false,
			hasRel: relText !== "",
			relText,
			...exactLanes(row.lanes),
			// roles-links: the panel's Linked work line only; the cards stay as designed.
			linksText: exactLinks(row.links),
			op: hover && hover !== row.roleId && !linked ? "0.38" : model.lastReceived ? "0.8" : "1",
			bdNow: hover === row.roleId ? "#9CC7FF" : linked ? "#3D5A80" : onYou ? "#6B5426" : "#2A2E34",
			hoverOn: (e: Event | Element) => {
				if (quietFocusRestore || !acceptsHover(e)) return;
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
			taskSrc: ownTask?.requester ? `· From ${ownTask.requester}` : "· requester not recorded",
			taskSrcFg: ownTask?.requester ? "#9CC7FF" : "#A9AEB6",
			progressText: lead ? (lead.latest ?? (queueEvent ? QUEUE_EVENT[queueEvent.kind] : NR)) : (lines[0]?.text ?? NR),
			progressAt: lead ? (lead.latest ? NR : exactClock(queueEvent?.at ?? null)) : exactClock(lines[0]?.ts ?? null),
			nextShort: nextText(ownTask),
			mix: "Reported status",
			updated: exactClock(lines[0]?.ts ?? null),
			outText: exactSentText(panel?.sent, model.now),
			reqInText:
				panel?.requests.open === null || panel?.requests.open === undefined ? NR : `${panel.requests.open} open`,
			hasBlocker: !!blocked,
			blocker: { waitingFor: blocked?.waitsOn ?? NR, resolver, check: exactClock(owing?.due ?? null) },
			boxBg: "#1B1912",
			boxBd: "#4D3F1F",
			boxFg: "#F0B95A",
			boxTitle: "What it’s waiting on",
			hasEvidence: true,
			ev: exactEvidence(lead?.evidence, model.now),
			queueText: `${count(row.counts.active)} active · ${count(row.counts.queued)} queued · ${count(row.counts.done)} done`,
			hasTaskOmission: !!taskOmission,
			taskOmission,
			chatHref: "#exact-route:home",
			queueHref: "#exact-route:queue",
			...instructionsOf(role.instructions, model.now),
			// roles-model: the home chat's model as its header names it.
			model: row.model ?? NR,
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
							...rowDetail(t),
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
							...rowDetail(t),
						})),
				},
			].filter((g) => g.items.length > 0),
			acts: acts.length
				? acts
				: [
						{
							at: "",
							text: tab === "config" ? CONFIG_NOT_RECORDED : "No progress text is available in this snapshot.",
						},
					],
			actsEmpty: false,
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
			questions: roleContacts.slice(0, 8).map((c) => contactItem(c, model)),
			hasQuestions: model.contacts === null || roleContacts.length > 0,
			missingContacts: model.contacts === null,
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
		// The header floats inside the canvas. Keep every node and expanded panel below it.
		const measured = chrome?.getBoundingClientRect().height || 48;
		const topInset = Math.ceil(Math.min(600, Math.max(0, measured))) + 24;
		// roles-phone: below 1024 px one column replaces the ring, as tall as its items.
		stacked = narrow();
		const stackWidth = width || graph?.clientWidth || 360;
		const stackHeights = stacked ? measureStack() : [];
		const inner = ringLayout(
			model.roles.map((r) => ({ id: r.row.roleId, name: r.row.roleLabel })),
			width || graph?.clientWidth,
			Math.max(620, (height || graph?.clientHeight || 780) - topInset),
		);
		const layout = stacked
			? stackLayout(
					model.roles.map((r) => r.row.roleId),
					stackWidth,
					stackHeights,
					topInset,
				)
			: {
					...inner,
					height: inner.height + topInset,
					pos: new Map([...inner.pos].map(([id, [x, y]]) => [id, [x, y + topInset] as const])),
				};
		planned =
			chrome && graph && !height
				? {
						chrome: measured,
						height: layout.height,
						stack: stacked ? { width: stackWidth, heights: stackHeights } : null,
					}
				: null;
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
		// pages-live: "Updating" is calm (neutral) for up to LIVE_GRACE_MS; the red or amber state follows if no check comes.
		const updating = model.source === "updating";
		const palette = failed
			? { bg: "#221415", bd: "#5A2A2C", fg: "#FF8A80" }
			: stale || (unavailable && !loading && !updating)
				? { bg: "#1D1A12", bd: "#4D3F1F", fg: "#F0B95A" }
				: { bg: "#16181B", bd: "#2A2E34", fg: "#ECEDEE" };
		const receipt =
			model.receivedAt !== null
				? `last received ${exactClock(model.receivedAt)}${stale ? ` (${exactAge(model.receivedAt, model.now)} ago)` : ""}`
				: model.hasOverview
					? "receipt time unknown"
					: "nothing loaded yet";
		// roles-small-fixes N2: a connected feed whose asks can't be confirmed says why, in amber.
		const asksWhy = model.source === "connected-source-unverified" ? ASKS_UNCONFIRMED[needs.tell] : undefined;
		const freshText = unavailable
			? `${model.source === "connected-source-unverified" ? (asksWhy?.label ?? "Incomplete status") : source.label} · ${receipt}`
			: `Live · ${model.receivedAt !== null ? `updated ${exactClock(model.receivedAt)}` : receipt}`;
		// roles-retry-pill (owner 2026-10-18): the freshness banner never shows. Its reason moves into the
		// status pill's tooltip, and the pill does the banner's old Retry now / Refresh now in every state.
		const why = {
			title: source.title || "Some owner asks could not be confirmed",
			body:
				source.body ||
				asksWhy?.body ||
				"The received list may be incomplete. Open the original chats for anything not shown here.",
		};
		const date = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(model.now);
		const spending = model.roles.filter((r) => r.spend.reported);
		const budgetRole = spending.length === 1 ? spending[0] : null;
		const budget = budgetRole?.spend;
		return {
			// In the reference template this gates only the introductory helper/legend row.
			// The owner removed that row; data readiness and the graph are separate below.
			ready: false,
			floatingHeader: "true",
			headerSpace: `${topInset}px`,
			stacked: String(stacked),
			stackHeight: `${layout.height}px`,
			youTop: ringAnchor(layout, "you")?.py ?? "50%",
			loading,
			offline: model.source === "disconnected",
			lastKnown: model.lastReceived,
			isGlance: true,
			headingSummary:
				model.roster === "reported"
					? `${model.roles.length} departments${model.omitted ? " shown · some unavailable" : ""} · ${date}`
					: "Department list unavailable",
			fresh: {
				text: freshText,
				fg: unavailable ? palette.fg : "#9FD8B8",
				bd: unavailable ? palette.bd : "#2F4A3C",
				tip: unavailable ? `${why.title}\n${why.body}\nClick to retry` : "Click to refresh",
				label: `${freshText}. ${unavailable ? "Retry now" : "Refresh now"}`,
				retry: () => {
					if (!disposed) actions.reload();
				},
			},
			// ladder-alarm: an amber chip beside the pill only while the approval step is off; no banner, no row.
			approvalsOff: model.approvalsOff !== null,
			approvals: {
				text: APPROVALS_OFF_TEXT,
				tip: model.approvalsOff !== null ? approvalsTip(model.approvalsOff, model.now) : "",
			},
			// The supplied template keeps its banner markup, unused (the same hidden shape the reference fixture sends).
			banner: { show: false, bg: "", bd: "", fg: "", title: "", body: "", hasAction: false, action: "" },
			footerText: model.lastReceived
				? "Last received data · current state unconfirmed"
				: "Existing Roles feed · reported information",
			provenanceText: "Missing data is marked as not recorded.",
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
			setChromeEl: (el: Event | Element) => {
				if ("getBoundingClientRect" in el && chrome !== el) {
					chrome = el;
					changed();
				}
			},
			graph: {
				edges: [
					// roles-sent: drawn first, so the owner-ask arrows and their labels stay on top.
					// roles-phone: a column draws no arrows; they show on wider screens.
					...(stacked ? [] : roleEdges(model, layout, hover)).map(({ edge, pair }) => ({
						...edge,
						chipClick: (e: Event | Element) => openRole(pair.from, e),
					})),
					...(stacked ? [] : ownerEdges(model, layout, hover)).map((edge) => ({
						...edge,
						chipClick: (e: Event | Element) => expand({ kind: "you" }, e),
					})),
				],
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
			arrowMeaning:
				(stacked ? "Arrows are hidden on narrow screens and show on wider screens. " : "") +
				"Arrows point from a department to whoever it is waiting on: its open requests and questions to another department, until answered, and its asks waiting on you. Messages from you and messages being sent are not drawn. Key:",
			channelShown: false,
			contactChannelTitle: MISSING,
			contactChannelText: MISSING,
			youText,
			youBd: hover === "you" ? "#F0B95A" : "#6B5426",
			youOp: hover && hover !== "you" ? "0.38" : "1",
			youHoverOn: (e: Event | Element) => {
				if (quietFocusRestore || !acceptsHover(e)) return;
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
			qs: (model.contacts ?? []).slice(0, 12).map((c) => contactItem(c, model)),
			qsEmpty: !model.contacts?.length,
			emptyContactsText:
				model.contacts === null
					? "Contact and reply tracking are not connected yet."
					: "No messages from you to a role in the last 90 days.",
			contactsHeading: "Your messages",
			roleContactsHeading: "Your messages to",
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
						// roles-phone: in a column the panel is a full-width sheet over the viewport.
						t: stacked ? "0px" : `${topInset}px`,
						l: "0px",
						w: "100%",
						h: stacked ? "100%" : `${layout.height - topInset}px`,
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
			closeEx: (e: Event | Element) =>
				close(false, "type" in e && e.type === "click" && "detail" in e && e.detail === 0),
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
		/** roles-small-fixes: true when the last plan no longer fits the page (the header changed size while the
		 * values were applied, or the graph took another height), so the host plans again before paint. */
		refit: () =>
			!!planned &&
			!!chrome &&
			!!graph &&
			(Math.abs((chrome.getBoundingClientRect().height || 48) - planned.chrome) > 0.5 ||
				Math.abs(graph.clientHeight - planned.height) > 1 ||
				// roles-phone: the column took another width, or an item another height, than the plan used.
				(planned.stack !== null &&
					(Math.abs(graph.clientWidth - planned.stack.width) > 0.5 ||
						!sameHeights(measureStack(), planned.stack.heights)))),
		dispose: () => {
			disposed = true;
			clearAnimation();
			selected = null;
			planned = null;
			graph = null;
			chrome = null;
			origin = null;
		},
	};
}
