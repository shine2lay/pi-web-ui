/// <reference types="vite/client" />
// @vitest-environment jsdom
// The real design's presentation-only adapter: fixed data, no chats, model requests,
// tracking producers or production fonts. Pixel checks use the separate reference recipe.
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXACT_SOURCE, exactWhen, projectExactRoles, type ExactRoles } from "../../web/src/roles-exact-model.js";
import { approvalsTip, createExactRolesView, exactCardShifts } from "../../web/src/roles-exact-view.js";
import { ringAnchor, ringLayout, stackLayout } from "../../web/src/roles-u0/layout.js";
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
function fixture(initial: ExactRoles = projectExactRoles(state(), "open", NOW), mounted = false, narrow = false) {
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
		() => narrow,
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

	it("roles-links: the panel's Linked work line counts open tasks by parent, else No open tasks or Not recorded", () => {
		const withLinks = (links: unknown, extra: Row = {}) =>
			role({ queue: { ...(role().queue as Row), links }, ...extra });
		const mounted = fixture(
			projectExactRoles(state([withLinks({ project: 5, initiative: 1, standalone: 2, unrecorded: 3 })]), "open", NOW),
			true,
		);
		mounted.view.openRole("ops", document.body);
		vi.runAllTimers();
		expect(object(mounted.view.values().ex).linksText).toBe(
			"5 in projects \u00b7 1 under an initiative \u00b7 2 standalone \u00b7 3 not recorded",
		);
		// In the panel, right after Task lanes.
		const panel = document.querySelector('[role="region"]')?.textContent ?? "";
		expect(panel).toContain(
			"Task lanesTask-lane occupancy is not recordedLinked work5 in projects \u00b7 1 under an initiative \u00b7 2 standalone",
		);
		const cases: [unknown, Row, string][] = [
			// Zero parts left out; one task reads in the singular.
			[{ project: 1, initiative: 0, standalone: 0, unrecorded: 2 }, {}, "1 in a project \u00b7 2 not recorded"],
			[{ project: 0, initiative: 2, standalone: 0, unrecorded: 0 }, {}, "2 under initiatives"],
			[{ project: 0, initiative: 0, standalone: 0, unrecorded: 0 }, {}, "No open tasks"],
			// An older server sends none; a queue that couldn't be read, or a malformed count, isn't trusted.
			[undefined, {}, "Not recorded"],
			[{ project: 1, initiative: 0, standalone: 0, unrecorded: 0 }, { problems: ["home chat"] }, "Not recorded"],
			[{ project: -1, initiative: 0, standalone: 0, unrecorded: 0 }, {}, "Not recorded"],
			[{ project: 1.5, initiative: 0, standalone: 0, unrecorded: 0 }, {}, "Not recorded"],
			[{ project: "3", initiative: 0, standalone: 0, unrecorded: 0 }, {}, "Not recorded"],
			[{ project: 3, initiative: 0, standalone: 0 }, {}, "Not recorded"],
		];
		for (const [links, extra, text] of cases) {
			const { view } = fixture(projectExactRoles(state([withLinks(links, extra)]), "open", NOW));
			view.openRole("ops");
			expect(object(view.values().ex).linksText).toBe(text);
		}
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
		expect(object(v.banner).show).toBe(false);
		expect(String(object(v.fresh).text)).not.toMatch(/^Live/);
		expect(object(v.fresh).tip).toMatch(/\nClick to retry$/);
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
		["error", "open", { status: "error" }, "#FF8A80"],
		["disconnected", "closed", {}, "#FF8A80"],
		["stale", "open", { heardAt: NOW - 180_000 }, "#F0B95A"],
	] as const)(
		"keeps the %s warning palette and receipt time; the status pill retries",
		(_name, connection, extra, fg) => {
			const { view, actions } = fixture(projectExactRoles(state([role()], [], extra), connection, NOW));
			const v = view.values();
			expect(object(v.banner).show).toBe(false);
			expect(object(v.fresh)).toMatchObject({ fg });
			const text = String(object(v.fresh).text);
			expect(text).toContain("last received");
			expect(object(v.fresh).label).toBe(`${text}. Retry now`);
			invoke(object(v.fresh).retry);
			expect(actions.reload).toHaveBeenCalledTimes(1);
		},
	);

	it.each([
		["connected-source-unverified", "open", {}],
		["awaiting", "open", { status: "loading", overview: null }],
		["error", "open", { status: "error", overview: null }],
		["cached-error", "open", { status: "error" }],
		["disconnected", "closed", { overview: null }],
		["cached", "closed", {}],
		["stale", "open", { heardAt: NOW - 180_000 }],
		["partial", "open", { overview: { at: NOW, roles: [], asks: [], work: { initiatives: [], projects: [] } } }],
		["unknown", "open", { overview: null }],
	] as const)(
		"roles-retry-pill: no banner when the source is %s; the pill's tooltip says why",
		(source, connection, extra) => {
			const model = projectExactRoles(state([role()], [], extra), connection, NOW);
			expect(model.source).toBe(source);
			const v = fixture(model).view.values();
			expect(object(v.banner).show).toBe(false);
			const fresh = object(v.fresh);
			if (source === "connected-source-unverified") {
				expect(fresh.tip).toBe("Click to refresh");
				expect(fresh.label).toBe("Live \u00b7 updated 12:00. Refresh now");
			} else {
				const why = EXACT_SOURCE[source];
				expect(fresh.tip).toBe(`${why.title}\n${why.body}\nClick to retry`);
				expect(fresh.label).toBe(`${String(fresh.text)}. Retry now`);
			}
		},
	);

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

	it("gives an explicit uncertainty reason in the status pill's tooltip rather than a green status", () => {
		const { view } = fixture(projectExactRoles(state([role()], [], { appliedAt: null }), "open", NOW));
		expect(object(view.values().banner).show).toBe(false);
		// roles-small-fixes N2's reason (still checking) is what the tooltip gives, not the generic one.
		expect(object(view.values().fresh).tip).toBe(
			"Some owner asks could not be confirmed\nThe server hasn\u2019t confirmed the current asks since this page connected. The list below is the last one received.\nClick to retry",
		);
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
		// roles-retry-pill: no banner; the pill's tooltip carries the reason and the retry.
		expect(object(v.banner).show).toBe(false);
		const tip = String(object(v.fresh).tip);
		expect(tip).toMatch(/^Some owner asks could not be confirmed\n.+\nClick to retry$/);
		expect(tip).not.toContain("may be incomplete");
		expect(object(v.fresh).label).toBe(`Asks unconfirmed: ${reason} \u00b7 last received 12:00. Retry now`);
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

	// roles-budget-card (Ops #265, H-BUDGET-CARD-1): a reported role's own-work budget on its card, no click needed.
	const cardOf = (view: ReturnType<typeof fixture>["view"], id: string) =>
		list(object(view.values().glance).boxes)
			.map(object)
			.find((b) => b.id === id);
	const designSpend = (spend: unknown) => [role(), role({ id: "design", title: "Design", spend })];

	it("roles-budget-card: a reported role's card shows the feed's exact figures and a bar; no other card does", () => {
		const spend = { state: "ok", spent: "$579.65", budget: "$2,000", age: "2 min ago" };
		const { view } = fixture(projectExactRoles(state(designSpend(spend)), "open", NOW), true);
		expect(cardOf(view, "design")).toMatchObject({
			hasSpend: true,
			spendText: "$579.65 of $2,000 this week",
			spendBarWidth: "28.983%",
			spendBarColor: "#7DB8FF",
			spendLabel: "Design own-work budget: $579.65 of $2,000 this week",
			spendBelow: false,
		});
		expect(cardOf(view, "ops")).toMatchObject({ hasSpend: false, spendText: "", spendLabel: "", spendBelow: true });
		const cards = [...document.querySelectorAll('button[aria-haspopup="dialog"]')];
		expect(cards).toHaveLength(2);
		const design = cards.find((card) => card.textContent?.includes("Design"));
		expect(design?.textContent).toContain("$579.65 of $2,000 this week");
		const line = design?.querySelector('[role="img"][aria-label^="Design own-work budget"]');
		expect(line?.getAttribute("aria-label")).toBe("Design own-work budget: $579.65 of $2,000 this week");
		// The line holds the text, then the track with the bar inside it.
		const bar = line?.lastElementChild?.firstElementChild as HTMLElement | null | undefined;
		expect(bar?.style.width).toBe("28.983%");
		expect(bar?.style.background).toMatch(/^(#7DB8FF|rgb\(125, 184, 255\))$/i);
		for (const card of cards.filter((card) => card !== design)) {
			expect(card.textContent).not.toMatch(/\$|this week/);
			expect(card.querySelector('[aria-label*="budget"]')).toBeNull();
		}
	});

	it.each([
		undefined,
		{ state: "none" },
		{ state: "old-week" },
		{ state: "unreadable" },
		{ state: "ok", spent: "$0", budget: "$0" },
		{ state: "ok", spent: "$20", budget: "$20" },
		{ state: "ok", spent: "USD 2", budget: "$20" },
	])("roles-budget-card: no budget line, never $0, without a reported tally (%j)", (spend) => {
		const { view } = fixture(projectExactRoles(state(designSpend(spend)), "open", NOW), true);
		expect(cardOf(view, "design")).toMatchObject({ hasSpend: false, spendText: "", spendBelow: true });
		const cards = [...document.querySelectorAll('button[aria-haspopup="dialog"]')];
		expect(cards).toHaveLength(2);
		for (const card of cards) expect(card.textContent).not.toMatch(/\$|this week|Budget used up/);
	});

	it("roles-budget-card: over budget reads Budget used up in red; stale and last received data are amber", () => {
		const { view, update } = fixture(
			projectExactRoles(state(designSpend({ state: "over", spent: "$2,040.10", budget: "$2,000" })), "open", NOW),
		);
		expect(cardOf(view, "design")).toMatchObject({
			hasSpend: true,
			spendText: "Budget used up",
			spendBarWidth: "100%",
			spendBarColor: "#FF8A80",
			spendLabel: "Design own-work budget: used up, $2,040.10 of $2,000 this week",
		});
		update(projectExactRoles(state(designSpend({ state: "stale", spent: "$5", budget: "$20" })), "open", NOW));
		expect(cardOf(view, "design")).toMatchObject({
			spendText: "$5 of $20 this week",
			spendBarWidth: "25%",
			spendBarColor: "#F0B95A",
		});
		const received = projectExactRoles(
			state(designSpend({ state: "ok", spent: "$2", budget: "$20" })),
			"closed",
			NOW + 3_000,
			{ visibleAt: NOW - 3_600_000 },
		);
		expect(received.lastReceived).toBe(true);
		update(received);
		expect(cardOf(view, "design")).toMatchObject({ spendText: "$2 of $20 this week", spendBarColor: "#F0B95A" });
		// The You panel's bar follows the same rule.
		expect(view.values().spendBarColor).toBe("#F0B95A");
	});

	it("roles-budget-card: a reported role's panel opens with spending first; other panels keep it lower", () => {
		const spend = { state: "ok", spent: "$579.65", budget: "$2,000" };
		const { view } = fixture(projectExactRoles(state(designSpend(spend)), "open", NOW), true);
		const headings = () =>
			[...document.querySelectorAll('[role="region"] h3')].map((h) => h.textContent?.trim().toLowerCase() ?? "");
		view.openRole("design", document.body);
		vi.runAllTimers();
		let order = headings();
		expect(order.filter((h) => h === "spending this week")).toHaveLength(1);
		expect(order[0]).toBe("spending this week");
		expect(document.querySelector('[role="region"]')?.textContent).toContain("$579.65 of $2,000");
		view.close(true);
		vi.runAllTimers();
		view.openRole("ops", document.body);
		vi.runAllTimers();
		order = headings();
		expect(order.filter((h) => h === "spending this week")).toHaveLength(1);
		expect(order.indexOf("spending this week")).toBe(order.indexOf("requests") + 1);
		expect(order.indexOf("now")).toBeLessThan(order.indexOf("spending this week"));
	});

	it("roles-budget-card: a taller card grows away from a close neighbour; no other card moves", () => {
		const roster = [
			["architecture", "Architecture"],
			["backend", "Backend"],
			["coo", "COO"],
			["data", "Data"],
			["design", "Design"],
			["docs", "Docs"],
			["frontend", "Frontend"],
			["marketing", "Marketing"],
			["ops", "Ops"],
			["product", "Product"],
			["qa", "QA"],
			["rollcall", "RollCall"],
			["security", "Security"],
			["systems", "Systems"],
			["temper", "Temper"],
		];
		const spend = { state: "ok", spent: "$579.65", budget: "$2,000" };
		const project = (withSpend: boolean) =>
			projectExactRoles(
				state(roster.map(([id, title]) => role({ id, title, ...(withSpend && id === "design" ? { spend } : {}) }))),
				"open",
				NOW,
			);
		const ring = (model: ExactRoles, width: number, height: number) =>
			ringLayout(
				model.roles.map((r) => ({ id: r.row.roleId, name: r.row.roleLabel })),
				width,
				height,
			);
		const model = project(true);
		// 1050 px: Ops (inner ring, right) sits just above Design, so Design keeps its top edge and grows down.
		const narrow = ring(model, 1050, 876);
		expect([...exactCardShifts(model, narrow)]).toEqual([["design", 24]]);
		// 1400 px: room both ways, so it stays centred like every other card.
		expect(exactCardShifts(model, ring(model, 1400, 780)).size).toBe(0);
		// Without a budget line nothing moves.
		expect(exactCardShifts(project(false), narrow).size).toBe(0);
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

	it("roles-retry-pill: the status pill is a native button that retries in every state; no banner is drawn", () => {
		const { actions, update } = fixture(projectExactRoles(state([], [], { status: "error" }), "open", NOW), true);
		expect(document.querySelector('[role="alert"]')).toBeNull();
		const names = Array.from(document.querySelectorAll("button"), (b) => b.textContent);
		expect(names).not.toContain("Retry now");
		expect(names).not.toContain("Refresh now");
		const pill = document.querySelector('header [role="status"] > button');
		if (!(pill instanceof HTMLButtonElement)) throw new Error("expected the status pill's button");
		expect(pill.type).toBe("button");
		expect(pill.textContent).toBe(document.querySelector('header [role="status"]')?.textContent);
		const why = EXACT_SOURCE["cached-error"];
		expect(pill.title).toBe(`${why.title}\n${why.body}\nClick to retry`);
		expect(pill.getAttribute("aria-label")).toBe(`${pill.textContent}. Retry now`);
		expect(pill.style.cursor).toBe("pointer");
		pill.click();
		expect(actions.reload).toHaveBeenCalledTimes(1);
		update(projectExactRoles(state(), "open", NOW));
		vi.runAllTimers();
		const live = document.querySelector('header [role="status"] > button');
		if (!(live instanceof HTMLButtonElement)) throw new Error("expected the status pill's button");
		expect(live.textContent).toBe("Live \u00b7 updated 12:00");
		expect(live.title).toBe("Click to refresh");
		expect(live.getAttribute("aria-label")).toBe("Live \u00b7 updated 12:00. Refresh now");
		live.click();
		expect(actions.reload).toHaveBeenCalledTimes(2);
		expect(actions.open).not.toHaveBeenCalled();
	});
});

describe("ladder-alarm: an amber chip while message approvals are off", () => {
	const REASON = "recover: legacy writer divergence; refusing stale snapshot overwrite";
	const SINCE = NOW - 2 * 3_600_000;
	const withApprovals = (approvals: unknown) => {
		const s = state();
		return projectExactRoles({ ...s, overview: { ...s.overview, approvals } }, "open", NOW);
	};
	const chip = () => document.querySelector("[data-roles-approvals]");

	it("projects only an explicit off; on, not reported or a bad value is nothing", () => {
		expect(withApprovals({ on: false, reason: REASON, since: SINCE }).approvalsOff).toEqual({
			reason: REASON,
			since: SINCE,
		});
		expect(withApprovals({ on: true }).approvalsOff).toBeNull();
		expect(withApprovals(undefined).approvalsOff).toBeNull();
		expect(withApprovals({ on: "false" }).approvalsOff).toBeNull();
		expect(projectExactRoles(state(), "open", NOW).approvalsOff).toBeNull();
		// An unsafe reason is dropped whole; a start ahead of this clock isn't recorded.
		expect(withApprovals({ on: false, reason: "BAD\u202eREASON", since: NOW + 3_600_000 }).approvalsOff).toEqual({
			reason: null,
			since: null,
		});
	});

	it("off: the chip sits beside the pill, its tooltip gives the reason and the start; the pill is unchanged", () => {
		const { update } = fixture(withApprovals({ on: false, reason: REASON, since: SINCE }), true);
		vi.runAllTimers();
		const el = chip();
		if (!(el instanceof HTMLElement)) throw new Error("expected the approvals chip");
		expect(el.textContent?.trim()).toBe("Message approvals off");
		expect(el.title).toBe(
			`Chains between roles stop at 6 messages and nobody can approve more. Reason: ${REASON}. Off since this server started at ${exactWhen(SINCE, NOW)}.`,
		);
		expect(el.closest("header")).not.toBeNull();
		expect(el.getAttribute("role")).toBeNull();
		expect(el.tabIndex).toBe(0);
		expect(el.nextElementSibling?.getAttribute("role")).toBe("status");
		expect(document.querySelectorAll('header [role="status"]')).toHaveLength(1);
		expect(document.querySelector('[role="alert"]')).toBeNull();
		const pill = document.querySelector('header [role="status"] > button');
		if (!(pill instanceof HTMLButtonElement)) throw new Error("expected the status pill's button");
		expect(pill.title).toBe("Click to refresh");
		// Turned on: the chip goes; the pill stays as it was.
		update(withApprovals({ on: true }));
		vi.runAllTimers();
		expect(chip()).toBeNull();
		expect(document.querySelectorAll('header [role="status"]')).toHaveLength(1);
	});

	it("on: no chip; a reason or start that isn't recorded is said plainly", () => {
		fixture(withApprovals({ on: true }), true);
		vi.runAllTimers();
		expect(chip()).toBeNull();
		expect(approvalsTip({ reason: null, since: null }, NOW)).toBe(
			"Chains between roles stop at 6 messages and nobody can approve more. Reason: not recorded. Off since this server started.",
		);
		expect(approvalsTip({ reason: "turned off.", since: SINCE }, NOW)).toContain("Reason: turned off. Off since");
	});
});

describe("roles-phone: one column below 1024 px", () => {
	it("stacks You first, then the departments in the order given, at their measured heights", () => {
		const lay = stackLayout(["temper", "coo", "ops"], 364, [66, 104, 120, 92], 72);
		expect(lay).toMatchObject({ width: 364, height: 526, nodeW: 340 });
		expect([...lay.pos]).toEqual([
			["you", [182, 113]],
			["temper", [182, 214]],
			["coo", [182, 342]],
			["ops", [182, 464]],
		]);
	});

	it("uses the You pill's and the loading card's heights before a first measurement", () => {
		const lay = stackLayout(["ops", "coo"], 300, [0]);
		expect([...lay.pos.values()].map(([, y]) => y)).toEqual([41, 142, 262]);
		expect(lay.height).toBe(330);
	});

	it("in narrow mode keeps roster order, draws no arrows and opens panels as full-width sheets", () => {
		const rows = [role({ id: "temper", title: "Temper" }), role({ id: "coo", title: "COO" }), role()];
		const model = projectExactRoles(state(rows, [ask(1)]), "open", NOW);
		// The same feed draws its owner-ask arrow on a wide screen.
		const wide = fixture(model).view.values(1400, 780);
		expect(wide.stacked).toBe("false");
		expect(list(object(wide.graph).edges)).toHaveLength(1);
		const { view } = fixture(model, false, true);
		const v = view.values(364, 844);
		expect(v.stacked).toBe("true");
		expect(list(object(v.graph).edges)).toEqual([]);
		const boxes = list(object(v.glance).boxes).map(object);
		expect(boxes.map((b) => b.id)).toEqual(["temper", "coo", "ops"]);
		// No header measured yet: the 48 px fallback plus 24.
		const lay = stackLayout(["temper", "coo", "ops"], 364, [], 72);
		for (const b of boxes) expect(b).toMatchObject(ringAnchor(lay, String(b.id)) ?? {});
		expect(v.youTop).toBe(ringAnchor(lay, "you")?.py);
		expect(v).toMatchObject({ nodeW: "340px", gw: 364, gh: lay.height, stackHeight: `${lay.height}px` });
		expect(String(v.arrowMeaning)).toMatch(
			/^Arrows are hidden on narrow screens and show on wider screens\. Arrows point from a department/,
		);
		view.openRole("ops");
		vi.runAllTimers();
		expect(object(view.values(364, 844).exPos)).toMatchObject({ t: "0px", l: "0px", w: "100%", h: "100%" });
	});
});

// pages-live (Ops #244): an alarm waits up to LIVE_GRACE_MS of visible time for fresh data, showing the last data
// calmly with its time; never past it, and never an all-clear from it.
describe("pages-live: Updating instead of an alarm, for up to 8 s", () => {
	const waiting = (extra: Row = {}) =>
		state([role()], [], { appliedAt: undefined, waitingSince: NOW - 2_000, ...extra });
	const long = { visibleAt: NOW - 3_600_000 };

	it("a lost connection shows Updating with the last data's time, calm, then Disconnected after 8 s", () => {
		const model = projectExactRoles(waiting(), "closed", NOW, long);
		expect(model.source).toBe("updating");
		expect(model.needs.tell).toBe("awaiting");
		expect(model.lastReceived).toBe(true);
		expect(model.graceUntil).toBe(NOW + 6_000);
		const { view, update } = fixture(model);
		const fresh = object(view.values().fresh);
		expect(fresh.text).toBe("Updating\u2026 \u00b7 last received 12:00");
		expect(fresh.fg).toBe("#ECEDEE");
		expect(object(view.values().banner).show).toBe(false);
		const later = projectExactRoles(waiting(), "closed", NOW + 6_000, long);
		expect(later.source).toBe("cached");
		expect(later.graceUntil).toBeNull();
		update(later);
		expect(object(view.values().fresh).text).toBe("Disconnected \u00b7 last received 12:00");
		expect(object(view.values().fresh).fg).toBe("#FF8A80");
	});

	it("counts from the tab coming back; nothing is used up while hidden", () => {
		const old = waiting({ waitingSince: NOW - 600_000 });
		expect(projectExactRoles(old, "closed", NOW, long).source).toBe("cached");
		const hidden = projectExactRoles(old, "closed", NOW, { visibleAt: null });
		expect(hidden.source).toBe("updating");
		expect(hidden.graceUntil).toBeNull();
		const back = projectExactRoles(old, "closed", NOW, { visibleAt: NOW - 1_000 });
		expect(back.source).toBe("updating");
		expect(back.graceUntil).toBe(NOW + 7_000);
		expect(projectExactRoles(old, "closed", NOW + 7_000, { visibleAt: NOW - 1_000 }).source).toBe("cached");
	});

	it("a pending watch, a failed look and a silent feed wait too; fresh data ends the wait at once", () => {
		expect(projectExactRoles(waiting(), "open", NOW, long).source).toBe("updating");
		expect(projectExactRoles(waiting(), "open", NOW + 6_000, long)).toMatchObject({
			source: "connected-source-unverified",
			needs: { tell: "awaiting" },
		});
		expect(projectExactRoles(waiting({ error: "boom" }), "open", NOW, long).source).toBe("updating");
		expect(projectExactRoles(waiting({ error: "boom" }), "open", NOW + 6_000, long).source).toBe("cached-error");
		// silent for 2 min 5 s with no wait recorded: it turned stale 5 s ago
		const quiet = state([role()], [], { heardAt: NOW - 125_000 });
		expect(projectExactRoles(quiet, "open", NOW, long).source).toBe("updating");
		expect(projectExactRoles(quiet, "open", NOW + 3_000, long).source).toBe("stale");
		// fresh: the server was heard looking again (appliedAt), no wait
		const fresh = projectExactRoles(state(), "open", NOW, long);
		expect(fresh.source).toBe("connected-source-unverified");
		expect(fresh.needs.tell).toBe("can-tell");
		expect(fresh.graceUntil).toBeNull();
	});

	it("with nothing loaded it says Loading, not Disconnected or Unavailable, until the 8 s are up", () => {
		const none = waiting({ overview: null, status: "loading", overviewReceivedAt: undefined });
		expect(projectExactRoles(none, "closed", NOW, long).source).toBe("awaiting");
		expect(projectExactRoles(none, "closed", NOW + 6_000, long).source).toBe("disconnected");
		const failed = waiting({ overview: null, status: "error", error: "boom" });
		expect(projectExactRoles(failed, "open", NOW, long).source).toBe("awaiting");
		expect(projectExactRoles(failed, "open", NOW + 6_000, long).source).toBe("error");
	});

	it("without the tab's visibility (old callers) every alarm shows at once, as before", () => {
		expect(projectExactRoles(waiting(), "closed", NOW).source).toBe("cached");
		expect(projectExactRoles(waiting(), "open", NOW).source).toBe("connected-source-unverified");
	});
});
