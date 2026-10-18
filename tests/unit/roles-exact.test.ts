/// <reference types="vite/client" />
// @vitest-environment jsdom
// The real design's presentation-only adapter: fixed data, no chats, model requests,
// tracking producers or production fonts. Pixel checks use the separate reference recipe.
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectExactRoles, type ExactRoles } from "../../web/src/roles-exact-model.js";
import { createExactRolesView } from "../../web/src/roles-exact-view.js";
import { ringAnchor, ringLayout } from "../../web/src/roles-u0/layout.js";
import { bindRolesSurface } from "../../web/src/roles-u0/surface.js";
import type { SurfaceValue, SurfaceValues } from "../../web/src/roles-u0/types.js";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const HOME = "/home/test/.pi/agent/sessions/fixture/ops-home.jsonl";
const TASK = "/home/test/.pi/agent/sessions/fixture/task-7.jsonl";
type Row = Record<string, unknown>;
const task = (id: number, extra: Row = {}) => ({ id, title: `Task ${id}`, status: "working", ...extra });
const role = (extra: Row = {}) => ({
	id: "ops",
	title: "Ops",
	status: "busy",
	focus: "Keeps tools working",
	workMode: "request-only",
	workModeFrom: "rules",
	homeChat: { file: HOME, where: "home" },
	goals: [{ name: "Fewer stalls", scope: "Make waits clear", approvedAt: "2026-10-17" }],
	tldr: [{ id: "line-1", text: "Building the supplied design", ts: NOW - 60_000 }],
	report: { state: "report", date: "2026-10-17", sections: [{ heading: "Done", text: "One\nTwo" }] },
	requests: { open: 2 },
	queue: {
		running: true,
		active: [task(7, { chat: { file: TASK, where: 7 }, busy: true, latest: { text: "Wiring the page" } })],
		queued: [task(8, { status: "ready" })],
		counts: { active: 1, queued: 1, done: 3 },
	},
	...extra,
});
const state = (roles: unknown[] = [role()], asks: unknown[] = [], extra: Row = {}) => ({
	status: "ready",
	overview: { at: NOW, roles, asks, work: { initiatives: [], projects: [] } },
	checkedAt: NOW,
	heardAt: NOW,
	overviewReceivedAt: NOW,
	appliedAt: NOW,
	...extra,
});
const ask = (n: number, extra: Row = {}) => ({
	key: `ops:tldr:${n}`,
	role: "ops",
	kind: "tldr",
	text: `Question ${n}`,
	since: NOW - n * 60_000,
	chat: { file: HOME, where: "home" },
	...extra,
});
function object(value: SurfaceValue): SurfaceValues {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
	return value;
}
function list(value: SurfaceValue): SurfaceValue[] {
	if (!Array.isArray(value)) throw new Error("expected list");
	return value;
}
function invoke(value: SurfaceValue, source: Event | Element = document.body) {
	if (typeof value !== "function") throw new Error("expected callback");
	value(source);
}
const cleanups: (() => void)[] = [];
function fixture(initial: ExactRoles = projectExactRoles(state(), "open", NOW), mounted = false) {
	vi.useFakeTimers();
	let model = initial;
	let surface: ReturnType<typeof bindRolesSurface> | null = null;
	const actions = { open: vi.fn(), about: vi.fn(), answer: vi.fn(), reload: vi.fn() };
	const view = createExactRolesView(
		() => model,
		actions,
		{
			raf: (fn) => setTimeout(fn, 0),
			cancelRaf: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
			setTimeout: (fn, ms) => setTimeout(fn, ms),
			clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
		},
		() => surface?.update(),
	);
	if (mounted) surface = bindRolesSurface(document, () => view.values(1400, 780));
	cleanups.push(() => {
		surface?.dispose();
		view.dispose();
	});
	return {
		view,
		actions,
		update: (next: ExactRoles) => {
			model = next;
			surface?.update();
		},
	};
}
afterEach(() => {
	for (const clean of cleanups.splice(0)) clean();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

describe("the supplied Roles design with the existing feed", () => {
	it("uses the supplied ring geometry and a closed presentation, not a native receipt", () => {
		const model = projectExactRoles(state(), "open", NOW);
		const { view } = fixture(model);
		const values = view.values(1400, 780);
		const boxes = list(object(values.glance).boxes);
		expect(boxes).toHaveLength(1);
		const base = ringLayout([{ id: "ops", name: "Ops" }], 1400, 708);
		const floating = {
			...base,
			height: 780,
			pos: new Map([...base.pos].map(([id, [x, y]]) => [id, [x, y + 72] as const])),
		};
		expect(object(boxes[0])).toMatchObject({
			id: "ops",
			name: "Ops",
			state: "working",
			...ringAnchor(floating, "ops"),
		});
		expect(object(values.fresh).text).toBe("Live · updated 12:00");
		expect(values.headingSummary).toBe("1 departments · Oct 17");
		expect(object(values.graph).edges).toEqual([]);
		expect(object(boxes[0]).lanes).toEqual([]);
		expect(values.spendAmountText).toBe("Not recorded");
		expect(values).not.toHaveProperty("namespace");
	});

	it.each([48, 122, 205])("keeps nodes, You and panels below a %ipx floating header", (headerHeight) => {
		const { view } = fixture();
		const chrome = document.createElement("div");
		chrome.getBoundingClientRect = () => ({ height: headerHeight }) as DOMRect;
		invoke(view.values().setChromeEl, chrome);
		const values = view.values(1400, 900);
		const inset = headerHeight + 24;
		expect(values.floatingHeader).toBe("true");
		expect(values.headerSpace).toBe(`${inset}px`);
		const base = ringLayout([{ id: "ops", name: "Ops" }], 1400, 900 - inset);
		const you = base.pos.get("you")!;
		expect(Number.parseFloat(String(values.youTop))).toBeCloseTo(((you[1] + inset) / 900) * 100);
		for (const item of list(object(values.glance).boxes)) {
			expect((Number.parseFloat(String(object(item).py)) / 100) * 900).toBeGreaterThan(inset);
		}
		view.openRole("ops");
		vi.runAllTimers();
		expect(object(view.values(1400, 900).exPos)).toMatchObject({ t: `${inset}px`, h: `${900 - inset}px` });
	});

	it("omits the helper row through updates without hiding real ON YOU markers or panels", () => {
		const input = state([role()], [ask(1)]);
		const { view, update } = fixture(projectExactRoles(input, "open", NOW), true);
		const noHelper = () => {
			expect(document.body.textContent).not.toContain("the next step is yours");
			expect(document.body.textContent).not.toContain("Hover a label to read messages");
			expect(
				[...document.querySelectorAll("button")].some((el) => /^(Hide )?Legend$/i.test(el.textContent ?? "")),
			).toBe(false);
			expect(document.querySelector("[data-boxgrid]")).not.toBeNull();
		};
		noHelper();
		const ops = [...document.querySelectorAll('button[aria-haspopup="dialog"]')].find((button) =>
			button.textContent?.trim().startsWith("Ops"),
		);
		expect(ops).toBeDefined();
		expect(ops?.parentElement?.textContent).toContain("ON YOU");
		update(projectExactRoles(input, "closed", NOW));
		noHelper();
		update(projectExactRoles(input, "open", NOW));
		noHelper();
		view.openRole("ops", document.body);
		vi.runAllTimers();
		expect(document.querySelector('[role="region"]')?.textContent).toContain("Task 7");
	});

	it("roles-lanes: draws the queue's lanes on the card and in the panel", () => {
		const input = role({
			queue: { ...(role().queue as Row), lanes: { atOnce: 3, inUse: 2 } },
		});
		const { view } = fixture(projectExactRoles(state([input]), "open", NOW), true);
		const box = object(list(object(view.values(1400, 780).glance).boxes)[0]);
		expect(list(box.lanes).map((l) => object(l).bg)).toEqual(["#7DB8FF", "#7DB8FF", "transparent"]);
		expect(box.lanesText).toBe("2 of 3 lanes in use");
		const pills = document.querySelector('[role="img"][aria-label="2 of 3 lanes in use"]');
		expect(pills?.textContent).toContain("2 of 3 lanes in use");
		view.openRole("ops", document.body);
		vi.runAllTimers();
		expect(object(view.values().ex).lanesLabel).toBe("2 of 3 lanes in use");
		expect(document.querySelector('[role="region"]')?.textContent).toContain("Task lanes2 of 3 lanes in use");
	});

	it("roles-model: the panel's Model line names the home chat's model, else Not recorded", () => {
		const named = fixture(projectExactRoles(state([role({ model: "Claude Opus 4.5" })]), "open", NOW), true);
		named.view.openRole("ops", document.body);
		vi.runAllTimers();
		expect(object(named.view.values().ex).model).toBe("Claude Opus 4.5");
		expect(document.querySelector('[role="region"]')?.textContent).toContain("Model: Claude Opus 4.5");
		for (const bad of [undefined, "", "a\u0007b", 42]) {
			const { view } = fixture(projectExactRoles(state([role({ model: bad })]), "open", NOW));
			view.openRole("ops");
			expect(object(view.values().ex).model).toBe("Not recorded");
		}
	});

	it("mounts the actual supplied template and opens the complete department panel", () => {
		const { view } = fixture(undefined, true);
		expect(document.querySelector("h1")?.textContent).toBe("Roles");
		expect(document.querySelector("[data-boxgrid]")).not.toBeNull();
		view.openRole("ops", document.body);
		vi.runAllTimers();
		const panel = document.querySelector('[role="region"]');
		expect(panel?.textContent).toContain("Task 7");
		expect(panel?.textContent).not.toContain("6 am report");
		for (const title of [
			"Now",
			"Task queue",
			"Own initiatives",
			"Requests",
			"Spending this week",
			"Recent activity",
			"About",
		])
			expect(panel?.textContent).toContain(title);
		expect(panel?.textContent).toContain("Goal: Fewer stalls");
		expect(panel?.textContent).toContain("Wiring the page");
		expect(object(object(view.values().ex).spend)).toEqual({ own: "Not recorded", req: "Not recorded" });
	});

	it("does not expose chat paths or unprojected data in text, attributes or markup", () => {
		fixture(
			projectExactRoles(state([role({ secret: "DO_NOT_RENDER", loadedModel: "DO_NOT_RENDER" })]), "open", NOW),
			true,
		).view.openRole("ops", document.body);
		vi.runAllTimers();
		const html = document.documentElement.outerHTML;
		for (const forbidden of [HOME, TASK, "DO_NOT_RENDER"]) expect(html).not.toContain(forbidden);
	});

	it("renders plain text, never data-supplied HTML; unsafe characters reject the whole title", () => {
		const unsafeTask = task(7, { title: "BAD\u202eTITLE", chat: { file: TASK } });
		const r = role({ focus: "<img src=x onerror=evil()>", queue: { ...role().queue, active: [unsafeTask] } });
		const { view } = fixture(projectExactRoles(state([r]), "open", NOW), true);
		view.openRole("ops", document.body);
		vi.runAllTimers();
		expect(document.body.textContent).toContain("<img src=x onerror=evil()>");
		expect(document.querySelector("img")).toBeNull();
		expect(document.body.textContent).not.toContain("BAD");
	});

	it.each([
		["error", "open", { status: "error", problem: "read failed" }],
		["disconnected", "closed", {}],
		["stale", "open", { heardAt: NOW - 180_000, checkedAt: NOW - 180_000 }],
	] as const)("does not show a current all-clear for %s", (_label, connection, extra) => {
		const { view } = fixture(projectExactRoles(state([role()], [], extra), connection, NOW));
		const v = view.values();
		expect(object(v.banner).show).toBe(true);
		expect(v.emptyInboxText).toContain("could not be confirmed");
		expect(v.youText).toBe("Current asks unknown");
		expect(v.lastKnown).toBe(true);
	});

	it("has a scoped empty inbox only after a current checked snapshot", () => {
		const { view } = fixture(projectExactRoles(state(), "open", NOW));
		expect(view.values().emptyInboxText).toMatch(/^No owner asks reported at /);
	});

	it("keeps unreadable and over-limit asks counted, with only original-chat navigation", () => {
		const asks = Array.from({ length: 53 }, (_, n) => ask(n, n === 1 ? { text: "unsafe\u202etext" } : {}));
		const { view, actions } = fixture(projectExactRoles(state([role()], asks), "open", NOW));
		const v = view.values();
		expect(v.youText).toBe("53 waiting on you");
		const inbox = list(v.inbox).map(object);
		expect(inbox).toHaveLength(51);
		expect(inbox.at(-1)?.title).toBe("3 more reported asks are not shown here");
		expect(inbox.some((item) => item.title === "Open the original item to read it")).toBe(true);
		const choice = object(list(inbox[0].choices)[0]);
		expect(choice.label).toBe("Open chat");
		invoke(choice.pick);
		expect(actions.open).toHaveBeenCalledWith(expect.objectContaining({ file: HOME }));
	});

	it("offers Answer in the exact design without replacing Open chat or exposing the target", () => {
		const entry = ask(1, {
			key: "ops:question:q1",
			kind: "question",
			focus: "question:q1",
			askId: "ask-1",
		});
		const { view, actions } = fixture(projectExactRoles(state([role()], [entry]), "open", NOW), true);
		invoke(view.values().youExpand);
		vi.runAllTimers();
		const choices = list(object(list(view.values().inbox)[0]).choices).map(object);
		expect(choices.map((c) => c.label)).toEqual(["Answer", "Open chat"]);
		expect(actions.answer).not.toHaveBeenCalled();
		invoke(choices[0].pick);
		expect(actions.answer).toHaveBeenCalledWith(
			expect.objectContaining({ answer: { key: entry.key, id: "ask-1" } }),
			document.body,
		);
		for (const hidden of [entry.key, "ask-1", HOME]) expect(document.documentElement.outerHTML).not.toContain(hidden);
		invoke(choices[1].pick);
		expect(actions.open).toHaveBeenCalledWith(expect.objectContaining({ file: HOME }));
	});

	it.each(["closed", "changed", "unconfirmed"])("a retained Answer callback refuses a %s item", (mode) => {
		const entry = ask(1, {
			key: "ops:question:q1",
			kind: "question",
			focus: "question:q1",
			askId: "ask-1",
		});
		const { view, actions, update } = fixture(projectExactRoles(state([role()], [entry]), "open", NOW));
		const choices = list(object(list(view.values().inbox)[0]).choices).map(object);
		expect(choices.map((c) => c.label)).toEqual(["Answer", "Open chat"]);
		const pick = choices[0].pick;
		update(
			projectExactRoles(
				state(
					[role()],
					[{ ...entry, askId: mode === "changed" ? "ask-2" : "ask-1" }],
					mode === "unconfirmed" ? { appliedAt: null } : {},
				),
				mode === "closed" ? "closed" : "open",
				NOW,
			),
		);
		invoke(pick);
		expect(actions.answer).not.toHaveBeenCalled();
		if (mode !== "changed")
			expect(list(object(list(view.values().inbox)[0]).choices).map((c) => object(c).label)).toEqual(["Open chat"]);
	});

	it("associates panel questions by validated role id, not identical display names", () => {
		const roles = [role(), role({ id: "frontend", title: "Ops" })];
		const asks = [
			ask(1),
			ask(2, { role: "frontend", text: "Other department's question" }),
			ask(3, { role: "missing" }),
		];
		const { view } = fixture(projectExactRoles(state(roles, asks), "open", NOW));
		view.openRole("ops");
		const decisions = list(object(view.values().ex).decisions).map(object);
		expect(decisions.map((item) => item.title)).toEqual(["Question 1"]);
		expect(list(view.values().inbox)).toHaveLength(3);
	});

	it("the full-queue link goes to the role's home queue, not the first task's chat", () => {
		const { view, actions } = fixture();
		view.openRole("ops");
		expect(view.navigate("queue")).toBe(true);
		expect(actions.open).toHaveBeenCalledWith({ file: HOME, focus: { kind: "task", id: "7" } });
		expect(view.navigate("home")).toBe(true);
		expect(actions.open).toHaveBeenLastCalledWith({ file: HOME });
		expect(view.navigate("made-up")).toBe(false);
	});

	it("no home or known task means no fabricated navigation target", () => {
		const { view, actions } = fixture(
			projectExactRoles(
				state([role({ homeChat: null, queue: { active: [], queued: [], counts: { active: 0, queued: 0, done: 0 } } })]),
				"open",
				NOW,
			),
		);
		view.openRole("ops");
		expect(view.canNavigate("home")).toBe(false);
		expect(view.canNavigate("queue")).toBe(false);
		expect(view.navigate("queue")).toBe(false);
		expect(actions.open).not.toHaveBeenCalled();
	});

	it("does not preserve a selected role that disappears during expansion", () => {
		const { view, update, actions } = fixture();
		view.openRole("ops");
		update(projectExactRoles(state([], []), "open", NOW));
		expect(view.values().exOpen).toBe(false);
		vi.runAllTimers();
		expect(view.isOpen()).toBe(false);
		expect(view.navigate("home")).toBe(false);
		expect(actions.open).not.toHaveBeenCalled();
	});

	it("close and disposal cancel animation callbacks and forbid later navigation", () => {
		const { view, actions } = fixture();
		view.openRole("ops");
		view.close(true);
		vi.runAllTimers();
		expect(view.values().exOpen).toBe(false);
		view.openRole("ops");
		view.dispose();
		vi.runAllTimers();
		expect(view.isOpen()).toBe(false);
		expect(view.navigate("home")).toBe(false);
		expect(actions.open).not.toHaveBeenCalled();
	});

	it("switches activity presentation without exposing the retired daily report", () => {
		const { view } = fixture();
		view.openRole("ops");
		let v = view.values();
		expect(object(v.ex).rep).toBeUndefined();
		expect(v.toggleRep).toBeUndefined();
		invoke(object(list(v.drTabs)[1]).pick);
		v = view.values();
		expect(object(list(object(v.ex).acts)[0]).text).toBe("Settings history is not recorded yet.");
	});

	it.each([
		["error", "open", { status: "error" }, "#FF8A80", "Retry now"],
		["disconnected", "closed", {}, "#FF8A80", "Retry now"],
		["stale", "open", { heardAt: NOW - 180_000 }, "#F0B95A", "Refresh now"],
	] as const)("preserves the %s warning palette, receipt time and action", (_name, connection, extra, fg, action) => {
		const { view, actions } = fixture(projectExactRoles(state([role()], [], extra), connection, NOW));
		const v = view.values();
		expect(object(v.banner)).toMatchObject({ show: true, fg, hasAction: true, action });
		expect(object(v.fresh)).toMatchObject({ fg });
		expect(object(v.fresh).text).toContain("last received");
		invoke(object(v.banner).retry);
		expect(actions.reload).toHaveBeenCalledTimes(1);
	});

	it("uses the displayed overview's receipt rather than a later transport or server timestamp", () => {
		const { view } = fixture(
			projectExactRoles(state([role()], [], { overviewReceivedAt: NOW - 300_000 }), "closed", NOW),
		);
		expect(object(view.values().fresh).text).toBe("Disconnected · last received 11:55");
	});

	it("says nothing loaded yet on the first failure even if a transport timestamp exists", () => {
		const model = projectExactRoles(state([], [], { status: "error", overview: null }), "open", NOW);
		expect(model.hasOverview).toBe(false);
		expect(model.receivedAt).toBeNull();
		const { view } = fixture(model);
		expect(object(view.values().fresh).text).toBe("Unavailable · nothing loaded yet");
	});

	it.each([undefined, null, "now", NaN, Infinity, -1, 1.5, NOW + 1_000_000])(
		"does not invent an overview receipt for a missing or invalid value (%s)",
		(overviewReceivedAt) => {
			const model = projectExactRoles(state([role()], [], { overviewReceivedAt }), "closed", NOW);
			expect(model.hasOverview).toBe(true);
			expect(model.receivedAt).toBeNull();
			const { view } = fixture(model);
			expect(object(view.values().fresh).text).toBe("Disconnected · receipt time unknown");
		},
	);

	it("gives an explicit uncertainty reason rather than a green connected banner", () => {
		const { view } = fixture(projectExactRoles(state([role()], [], { appliedAt: null }), "open", NOW));
		expect(object(view.values().banner)).toMatchObject({ show: true, title: "Some owner asks could not be confirmed" });
		expect(object(view.values().fresh).fg).toBe("#F0B95A");
		expect(view.values().emptyInboxText).toContain("could not be confirmed");
	});

	// roles-small-fixes N2: connected, but the asks can't be confirmed: an amber label naming the reason.
	it.each([
		["awaiting", state([role()], [], { appliedAt: null }), "still checking"],
		["partial", { ...state(), overview: { ...state().overview, asks: undefined } }, "some roles not read"],
		[
			"decision",
			state([
				role({ queue: { ...role().queue, active: [task(7, { status: "stuck", chat: { file: TASK, where: 7 } })] } }),
			]),
			"a stuck task\u2019s question is missing",
		],
	] as const)("says why %s asks can't be confirmed, never a green label", (tell, input, reason) => {
		const model = projectExactRoles(input, "open", NOW);
		expect(model.source).toBe("connected-source-unverified");
		expect(model.needs.tell).toBe(tell);
		const v = fixture(model).view.values();
		expect(object(v.fresh).text).toBe(`Asks unconfirmed: ${reason} \u00b7 last received 12:00`);
		expect(object(v.fresh)).toMatchObject({ fg: "#F0B95A", bd: "#4D3F1F" });
		expect(object(v.banner)).toMatchObject({ show: true, title: "Some owner asks could not be confirmed" });
		expect(String(object(v.banner).body)).not.toContain("may be incomplete");
	});

	it("draws only known current owner-ask lines and does not invent message kinds", () => {
		const rows = [role(), role({ id: "design", title: "Design" })];
		const { view, update } = fixture(projectExactRoles(state(rows, [ask(1)]), "open", NOW));
		const edges = list(object(view.values().graph).edges).map(object);
		expect(edges).toHaveLength(1);
		expect(edges[0]).toMatchObject({ chip: "Waiting on you", aria: "Ops: waiting on you", stroke: "#B08433" });
		expect(edges[0].d).toMatch(/^M[\d. -]+ Q[\d. -]+$/);
		invoke(edges[0].chipClick);
		expect(view.values().exIsYou).toBe(true);
		update(projectExactRoles(state(rows, [ask(1)]), "closed", NOW));
		expect(list(object(view.values().graph).edges)).toHaveLength(0);
	});

	it("roles-sent: one arrow per open pair, pointing at the receiver, with the sent line and who it waits on", () => {
		const H = 3 * 60 * 60_000;
		const sent = {
			open: 3,
			newest: { id: "rm-9", to: "temper", kind: "request", firstLine: "Check the gate", at: NOW - H },
		};
		const rows = [
			role({ sent }),
			role({ id: "design", title: "Design", sent: { open: 0 } }),
			role({ id: "temper", title: "Temper", sent: { open: 1 } }),
		];
		const openPairs = [
			{ from: "ops", to: "design", count: 1, at: NOW - 2 * H },
			{ from: "ops", to: "temper", count: 2, at: NOW - H },
			{ from: "temper", to: "ops", count: 1, at: NOW - 60_000 },
			// dropped: to itself, a role not shown, a repeat, no count
			{ from: "ops", to: "ops", count: 1, at: NOW },
			{ from: "ops", to: "ghost", count: 1, at: NOW },
			{ from: "ops", to: "temper", count: 9, at: NOW },
			{ from: "design", to: "temper", count: 0, at: NOW },
		];
		const withPairs = (o: Row) => ({ ...o, overview: { ...(o.overview as Row), openPairs } });
		const before = fixture(projectExactRoles(state(rows, [ask(1)]), "open", NOW));
		const ownerBefore = JSON.stringify(list(object(before.view.values(1400, 780).graph).edges));
		const { view } = fixture(projectExactRoles(withPairs(state(rows, [ask(1)])), "open", NOW));
		const values = view.values(1400, 780);
		const edges = list(object(values.graph).edges).map(object);
		expect(edges).toHaveLength(4);
		// the owner-ask arrow is unchanged and stays last (on top)
		expect(JSON.stringify([edges[3]])).toBe(ownerBefore);
		const dept = edges.slice(0, 3);
		expect(dept.map((e) => e.aria)).toEqual([
			"Ops waiting on Design: 1 open request or question, newest 6 h ago",
			"Ops waiting on Temper: 2 open requests or questions, newest 3 h ago",
			"Temper waiting on Ops: 1 open request or question, newest 1 min ago",
		]);
		expect(dept.map((e) => e.chip)).toEqual(["1 open", "2 open", "1 open"]);
		for (const e of dept) {
			expect(e).toMatchObject({ stroke: "#4A82C0", chipFg: "#9CC7FF", op: "0.95", sw: "1.6" });
			// the head points from sender to receiver
			const [x1, y1, , , x2, y2] = String(e.d)
				.match(/-?[\d.]+/g)!
				.map(Number);
			const [tx, ty, ax, ay, bx, by] = String(e.arrow)
				.match(/-?[\d.]+/g)!
				.map(Number);
			const dir = (tx - (ax + bx) / 2) * (x2 - x1) + (ty - (ay + by) / 2) * (y2 - y1);
			expect(dir).toBeGreaterThan(0);
		}
		// both directions open: the two curves split apart
		expect(String(dept[1].d).split("Q")[1]).not.toBe(String(dept[2].d).split("Q")[1]);

		const boxes = new Map(list(object(values.glance).boxes).map((b) => [object(b).id, object(b)]));
		expect(boxes.get("ops")).toMatchObject({ hasRel: true, relText: "Waiting on 2 roles" });
		expect(boxes.get("temper")).toMatchObject({ hasRel: true, relText: "Waiting on Ops" });
		expect(boxes.get("design")).toMatchObject({ hasRel: false, relText: "" });
		expect(values.arrowMeaning).toContain("from a department to whoever it is waiting on");
		expect(values.arrowMeaning).not.toContain("not connected");

		// hovering Design: its arrow and the role it is linked to stay bright, the rest dims
		invoke(boxes.get("design")!.hoverOn);
		const hovered = view.values(1400, 780);
		const hEdges = list(object(hovered.graph).edges).map(object);
		expect(hEdges.slice(0, 3).map((e) => [e.op, e.sw])).toEqual([
			["0.95", "2.5"],
			["0.08", "1.6"],
			["0.08", "1.6"],
		]);
		const hBoxes = new Map(list(object(hovered.glance).boxes).map((b) => [object(b).id, object(b)]));
		expect(hBoxes.get("ops")).toMatchObject({ op: "1", bdNow: "#3D5A80" });
		expect(hBoxes.get("temper")?.op).toBe("0.38");

		// its label opens the sender's panel, whose sent line names the newest
		invoke(dept[1].chipClick);
		vi.runAllTimers();
		expect(object(view.values().ex)).toMatchObject({
			id: "ops",
			outText: "3 open \u00b7 newest to Temper, 3 h ago: Check the gate",
			reqInText: "2 open",
		});
		view.openRole("design", document.body);
		vi.runAllTimers();
		expect(object(view.values().ex).outText).toBe("0 open");
	});

	it("roles-sent: an older server without sent requests or pairs draws no role arrows", () => {
		const rows = [role(), role({ id: "design", title: "Design" })];
		const model = projectExactRoles(state(rows), "open", NOW);
		expect(model.pairs).toBeNull();
		const { view } = fixture(model);
		expect(list(object(view.values(1400, 780).graph).edges)).toEqual([]);
		expect(object(list(object(view.values().glance).boxes)[0]).hasRel).toBe(false);
		view.openRole("ops", document.body);
		vi.runAllTimers();
		expect(object(view.values().ex).outText).toBe("Not recorded");
	});

	it("shows a role's validated own tally, not a system-wide total or requested spend", () => {
		const spend = { state: "ok", spent: "$1,240.50", budget: "$2,000", age: "2 min ago" };
		const { view } = fixture(projectExactRoles(state([role({ spend })]), "open", NOW), true);
		view.openRole("ops");
		vi.runAllTimers();
		expect(object(object(view.values().ex).spend)).toEqual({ own: "$1,240.50 of $2,000", req: "Not recorded" });
		expect(view.values().spendRoleText).toBe("Ops");
		expect(view.values().spendAmountText).toBe("$1,240.50");
		expect(view.values().spendBarWidth).toBe("62.025%");
		expect(view.values().spendNoteText).toContain("Role’s own tally");
		expect(document.body.textContent).not.toContain("$0");
	});

	it.each([
		undefined,
		{ state: "none" },
		{ state: "unreadable" },
		{ state: "old-week" },
		{ state: "ok", spent: "$0", budget: "$0" },
		{ state: "ok", spent: "USD 2", budget: "$20" },
		{ state: "ok", spent: "$2\u202e", budget: "$20" },
		{ state: "ok", spent: "$2\n", budget: "$20" },
		{ state: "ok", spent: "$2", budget: "$20\n" },
		{ state: "ok", spent: "$20", budget: "$20" },
		{ state: { toString: "invalid" }, spent: "$2", budget: "$20" },
	])("never treats an absent or invalid tally as zero (%j)", (spend) => {
		const { view } = fixture(projectExactRoles(state([role({ spend })]), "open", NOW));
		expect(view.values().spendAmountText).toBe("Not recorded");
		expect(view.values().spendBarColor).toBe("transparent");
	});

	it("does not admit a final newline in a tally age", () => {
		const spend = { state: "ok", spent: "$2", budget: "$20", age: "just now\n" };
		const { view } = fixture(projectExactRoles(state([role({ spend })]), "open", NOW));
		expect(view.values().spendAmountText).toBe("$2");
		expect(view.values().spendNoteText).not.toContain("updated just now");
	});

	it("does not add multiple role budgets together, and marks stale/over-budget tallies", () => {
		const spend = { state: "stale", spent: "$5", budget: "$20" };
		const { view, update } = fixture(projectExactRoles(state([role({ spend })]), "open", NOW));
		expect(view.values().spendBarColor).toBe("#F0B95A");
		expect(view.values().spendNoteText).toContain("stale");
		update(projectExactRoles(state([role({ spend: { ...spend, state: "over", spent: "$25" } })]), "open", NOW));
		expect(view.values().spendBarWidth).toBe("100%");
		expect(view.values().spendBarColor).toBe("#FF8A80");
		update(projectExactRoles(state([role({ spend }), role({ id: "design", spend })]), "open", NOW));
		expect(view.values().spendAmountText).toBe("Not recorded");
		expect(view.values().spendRoleText).toBe("2 departments · see each role");
	});

	it("does not render archived report content or a report reminder", () => {
		const r = role({
			report: {
				state: "report",
				date: "2026-10-17",
				sections: [{ heading: "Done", text: Array(1100).fill("ARCHIVED_DAILY_REPORT").join("\n") }],
			},
		});
		const { view } = fixture(projectExactRoles(state([r]), "open", NOW), true);
		view.openRole("ops");
		vi.runAllTimers();
		expect(document.body.textContent).not.toContain("ARCHIVED_DAILY_REPORT");
		expect(document.body.textContent).not.toContain("6 am report");
		expect(document.body.textContent).not.toContain("Not received today");
		expect(document.querySelector('[role="region"]')).not.toBeNull();
		expect(r.report.sections?.[0].text).toContain("ARCHIVED_DAILY_REPORT");
	});

	// roles-small-fixes N3: the active list is cut at 20 too (the server sends them all); both cuts add up.
	it.each([
		[21, 0, "1 more task not shown here"],
		[25, 22, "7 more tasks not shown here"],
	])("says how many of %i active and %i queued tasks aren't shown", (activeN, queuedN, line) => {
		const r = role({
			queue: {
				active: Array.from({ length: activeN }, (_, i) => task(i + 1)),
				queued: Array.from({ length: Math.min(queuedN, 20) }, (_, i) => task(i + 101, { status: "ready" })),
				counts: { active: activeN, queued: queuedN, done: 0 },
			},
		});
		const { view } = fixture(projectExactRoles(state([r]), "open", NOW), true);
		view.openRole("ops");
		vi.runAllTimers();
		expect(document.body.textContent).toContain(`${line}. Open the full queue.`);
		expect(document.body.textContent).not.toContain("1 more tasks");
	});

	it("counts omitted tasks and mutes missing requester labels", () => {
		const r = role({
			queue: {
				active: [],
				queued: Array.from({ length: 23 }, (_, i) => task(i + 1, { status: "ready" })),
				counts: { active: 0, queued: 23, done: 0 },
			},
		});
		const { view } = fixture(projectExactRoles(state([r]), "open", NOW), true);
		view.openRole("ops");
		vi.runAllTimers();
		expect(document.body.textContent).toContain("3 more tasks not shown here");
		const queue = [...document.querySelectorAll("section")].find(
			(el) => el.querySelector("h3")?.textContent === "Task queue",
		);
		const labels = [...(queue?.querySelectorAll<HTMLSpanElement>("li > span") ?? [])].filter(
			(el) => el.textContent === "Not recorded",
		);
		expect(labels).toHaveLength(20);
		expect(labels.every((el) => el.style.color === "rgb(169, 174, 182)")).toBe(true);
	});

	it.each(["role", "you"])("spotlights %s focus only when it is keyboard-visible", (which) => {
		vi.stubGlobal("matchMedia", () => ({ matches: true }));
		const { view } = fixture(projectExactRoles(state([role(), role({ id: "design" })]), "open", NOW));
		const values = view.values();
		const highlight = which === "role" ? object(list(object(values.glance).boxes)[0]).hoverOn : values.youHoverOn;
		const opener = document.createElement("button");
		const visible = vi.spyOn(opener, "matches").mockReturnValue(false);
		const focus = new FocusEvent("focus");
		Object.defineProperty(focus, "currentTarget", { value: opener });
		const opacity = () => list(object(view.values().glance).boxes).map((b) => object(b).op);
		invoke(highlight, focus);
		expect(opacity()).toEqual(["1", "1"]);
		expect(visible).toHaveBeenCalledWith(":focus-visible");
		visible.mockReturnValue(true);
		invoke(highlight, focus);
		expect(opacity()).toEqual(which === "role" ? ["1", "0.38"] : ["0.38", "0.38"]);
		invoke(values.hoverOff);
		invoke(highlight, opener);
		expect(opacity()).toEqual(which === "role" ? ["1", "0.38"] : ["0.38", "0.38"]);
	});

	it.each([
		["role", false],
		["you", false],
		["role", true],
		["you", true],
	] as const)("restores %s focus without pointer-close spotlight (keyboard=%s)", (which, keyboard) => {
		const { view } = fixture(projectExactRoles(state([role(), role({ id: "design" })]), "open", NOW));
		const values = view.values();
		const box = object(list(object(values.glance).boxes)[0]);
		const opener = document.createElement("button");
		document.body.append(opener);
		vi.spyOn(opener, "matches").mockReturnValue(true);
		opener.addEventListener("focus", (event) => invoke(which === "role" ? box.hoverOn : values.youHoverOn, event));
		invoke(which === "role" ? box.expand : values.youExpand, opener);
		invoke(view.values().closeEx, new MouseEvent("click", { detail: keyboard ? 0 : 1 }));
		vi.runAllTimers();
		expect(document.activeElement).toBe(opener);
		expect(list(object(view.values().glance).boxes).map((b) => object(b).op)).toEqual(
			keyboard ? (which === "role" ? ["1", "0.38"] : ["0.38", "0.38"]) : ["1", "1"],
		);
	});

	it("does not keep hover dimming from a touch device after opening and closing a card", () => {
		vi.stubGlobal("matchMedia", () => ({ matches: false }));
		const { view } = fixture(projectExactRoles(state([role(), role({ id: "design" })]), "open", NOW));
		invoke(object(list(object(view.values().glance).boxes)[0]).hoverOn);
		view.openRole("ops");
		view.close(true);
		expect(list(object(view.values().glance).boxes).map((b) => object(b).op)).toEqual(["1", "1"]);
	});

	it("shows recorded next actions and queue milestones, never unrelated home progress", () => {
		const r = role({
			queue: {
				active: [
					task(7, {
						status: "waiting",
						chat: { file: TASK },
						next: { kind: "check", what: "staging check", everyMs: 30000, until: NOW + 60000 },
						queueEvent: { kind: "waiting", at: NOW - 60000 },
					}),
				],
				queued: [task(8, { status: "ready", waitsOn: "#7", next: { kind: "queue", after: ["#7"] } })],
				counts: { active: 1, queued: 1, done: 0 },
			},
		});
		const { view, actions } = fixture(projectExactRoles(state([r]), "open", NOW), true);
		view.openRole("ops");
		vi.runAllTimers();
		const current = object(view.values().ex);
		expect(current.nextShort).toContain("Recorded wait: staging check");
		expect(current.nextShort).toContain("checked every 0.5 min");
		expect(current.progressText).toBe("Queue recorded: waiting for a check");
		expect(current.progressText).not.toContain("Building the supplied design");
		expect(current.progressAt).not.toBe("Not recorded");
		expect(document.body.textContent).toContain("Next: Waiting for tasks: #7");
		expect(document.body.textContent).toContain("Next: Recorded wait: staging check");
		expect(document.body.textContent).not.toContain("Depends on:");
		expect(actions.open).not.toHaveBeenCalled();
		expect(actions.answer).not.toHaveBeenCalled();
		expect(actions.reload).not.toHaveBeenCalled();
	});

	it("old task records keep dependency labels without borrowing progress or inventing a next step", () => {
		const r = role({
			queue: {
				active: [task(7, { status: "blocked", waitsOn: "#12" })],
				queued: [],
				counts: { active: 1, queued: 0, done: 0 },
			},
		});
		const { view } = fixture(projectExactRoles(state([r]), "open", NOW), true);
		view.openRole("ops");
		vi.runAllTimers();
		expect(object(view.values().ex).progressText).toBe("Not recorded");
		expect(object(view.values().ex).nextShort).toBe("Not recorded");
		expect(document.body.textContent).toContain("Depends on: #12");
		expect(document.body.textContent).not.toContain("Next:");
	});

	it("a recorded wait is plain text, not injected HTML", () => {
		const r = role({
			queue: {
				active: [
					task(7, {
						status: "blocked",
						next: { kind: "blocked", what: "<img src=x onerror=evil()>" },
					}),
				],
				queued: [],
				counts: { active: 1, queued: 0, done: 0 },
			},
		});
		const { view } = fixture(projectExactRoles(state([r]), "open", NOW), true);
		view.openRole("ops");
		vi.runAllTimers();
		expect(document.body.textContent).toContain("<img src=x onerror=evil()>");
		expect(document.querySelector("img[onerror]")).toBeNull();
	});

	it("Retry is read-only and the supplied banner button invokes it", () => {
		const { actions } = fixture(projectExactRoles(state([], [], { status: "error" }), "open", NOW), true);
		const button = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Retry now");
		expect(button).toBeDefined();
		button?.click();
		expect(actions.reload).toHaveBeenCalledTimes(1);
		expect(actions.open).not.toHaveBeenCalled();
	});
});
