// initiatives-exact: the supplied Initiatives design's own renderVals() and state logic, ported to TypeScript
// (docs/initiatives-exact.md). It reads only InitiativesExactInput: no sample data, and an absent field shows
// the design's own empty or "Not recorded" wording. Its local state is the design's: selection, tab, filter,
// open outcomes and the done list. The 8 drawn states come from the input (page state, an initiative's
// oldSince, a step's "unproven" kind, askFailedAt), never from a drawn-state switch.
import type {
	InitiativesExactActivity,
	InitiativesExactAnswerTarget,
	InitiativesExactDecider,
	InitiativesExactHandoffKind,
	InitiativesExactInitiative,
	InitiativesExactInput,
	InitiativesExactRole,
	InitiativesExactStatus,
	InitiativesExactStep,
	InitiativesExactStepKind,
	InitiativesExactTab,
	InitiativesExactTarget,
} from "./initiatives-exact-model";
import type { SurfaceValue, SurfaceValues } from "./roles-u0/types";

/** The host's handlers. A control whose handler is absent isn't shown (`open` is always there). */
export interface InitiativesExactActions {
	open: (target: InitiativesExactTarget) => void;
	retry?: () => void;
	newInitiative?: () => void;
	changeLead?: (initiative: string) => void;
	messageLead?: (initiative: string) => void;
	resume?: (initiative: string) => void;
	markRead?: (initiative: string) => void;
	askDesign?: (initiative: string) => void;
	answer?: (target: InitiativesExactAnswerTarget, choice: string) => void;
	/** initiatives-page: the owner picked an initiative, or the "in no initiative" box (its detail's id). */
	select?: (id: string) => void;
}

type Filter = "all" | "you" | "attention" | "paused";
interface ViewState {
	sel: string | null;
	tab: InitiativesExactTab;
	tabPicked: boolean;
	filter: Filter;
	openGoals: Readonly<Record<string, boolean>>;
	doneOpen: boolean;
}

const NOT_RECORDED = "Not recorded";
const STAT: Record<InitiativesExactStatus, readonly [string, string, string, string]> = {
	moving: ["Moving", "#7DB8FF", "rgba(125,184,255,0.12)", "rgba(125,184,255,0.4)"],
	attention: ["Needs attention", "#FF8A80", "rgba(255,138,128,0.1)", "rgba(255,138,128,0.45)"],
	paused: ["Paused by you", "#C3C8CF", "rgba(195,200,207,0.08)", "rgba(195,200,207,0.3)"],
	unknown: ["Unknown", "#C7B8FF", "rgba(199,184,255,0.08)", "rgba(199,184,255,0.5)"],
};
const STEP: Record<InitiativesExactStepKind, readonly [string, string, string, string]> = {
	done: ["#9FD8B8", "rgba(159,216,184,0.1)", "rgba(159,216,184,0.4)", "solid"],
	active: ["#7DB8FF", "rgba(125,184,255,0.12)", "rgba(125,184,255,0.45)", "solid"],
	wait: ["#F0B95A", "rgba(240,185,90,0.1)", "rgba(240,185,90,0.45)", "solid"],
	failed: ["#FF8A80", "rgba(255,138,128,0.1)", "rgba(255,138,128,0.45)", "solid"],
	paused: ["#C3C8CF", "transparent", "rgba(195,200,207,0.35)", "solid"],
	pending: ["#8D939B", "transparent", "#3A3F46", "dashed"],
	unproven: ["#C7B8FF", "rgba(199,184,255,0.08)", "rgba(199,184,255,0.5)", "dashed"],
};
const HC: Record<InitiativesExactHandoffKind, string> = {
	wait: "#F0B95A",
	done: "#9FD8B8",
	active: "#7DB8FF",
	unknown: "#C7B8FF",
	paused: "#C3C8CF",
};
const GS: Record<InitiativesExactStepKind, string> = {
	done: "Done",
	active: "In progress",
	wait: "Waiting",
	failed: "Failed",
	paused: "Paused by you",
	pending: "Not started",
	unproven: "Not proven",
};
const VERDICT: Record<InitiativesExactDecider, readonly [string, string]> = {
	you: ["#9FD8B8", "rgba(159,216,184,0.45)"],
	lead: ["#CBBEFF", "rgba(185,167,255,0.45)"],
	role: ["#F0B95A", "rgba(240,185,90,0.45)"],
};
/** A decision with no recorded decider: the design's neutral grey. */
const VERDICT_UNKNOWN = ["#A9AEB6", "#3A3F46"] as const;
/** initiatives-page: a status that isn't a live state (the registry's): the state chip's Idle grey. */
const NEUTRAL = ["#A9AEB6", "transparent", "#3A3F46"] as const;
/** The state chip's Done colours. */
const DONE_CHIP = ["#9FD8B8", "rgba(159,216,184,0.1)", "rgba(159,216,184,0.4)"] as const;
const CK = {
	changed: ["Changed", "#9CC7FF", "rgba(125,184,255,0.16)"],
	added: ["Added", "#9FD8B8", "rgba(159,216,184,0.14)"],
	removed: ["Removed", "#FF8A80", "rgba(255,138,128,0.14)"],
} as const;
const ROW_PAD = "14px";
/** A child task row: the same row, indented 16 px. */
const CHILD_PAD = "14px 14px 14px 30px";

const mono = (name: string | undefined) => (name ? name.slice(0, 2).toUpperCase() : "—");
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const kindOf = <K extends string>(value: string | undefined, table: Record<K, unknown>, fallback: NoInfer<K>): K =>
	value !== undefined && Object.hasOwn(table, value) ? (value as K) : fallback;

interface Step {
	label: string;
	kind: InitiativesExactStepKind;
	at: string;
}
interface Outcome {
	title: string;
	owner: string;
	steps: Step[];
}
const step = (s: InitiativesExactStep): Step => ({
	label: s.label ?? NOT_RECORDED,
	kind: kindOf(s.kind, STEP, "pending"),
	at: s.at ?? "",
});
/** Done when every step is done; an outcome with no steps recorded isn't. */
const outcomeDone = (oc: Outcome) => oc.steps.length > 0 && oc.steps.every((s) => s.kind === "done");

function normalize(i: InitiativesExactInitiative) {
	const old = typeof i.oldSince === "string" && i.oldSince !== "";
	const role = (r: InitiativesExactRole, parent?: string) => ({
		name: r.name ?? parent ?? NOT_RECORDED,
		opens: r.opens ?? "",
		lead: !!r.lead && parent === undefined,
		part: r.part ?? "",
		task: r.task ?? "",
		taskTitle: r.taskTitle ?? (r.task ? "" : NOT_RECORDED),
		note: r.note ?? "",
		kind: kindOf(r.kind, KINDS, "unknown"),
		lastKnown: !!r.lastKnown || old,
		wait: r.wait ?? "",
		unblocks: r.unblocks ?? "",
		at: r.at ?? "",
		plain: r.statusLabel ?? "",
		plainDone: r.statusTone === "done",
	});
	const act = (a: InitiativesExactActivity) => [a.at ?? "", a.role ?? NOT_RECORDED, a.text ?? NOT_RECORDED] as const;
	const status = old ? ("unknown" as InitiativesExactStatus) : kindOf(i.status, STAT, "unknown");
	return {
		id: i.id,
		name: i.name ?? NOT_RECORDED,
		status,
		chip:
			!old && i.status === undefined && i.statusLabel !== undefined
				? ([i.statusLabel, ...NEUTRAL] as const)
				: STAT[status],
		leadName: i.lead ?? i.leadName ?? NOT_RECORDED,
		outcomeCount: i.outcomes === undefined ? i.outcomeCount : undefined,
		outcomesNote: i.outcomesNote ?? "",
		rowsNote: i.rowsNote ?? "",
		latest: i.latest?.map(act),
		latestNote: i.latestNote ?? "",
		handoffsNote: i.handoffsNote ?? "",
		gapsNote: i.gapsNote ?? "",
		activityNote: i.activityNote ?? "",
		rolesLine: i.rolesLine,
		members: i.members,
		canMessageLead: i.canMessageLead !== false,
		canChangeLead: i.canChangeLead !== false,
		statusNote: old ? `Old data · last confirmed ${i.oldSince}` : (i.statusNote ?? ""),
		lead: i.lead,
		goal: i.goal ?? NOT_RECORDED,
		started: i.started ?? NOT_RECORDED,
		finish: i.finish ?? "Not set by the lead",
		finishMissing: i.finish === undefined,
		pausedText: i.pausedText ?? "",
		roles: (i.roles ?? []).map((r) => ({
			...role(r),
			tasks: (r.tasks ?? []).map((t) => role(t, r.name ?? NOT_RECORDED)),
		})),
		outcomes: (i.outcomes ?? []).map((oc): Outcome => ({
			title: oc.title ?? NOT_RECORDED,
			owner: oc.owner ?? "",
			steps: (oc.steps ?? []).map(step),
		})),
		handoffs: (i.handoffs ?? []).map((h) => ({
			from: h.from ?? NOT_RECORDED,
			fromT: h.fromTask ?? "",
			to: h.to ?? NOT_RECORDED,
			toT: h.toTask ?? "",
			what: h.what ?? NOT_RECORDED,
			s: h.state ?? NOT_RECORDED,
			k: kindOf(h.kind, HC, "unknown"),
			named: [h.from, h.to].filter((n): n is string => !!n),
		})),
		gaps: i.gaps ?? [],
		onYou: (i.onYou ?? []).map((o) => ({
			id: o.id,
			kind: o.kind ?? "Question",
			from: o.from ?? NOT_RECORDED,
			age: o.age ?? "",
			title: o.title ?? NOT_RECORDED,
			context: o.context ?? "",
			choices: o.choices ?? [],
			answer: o.answer,
		})),
		design: i.design,
		askFailedAt: i.askFailedAt,
		leadNext: i.leadNext ?? NOT_RECORDED,
		leadReport: i.leadReport ?? "Not reported for this initiative.",
		leadReportAt: i.leadReportAt ?? "—",
		spend: (i.spend ?? []).map((p) => [p.role ?? NOT_RECORDED, p.value ?? "Not reported"] as const),
		spendTotal: i.spendTotal ?? "Not reported",
		spendNote: i.spendNote ?? "",
		decisions: i.decisions ?? [],
		decisionsTotal: i.decisionsTotal,
		decNote: i.decisionsNote,
		activity: (i.activity ?? []).map(act),
	};
}
const KINDS = {
	working: 1,
	waiting: 1,
	blocked: 1,
	onhold: 1,
	queued: 1,
	paused: 1,
	idle: 1,
	error: 1,
	unknown: 1,
	done: 1,
} as const;
type Initiative = ReturnType<typeof normalize>;

/** The view: `values()` is the template's values for the current input and the owner's clicks. */
export function createInitiativesExactView(
	read: () => InitiativesExactInput,
	actions: () => InitiativesExactActions,
	invalidate: () => void,
) {
	let st: ViewState = { sel: null, tab: "overview", tabPicked: false, filter: "all", openGoals: {}, doneOpen: false };
	let disposed = false;
	const setState = (patch: Partial<ViewState>) => {
		if (disposed) return;
		st = { ...st, ...patch };
		invalidate();
	};
	// Handlers look the host's callback up when clicked, so a changed prop is honoured without a stale closure.
	const call = <K extends keyof InitiativesExactActions>(
		name: K,
		...args: Parameters<NonNullable<InitiativesExactActions[K]>>
	) => {
		const f = actions()[name] as ((...a: typeof args) => void) | undefined;
		if (!disposed && typeof f === "function") f(...args);
	};
	const has = (name: keyof InitiativesExactActions) => typeof actions()[name] === "function";
	// Opens a card's detail, the box's, or (initiatives-page) a frame in the input's `details`.
	const pickId = (id: string) => {
		if (st.sel === id) return;
		setState({ sel: id });
		call("select", id);
	};

	function values(): SurfaceValues {
		const input = read();
		const page = input.page ?? {};
		const pageState = page.state ?? "live";
		const all = (input.initiatives ?? []).map(normalize);
		const looseDetail = input.loose?.detail ? normalize(input.loose.detail) : undefined;
		const details = (input.details ?? []).map(normalize);
		const tab: InitiativesExactTab = st.tabPicked ? st.tab : (input.tab ?? "overview");
		const filter = st.filter;
		const filtersNote = input.filtersNote;
		const openOnYou = (i: Initiative) => i.onYou.filter((o) => o.answer === undefined);
		const looseItems = input.loose?.items ?? [];
		const looseAsks = looseItems.filter((l) => l.onYou && l.answer === undefined).length;
		const totalOnYou = all.reduce((n, i) => n + openOnYou(i).length, 0) + looseAsks;
		const canAnswer = has("answer");

		const matches = (i: Initiative) =>
			filter === "all" ||
			(!filtersNote &&
				((filter === "you" && openOnYou(i).length > 0) ||
					(filter === "attention" && i.status === "attention") ||
					(filter === "paused" && i.status === "paused")));
		const FL: [Filter, string, number][] = [
			["all", "All", all.length],
			["you", "Needs you", all.filter((i) => openOnYou(i).length).length],
			["attention", "Needs attention", all.filter((i) => i.status === "attention").length],
			["paused", "Paused by you", all.filter((i) => i.status === "paused").length],
		];
		let filters: SurfaceValue[] = FL.map((f) => {
			const on = f[0] === filter;
			return {
				label: f[1],
				count: filtersNote && f[0] !== "all" ? "\u2014" : String(f[2]),
				pressed: on ? "true" : "false",
				bg: on ? "#ECEDEE" : "transparent",
				fg: on ? "#0E0F11" : "#C9CDD2",
				bd: on ? "#ECEDEE" : "#2F343A",
				countFg: on ? "#4A4F57" : "#8D939B",
				pick: () => setState({ filter: f[0] }),
			};
		});

		const selId = st.sel ?? input.selected ?? all[0]?.id;
		const looseOpen = !!looseDetail && selId === looseDetail.id;
		const frame = looseOpen ? undefined : details.find((d) => d.id === selId);
		const seg = (d: boolean, p: boolean) => ({
			bg: d ? "#9FD8B8" : p ? "transparent" : "rgba(125,184,255,0.18)",
			bd: d ? "#9FD8B8" : p ? "#4A4F57" : "rgba(125,184,255,0.45)",
			bs: p && !d ? "dashed" : "solid",
		});
		let list: SurfaceValue[] = all.filter(matches).map((i) => {
			const s = i.chip;
			const on = i.id === selId;
			const n = openOnYou(i).length;
			const nd = i.outcomes.filter(outcomeDone).length;
			const p = i.status === "paused";
			const count = i.outcomeCount;
			return {
				name: i.name,
				statusNote: i.statusNote,
				sText: s[0],
				sFg: s[1],
				leadName: i.leadName,
				leadMono: mono(i.lead),
				members: i.members
					? i.members.map((m) => ({ mono: mono(m) }))
					: i.roles.filter((r) => !r.lead).map((r) => ({ mono: mono(r.name) })),
				bg: on ? "#18162A" : "#141619",
				bd: on ? "#8B7CF6" : "#22262B",
				current: on ? "true" : "false",
				hasOnYou: n > 0,
				onYouText: "ON YOU · " + n,
				segs: count
					? Array.from({ length: count.total }, (_, k) => seg(k < count.done, p))
					: i.outcomes.map((oc) => seg(outcomeDone(oc), p)),
				doneText: count
					? count.total
						? count.done + " of " + count.total + " outcomes done"
						: "No outcomes recorded"
					: i.outcomes.length
						? nd + " of " + i.outcomes.length + " outcomes done"
						: "No outcomes recorded",
				pick: () => pickId(i.id),
			};
		});

		const I = (looseOpen ? looseDetail : (all.find((i) => i.id === selId) ?? frame)) ?? all[0];
		const sel = I ? detail(I, tab, openOnYou(I).length) : {};
		const dz = I
			? designValues(I)
			: { has: false, none: false, hasChanges: false, noChanges: false, changes: [], sections: [] };
		const dChanges = I?.design && !I.design.seen ? (I.design.changes ?? []) : [];
		const TB: [InitiativesExactTab, string, string][] = I
			? [
					["overview", "Overview", ""],
					["design", "Current design", dChanges.length ? dChanges.length + " new" : ""],
					["decisions", "Decisions", String(I.decisionsTotal ?? I.decisions.length)],
					["activity", "Activity", I.activityNote ? "\u2014" : String(I.activity.length)],
				]
			: [];
		const tabs = TB.map((t) => {
			const on = t[0] === tab;
			return {
				label: t[1],
				count: t[2],
				sel: on ? "true" : "false",
				fg: on ? "#ECEDEE" : "#A9AEB6",
				bd: on ? "#B9A7FF" : "transparent",
				pick: () => setState({ tab: t[0], tabPicked: true }),
			};
		});

		const note = input.summaryNote ? " " + input.summaryNote : "";
		let summary =
			input.summary ??
			(totalOnYou
				? totalOnYou + (totalOnYou === 1 ? " thing is" : " things are") + " waiting on you across initiatives." + note
				: "Nothing is waiting on you." + note);

		// The design's drawn states, from the page's state and the list (its drawn() step).
		const at = page.at;
		const date = page.date ? " · " + page.date : "";
		const ds = {
			countLine: plural(all.length, "initiative", "initiatives") + date,
			chipText: at ? "Live · updated " + at : "Live",
			chipFg: "#9FD8B8",
			chipBd: "rgba(159,216,184,0.4)",
			showNew: has("newInitiative"),
			showOnYou: true,
			showNav: true,
			showRoles: looseItems.length > 0,
			showDetail: !!I,
			showPanel: false,
			stale: false,
			oldData: false,
			failed: false,
			isError: false,
			hasBody: false,
			hasBody2: false,
			listEmptyText: filtersNote && filter !== "all" ? filtersNote : "Nothing matches this filter.",
			title: "",
			body: "",
			body2: "",
			alert: "",
			staleText: "",
			oldText: "",
			failText: "",
		};
		const counts = (c: string) => filters.map((f) => ({ ...(f as SurfaceValues), count: c }));
		const panel = (title: string, body?: string, body2?: string) => {
			ds.showDetail = false;
			ds.showPanel = true;
			ds.title = title;
			ds.body = body ?? "";
			ds.hasBody = !!body;
			ds.body2 = body2 ?? "";
			ds.hasBody2 = !!body2;
			list = [];
		};
		if (pageState === "loading") {
			panel(
				"Loading initiatives",
				"How many there are, what they’re doing and what’s waiting on you aren’t known yet.",
			);
			ds.countLine = "Loading…";
			ds.chipText = "Loading";
			ds.chipFg = "#A9AEB6";
			ds.chipBd = "#3A3F46";
			ds.showRoles = false;
			ds.listEmptyText = "Loading initiatives…";
			filters = counts("—");
			summary = "Not loaded yet. Anything waiting on you shows here once the page loads.";
		} else if (pageState === "error") {
			panel("Couldn’t load initiatives");
			ds.isError = true;
			ds.alert =
				"The server sent an error" +
				(at ? " at " + at : "") +
				". Nothing about initiatives is known until a load works: not how many there are, what they’re doing or what’s waiting on you.";
			ds.countLine = "Not loaded";
			ds.chipText = at ? "Couldn’t load · " + at : "Couldn’t load";
			ds.chipFg = "#FF8A80";
			ds.chipBd = "rgba(255,138,128,0.45)";
			ds.showRoles = false;
			ds.listEmptyText = "Couldn’t load the list.";
			filters = counts("—");
			summary = "Couldn’t load what’s waiting on you. That doesn’t mean nothing is.";
		} else if (pageState === "no-access") {
			panel(
				"You don’t have access to Initiatives",
				"This account isn’t allowed to see initiatives, so nothing about them is shown: not how many there are, who leads them or what’s waiting on you.",
				"If you should have access, ask for it to be turned on for this account.",
			);
			ds.countLine = "";
			ds.chipText = "No access";
			ds.chipFg = "#C3C8CF";
			ds.chipBd = "rgba(195,200,207,0.3)";
			ds.showNew = false;
			ds.showOnYou = false;
			ds.showNav = false;
			ds.showRoles = false;
			filters = [];
			summary = "";
		} else if (all.length === 0 && !looseOpen && !frame) {
			panel(
				"No initiatives yet",
				"The list was checked" + (at ? " at " + at : "") + " and is empty. This isn’t a loading or connection problem.",
				"When an initiative starts, it shows here with its lead, the roles on it and anything waiting on you.",
			);
			ds.listEmptyText = "No initiatives yet.";
			filters = counts("0").map((f, k) => (filtersNote && k > 0 ? { ...f, count: "\u2014" } : f));
			summary =
				input.summary ?? (looseAsks ? summary : "Nothing is waiting on you here: there are no initiatives yet.");
		}
		if (pageState === "stale" && all.length > 0) {
			ds.stale = true;
			ds.chipText = at ? "Out of date · updated " + at : "Out of date";
			ds.chipFg = "#F0B95A";
			ds.chipBd = "rgba(240,185,90,0.45)";
			ds.staleText = at
				? `Not live. This page last updated at ${at} and can’t reach the server now. Everything below is as of ${at} and may have changed since.`
				: "Not live. This page can’t reach the server now. Everything below may have changed since.";
			summary = (at ? "As of " + at + ": " : "") + summary;
		}
		const old =
			pageState === "live" || pageState === "stale" ? all.filter((i) => i.statusNote.startsWith("Old data")) : [];
		if (old.length) {
			ds.oldData = true;
			ds.oldText =
				old.length === 1
					? `Old data, not confirmed. ${old[0].name}’s records were last read ${initiativeOldSince(input, old[0].id)} and nothing has confirmed them since. Each status shows the last thing known; what was never recorded says Unknown, not zero or done.`
					: `Old data, not confirmed. These initiatives’ records haven’t been confirmed since they were last read: ${old.map((i) => `${i.name} (${initiativeOldSince(input, i.id)})`).join(", ")}. Each status shows the last thing known; what was never recorded says Unknown, not zero or done.`;
		}
		if (I?.askFailedAt && !I.design) {
			ds.failed = true;
			const lead = I.lead ?? "the lead";
			ds.failText = `Couldn’t send your request to ${lead} at ${I.askFailedAt}. Nothing was sent, so ${lead} hasn’t been asked. You can ask again.`;
		}
		const doneOpen = st.doneOpen;
		return {
			summary,
			showActivity: () => setState({ tab: "activity", tabPicked: true }),
			toggleDone: () => setState({ doneOpen: !st.doneOpen }),
			doneOpen,
			doneOpenStr: doneOpen ? "true" : "false",
			doneRot: doneOpen ? "rotate(90deg)" : "none",
			filters,
			list,
			listEmpty: list.length === 0,
			sel,
			tabs,
			dz,
			isDesign: tab === "design",
			isOverview: tab === "overview",
			isDecisions: tab === "decisions",
			isActivity: tab === "activity",
			ds,
			loose: {
				pick: () => {
					if (looseDetail) pickId(looseDetail.id);
				},
				current: looseOpen ? "true" : "false",
				bd: looseOpen ? "#8B7CF6" : "#3A3F46",
				bg: looseOpen ? "#18162A" : "transparent",
				heading: input.loose?.heading ?? "Roles in no initiative · " + looseItems.length,
				items: looseItems.map((l) => ({
					name: l.name ?? NOT_RECORDED,
					nameOpens: !!l.opens,
					nameStill: !l.opens,
					nameCurrent: !!l.opens && l.opens === selId ? "true" : "false",
					pickName: (e: Event | Element) => {
						// The item sits in the box, whose own click opens the box.
						if ("stopPropagation" in e) e.stopPropagation();
						if (l.opens) pickId(l.opens);
					},
					mono: l.mono ?? mono(l.name),
					note: l.note ?? "",
					hasNote: !!l.note,
					hasOnYou: !!l.onYou && l.answer === undefined,
					open: !!l.onYou && l.answer === undefined && canAnswer && (l.choices ?? []).length > 0,
					sent: l.answer !== undefined,
					answer: l.answer ?? "",
					choices: (l.choices ?? []).map((c) => ({
						label: c,
						pick: () => call("answer", { loose: l.id }, c),
					})),
				})),
			},
			newInitiative: () => call("newInitiative"),
			retry: () => call("retry"),
		};
	}

	function detail(I: Initiative, tab: InitiativesExactTab, openCount: number): SurfaceValues {
		const S = I.chip;
		const ndSel = I.outcomes.filter(outcomeDone).length;
		const rows: SurfaceValues[] = [];
		I.roles.forEach((r) => {
			const row = (x: Omit<typeof r, "tasks">, child: boolean) => ({
				name: x.name,
				nameOpens: x.opens !== "",
				nameStill: x.opens === "",
				nameCurrent: x.opens !== "" && x.opens === I.id ? "true" : "false",
				pickName: x.opens ? () => pickId(x.opens) : undefined,
				lead: x.lead,
				part: x.part,
				task: x.task,
				taskTitle: x.taskTitle,
				note: x.note,
				kind: x.kind,
				lastKnown: x.lastKnown,
				at: x.at,
				mono: mono(x.name),
				monoBg: x.lead ? "#241F38" : "#22262B",
				monoBd: x.lead ? "#B9A7FF" : "#22262B",
				monoFg: x.lead ? "#DCD3FF" : "#C9CDD2",
				bg: r.lead ? "#15131E" : "#121417",
				topBd: rows.length ? "#22262B" : "transparent",
				pad: child ? CHILD_PAD : ROW_PAD,
				hasWait: !!x.wait,
				wait: x.wait,
				hasUnblocks: !!x.unblocks,
				unblocks: x.unblocks,
				chip: !x.plain,
				plain: x.plain,
				plainFg: x.plainDone ? DONE_CHIP[0] : NEUTRAL[0],
				plainBg: x.plainDone ? DONE_CHIP[1] : NEUTRAL[1],
				plainBd: x.plainDone ? DONE_CHIP[2] : NEUTRAL[2],
			});
			rows.push(row(r, false));
			for (const t of r.tasks) rows.push(row(t, true));
		});
		const roleCount =
			I.rolesLine ??
			(I.roles.length === 0
				? NOT_RECORDED
				: plural(I.roles.length, "role", "roles") + (I.roles.length > 1 ? " · lead + " + (I.roles.length - 1) : ""));
		const canAnswer = has("answer");
		const outcomes = I.outcomes.map((oc) => ({
			title: oc.title,
			owner: oc.owner,
			steps: oc.steps.map((s, k) => {
				const m = STEP[s.kind];
				return {
					label: s.label,
					at: s.at,
					hasAt: !!s.at,
					notFirst: k > 0,
					fg: m[0],
					bg: m[1],
					bd: m[2],
					bs: m[3],
					atFg: s.kind === "pending" ? "#7F858D" : m[0],
					isDone: s.kind === "done",
					isActive: s.kind === "active",
					isWait: s.kind === "wait",
					isFailed: s.kind === "failed",
					isPaused: s.kind === "paused",
					isUnknown: s.kind === "unproven",
				};
			}),
		}));
		const line = (a: readonly [string, string, string], k: number) => ({
			at: a[0],
			role: a[1],
			text: a[2],
			roleFg: a[1] === "You" ? "#F0B95A" : a[1] === I.lead ? "#CBBEFF" : "#ECEDEE",
			topBd: k ? "#22262B" : "transparent",
		});
		const activity = I.activityNote ? [] : I.activity.map(line);
		const latest = I.latest ? I.latest.map(line) : activity.slice(0, 3);
		const named = (owner: string, name: string) => !!name && owner.indexOf(name) >= 0;
		const goals = I.outcomes.map((oc, k) => {
			const d = outcomeDone(oc);
			const cur = oc.steps.find((s) => s.kind !== "done");
			const started = oc.steps.some((s) => s.kind === "done");
			const kind: InitiativesExactStepKind | "next" = d
				? "done"
				: !cur
					? "pending"
					: cur.kind === "pending" && started
						? "next"
						: cur.kind;
			const m = kind === "next" ? STEP.pending : STEP[kind];
			const state = d
				? "Done · " + (oc.steps[oc.steps.length - 1].at || "")
				: !cur
					? NOT_RECORDED
					: kind === "next"
						? "Next: " + cur.label + (cur.at ? " · " + cur.at : "")
						: GS[kind] + ": " + cur.label + (cur.at ? " · " + cur.at : "");
			const gk = I.id + ":" + k;
			const open = !!st.openGoals[gk];
			const roles = I.roles
				.filter((r) => named(oc.owner, r.name) || (r.lead && oc.owner.indexOf("lead") >= 0))
				.map((r) => ({ name: r.name, kind: r.kind, now: (r.task ? r.task + " " : "") + r.taskTitle }));
			const hand = I.handoffs
				.filter((h) => h.named.some((n) => named(oc.owner, n)))
				.map((h) => ({
					from: h.from + (h.fromT ? " " + h.fromT : ""),
					to: h.to + (h.toT ? " " + h.toT : ""),
					what: h.what,
					s: h.s,
					c: HC[h.k],
				}));
			return {
				open,
				openStr: open ? "true" : "false",
				rot: open ? "rotate(90deg)" : "none",
				span: open ? "1 / -1" : "auto",
				owner: oc.owner,
				toggle: () => setState({ openGoals: { ...st.openGoals, [gk]: !st.openGoals[gk] } }),
				steps: oc.steps.map((s) => {
					const sm = STEP[s.kind];
					return {
						label: s.label,
						at: s.at || (s.kind === "pending" ? "not started" : ""),
						fg: sm[0],
						dot: s.kind === "done" ? sm[0] : "transparent",
						bs: s.kind === "pending" ? "dashed" : "solid",
						labelFg: s.kind === "pending" ? "#A9AEB6" : "#ECEDEE",
					};
				}),
				roles,
				noRoles: roles.length === 0,
				hand,
				hasHand: hand.length > 0,
				num: String(k + 1),
				title: oc.title,
				state,
				fg: kind === "next" ? "#A9AEB6" : m[0],
				bg: d ? "rgba(159,216,184,0.05)" : "#111316",
				bd: d ? "rgba(159,216,184,0.3)" : "#22262B",
				bs: "solid",
				dotBg: d ? "#9FD8B8" : "#111316",
				numFg: d ? "#0E0F11" : kind === "next" ? "#A9AEB6" : m[0],
				titleFg: d ? "#B9BEC5" : "#ECEDEE",
			};
		});
		const doneOutcomes = I.outcomes.filter(outcomeDone).map((oc) => ({
			title: oc.title,
			owner: oc.owner,
			finished: oc.steps[oc.steps.length - 1].at || "",
		}));
		const canChangeLead = has("changeLead") && I.canChangeLead;
		const canMessage = has("messageLead") && I.canMessageLead;
		return {
			name: I.name,
			goal: I.goal,
			statusNote: I.statusNote,
			sText: S[0],
			sFg: S[1],
			sBg: S[2],
			sBd: S[3],
			leadName: I.leadName,
			leadMono: mono(I.lead),
			roleCount,
			started: I.started,
			finish: I.finish,
			finishFg: I.finishMissing ? "#C7B8FF" : "#ECEDEE",
			spendTotal: I.spendTotal,
			spendNote: I.spendNote,
			isPaused: I.status === "paused",
			pausedText: I.pausedText,
			canResume: has("resume"),
			resume: () => call("resume", I.id),
			hasLeadActions: canChangeLead || canMessage,
			canMessage,
			messageLead: () => call("messageLead", I.id),
			canChangeLead,
			changeLead: () => call("changeLead", I.id),
			leadNext: I.leadNext,
			leadReport: I.leadReport,
			leadReportAt: I.leadReportAt,
			doneText: I.outcomeCount
				? I.outcomeCount.done + " of " + I.outcomeCount.total + " done"
				: ndSel + " of " + I.outcomes.length + " done",
			outcomesNote: I.outcomesNote,
			rowsNote: I.rowsNote,
			handoffsNote: I.handoffsNote,
			gapsNote: I.gapsNote,
			activityNote: I.activityNote,
			latestNote: latest.length === 0 ? I.latestNote : "",
			roles: rows,
			outcomes,
			openOutcomes: outcomes.filter((_, k) => !outcomeDone(I.outcomes[k])),
			doneOutcomes,
			hasDone: doneOutcomes.length > 0,
			doneCount: String(doneOutcomes.length),
			doneLatest: doneOutcomes.length ? "latest " + doneOutcomes[0].finished : "",
			goals,
			handoffs: (I.handoffsNote ? [] : I.handoffs).map((h) => ({
				from: h.from,
				fromT: h.fromT,
				to: h.to,
				toT: h.toT,
				what: h.what,
				s: h.s,
				c: HC[h.k],
			})),
			gaps: (I.gapsNote ? [] : I.gaps).map((t) => ({ t })),
			gapCount: I.gapsNote ? "\u2014" : String(I.gaps.length),
			spend: I.spend.map((p) => ({ role: p[0], v: p[1], fg: p[1] === "Not reported" ? "#C7B8FF" : "#ECEDEE" })),
			hasOnYou: I.onYou.length > 0,
			onYouCount: String(openCount),
			onYou: I.onYou.map((o) => {
				const sent = o.answer !== undefined;
				return {
					kind: o.kind,
					from: o.from,
					age: o.age,
					title: o.title,
					context: o.context,
					open: !sent && canAnswer && o.choices.length > 0,
					sent,
					answer: o.answer ?? "",
					choices: o.choices.map((c, k) => ({
						label: c,
						bg: k ? "transparent" : "#ECEDEE",
						fg: k ? "#ECEDEE" : "#0E0F11",
						bd: k ? "#4A4F57" : "#ECEDEE",
						pick: () => call("answer", { initiative: I.id, ask: o.id }, c),
					})),
				};
			}),
			decisions: I.decisions.map((d) => {
				const V = d.by && Object.hasOwn(VERDICT, d.by) ? VERDICT[d.by] : VERDICT_UNKNOWN;
				const options = d.options ?? "not given";
				const until = d.until ?? "not given";
				const miss = (x: string) => x === "not given";
				const ref = d.sourceRef;
				return {
					title: d.title ?? NOT_RECORDED,
					body: d.body ?? "",
					at: d.at ?? NOT_RECORDED,
					who: d.who ?? NOT_RECORDED,
					how: d.how ?? NOT_RECORDED,
					verdict: d.verdict ?? NOT_RECORDED,
					impact: d.impact ?? NOT_RECORDED,
					options,
					until,
					source: d.source ?? NOT_RECORDED,
					quote: d.quote ?? "",
					filed: d.filed ?? "",
					hasQuote: !!d.quote,
					hasFiled: !!d.filed,
					vFg: V[0],
					vBd: V[1],
					optFg: miss(options) ? "#8D939B" : "#ECEDEE",
					optStyle: miss(options) ? "italic" : "normal",
					untilFg: miss(until) ? "#8D939B" : "#ECEDEE",
					untilStyle: miss(until) ? "italic" : "normal",
					// The design's link is href="#": never let it scroll the frame; open only a recorded source.
					openSource: (e: Event | Element) => {
						if ("preventDefault" in e) e.preventDefault();
						if (ref) call("open", { kind: "source", initiative: I.id, ref });
					},
				};
			}),
			activity,
			activityCount: I.activityNote ? "\u2014" : String(I.activity.length),
			latest,
			decNote:
				I.decNote ??
				"Decisions taken inside this initiative: who made each one, how it was approved, and what it means for you.",
			tab,
		};
	}

	function designValues(I: Initiative): SurfaceValues {
		const DG = I.design;
		if (!DG)
			return {
				has: false,
				none: true,
				hasChanges: false,
				noChanges: false,
				changes: [],
				sections: [],
				canAsk: has("askDesign"),
				ask: () => call("askDesign", I.id),
			};
		const seen = !!DG.seen;
		const dChanges = seen ? [] : (DG.changes ?? []);
		return {
			has: true,
			none: false,
			version: DG.version ?? NOT_RECORDED,
			by: DG.by ?? NOT_RECORDED,
			updatedAt: DG.updatedAt ?? NOT_RECORDED,
			lastSeen: DG.lastSeen ?? "never",
			hasChanges: dChanges.length > 0,
			noChanges: dChanges.length === 0,
			changeCount: String(dChanges.length),
			changes: dChanges.map((c) => {
				const k = CK[kindOf(c.kind, CK, "changed")];
				return {
					label: k[0],
					fg: k[1],
					bg: k[2],
					text: c.text ?? NOT_RECORDED,
					hasDiff: !!c.before,
					before: c.before ?? "",
					after: c.after ?? "",
					why: c.why ?? "",
				};
			}),
			canMark: has("markRead"),
			markSeen: () => call("markRead", I.id),
			sections: (DG.sections ?? []).map((s, k) => ({
				h: s.heading ?? NOT_RECORDED,
				body: s.body ?? "",
				mark: s.mark === "new" ? "New" : "Changed",
				hasMark: !!s.mark && !seen,
				bg: s.mark && !seen ? "rgba(125,184,255,0.04)" : "transparent",
				topBd: k ? "#22262B" : "transparent",
			})),
		};
	}

	return {
		values,
		dispose: () => {
			disposed = true;
		},
	};
}

function initiativeOldSince(input: InitiativesExactInput, id: string): string {
	return input.initiatives?.find((i) => i.id === id)?.oldSince ?? NOT_RECORDED;
}
