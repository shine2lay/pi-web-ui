/** Presentation controller for the supplied template. This is not a tracking producer.
 * Its only inputs are the same closed models already used by the live Roles page.
 * The view keeps the page's state (the hovered card, the open panel and its grow animation, its tab, the legend) and
 * plans the layout; each part's values come from its own module in roles-exact/.
 */
import type { ExactRoles } from "./roles-exact-model";
import { ringAnchor, ringLayout, stackLayout } from "./roles-u0/layout";
import type { SurfaceValues } from "./roles-u0/types";
import type { UsefulOpenTarget } from "./roles-useful-model";
import { ownerEdges, roleEdges } from "./roles-exact/arrows";
import { exactCardShifts } from "./roles-exact/card-layout";
import { departmentValues } from "./roles-exact/department";
import type { ExactViewActions, ExactViewClock } from "./roles-exact/host";
import { pageStatusValues } from "./roles-exact/page-status";
import type { ExactViewState } from "./roles-exact/view-state";
import { youPanelValues } from "./roles-exact/you-panel";

type Selection = { kind: "you" } | { kind: "role"; id: string } | null;

function acceptsHover(source: Event | Element): boolean {
	const el = "currentTarget" in source ? (source.currentTarget as Element | null) : source;
	if (!el) return false;
	// Restored mouse focus is not a hover. Keep the spotlight for visible keyboard focus.
	if ("type" in source && (source.type === "focus" || source.type === "focusin")) return el.matches(":focus-visible");
	return el.ownerDocument?.defaultView?.matchMedia?.("(hover: hover)").matches !== false;
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
	/** The hover spotlight on a card, or on the You pill ("you"); never from focus restored after a pointer close. */
	function spotlight(id: string, source: Event | Element) {
		if (quietFocusRestore || !acceptsHover(source)) return;
		hover = id;
		changed();
	}
	/** owner-contacts: opens a message's reply, or closes it when it is the open one. */
	function toggleContact(id: string) {
		openContact = openContact === id ? null : id;
		changed();
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
		// roles-budget-card: a card with a budget line grows away from a close neighbour (exactCardShifts).
		const shifts = stacked ? null : exactCardShifts(model, inner);
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
					pos: new Map([...inner.pos].map(([id, [x, y]]) => [id, [x, y + topInset + (shifts?.get(id) ?? 0)] as const])),
				};
		planned =
			chrome && graph && !height
				? {
						chrome: measured,
						height: layout.height,
						stack: stacked ? { width: stackWidth, heights: stackHeights } : null,
					}
				: null;
		const state: ExactViewState = {
			actions,
			read,
			disposed: () => disposed,
			hover,
			tab,
			openContact,
			toggleContact,
			spotlight,
			openRole,
			openYou: (e) => expand({ kind: "you" }, e),
		};
		const boxes: SurfaceValues[] = model.roles.map((r) => ({
			...departmentValues(r, model, state),
			...ringAnchor(layout, r.row.roleId),
		}));
		const you = youPanelValues(model, state);
		const selectedId = selected?.kind === "role" ? selected.id : null;
		const ex = selectedId ? boxes.find((b) => b.id === selectedId) : undefined;
		const exIsYou = selected?.kind === "you";
		return {
			// In the reference template this gates only the introductory helper/legend row.
			// The owner removed that row; data readiness and the graph are separate below.
			ready: false,
			floatingHeader: "true",
			headerSpace: `${topInset}px`,
			stacked: String(stacked),
			stackHeight: `${layout.height}px`,
			youTop: ringAnchor(layout, "you")?.py ?? "50%",
			...pageStatusValues(model, state),
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
			...you,
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
		/** Candidates only: the host may acknowledge them after successful DOM binding/refit.
		 * Automatic details exist only in the expanded role panel, never unopened cards. */
		usageRenderCandidates: () => {
			const role = selectedRole();
			const cost = role?.usageCost;
			return role && cost && !cost.stale && cost.value.generation
				? [{ role: role.row.roleId, generation: cost.value.generation }]
				: [];
		},
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
