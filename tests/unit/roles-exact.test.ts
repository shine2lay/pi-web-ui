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
function invoke(value: SurfaceValue) {
	if (typeof value !== "function") throw new Error("expected callback");
	value(document.body);
}
const cleanups: (() => void)[] = [];
function fixture(initial: ExactRoles = projectExactRoles(state(), "open", NOW), mounted = false) {
	vi.useFakeTimers();
	let model = initial;
	let surface: ReturnType<typeof bindRolesSurface> | null = null;
	const actions = { open: vi.fn(), about: vi.fn(), reload: vi.fn() };
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
	document.body.replaceChildren();
});

describe("the supplied Roles design with the existing feed", () => {
	it("uses the supplied ring geometry and a closed presentation, not a native receipt", () => {
		const model = projectExactRoles(state(), "open", NOW);
		const { view } = fixture(model);
		const values = view.values(1400, 780);
		const boxes = list(object(values.glance).boxes);
		expect(boxes).toHaveLength(1);
		expect(object(boxes[0])).toMatchObject({
			id: "ops",
			name: "Ops",
			state: "working",
			...ringAnchor(ringLayout([{ id: "ops", name: "Ops" }], 1400, 780), "ops"),
		});
		expect(object(values.fresh).text).toBe("Reported status");
		expect(object(values.graph).edges).toEqual([]);
		expect(object(boxes[0]).lanes).toEqual([]);
		expect(values.spendAmountText).toBe("Not connected yet");
		expect(values).not.toHaveProperty("namespace");
	});

	it("mounts the actual supplied template and opens the complete department panel", () => {
		const { view } = fixture(undefined, true);
		expect(document.querySelector("h1")?.textContent).toBe("Roles");
		expect(document.querySelector("[data-boxgrid]")).not.toBeNull();
		view.openRole("ops", document.body);
		vi.runAllTimers();
		const panel = document.querySelector('[role="region"]');
		expect(panel?.textContent).toContain("Task 7");
		for (const title of [
			"6 am report",
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
		expect(object(object(view.values().ex).spend)).toEqual({ own: "Not connected yet", req: "Not connected yet" });
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
		expect(v.youText).toBe("53 reported asks");
		const inbox = list(v.inbox).map(object);
		expect(inbox).toHaveLength(51);
		expect(inbox.at(-1)?.title).toBe("3 more reported asks are not shown here");
		expect(inbox.some((item) => item.title === "Open the original item to read it")).toBe(true);
		const choice = object(list(inbox[0].choices)[0]);
		expect(choice.label).toBe("Open chat");
		invoke(choice.pick);
		expect(actions.open).toHaveBeenCalledWith(expect.objectContaining({ file: HOME }));
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

	it("uses the same report and activity data while switching only local presentation", () => {
		const { view } = fixture();
		view.openRole("ops");
		let v = view.values();
		expect(object(object(v.ex).rep).has).toBe(true);
		invoke(v.toggleRep);
		expect(view.values().repOpen).toBe(true);
		invoke(object(list(v.drTabs)[1]).pick);
		v = view.values();
		expect(object(list(object(v.ex).acts)[0]).text).toBe("Configuration history is not connected yet.");
	});

	it("Retry is read-only and the supplied banner button invokes it", () => {
		const { actions } = fixture(projectExactRoles(state([], [], { status: "error" }), "open", NOW), true);
		const button = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Retry");
		expect(button).toBeDefined();
		button?.click();
		expect(actions.reload).toHaveBeenCalledTimes(1);
		expect(actions.open).not.toHaveBeenCalled();
	});
});
