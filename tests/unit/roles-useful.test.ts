// @vitest-environment jsdom
// Fixed projection + actual store/mounted consumer contract. Real reader/wire integration: roles-page-test.mjs.
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppGlobals, setAppGlobals, setAppSend } from "../../web/src/app-globals.js";
import { RolesUsefulView } from "../../web/src/components/RolesUsefulView.js";
import { en, LanguageProvider } from "../../web/src/i18n.js";
import {
	receiveRoles,
	resendRolesWatch,
	resetRolesState,
	watchRoles,
	type RolesPayload,
} from "../../web/src/roles-state.js";
import { projectUsefulRoles, type UsefulRoles } from "../../web/src/roles-useful-model.js";

const task = (id: unknown = 1, status: unknown = "working", extra: Record<string, unknown> = {}) => ({
	id,
	status,
	...extra,
});
const queue = (extra: Record<string, unknown> = {}) => ({
	running: true,
	active: [task()],
	queued: [task(2, "ready")],
	counts: { active: 1, queued: 1, done: 2 },
	...extra,
});
const role = (id: unknown = "frontend", extra: Record<string, unknown> = {}) => ({
	id,
	title: "Frontend",
	queue: queue(),
	...extra,
});
const state = (roles: unknown[] = [role()], extra: Record<string, unknown> = {}) => ({
	status: "ready",
	overview: { roles, asks: [] },
	...extra,
});
const project = (rows: unknown[] = [role()]) => projectUsefulRoles(state(rows), "open");
const keys = (value: object, expected: string[]) => expect(Object.keys(value).sort()).toEqual(expected.sort());
function closed(model: UsefulRoles) {
	keys(model, ["source", "roster", "omitted", "roles"]);
	for (const r of model.roles) {
		keys(r, [
			"roleId",
			"roleLabel",
			"labelTruncated",
			"partial",
			"queueEnabled",
			"stopReason",
			"hold",
			"counts",
			"active",
			"queued",
		]);
		keys(r.counts, ["active", "queued", "done"]);
		for (const list of [r.active, r.queued]) {
			keys(list, ["available", "omitted", "notAllShown", "records"]);
			for (const record of list.records) keys(record, ["taskId", "reportedStatus", "pause"]);
		}
	}
}

let root: Root | null = null;
let container: HTMLDivElement;
const sent: unknown[] = [];
function mount(active = true) {
	act(() => {
		root ??= createRoot(container);
		root.render(createElement(LanguageProvider, null, createElement(RolesUsefulView, { active, phone: false })));
	});
}
function receive(value: unknown) {
	act(() => receiveRoles(value as RolesPayload));
}
function feed(rows: unknown[]) {
	receive({ type: "roles", overview: { roles: rows, asks: [] } });
}
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	resetRolesState();
	resetAppGlobals();
	setAppGlobals({ status: "open" });
	sent.length = 0;
	setAppSend((message) => {
		sent.push(message);
		return true;
	});
	container = document.createElement("div");
	document.body.appendChild(container);
});
afterEach(() => {
	if (root) act(() => root!.unmount());
	root = null;
	container.remove();
	setAppSend(null);
	resetRolesState();
	resetAppGlobals();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("reduced Roles closed projection", () => {
	it("happy path: reported facts, no global task identity or aggregation", () => {
		const model = project([role(), role("backend")]);
		closed(model);
		expect(model.source).toBe("connected-source-unverified");
		expect(model.roles.map((r) => r.active.records)).toEqual([
			[{ taskId: 1, reportedStatus: "working", pause: "not-reported" }],
			[{ taskId: 1, reportedStatus: "working", pause: "not-reported" }],
		]);
		expect(model.roles[0].counts).toEqual({ active: 1, queued: 1, done: 2 });
		expect(project([role("backend")]).roles.map((r) => r.roleId)).toEqual(["backend"]);
	});
	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "1", null, true])(
		"omits invalid task id %s",
		(id) => {
			const r = project([role("ops", { queue: queue({ active: [task(id)] }) })]).roles[0];
			expect(r.active.records).toEqual([]);
			expect(r.active.omitted).toBe(true);
		},
	);
	it("accepts max-safe id, every exact status; unknown never becomes done", () => {
		const statuses = ["ready", "working", "asking", "stuck", "waiting", "blocked", "done"];
		const rows = statuses.map((s, i) => task(i + 10, s));
		rows.push(task(Number.MAX_SAFE_INTEGER, "finished"));
		const r = project([role("ops", { queue: queue({ active: rows }) })]).roles[0];
		expect(r.active.records.map((t) => t.reportedStatus)).toEqual([...statuses, null]);
	});
	it("omits duplicate roles and role-local task ids across both lists, without merging", () => {
		const model = project([
			role("ops"),
			role("ops"),
			role("backend", { queue: queue({ active: [task(), task(3), task(3)], queued: [task()] }) }),
		]);
		expect(model.omitted).toBe(true);
		expect(model.roles.map((r) => r.roleId)).toEqual(["backend"]);
		expect(model.roles[0].active.records).toEqual([]);
		expect(model.roles[0].queued.records).toEqual([]);
	});
	it.each(["", "Bad", "../ops", "a".repeat(33), "x\n", 1, null])("rejects invalid role id %s", (id) => {
		const model = project([role(id), null, []]);
		expect(model.roster).toBe("unavailable");
		expect(model.roles).toEqual([]);
		expect(model.omitted).toBe(true);
	});
	it.each([undefined, null, 0, -1, 1.2, Infinity, NaN, "2", Number.MAX_SAFE_INTEGER + 1])(
		"count %s never falls back to numeric zero",
		(value) => {
			const r = project([role("ops", { queue: queue({ counts: { active: value, queued: value, done: value } }) })])
				.roles[0];
			const expected = value === 0 ? "not-established" : "unavailable";
			expect(r.counts).toEqual({ active: expected, queued: expected, done: expected });
		},
	);
	it("missing queue/counts and reported role/home problems make counts unavailable", () => {
		for (const extra of [
			{ queue: undefined },
			{ queue: queue({ counts: undefined }) },
			{ problems: ["CANARY-HOME"] },
			{ problems: {} },
		]) {
			expect(project([role("ops", extra)]).roles[0].counts).toEqual({
				active: "unavailable",
				queued: "unavailable",
				done: "unavailable",
			});
		}
		expect(project([]).roster).toBe("unavailable");
		expect(project([role("ops", { queue: queue({ active: null }) })]).roles[0].active.notAllShown).toBe(true);
	});
	it("distinguishes absence, reported pause/hold, malformed markers, and ordinary stop", () => {
		const valid = { at: 0, why: "CANARY-PAUSE" };
		for (const value of [
			null,
			[],
			{},
			{ at: Infinity, why: "x" },
			{ at: "1", why: "x" },
			{ at: 1, why: " " },
			{ at: 1, why: 1 },
			undefined,
		]) {
			const r = project([
				role("ops", { queue: queue({ hold: value, active: [task(1, "blocked", { paused: value })] }) }),
			]).roles[0];
			expect(r.hold).toBe("unknown");
			expect(r.active.records[0].pause).toBe("unknown");
		}
		const r = project([
			role("ops", {
				queue: queue({
					running: false,
					pausedReason: "stopped",
					hold: valid,
					active: [task(1, "waiting", { paused: valid })],
				}),
			}),
		]).roles[0];
		expect(r.hold).toBe("reported-paused");
		expect(r.active.records[0].pause).toBe("reported-paused");
		expect(project().roles[0].hold).toBe("not-reported");
		expect(project([role("ops", { queue: queue({ running: false }) })]).roles[0].hold).toBe("not-reported");
	});
	it("enabled is boolean only, stop reason is a closed code only", () => {
		for (const code of ["user", "stopped", "error", "restart", "finished"]) {
			expect(project([role("ops", { queue: queue({ pausedReason: code }) })]).roles[0].stopReason).toBe(code);
		}
		for (const value of ["CANARY-REASON", 0, [], null]) {
			const r = project([role("ops", { queue: queue({ running: value, pausedReason: value }) })]).roles[0];
			expect(r.queueEnabled).toBeNull();
			expect(r.stopReason).toBeNull();
		}
	});
	it("bounds Unicode labels including ellipsis; unsafe text falls back only to id", () => {
		for (const title of ["", "   ", "x\u0000", "x\u202e", "x\u2066", "x\ud800", "x\udc00"]) {
			expect(project([role("ops", { title })]).roles[0].roleLabel).toBe("ops");
		}
		const exact = project([role("ops", { title: "😀".repeat(120) })]).roles[0];
		expect(Array.from(exact.roleLabel)).toHaveLength(120);
		expect(exact.labelTruncated).toBe(false);
		const clipped = project([role("ops", { title: "😀".repeat(121) })]).roles[0];
		expect(Array.from(clipped.roleLabel)).toHaveLength(120);
		expect(clipped.roleLabel.endsWith("…")).toBe(true);
		expect(clipped.labelTruncated).toBe(true);
	});
	it("caps 64/65 roles and 20/21 rows without changing explicit counts", () => {
		for (const n of [64, 65]) {
			const m = project(Array.from({ length: n }, (_, i) => role(`r-${i}`)));
			expect(m.roles).toHaveLength(64);
			expect(m.omitted).toBe(n === 65);
		}
		for (const n of [20, 21]) {
			const r = project([
				role("ops", {
					queue: queue({
						active: Array.from({ length: n }, (_, i) => task(i + 10)),
						queued: Array.from({ length: n }, (_, i) => task(i + 100)),
						counts: { active: 30, queued: 30, done: 5 },
					}),
				}),
			]).roles[0];
			expect(r.active.records).toHaveLength(20);
			expect(r.queued.records).toHaveLength(20);
			expect(r.active.omitted).toBe(n === 21);
			expect(r.queued.omitted).toBe(n === 21);
			expect(r.active.notAllShown).toBe(true);
			expect(r.counts).toEqual({ active: 30, queued: 30, done: 5 });
		}
		const lateDuplicate = Array.from({ length: 65 }, (_, i) => role(`r-${i}`));
		lateDuplicate.push(role("r-0"));
		expect(project(lateDuplicate).roles.some((r) => r.roleId === "r-0")).toBe(false);
	});
	it("closed awaiting/error/cached/partial/unknown states never certify freshness", () => {
		expect(projectUsefulRoles({ status: "loading", overview: null }, "open").source).toBe("awaiting");
		expect(projectUsefulRoles({ status: "error", error: "CANARY", overview: null }, "open").source).toBe("error");
		expect(projectUsefulRoles(state(undefined, { error: "CANARY" }), "open").source).toBe("cached-error");
		expect(projectUsefulRoles(state(), "closed").source).toBe("cached");
		expect(projectUsefulRoles({ overview: null }, "connecting").source).toBe("disconnected");
		expect(projectUsefulRoles(state(), "other").source).toBe("unknown");
		expect(project([]).source).toBe("partial");
	});
});

describe("actual Roles store and mounted reduced consumer", () => {
	it("one happy path shares badge watch, leaves/returns, rewatch and cleanup without extra acquisition", () => {
		const badge = watchRoles(false);
		mount();
		feed([role()]);
		expect(container.textContent).toContain("Task #1 — Reported status: working");
		expect(container.textContent).toContain("Completeness unknown");
		mount(false);
		mount(true);
		act(() => resendRolesWatch());
		expect(sent).toEqual([
			{ type: "roles_watch", full: false },
			{ type: "roles_watch", full: true },
			{ type: "roles_watch", full: false },
			{ type: "roles_watch", full: true },
			{ type: "roles_watch", full: true },
		]);
		act(() => root!.unmount());
		root = null;
		expect(sent.at(-1)).toEqual({ type: "roles_watch", full: false });
		badge();
		expect(sent.at(-1)).toEqual({ type: "roles_unwatch" });
	});
	it("error retains reported values; count/heartbeat/reconnect receipts cannot make them native fresh", () => {
		mount();
		feed([role()]);
		receive({ type: "roles", error: "CANARY-ERROR" });
		expect(container.textContent).toContain("Feed error — cached");
		expect(container.textContent).toContain("Task #1");
		receive({ type: "roles", asks: 5, checkedAt: 999999 });
		expect(container.textContent).toContain("source freshness unverified");
		act(() => setAppGlobals({ status: "closed" }));
		expect(container.textContent).toContain("Not live — cached");
		act(() => setAppGlobals({ status: "open" }));
		feed([role()]);
		expect(container.textContent).toContain("Connected — source freshness unverified");
		feed([role("backend", { queue: queue({ active: [task(4)], queued: [] }) })]);
		expect(container.textContent).not.toContain("Role ID: frontend");
		expect(container.textContent).not.toContain("Task #1");
		expect(container.textContent).toContain("Task #4");
		feed([]);
		expect(container.textContent).toContain("Roster unavailable — completeness not established");
	});
	it("canaries in every excluded raw field cannot enter closed props/DOM/attributes/logs", () => {
		const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
		const excluded: Record<string, unknown> = {};
		const fields = [
			"title",
			"plan",
			"goal",
			"question",
			"waitsOn",
			"dependencies",
			"latest",
			"tldr",
			"asks",
			"requests",
			"boardOrders",
			"board",
			"report",
			"focus",
			"goals",
			"workMode",
			"status",
			"busy",
			"homeBusy",
			"lastActivity",
			"askOps",
			"spend",
			"usage",
			"chat",
			"homeChat",
			"file",
			"url",
			"html",
		];
		for (const field of fields) excluded[field] = `CANARY-${field}`;
		const rawRole = role("ops", {
			...excluded,
			title: "<b>Safe label</b>",
			queue: queue({
				active: [
					task(1, "working", { ...excluded, id: 1, status: "working", paused: { at: 12345, why: "CANARY-why" } }),
				],
				pausedReason: "CANARY-stop",
				hold: { at: 12345, why: "CANARY-hold" },
			}),
		});
		const model = project([rawRole]);
		closed(model);
		expect(JSON.stringify(model)).not.toContain("CANARY");
		mount();
		feed([rawRole]);
		expect(container.querySelector("h2")?.textContent).toBe("<b>Safe label</b>");
		expect(container.querySelector("h2 b")).toBeNull();
		expect(container.querySelectorAll("a, button, input, svg, img, [title], [data-role-id], [onclick]")).toHaveLength(
			0,
		);
		expect(container.innerHTML).not.toContain("CANARY");
		// Inspect actual new React child props, not a parallel test renderer.
		type Fiber = { type?: { name?: string }; memoizedProps?: Record<string, unknown>; child?: Fiber; sibling?: Fiber };
		const internal = root as unknown as { _internalRoot: { current: Fiber } };
		const props: Record<string, unknown>[] = [];
		function visit(fiber?: Fiber) {
			if (!fiber) return;
			const name = fiber.type?.name;
			const allowed: Record<string, string[]> = {
				RolesUsefulView: ["active", "phone"],
				RolesUsefulContent: ["model", "phone"],
				RoleCard: ["role"],
				RecordList: ["heading", "list"],
			};
			if (name && allowed[name]) {
				keys(fiber.memoizedProps!, allowed[name]);
				props.push(fiber.memoizedProps!);
			}
			visit(fiber.child);
			visit(fiber.sibling);
		}
		visit(internal._internalRoot.current);
		expect(props.length).toBeGreaterThanOrEqual(5);
		expect(JSON.stringify(props)).not.toContain("CANARY");
		expect(JSON.stringify(logs.flatMap((log) => log.mock.calls))).not.toContain("CANARY");
	});
	it("does not inspect excluded getters; clipping does not hide full labels in DOM", () => {
		const r = role("ops", { title: "x".repeat(121) });
		Object.defineProperty(r, "homeChat", {
			get() {
				throw new Error("excluded getter accessed");
			},
		});
		mount();
		feed([r]);
		expect(container.innerHTML).not.toContain("x".repeat(121));
		expect(container.textContent).toContain("Configured label truncated to 120 code points");
	});
	it("source route has exactly the existing hooks, no old rich page/actions or side effect APIs", () => {
		const source = readFileSync(new URL("../../web/src/components/RolesUsefulView.tsx", import.meta.url), "utf8");
		const model = readFileSync(new URL("../../web/src/roles-useful-model.ts", import.meta.url), "utf8");
		const app = readFileSync(new URL("../../web/src/App.tsx", import.meta.url), "utf8");
		expect(source.match(/useRoles\(active \? "full" : "off"\)/g)).toHaveLength(1);
		expect(source.match(/useAppField\("status"\)/g)).toHaveLength(1);
		expect(app).toContain('import("./components/RolesUsefulView")');
		expect(app).not.toContain('import("./components/RolesView")');
		expect(source + model).not.toMatch(
			/localStorage|sessionStorage|fetch\(|WebSocket|setInterval|setTimeout|appSend|reloadRoles|boardRequest|dangerouslySetInnerHTML|onClick|Markdown|react-icons|TaskLink|QueuedList/,
		);
		expect(source + model).not.toMatch(/\.\.\./);
	});
	it("all eight locale packs carry the exact new English-only fork copy", () => {
		const newKeys = Object.keys(en).filter((key) => /^ru[A-Z]/.test(key)) as (keyof typeof en)[];
		for (const lang of ["de", "es", "fr", "it", "ja", "ko", "pt", "ru"]) {
			const pack = JSON.parse(readFileSync(new URL(`../../locales/${lang}.json`, import.meta.url), "utf8"));
			for (const key of newKeys) expect(pack.strings[key]).toBe(en[key]);
		}
	});
});
