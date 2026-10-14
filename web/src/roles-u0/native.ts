// Inert U0 native projection: the native Roles snapshot -> the exact design's
// template slots (SLOTS.txt). No app registration, network, resource loading,
// storage access, receipt mutation, simulation or production enable switch.
// Anything no producer records yet is shown as "Not recorded" / "Not reported"
// or Unknown; nothing is inferred from legacy status, screenshots or fixtures.
import type { UiRoleOverview, UiRoleTask } from "../../../server/protocol.js";
import { assertNativeFields, fieldDisplay, missingFields, type NativeFields, type NativeReadModel } from "./fields.js";
import { ringAnchor, ringLayout } from "./layout.js";
import type { SurfaceValues } from "./types.js";

export const NATIVE_RECEIPT_LABEL = "Processed in a settled turn";
export const NATIVE_CONTACT_LABEL = "Your contacts";
const NR = "Not recorded",
	NREP = "Not reported";
export interface NativeRoleInput {
	readonly role: UiRoleOverview;
	readonly metadata: NativeReadModel;
}
export interface NativeSnapshot {
	readonly namespace: "rtpi-native";
	readonly registryComplete: boolean;
	readonly checkedAt: string | null;
	readonly connection: "connected" | "disconnected" | "loading";
	readonly roles: readonly NativeRoleInput[];
}
export type NativeRoute = "home" | "queue" | "board" | "report" | "spend" | "about";
export const PRESERVED_ROUTES: readonly NativeRoute[] = Object.freeze([
	"home",
	"queue",
	"board",
	"report",
	"spend",
	"about",
]);
export interface NativeRoutes {
	// Host supplies its EXISTING authorized navigation. No fallback/new home.
	canOpen(roleId: string, route: NativeRoute): boolean;
	open(roleId: string, route: NativeRoute): void;
}
/** Timers come from the host so tests can drive the expand animation. */
export interface NativeClock {
	raf(fn: () => void): void;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}
const STATES = new Set(["working", "waiting", "blocked", "onhold", "queued", "paused", "idle", "error", "unknown"]);
const LANE_STATES = new Set(["working", "blocked", "queued", "onhold", "paused", "error", "unknown", "free"]);
const known = (f: NativeFields, id: keyof NativeFields): unknown => {
	const d = f[id];
	return d.state === "known" || d.state === "last-known" ? d.value : undefined;
};
const text = (f: NativeFields, id: keyof NativeFields): string => fieldDisplay(f[id]);

/** Legacy status='busy' is NOT an RTPI occupancy/origin/receipt. Only the new
 * field can supply an operational state; otherwise the source Unknown chip. */
export function nativeOperationalState(fields: NativeFields): string {
	const state = known(fields, "A05");
	return typeof state === "string" && STATES.has(state) ? state : "unknown";
}

// Design constants (colours and words), copied from the supplied source.
const BOX: Record<string, { bg: string; bd: string; fg: string; title: string }> = {
	waiting: { bg: "#1B1912", bd: "#4D3F1F", fg: "#F0B95A", title: "Why it’s waiting" },
	blocked: { bg: "#1B1912", bd: "#4D3F1F", fg: "#F0B95A", title: "What it’s blocked on" },
	queued: { bg: "#15181D", bd: "#34404F", fg: "#AFC4E2", title: "Why it hasn’t started (no action needed)" },
	onhold: { bg: "#121A19", bd: "#2E4744", fg: "#8FC7C0", title: "Why it’s on hold" },
	error: { bg: "#201415", bd: "#5A2A2C", fg: "#FF8A80", title: "What failed" },
	unknown: { bg: "#191724", bd: "#43396A", fg: "#C7B8FF", title: "Why the status is unknown" },
};
const LS: Record<string, { bg: string; bd: string; bs: string }> = {
	working: { bg: "#7DB8FF", bd: "#7DB8FF", bs: "solid" },
	blocked: { bg: "rgba(240,185,90,0.35)", bd: "#F0B95A", bs: "solid" },
	queued: { bg: "rgba(175,196,226,0.22)", bd: "#AFC4E2", bs: "solid" },
	onhold: { bg: "rgba(143,199,192,0.28)", bd: "#8FC7C0", bs: "solid" },
	paused: { bg: "#4A4F57", bd: "#6B7079", bs: "solid" },
	error: { bg: "#FF8A80", bd: "#FF8A80", bs: "solid" },
	unknown: { bg: "transparent", bd: "#C7B8FF", bs: "dashed" },
	free: { bg: "transparent", bd: "#4A4F57", bs: "solid" },
};
const LWORD: Record<string, string> = {
	working: "working",
	blocked: "blocked",
	queued: "queued",
	onhold: "on hold",
	paused: "paused by you",
	error: "failed",
	unknown: "unknown",
	free: "free",
};
// Source ORD has no "waiting"; it sorts with blocked here so the order is defined (register R-ORD).
const ORD: Record<string, number> = {
	working: 1,
	blocked: 2,
	waiting: 2,
	queued: 3,
	onhold: 4,
	error: 5,
	unknown: 6,
	paused: 7,
	idle: 8,
};
const FRESH = {
	live: { fg: "#9FD8B8", bd: "#2F4A3C" },
	disconnected: { fg: "#FF8A80", bd: "#5A2A2C" },
	loading: { fg: "#B9BEC5", bd: "#3A3F46" },
};
const TG: readonly [string, string, (t: UiRoleTask) => boolean][] = [
	["Running", "#7DB8FF", (t) => !t.paused && (t.status === "working" || t.status === "asking")],
	["Ready to start", "#D6D9DD", (t) => !t.paused && t.status === "ready"],
	[
		"Waiting on something",
		"#F0B95A",
		(t) => !t.paused && (t.status === "waiting" || t.status === "blocked" || t.status === "stuck"),
	],
	["Paused by you", "#B9BEC5", (t) => !!t.paused],
];
const tabBtn = (on: boolean, label: string, pick: () => void) => ({
	label,
	pressed: String(on),
	bg: on ? "#ECEDEE" : "transparent",
	fg: on ? "#0E0F11" : "#D6D9DD",
	bd: on ? "#ECEDEE" : "#3A3F46",
	pick,
});
const hhmmss = (iso: string): string => {
	const d = new Date(iso);
	const p = (n: number) => String(n).padStart(2, "0");
	return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
};

function lanes(f: NativeFields) {
	const v = known(f, "A06");
	if (!Array.isArray(v) || !v.length || !v.every((s) => typeof s === "string" && LANE_STATES.has(s)))
		return { lanes: [], lanesText: NR, lanesLabel: "Task lanes not recorded" };
	const ls = v as string[],
		n: Record<string, number> = {};
	ls.forEach((s) => {
		n[s] = (n[s] || 0) + 1;
	});
	const order = ["working", "blocked", "queued", "onhold", "paused", "error", "unknown", "free"].filter((k) => n[k]);
	return {
		lanes: ls.map((s) => LS[s]),
		lanesText: (n.working || 0) + "/" + ls.length + " working",
		lanesLabel: ls.length + " task lanes: " + order.map((k) => n[k] + " " + LWORD[k]).join(", "),
	};
}
function report(role: UiRoleOverview) {
	const r = role.report,
		when = r.date || NR;
	if (r.state === "report") {
		const sections = r.sections?.length
			? r.sections.map((s) => ({
					label: s.heading,
					fg: "#9CC7FF",
					items: s.text
						.split("\n")
						.filter(Boolean)
						.map((t) => ({ t })),
				}))
			: [
					{
						label: "Report",
						fg: "#9CC7FF",
						items: (r.text || "")
							.split("\n")
							.filter(Boolean)
							.map((t) => ({ t })),
					},
				];
		return { has: true, missing: false, when, summary: NR, sections, reason: "", last: "" };
	}
	const reason =
		r.state === "failed" || r.state === "unavailable"
			? r.error || NR
			: (
					{
						pending: "Not received yet.",
						"no-answer": "No answer was received.",
						first: "No report yet.",
						"not-active": "Reports are not active.",
						"not-in-job": "Not part of the report job.",
					} as Record<string, string>
				)[r.state] || NR;
	return { has: false, missing: true, when, summary: "", sections: [], reason, last: NR };
}
function spendText(role: UiRoleOverview): string {
	const s = role.spend;
	return s && (s.state === "ok" || s.state === "over" || s.state === "stale") ? s.spent + " of " + s.budget : NREP;
}

export function createNativeRolesView(
	read: () => NativeSnapshot,
	routes: NativeRoutes,
	clock: NativeClock,
	invalidate: () => void = () => {},
): {
	values: (width?: number, height?: number) => SurfaceValues;
	select: (roleId: string) => void;
	navigate: (route: NativeRoute) => boolean;
	fields: (roleId: string) => NativeFields;
} {
	const st: {
		hover: string | null;
		expanded: string | null;
		grown: boolean;
		settled: boolean;
		from: { t: number; l: number; w: number; h: number };
		wrapH: number;
		legend: boolean;
		rep: boolean;
		tab: "work" | "config";
	} = {
		hover: null,
		expanded: null,
		grown: false,
		settled: false,
		from: { t: 0, l: 0, w: 0, h: 0 },
		wrapH: 600,
		legend: false,
		rep: false,
		tab: "work",
	};
	let settleT: unknown = null,
		graphEl: Element | null = null;
	const set = (patch: Partial<typeof st>) => {
		Object.assign(st, patch);
		invalidate();
	};
	function snapshot(): NativeSnapshot {
		const s = read();
		if (
			s.namespace !== "rtpi-native" ||
			Object.keys(s).sort().join() !== "checkedAt,connection,namespace,registryComplete,roles"
		)
			throw new Error("U0 fixture/unsupported snapshot");
		if (!Array.isArray(s.roles) || s.roles.length > 200 || typeof s.registryComplete !== "boolean")
			throw new Error("U0 registry cap/completeness");
		if (!["connected", "disconnected", "loading"].includes(s.connection)) throw new Error("U0 connection");
		if (s.checkedAt !== null && (typeof s.checkedAt !== "string" || !Number.isFinite(Date.parse(s.checkedAt))))
			throw new Error("U0 checked-at");
		const ids = new Set<string>();
		for (const r of s.roles) {
			if (Object.keys(r).sort().join() !== "metadata,role") throw new Error("U0 role keys");
			if (!/^[a-z][a-z0-9-]{0,127}$/.test(r.role.id) || ids.has(r.role.id)) throw new Error("U0 registry identity");
			ids.add(r.role.id);
			assertNativeFields(r.metadata);
		}
		return s;
	}
	function fields(roleId: string): NativeFields {
		return snapshot().roles.find((x) => x.role.id === roleId)?.metadata.fields || missingFields();
	}
	function navigate(route: NativeRoute): boolean {
		if (!PRESERVED_ROUTES.includes(route) || !st.expanded) return false;
		const input = snapshot().roles.find((x) => x.role.id === st.expanded);
		if (!input || !routes.canOpen(input.role.id, route)) return false;
		if (route === "home" && !input.role.homeChat) return false;
		if (route === "queue" && !input.role.queue) return false;
		routes.open(input.role.id, route);
		return true;
	}
	const makeExpand = (id: string) => (e?: Event | Element) => {
		const el = (e && "currentTarget" in e ? e.currentTarget : e) as Element | null | undefined;
		const zero = { top: 0, left: 0, width: 0, height: 0 };
		const rc = el?.getBoundingClientRect ? el.getBoundingClientRect() : zero;
		const wrap = el?.closest ? el.closest("[data-boxgrid]") : null;
		const wr = wrap ? wrap.getBoundingClientRect() : rc;
		set({
			expanded: id,
			grown: false,
			wrapH: wr.height,
			from: { t: rc.top - wr.top, l: rc.left - wr.left, w: rc.width, h: rc.height },
		});
		clock.clearTimeout(settleT);
		clock.raf(() =>
			clock.raf(() => {
				set({ grown: true, settled: false });
				settleT = clock.setTimeout(() => set({ settled: true }), 380);
			}),
		);
	};
	const closeEx = () => {
		clock.clearTimeout(settleT);
		set({ grown: false, settled: false });
		clock.setTimeout(() => set({ expanded: null }), 350);
	};
	function select(roleId: string): void {
		if (snapshot().roles.some((x) => x.role.id === roleId)) makeExpand(roleId)();
	}

	function values(width?: number, height?: number): SurfaceValues {
		const s = snapshot();
		// The measured graph client size, as the source's measureGraph(); falsy -> source defaults.
		width = width || (graphEl ? Math.round(graphEl.clientWidth) : 0);
		height = height || (graphEl ? Math.round(graphEl.clientHeight) : 0);
		const loading = s.connection === "loading",
			ready = !loading,
			offline = s.connection === "disconnected",
			lastKnown = offline,
			dim = lastKnown ? "0.8" : "1";
		const lay = ringLayout(
			s.roles.map((x) => ({ id: x.role.id, name: x.role.title })),
			width,
			height,
		);
		const VW = lay.width,
			VH = lay.height,
			hov = st.hover;
		const boxes = ready
			? s.roles
					.map(({ role, metadata }) => {
						const f = metadata.fields,
							state = nativeOperationalState(f),
							b = BOX[state] || BOX.waiting,
							isHov = hov === role.id;
						const onYou = known(f, "A08") === true,
							lead = role.queue?.active[0];
						const g8 = known(f, "B08");
						const glance = typeof g8 === "string" ? g8 : lead ? "#" + lead.id + " " + lead.title : NR;
						const a = ringAnchor(lay, role.id) || { px: "50%", py: "50%" };
						const tasks = role.queue ? [...role.queue.active, ...role.queue.queued] : [];
						const instr = known(f, "C04"),
							model = known(f, "C05"),
							src = known(f, "B16"),
							prog = known(f, "B09");
						const inits = known(f, "B18");
						return {
							id: role.id,
							name: role.title,
							state,
							onYou,
							ownPaused: known(f, "A09") === true,
							hasRel: false,
							relText: "",
							...lanes(f),
							px: a.px,
							py: a.py,
							op: hov && !isHov ? "0.38" : dim,
							bdNow: isHov ? "#9CC7FF" : onYou ? "#6B5426" : "#2A2E34",
							hoverOn: () => {
								if (st.hover !== role.id) set({ hover: role.id });
							},
							expand: makeExpand(role.id),
							glance,
							modeLabel: role.workMode === "self-start" ? "Starts own work" : "Starts work when asked",
							taskId: lead ? "#" + lead.id : "",
							taskTitle: lead ? lead.title : "No current task",
							taskSrc: typeof src === "string" ? "· " + src : "· requester not recorded",
							progressText: typeof prog === "string" ? prog : NREP,
							progressAt: NR,
							nextShort: NR,
							mix: text(f, "B02"),
							updated: text(f, "A02"),
							outText: text(f, "B19"),
							reqInText: text(f, "B19"),
							hasBlocker: false,
							blocker: { waitingFor: "", resolver: "", check: "" },
							boxBg: b.bg,
							boxBd: b.bd,
							boxFg: b.fg,
							boxTitle: b.title,
							hasEvidence: false,
							ev: [],
							queueText: role.queue
								? role.queue.counts.active +
									" active · " +
									role.queue.counts.queued +
									" queued · " +
									role.queue.counts.done +
									" done"
								: NR,
							chatHref: "#u0-route:home",
							queueHref: "#u0-route:queue",
							instrLabel: typeof instr === "string" ? "Recorded" : NREP,
							instrFg: "#C7B8FF",
							instr: { text: typeof instr === "string" ? instr : NREP },
							model: typeof model === "string" ? model : NREP,
							purpose: role.focus || text(f, "C03"),
							respList: role.focus ? [{ t: role.focus }] : [],
							hasBudgetNote: false,
							budgetNote: "",
							taskGroups: TG.map(([label, fg, test]) => ({
								label,
								fg,
								items: tasks.filter(test).map((t) => ({
									id: "#" + t.id,
									title: t.title,
									hasDep: !!t.waitsOn,
									dep: t.waitsOn || "",
									srcText: NR,
								})),
							})).filter((gr) => gr.items.length),
							acts: [],
							actsEmpty: true,
							rep: report(role),
							inits: Array.isArray(inits)
								? inits
										.filter((x): x is string => typeof x === "string")
										.map((name) => ({ name, status: NR, fg: "#C7B8FF", goal: "", tasksText: NR }))
								: [],
							initEmpty: false,
							initCount: Array.isArray(inits)
								? inits.length + (inits.length === 1 ? " initiative" : " initiatives")
								: NR,
							spend: { own: spendText(role), req: NREP },
							decisions: [],
							hasDecisions: false,
							questions: [],
							hasQuestions: false,
						};
					})
					.sort((x, y) => ORD[x.state] - ORD[y.state] || Number(y.onYou) - Number(x.onYou))
			: [];
		const exIsYou = ready && st.expanded === "you";
		// As the source: the You panel reuses the first box as its frame.
		const exRaw = exIsYou ? boxes[0] || null : boxes.find((x) => x.id === st.expanded) || null;
		const ex = exRaw || boxes[0] || {};
		const fr = st.from;
		const exPos = st.grown
			? {
					t: "0px",
					l: "0px",
					w: "100%",
					h: st.wrapH + "px",
					o: "1",
					y: "0px",
					d: "150ms",
					ov: st.settled ? "auto" : "hidden",
				}
			: { t: fr.t + "px", l: fr.l + "px", w: fr.w + "px", h: fr.h + "px", o: "0", y: "8px", d: "0ms", ov: "hidden" };
		const coo = lay.pos.get("coo"),
			you = lay.pos.get("you") as readonly [number, number];
		const fresh = loading
			? { text: "Loading…", ...FRESH.loading }
			: offline
				? {
						text: "Disconnected · last known " + (s.checkedAt ? hhmmss(s.checkedAt).slice(0, 5) : NR),
						...FRESH.disconnected,
					}
				: { text: s.checkedAt ? "Snapshot checked " + hhmmss(s.checkedAt) : NR, ...FRESH.live };
		const banner = offline
			? {
					show: true,
					bg: "#221415",
					bd: "#5A2A2C",
					fg: "#FF8A80",
					title: "Disconnected from the Roles service",
					body: "Everything below is the last known state.",
					hasAction: false,
					action: "",
				}
			: loading
				? {
						show: true,
						bg: "#16181B",
						bd: "#2A2E34",
						fg: "#ECEDEE",
						title: "Loading role status",
						body: "Nothing is shown as Idle, Finished or All clear until each role’s status is confirmed.",
						hasAction: false,
						action: "",
					}
				: { show: false, bg: "", bd: "", fg: "", title: "", body: "", hasAction: false, action: "" };
		const spends = s.roles.filter((x) => x.role.spend && ["ok", "over", "stale"].includes(x.role.spend.state));
		const one = spends.length === 1 ? spends[0].role : null,
			sp = one?.spend as { spent: string; budget: string } | undefined;
		const amt = (v?: string) => {
			const n = v ? Number(v.replace(/[$,]/g, "")) : NaN;
			return Number.isFinite(n) ? n : NaN;
		};
		const ratio = sp ? amt(sp.spent) / amt(sp.budget) : NaN;
		return {
			ready,
			loading,
			offline,
			lastKnown,
			isGlance: true,
			fresh,
			banner,
			footerText: loading ? "Waiting for first update" : s.checkedAt ? "Snapshot checked " + hhmmss(s.checkedAt) : NR,
			headingSummary:
				(s.registryComplete ? s.roles.length + " departments" : "Department count not recorded") +
				" · " +
				(s.checkedAt ? new Date(s.checkedAt).toDateString().slice(0, 10) : NR),
			provenanceText: "Per-domain source coverage is shown on each figure",
			glance: { boxes },
			nodeW: lay.nodeW + "px",
			gw: VW,
			gh: VH,
			setGraphEl: (el: Event | Element) => {
				if (el && "getBoundingClientRect" in el && graphEl !== el) {
					graphEl = el;
					invalidate();
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
				if (st.hover) set({ hover: null });
			},
			legendOpen: st.legend,
			legendOpenStr: String(st.legend),
			legendLabel: st.legend ? "Hide legend" : "Legend",
			toggleLegend: () => set({ legend: !st.legend }),
			arrowMeaning: "Arrows = messages " + NATIVE_RECEIPT_LABEL.toLowerCase() + " are not drawn until recorded:",
			contactChannelTitle: "Contact channel not recorded",
			contactChannelText: NR,
			// The chip belongs on the You-COO edge; with no COO it has no place.
			channelShown: !!coo,
			tgX: coo ? ((you[0] + coo[0]) / 2 / VW) * 100 + "%" : "50%",
			tgY: coo ? ((you[1] + coo[1]) / 2 / VH) * 100 + "%" : "50%",
			tgOp: hov && hov !== "you" && hov !== "coo" ? "0.2" : "1",
			youText: NR,
			youBd: hov === "you" ? "#F0B95A" : "#6B5426",
			youOp: hov && hov !== "you" ? "0.38" : "1",
			youHoverOn: () => {
				if (st.hover !== "you") set({ hover: "you" });
			},
			youExpand: makeExpand("you"),
			inbox: [],
			inboxEmpty: true,
			emptyInboxText: NR,
			qs: [],
			qsEmpty: true,
			emptyContactsText: NR,
			contactsHeading: NATIVE_CONTACT_LABEL,
			roleContactsHeading: NATIVE_CONTACT_LABEL + " with",
			spendPeriodText: "Individual spending",
			spendRoleText: one ? one.title + " · own-initiative" : NREP,
			spendAmountText: sp ? sp.spent : NREP,
			spendBudgetText: sp ? "of " + sp.budget : NREP,
			spendAria:
				sp && one
					? one.title + " has used " + sp.spent + " of its " + sp.budget + " own-work budget"
					: "Spend not reported",
			spendBarWidth: Number.isFinite(ratio) ? Math.max(0, Math.min(100, Math.round(ratio * 100))) + "%" : "0%",
			spendBarColor: Number.isFinite(ratio) ? "#7DB8FF" : "transparent",
			spendNoteText: "Individual figures only; no total across departments. “" + NREP + "” never means $0.",
			exOpen: !!exRaw,
			ex,
			exPos,
			closeEx,
			exMinH: "0px",
			exIsYou,
			exIsDept: !!exRaw && !exIsYou,
			exLabel: exIsYou ? "Your decisions, questions and spending" : ((ex as { name?: string }).name || NR) + " details",
			repOpen: st.rep,
			repOpenStr: String(st.rep),
			repChev: st.rep ? "rotate(180deg)" : "none",
			toggleRep: () => set({ rep: !st.rep }),
			drTabs: [
				tabBtn(st.tab === "work", "Work progress", () => set({ tab: "work" })),
				tabBtn(st.tab === "config", "Configuration", () => set({ tab: "config" })),
			],
		};
	}
	return { values, select, navigate, fields };
}
