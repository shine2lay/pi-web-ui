// @vitest-environment jsdom
// roles-needs-you (task #200): fixed cases for the closed projection (task names, blockers, links,
// "Needs you") and the actual store + mounted view. Server reader -> projection for answered asks and
// live dialogs: roles-useful-asks.test.ts. Real wire/browser: roles-page-test.mjs.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
import {
	ASK_LIMIT,
	NAME_LIMIT,
	projectUsefulRoles,
	RECORD_LIMIT,
	TEXT_LIMIT,
	type UsefulOpenTarget,
	type UsefulRecord,
	type UsefulRoles,
} from "../../web/src/roles-useful-model.js";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const DIR = "/home/u/.pi/agent/sessions/--home-u--";
const HOME = `${DIR}/home.jsonl`;
const chatOf = (n: number) => `${DIR}/task-${n}.jsonl`;
type Row = Record<string, unknown>;
const task = (id: unknown = 1, status: unknown = "working", extra: Row = {}) => ({
	id,
	status,
	title: `Name of ${String(id)}`,
	...extra,
});
const started = (id: number, status = "working", extra: Row = {}) =>
	task(id, status, { chat: { file: chatOf(id), where: id }, ...extra });
const queue = (extra: Row = {}) => ({
	running: true,
	active: [started(1)],
	queued: [task(20, "ready")],
	counts: { active: 1, queued: 1, done: 2 },
	...extra,
});
const role = (id: unknown = "frontend", extra: Row = {}) => ({
	id,
	title: "Frontend",
	homeChat: { file: HOME, where: "home" },
	queue: queue(),
	...extra,
});
const ask = (key: string, extra: Row = {}) => ({
	key,
	role: key.split(":")[0],
	kind: "tldr",
	text: `Text of ${key}`,
	since: NOW - 60_000,
	chat: { file: HOME, where: "home" },
	...extra,
});
const state = (roles: unknown[] = [role()], asks: unknown[] = [], extra: Row = {}) => ({
	status: "ready",
	overview: { at: NOW, roles, asks },
	checkedAt: NOW,
	heardAt: NOW,
	appliedAt: NOW,
	...extra,
});
const project = (roles: unknown[] = [role()], asks: unknown[] = [], extra: Row = {}, connection: unknown = "open") =>
	projectUsefulRoles(state(roles, asks, extra), connection, NOW);
const byId = (model: UsefulRoles, id: number): UsefulRecord => {
	for (const r of model.roles)
		for (const rec of [...r.active.records, ...r.queued.records, ...r.dropped.records])
			if (rec.taskId === id) return rec;
	throw new Error(`no task ${id}`);
};
const keys = (value: object, expected: string[]) => expect(Object.keys(value).sort()).toEqual(expected.sort());
function linkShape(link: UsefulOpenTarget) {
	keys(link, link.focus ? ["file", "focus"] : ["file"]);
	if (link.focus) keys(link.focus, ["kind", "id"]);
}
function closed(model: UsefulRoles) {
	keys(model, ["source", "roster", "omitted", "lastReceived", "roles", "needsYou"]);
	keys(model.needsYou, ["tell", "asOf", "total", "items", "more"]);
	for (const item of model.needsYou.items) {
		keys(item, ["key", "roleId", "answer", "roleLabel", "text", "since", "link"]);
		if (item.answer) keys(item.answer, ["key", "id"]);
		if (item.link) linkShape(item.link);
	}
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
			"dropped",
			"spend",
		]);
		if (r.spend) {
			keys(r.spend, ["state", "line", "amounts", "initiatives"]);
			for (const item of r.spend.initiatives) keys(item, ["id", "amount"]);
		}
		keys(r.counts, ["active", "queued", "done", "dropped"]);
		for (const list of [r.active, r.queued, r.dropped]) {
			keys(list, ["available", "omitted", "notAllShown", "records"]);
			for (const rec of list.records) {
				// roles-live (Ops #272): a line's time and a lead's role id cross only when the server sends them.
				const live = [
					...(rec.latestAt !== undefined ? ["latestAt"] : []),
					...(rec.withLead !== undefined ? ["withLead"] : []),
				];
				keys(rec, [
					"taskId",
					"name",
					"state",
					"askLead",
					"waitsOn",
					"busy",
					"latest",
					"dropped",
					"pause",
					"link",
					...live,
				]);
				if (rec.latestAt !== undefined) expect(Number.isFinite(rec.latestAt)).toBe(true);
				if (rec.withLead !== undefined) expect(rec.withLead).toMatch(/^[a-z][a-z0-9-]{0,31}$/);
				if (rec.link) linkShape(rec.link);
			}
		}
	}
}

let root: Root | null = null;
let container: HTMLDivElement;
const sent: unknown[] = [];
const opened: unknown[] = [];
const onOpen = (target: UsefulOpenTarget) => {
	opened.push(target);
};
function mount(active = true) {
	act(() => {
		root ??= createRoot(container);
		root.render(
			createElement(
				LanguageProvider,
				null,
				createElement(RolesUsefulView, { active, phone: false, onOpen, onAbout: () => undefined }),
			),
		);
	});
}
function receive(value: unknown) {
	act(() => receiveRoles(value as RolesPayload));
}
/** The server's clock: each look strictly later than the one before. */
let serverClock = 0;
/** A full update as the server sends it. The first one after a watch may replay an old look (R1). */
function overview(roles: unknown[], asks: unknown[] = [], checkedAt = ++serverClock) {
	receive({ type: "roles", overview: { at: checkedAt, roles, asks }, asks: asks.length, checkedAt });
}
/** The server's next look, unchanged: "still the same, checked at". */
function heartbeat(asks = 0, checkedAt = ++serverClock) {
	receive({ type: "roles", asks, checkedAt });
}
/** What the page sees once the server has looked again: the update, then its next look. */
function feed(roles: unknown[], asks: unknown[] = []) {
	overview(roles, asks);
	heartbeat(asks.length);
}
const text = () => container.textContent ?? "";
function click(label: string, index = 0) {
	const buttons = [...container.querySelectorAll("button")].filter((b) => b.textContent?.startsWith(label));
	expect(buttons.length).toBeGreaterThan(index);
	act(() => buttons[index].dispatchEvent(new MouseEvent("click", { bubbles: true })));
}
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	resetRolesState();
	resetAppGlobals();
	setAppGlobals({ status: "open" });
	sent.length = 0;
	opened.length = 0;
	serverClock = Date.now();
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

describe("task rows: names, plain-word status, blockers", () => {
	it("each reported status reads in plain words; unknown never reads as done", () => {
		const rows = [
			started(1, "working"),
			started(2, "asking", { askOps: true }),
			started(3, "asking"),
			started(4, "asking", { askOps: false }),
			started(5, "stuck"),
			started(6, "waiting"),
			started(7, "blocked"),
			started(8, "done"),
			started(9, "asking", { askOps: true, askLead: "temper" }),
			started(10, "asking", { askOps: true, askLead: "ops" }),
			started(14, "asking", { askOps: true, askLead: "Bad Id!" }),
			started(15, "asking", { askLead: "temper" }),
		];
		const queued = [task(11, "ready"), task(12, "mystery"), task(13, 42)];
		const model = project([
			role("frontend", { queue: queue({ active: rows, queued, counts: { active: 12, queued: 3, done: 0 } }) }),
		]);
		closed(model);
		// question-lead: a department's lead by its id; Ops, a bad id or no Ops route stay as before.
		expect([9, 10, 14, 15].map((id) => [byId(model, id).state, byId(model, id).askLead])).toEqual([
			["asking-lead", "temper"],
			["asking-ops", null],
			["asking-ops", null],
			["asking-main", null],
		]);
		const states = [1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 13].map((id) => byId(model, id).state);
		expect(states).toEqual([
			"working",
			"asking-ops",
			"asking-main",
			"asking",
			"needs-decision",
			"on-hold",
			"blocked",
			"done",
			"ready",
			"unknown",
			"unknown",
		]);
		expect(byId(model, 1).name).toBe("Name of 1");
		expect(model.source).toBe("connected-source-unverified");
	});
	it("a ready task that waits on other tasks says what it waits on, never 'ready'", () => {
		const model = project([
			role("frontend", {
				queue: queue({ queued: [task(5, "ready", { waitsOn: "#3, #4" }), task(6, "ready", { waitsOn: "  " })] }),
			}),
		]);
		expect(byId(model, 5)).toMatchObject({ state: "ready-after", waitsOn: "#3, #4" });
		expect(byId(model, 6)).toMatchObject({ state: "ready", waitsOn: null });
		mount();
		feed([role("frontend", { queue: queue({ queued: [task(5, "ready", { waitsOn: "#3, #4" })] }) })]);
		const row = [...container.querySelectorAll(".roles-useful-task")].find((li) => li.textContent?.includes("#5"));
		expect(row?.textContent).toContain("#5 Name of 5");
		expect(row?.textContent).toContain("waits on #3, #4");
		expect(row?.textContent).not.toMatch(/\bready\b/);
	});
	it("blocked and on-hold rows say what they wait on; asking says where the question is", () => {
		mount();
		feed([
			role("frontend", {
				queue: queue({
					active: [
						started(1, "blocked", { waitsOn: "temper #38" }),
						started(2, "asking", { askOps: true }),
						started(3, "asking"),
						started(4, "asking", { askOps: true, askLead: "temper" }),
					],
					queued: [],
					counts: { active: 4, queued: 0, done: 0 },
				}),
			}),
		]);
		const rows = [...container.querySelectorAll(".roles-useful-task")].map((li) => li.textContent);
		expect(rows[0]).toContain("blocked · waits on temper #38");
		expect(rows[1]).toContain("question with Ops");
		expect(rows[2]).toContain("question with its main chat");
		expect(rows[3]).toContain("question with temper's lead");
		expect(rows[3]).not.toContain("Ops");
	});
	it("working reads 'working'; a running chat adds 'working' to other statuses; only working tasks show their newest line", () => {
		const model = project([
			role("frontend", {
				queue: queue({
					active: [
						started(1, "working", { busy: true, latest: { text: "Ran the tests", ts: NOW } }),
						started(2, "working", { latest: { text: "Waiting for CI", ts: NOW } }),
						started(3, "asking", { busy: true, latest: { text: "Not shown", ts: NOW } }),
					],
				}),
			}),
		]);
		expect(byId(model, 1)).toMatchObject({ busy: true, latest: "Ran the tests" });
		expect(byId(model, 2)).toMatchObject({ busy: false, latest: "Waiting for CI" });
		expect(byId(model, 3)).toMatchObject({ busy: true, latest: null });
		mount();
		feed([
			role("frontend", {
				queue: queue({
					active: [
						started(1, "working", { busy: true, latest: { text: "Ran the tests", ts: 1 } }),
						started(3, "asking", { busy: true }),
					],
					counts: { active: 2, queued: 1, done: 2 },
				}),
			}),
		]);
		const rows = [...container.querySelectorAll(".roles-useful-task")];
		const states = rows.map((li) => li.querySelector(".roles-useful-task-state")?.textContent);
		expect(states).toEqual(["working", "question with its main chat · working", "ready"]);
		expect(rows[0].textContent).toContain("Latest: Ran the tests");
		expect(text()).not.toContain("working now");
	});
	it("stuck reads 'needs a decision' (its question goes to Ops or its lead first); pauses read 'paused'; unclear markers aren't claimed", () => {
		const paused = { at: NOW, why: "Owner: wait for Monday" };
		const model = project([
			role("frontend", {
				queue: queue({
					active: [
						started(1, "stuck"),
						started(2, "stuck", { paused }),
						started(3, "working", { paused: { at: NOW, why: " " } }),
					],
					hold: paused,
				}),
			}),
		]);
		expect(byId(model, 1)).toMatchObject({ state: "needs-decision", pause: "not-reported" });
		expect(byId(model, 2)).toMatchObject({ state: "needs-decision", pause: "reported-paused" });
		expect(byId(model, 3)).toMatchObject({ state: "working", pause: "unknown" });
		expect(model.roles[0].hold).toBe("reported-paused");
		mount();
		feed([
			role("frontend", {
				queue: queue({ active: [started(1, "stuck"), started(2, "stuck", { paused })], hold: paused }),
			}),
		]);
		const rows = [...container.querySelectorAll(".roles-useful-task-state")].map((p) => p.textContent);
		expect(rows[0]).toBe("needs a decision");
		expect(rows[1]).toBe("needs a decision · paused");
		expect(container.querySelector(".roles-useful-queue")?.textContent).toBe("Queue running · queue paused");
		expect(text()).not.toContain("Owner: wait for Monday");
		expect(text()).not.toMatch(/by you|needs you\b|stuck/);
	});
	it("stop reason only when stopped, from the fixed list only", () => {
		const stopped = project([role("frontend", { queue: queue({ running: false, pausedReason: "user" }) })]);
		expect(stopped.roles[0]).toMatchObject({ queueEnabled: false, stopReason: "user", hold: "not-reported" });
		const odd = project([role("frontend", { queue: queue({ running: false, pausedReason: "CANARY" }) })]);
		expect(odd.roles[0].stopReason).toBeNull();
		mount();
		feed([role("frontend", { queue: queue({ running: false, pausedReason: "user" }) })]);
		expect(container.querySelector(".roles-useful-queue")?.textContent).toBe("Queue stopped: you stopped it");
	});
});

describe("links: only validated in-app chat targets", () => {
	it("a started task opens its own chat; a waiting one its queue at the task; bad refs give no link", () => {
		const model = project([
			role("frontend", {
				queue: queue({
					active: [
						started(1),
						task(3, "working", { chat: { file: "relative/task.jsonl", where: 3 } }),
						task(4, "working", { chat: { file: `${DIR}/sub/../task-4.jsonl`, where: 4 } }),
						task(5, "working", { chat: { file: `${DIR}/task-5.txt`, where: 5 } }),
						task(6, "working", { chat: { file: `${DIR}/task\u202E-6.jsonl`, where: 6 } }),
						task(7, "working", { chat: "CANARY" }),
					],
					queued: [task(2, "ready"), task(1_000_000_000, "ready")],
					counts: { active: 6, queued: 2, done: 0 },
				}),
			}),
			role("backend", { homeChat: { file: "C:relative.jsonl" }, queue: queue({ active: [], queued: [task(9)] }) }),
		]);
		closed(model);
		expect(byId(model, 1).link).toEqual({ file: chatOf(1) });
		expect(byId(model, 2).link).toEqual({ file: HOME, focus: { kind: "task", id: "2" } });
		for (const id of [3, 4, 5, 6, 7, 9, 1_000_000_000]) expect(byId(model, id).link).toBeNull();
	});
	it("clicking Open hands the app exactly the validated target, nothing else", () => {
		mount();
		feed(
			[role()],
			[ask("frontend:question:q1", { kind: "question", chat: { file: chatOf(1), where: 1 }, focus: "question:q1" })],
		);
		click("Open chat");
		click("Open queue");
		click("Open", 0);
		expect(opened).toEqual([
			{ file: chatOf(1) },
			{ file: HOME, focus: { kind: "task", id: "20" } },
			{ file: chatOf(1), focus: { kind: "question", id: "q1" } },
		]);
		expect(sent.filter((m) => (m as { type?: string }).type !== "roles_watch")).toEqual([]);
	});
});

describe("Needs you", () => {
	it("lists the open asks oldest first with role, text, wait and an Open link", () => {
		const asks = [
			ask("ops:tldr:a1", { text: "Pick a port", since: NOW - 3 * 3_600_000, focus: "tldr:a1" }),
			ask("frontend:task:7", {
				kind: "task",
				text: "Which option?",
				since: NOW - 10 * 60_000,
				chat: { file: HOME, where: 7 },
				focus: "task:7",
			}),
			ask("frontend:question:q1", {
				kind: "question",
				text: "Approve the plan?",
				since: undefined,
				chat: { file: chatOf(1), where: 1 },
				focus: "question:q1",
			}),
			ask("frontend:tldr:bad", { chat: { file: "nope" }, focus: "tldr:bad" }),
		];
		const model = project([role()], asks);
		closed(model);
		expect(model.needsYou.tell).toBe("can-tell");
		expect(model.needsYou.total).toBe(4);
		expect(model.needsYou.items).toEqual([
			{
				// Keys are places in the feed, never agent text; a role missing from the roster is unknown.
				key: "0",
				roleId: null,
				roleLabel: null,
				text: "Pick a port",
				since: NOW - 3 * 3_600_000,
				link: { file: HOME, focus: { kind: "tldr", id: "a1" } },
			},
			{
				key: "1",
				roleId: "frontend",
				roleLabel: "Frontend",
				text: "Which option?",
				since: NOW - 10 * 60_000,
				link: { file: HOME, focus: { kind: "task", id: "7" } },
			},
			{
				key: "2",
				roleId: "frontend",
				roleLabel: "Frontend",
				text: "Approve the plan?",
				since: null,
				link: { file: chatOf(1), focus: { kind: "question", id: "q1" } },
			},
			{
				key: "3",
				roleId: "frontend",
				roleLabel: "Frontend",
				text: "Text of frontend:tldr:bad",
				since: NOW - 60_000,
				link: null,
			},
		]);
		mount();
		const t = Date.now();
		feed(
			[role()],
			// 30 s margin: the view's clock was read at mount, a moment before `t`.
			asks.map((a) => ({ ...a, since: a.since === undefined ? undefined : t - (NOW - a.since) - 30_000 })),
		);
		const section = container.querySelector(".roles-useful-needs");
		expect(section?.querySelector("h2")?.textContent).toBe("Needs you (4)");
		const items = [...(section?.querySelectorAll("li") ?? [])].map((li) => li.textContent);
		expect(items[0]).toContain("Pick a port");
		expect(items[0]).toContain("Unknown role · waiting 3 h");
		expect(items[1]).toContain("Frontend · waiting 10 min");
		expect(items[2]).toContain("Frontend · time unknown");
		expect(items[2]).not.toContain("waiting");
		expect(section?.querySelectorAll("button")).toHaveLength(3);
		expect(section?.querySelectorAll("q.roles-useful-agent")).toHaveLength(4);
		expect(text()).not.toContain("None reported");
		expect(text()).toContain("Checks only: needs-you lines, task questions passed to you, open dialogs in role chats.");
	});
	it("empty while current: 'none reported', as of when the server was last heard looking again", () => {
		const model = project([role()], []);
		expect(model.needsYou).toEqual({ tell: "can-tell", asOf: NOW, total: 0, items: [], more: 0 });
		expect(model.lastReceived).toBe(false);
		mount();
		feed([role()]);
		expect(container.querySelector(".roles-useful-clear")?.textContent).toMatch(
			/^None reported to you in role chats and queues — last update received \d{2}:\d{2}\. This can miss items\.$/,
		);
		expect(container.querySelector(".roles-useful-cant")).toBeNull();
	});
	it("empty while not current, failed, partial or unclear: can't tell, never an all-clear", () => {
		const many = Array.from({ length: 9 }, (_, i) => started(i + 1));
		const cases: [string, UsefulRoles, string][] = [
			["cached", project([role()], [], {}, "closed"), "not-live"],
			["connecting", project([role()], [], {}, "connecting"), "not-live"],
			["stale", projectUsefulRoles(state([role()], [], { heardAt: NOW - 121_000 }), "open", NOW), "not-live"],
			["no heartbeat time", projectUsefulRoles(state([role()], [], { heardAt: undefined }), "open", NOW), "not-live"],
			["cached error", project([role()], [], { error: "boom" }), "feed-error"],
			[
				"error, nothing cached",
				projectUsefulRoles({ status: "error", overview: null, error: "x" }, "open", NOW),
				"feed-error",
			],
			["awaiting", projectUsefulRoles({ status: "loading", overview: null }, "open", NOW), "awaiting"],
			["role problem", project([role("frontend", { problems: ["home chat"] })]), "partial"],
			["safe role problem", project([role("frontend", { problems: ["report"] })]), "partial"],
			["roster empty", project([]), "partial"],
			["role omitted", project([role(), { id: "Bad Id" }]), "partial"],
			[
				"9 started chats, an older server (no allChatsRead)",
				project([role("frontend", { queue: queue({ active: many }) })]),
				"partial",
			],
			// roles-asks-read: the server's own word that a started chat wasn't read.
			[
				"the server says not every started chat was read",
				project([role("frontend", { allChatsRead: false })]),
				"partial",
			],
			[
				"a flag that isn't a boolean: the old count rule",
				project([role("frontend", { queue: queue({ active: many }), allChatsRead: "yes" })]),
				"partial",
			],
			[
				"asks not a list",
				projectUsefulRoles({ ...state(), overview: { at: NOW, roles: [role()] } }, "open", NOW),
				"partial",
			],
			["no full update since the latest watch", project([role()], [], { appliedAt: undefined }), "awaiting"],
			["unknown connection", project([role()], [], {}, "weird"), "unknown"],
			[
				"stuck task, its question not listed",
				project([role("frontend", { queue: queue({ active: [started(1, "stuck")] }) })]),
				"decision",
			],
			[
				"stuck task under an unclear pause",
				project([role("frontend", { queue: queue({ active: [started(1, "stuck", { paused: { at: NOW } })] }) })]),
				"decision",
			],
		];
		for (const [name, model, tell] of cases) {
			expect({ name, tell: model.needsYou.tell }).toEqual({ name, tell });
			expect({ name, asOf: model.needsYou.asOf }).toEqual({ name, asOf: null });
			// Shown counts are then marked last received, not current.
			expect({ name, lastReceived: model.lastReceived }).toEqual({ name, lastReceived: model.roles.length > 0 });
		}
		// The same 8 started chats an older server reads is still complete.
		expect(project([role("frontend", { queue: queue({ active: many.slice(0, 8) }) })]).needsYou.tell).toBe("can-tell");
		// roles-asks-read: a server that read every started chat says so, however many there are.
		const forty = Array.from({ length: 40 }, (_, i) => started(i + 1));
		for (const active of [many, forty])
			expect(project([role("frontend", { queue: queue({ active }), allChatsRead: true })]).needsYou.tell).toBe(
				"can-tell",
			);
		// A stuck task is accounted for when its question is listed, or when it or its queue is paused.
		const paused = { at: NOW, why: "Owner: later" };
		for (const model of [
			project([role("frontend", { queue: queue({ active: [started(1, "stuck")] }) })], [ask("frontend:task:1")]),
			project([role("frontend", { queue: queue({ active: [started(1, "stuck", { paused })] }) })]),
			project([role("frontend", { queue: queue({ active: [started(1, "stuck")], hold: paused }) })]),
		])
			expect(model.needsYou.tell).toBe("can-tell");
		// Asks that can't be read still count and show ("Open item", "Unknown role"); nothing is merged.
		const odd = project([role()], [ask("ops:tldr:x"), ask("ops:tldr:x"), { key: 7, role: "Not A Role" }, "CANARY"]);
		expect(odd.needsYou).toMatchObject({ tell: "can-tell", total: 4, more: 0 });
		expect(odd.needsYou.items.map((item) => [item.key, item.roleLabel, item.text, item.since, item.link])).toEqual([
			["0", null, "Text of ops:tldr:x", NOW - 60_000, { file: HOME }],
			["1", null, "Text of ops:tldr:x", NOW - 60_000, { file: HOME }],
			["2", null, null, null, null],
			["3", null, null, null, null],
		]);
		// An ask dated well ahead of this browser's clock has no age to show.
		const ahead = project([role()], [ask("frontend:tldr:f", { since: NOW + 301_000 })]);
		expect(ahead.needsYou.items[0].since).toBeNull();
	});
	it("more than the shown asks: says how many more", () => {
		const asks = Array.from({ length: ASK_LIMIT + 3 }, (_, i) => ask(`ops:tldr:k${i}`));
		const model = project([role()], asks);
		expect(model.needsYou.items).toHaveLength(ASK_LIMIT);
		expect(model.needsYou.more).toBe(3);
		mount();
		feed([role()], asks);
		expect(container.querySelector(".roles-useful-needs h2")?.textContent).toBe(`Needs you (${ASK_LIMIT + 3})`);
		expect(text()).toContain("3 more not shown.");
	});
});

describe("counts, caps and problems", () => {
	it("25 queued tasks: 20 shown with the real total; server-capped lists say the same", () => {
		const queued = Array.from({ length: 25 }, (_, i) => task(101 + i, "ready"));
		const model = project([role("frontend", { queue: queue({ queued, counts: { active: 1, queued: 25, done: 0 } }) })]);
		expect(model.roles[0].queued).toMatchObject({ available: true, omitted: false, notAllShown: true });
		expect(model.roles[0].queued.records).toHaveLength(RECORD_LIMIT);
		const capped = project([
			role("frontend", { queue: queue({ queued: queued.slice(0, 20), counts: { active: 1, queued: 25, done: 0 } }) }),
		]);
		expect(capped.roles[0].queued).toMatchObject({ omitted: false, notAllShown: true });
		mount();
		feed([
			role("frontend", { queue: queue({ queued: queued.slice(0, 20), counts: { active: 1, queued: 25, done: 0 } }) }),
		]);
		expect(text()).toContain("Waiting to start (25)");
		expect(text()).toContain("Showing 20 of 25.");
		expect(text()).not.toContain("Some tasks couldn't be shown.");
	});
	it("zero counts show 0 when the queue was read cleanly, 'couldn't read' when it wasn't", () => {
		const empty = queue({ active: [], queued: [], counts: { active: 0, queued: 0, done: 0 } });
		const clean = project([role("frontend", { queue: empty })]);
		// queue-drop: no dropped count and no dropped list from the server means none dropped.
		expect(clean.roles[0].counts).toEqual({ active: 0, queued: 0, done: 0, dropped: 0 });
		const broken = project([role("frontend", { queue: empty, problems: ["home chat"] })]);
		expect(broken.roles[0].counts).toEqual({
			active: "unavailable",
			queued: "unavailable",
			done: "unavailable",
			dropped: "unavailable",
		});
		expect(broken.roles[0].partial).toBe(true);
		// Any reported problem: no number is shown for that role, zero or not.
		const safe = project([role("frontend", { queue: empty, problems: ["report", "task #4 chat"] })]);
		expect(safe.roles[0].counts).toEqual({
			active: "unavailable",
			queued: "unavailable",
			done: "unavailable",
			dropped: "unavailable",
		});
		expect(safe.roles[0].partial).toBe(true);
		// No defaults and no numbers that disagree with the rows received (queued rows may be capped).
		const odd = (counts: unknown, extra: Row = {}) =>
			project([role("frontend", { queue: queue({ counts, ...extra }) })]).roles[0].counts;
		expect(odd({ active: 2, queued: 1, done: 0 })).toMatchObject({ active: "unavailable", queued: 1, done: 0 });
		expect(odd({ active: 1, queued: 0, done: -1 })).toEqual({
			active: 1,
			queued: "unavailable",
			done: "unavailable",
			dropped: 0,
		});
		expect(odd({ active: 1, queued: 30, done: 1.5 })).toEqual({
			active: 1,
			queued: 30,
			done: "unavailable",
			dropped: 0,
		});
		expect(odd({ active: "1", queued: null })).toEqual({
			active: "unavailable",
			queued: "unavailable",
			done: "unavailable",
			dropped: 0,
		});
		expect(odd(undefined)).toEqual({
			active: "unavailable",
			queued: "unavailable",
			done: "unavailable",
			dropped: "unavailable",
		});
		const none = project([role("frontend", { queue: undefined })]);
		expect(none.roles[0].counts).toEqual({
			active: "no-queue",
			queued: "no-queue",
			done: "no-queue",
			dropped: "no-queue",
		});
		mount();
		feed([
			role("frontend", { queue: empty }),
			role("backend", { title: "Backend", queue: empty, problems: ["home chat"] }),
		]);
		const [front, back] = [...container.querySelectorAll(".roles-useful-card")].map((c) => c.textContent);
		expect(front).toContain("Started (0)");
		expect(front).toContain("Waiting to start (0)");
		expect(front).not.toMatch(/None|nothing/i);
		expect(front).toContain("Done, still in the queue: 0");
		expect(back).toContain("Started (couldn't read)");
		expect(back).toContain("Done, still in the queue: couldn't read");
		expect(back).toContain("Some of this role's data couldn't be read.");
	});
	it("queue-drop: tasks its lead dropped are listed apart, each with why, and counted", () => {
		const gone = (id: number, why: unknown, extra: Row = {}) =>
			task(id, "dropped", { dropped: { why, at: NOW - 5_000 }, ...extra });
		const dropped = [gone(7, "Superseded by #9", { chat: { file: chatOf(7), where: 7 } }), gone(8, "\u202Espoof")];
		const model = project([
			role("frontend", { queue: queue({ dropped, counts: { active: 1, queued: 1, done: 2, dropped: 6 } }) }),
		]);
		const r = model.roles[0];
		expect(r.counts.dropped).toBe(6);
		expect(r.dropped.records.map((x) => [x.taskId, x.state, x.dropped])).toEqual([
			[7, "dropped", "Superseded by #9"],
			[8, "dropped", null],
		]);
		expect(byId(model, 7).link?.file).toBe(chatOf(7));
		expect(r.dropped.notAllShown).toBe(true);
		expect(byId(model, 1).dropped).toBeNull();
		closed(model);
		// A list without its count, or a count the rows don't fit, shows no number.
		const odd = (counts: Row) =>
			project([role("frontend", { queue: queue({ dropped: [gone(7, "x")], counts }) })]).roles[0].counts.dropped;
		expect(odd({ active: 1, queued: 1, done: 2 })).toBe("unavailable");
		expect(odd({ active: 1, queued: 1, done: 2, dropped: 0 })).toBe("unavailable");
		mount();
		feed([
			role("frontend", {
				queue: queue({ dropped: [gone(7, "Superseded by #9")], counts: { active: 1, queued: 1, done: 2, dropped: 1 } }),
			}),
			role("backend", { title: "Backend" }),
		]);
		const [front, back] = [...container.querySelectorAll(".roles-useful-card")].map((c) => c.textContent);
		expect(front).toContain("Dropped by the lead (1)");
		expect(front).toContain("dropped by the lead: Superseded by #9");
		expect(back).not.toContain("Dropped by the lead");
	});
	it("a malformed list is 'couldn't read'; duplicate ids are dropped with a note", () => {
		const model = project([
			role("frontend", {
				queue: queue({ active: "CANARY", queued: [task(2, "ready"), task(2, "ready"), task(3, "ready")] }),
			}),
		]);
		expect(model.roles[0].active.available).toBe(false);
		expect(model.roles[0].queued.records.map((r) => r.taskId)).toEqual([3]);
		expect(model.roles[0].queued.omitted).toBe(true);
		expect(model.roles[0].partial).toBe(true);
	});
});

describe("agent-written text: bounded plain text or a fixed fallback", () => {
	it("long names clip at 160 code points; Unicode stays whole; bidi/control/format chars fall back to Task #N", () => {
		const queued = [
			task(1, "ready", { title: "x".repeat(200) }),
			task(2, "ready", { title: "😀".repeat(170) }),
			task(3, "ready", { title: "日本語のタスク — ünïcödé" }),
			task(4, "ready", { title: "abc\u202Edef" }),
			task(5, "ready", { title: "beep\u0007" }),
			task(6, "ready", { title: "a\tb\nc\r\nd" }),
			task(7, "ready", { title: "\u2066isolated\u2069" }),
			task(8, "ready", { title: "zero\u200Bwidth" }),
			task(9, "ready", { title: "   " }),
			task(10, "ready", { title: 42 }),
			task(11, "ready", { title: "lone \uD800 surrogate" }),
			task(12, "ready", { title: "x".repeat(NAME_LIMIT) }),
		];
		const model = project([
			role("frontend", { queue: queue({ active: [], queued, counts: { active: 0, queued: 12, done: 0 } }) }),
		]);
		const name = (id: number) => byId(model, id).name;
		expect(Array.from(name(1)!)).toHaveLength(NAME_LIMIT);
		expect(name(1)!.endsWith("…")).toBe(true);
		expect(Array.from(name(2)!)).toHaveLength(NAME_LIMIT);
		expect(name(2)!.startsWith("😀😀")).toBe(true);
		expect(name(3)).toBe("日本語のタスク — ünïcödé");
		for (const id of [4, 5, 7, 8, 9, 10, 11]) expect({ id, name: name(id) }).toEqual({ id, name: null });
		expect(name(6)).toBe("a b c d");
		expect(name(12)).toBe("x".repeat(NAME_LIMIT));
		mount();
		feed([role("frontend", { queue: queue({ queued: [task(4, "ready", { title: "abc\u202Edef" })] }) })]);
		expect(text()).toContain("Task #4");
		expect(text()).not.toContain("\u202E");
	});
	it("ask text clips at 300; unsafe ask text falls back to 'Open item'; waitsOn and latest are bounded too", () => {
		const model = project(
			[
				role("frontend", {
					queue: queue({
						active: [
							started(1, "blocked", { waitsOn: "w".repeat(400) }),
							started(2, "working", { latest: { text: "l".repeat(400) } }),
						],
					}),
				}),
			],
			[ask("ops:tldr:long", { text: "t".repeat(400) }), ask("ops:tldr:bidi", { text: "x\u202Ey" })],
		);
		expect(Array.from(model.needsYou.items[0].text!)).toHaveLength(TEXT_LIMIT);
		expect(model.needsYou.items[1].text).toBeNull();
		expect(Array.from(byId(model, 1).waitsOn!)).toHaveLength(NAME_LIMIT);
		expect(Array.from(byId(model, 2).latest!)).toHaveLength(TEXT_LIMIT);
		mount();
		feed([role()], [ask("ops:tldr:bidi", { text: "x\u202Ey" })]);
		expect(container.querySelector(".roles-useful-ask-text")?.textContent).toBe("Open item");
	});
	it("HTML-looking text is shown as text, never as markup", () => {
		const html = '<img src=x onerror="alert(1)"><b>bold</b>';
		mount();
		feed(
			[role("frontend", { title: "<i>Front</i>", queue: queue({ active: [started(1, "working", { title: html })] }) })],
			[ask("frontend:tldr:h", { text: html })],
		);
		expect(container.querySelector(".roles-useful img, .roles-useful b, .roles-useful i")).toBeNull();
		expect(text()).toContain(html);
		expect(container.querySelector(".roles-useful-card h2")?.textContent).toBe("<i>Front</i>");
	});
	it("configured role labels clip at 120 with a note and no hidden full label", () => {
		mount();
		feed([role("ops", { title: "x".repeat(121) })]);
		expect(container.innerHTML).not.toContain("x".repeat(121));
		expect(text()).toContain("Name shortened to 120 characters.");
	});
});

describe("closed boundary and the actual store", () => {
	it("canaries in every field outside the contract never reach the model, props, DOM or logs", () => {
		const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
		const excluded: Row = {};
		for (const field of [
			"plan",
			"goal",
			"question",
			"dependencies",
			"tldr",
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
			"spend",
			"usage",
			"url",
			"html",
			"summary",
		])
			excluded[field] = `CANARY-${field}`;
		const rawRole = role("ops", {
			...excluded,
			title: "Ops",
			queue: queue({
				active: [
					started(1, "working", {
						...excluded,
						status: "working",
						busy: true,
						title: "Visible name",
						latest: { text: "Visible line", ts: NOW, html: "CANARY-latest-html" },
						paused: { at: 12345, why: "CANARY-why" },
					}),
				],
				queued: [task(2, "stuck", { ...excluded, status: "stuck", question: "CANARY-question" })],
				pausedReason: "CANARY-stop",
				hold: { at: 12345, why: "CANARY-hold" },
			}),
		});
		const rawAsk = ask("ops:task:2", {
			kind: "CANARY-kind",
			text: "Visible ask",
			html: "CANARY-ask",
			url: "CANARY-url",
		});
		const model = project([rawRole], [rawAsk]);
		closed(model);
		expect(JSON.stringify(model)).not.toContain("CANARY");
		mount();
		feed([rawRole], [rawAsk]);
		expect(text()).toContain("Visible name");
		expect(text()).toContain("Visible ask");
		expect(container.innerHTML).not.toContain("CANARY");
		expect(container.querySelectorAll("a, input, svg, img, [title], [href], [data-role-id]")).toHaveLength(0);
		for (const button of container.querySelectorAll("button"))
			expect(button.getAttributeNames().sort()).toEqual(["class", "type"]);
		type Fiber = { type?: { name?: string }; memoizedProps?: Record<string, unknown>; child?: Fiber; sibling?: Fiber };
		const internal = root as unknown as { _internalRoot: { current: Fiber } };
		const allowed: Record<string, string[]> = {
			// Only callbacks and the explicitly projected view cross component boundaries.
			RolesUsefulView: ["active", "phone", "onOpen", "onAbout"],
			RolesUsefulContent: ["model", "phone", "now", "onOpen", "onDetails", "onAnswer"],
			NeedsYouSection: ["needs", "now", "onOpen", "onAnswer"],
			AskRow: ["item", "now", "onOpen", "onAnswer"],
			RoleCard: ["role", "onOpen", "onDetails"],
			RoleSpend: ["spend"],
			RecordList: ["heading", "list", "count", "onOpen"],
			TaskRow: ["record", "onOpen"],
		};
		const seen = new Set<string>();
		const props: Record<string, unknown>[] = [];
		function visit(fiber?: Fiber) {
			if (!fiber) return;
			const name = fiber.type?.name;
			if (name && allowed[name]) {
				keys(fiber.memoizedProps!, allowed[name]);
				props.push(fiber.memoizedProps!);
				seen.add(name);
			}
			visit(fiber.child);
			visit(fiber.sibling);
		}
		visit(internal._internalRoot.current);
		expect([...seen].sort()).toEqual(Object.keys(allowed).sort());
		expect(JSON.stringify(props)).not.toContain("CANARY");
		expect(JSON.stringify(logs.flatMap((log) => log.mock.calls))).not.toContain("CANARY");
	});
	it("does not read getters outside the contract", () => {
		const r = role("ops");
		for (const field of ["tldr", "latest", "requests"])
			Object.defineProperty(r, field, {
				get() {
					throw new Error(`excluded getter ${field} accessed`);
				},
			});
		mount();
		feed([r]);
		expect(text()).toContain("Name of 1");
	});
	it("one happy path shares the badge watch; leave/return, rewatch and cleanup send no extra watch", () => {
		const badge = watchRoles(false);
		mount();
		feed([role()]);
		expect(text()).toContain("#1 Name of 1");
		expect(text()).toContain("Connected");
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
	it("error, count-only receipts and reconnects never make a cached snapshot read as current", () => {
		mount();
		feed([role()]);
		expect(container.querySelector(".roles-useful-clear")).not.toBeNull();
		receive({ type: "roles", asks: 0, error: "CANARY-ERROR" });
		expect(text()).toContain("The roles feed failed — showing the last update received");
		expect(text()).toContain("Can't tell right now: the roles feed reported an error.");
		expect(text()).toContain("#1 Name of 1");
		expect(text()).toContain("Last received values below; they may be out of date.");
		receive({ type: "roles", asks: 5 });
		expect(text()).toContain("Can't tell right now");
		expect(container.querySelector(".roles-useful-clear")).toBeNull();
		act(() => setAppGlobals({ status: "closed" }));
		expect(text()).toContain("Not connected — showing the last update received");
		expect(text()).toContain("Can't tell right now: this page isn't getting live updates.");
		expect(container.querySelector(".roles-useful-clear")).toBeNull();
		act(() => setAppGlobals({ status: "open" }));
		feed([role("backend", { title: "Backend", queue: queue({ active: [started(4)], queued: [] }) })]);
		expect(text()).not.toContain("Last received values below");
		expect(container.querySelector(".roles-useful-clear")).not.toBeNull();
		// Reconnected: the app watches again; until the server has looked again since, the old update
		// isn't current, and neither a count-only receipt nor a heartbeat ahead of the first update makes it so.
		act(() => resendRolesWatch());
		expect(text()).toContain("Can't tell right now: no fresh update has arrived since this page connected.");
		expect(text()).toContain("Last received values below; they may be out of date.");
		expect(container.querySelector(".roles-useful-clear")).toBeNull();
		receive({ type: "roles", asks: 0 });
		heartbeat();
		expect(container.querySelector(".roles-useful-clear")).toBeNull();
		feed([role("backend", { title: "Backend", queue: queue({ active: [started(4)], queued: [] }) })]);
		expect(text()).not.toContain("Frontend");
		expect(text()).toContain("#4 Name of 4");
		expect(container.querySelector(".roles-useful-clear")).not.toBeNull();
		expect(text()).not.toContain("CANARY");
		feed([]);
		expect(text()).toContain("No roles to show.");
		expect(text()).toContain("Can't tell right now: some roles, tasks or chats couldn't be read.");
	});
	it("R1: a replayed update isn't current until the server has looked again (strictly newer checkedAt)", () => {
		const clear = () => container.querySelector(".roles-useful-clear");
		mount();
		// Replay only: on a watch the server first sends its last look again, with that look's old time.
		const old = serverClock - 600_000;
		overview([role()], [], old);
		expect(text()).toContain("#1 Name of 1");
		expect(text()).toContain("Can't tell right now: no fresh update has arrived since this page connected.");
		expect(clear()).toBeNull();
		// Not newer: the same look again, an older one, or no usable time.
		for (const checkedAt of [old, old - 1, Number.NaN, -1, 1.5, "later"]) heartbeat(0, checkedAt as number);
		expect(clear()).toBeNull();
		// A newer heartbeat: the server read again and nothing changed.
		heartbeat();
		expect(clear()).not.toBeNull();
		// An error, then a rewatch, then the replay of the server's last look: still can't tell.
		receive({ type: "roles", asks: 0, error: "CANARY-ERROR" });
		expect(clear()).toBeNull();
		act(() => resendRolesWatch());
		overview([role()], [], serverClock);
		expect(clear()).toBeNull();
		expect(text()).toContain("Can't tell right now");
		// A newer full update (the next look found a change) is current again.
		overview([role()]);
		expect(clear()).not.toBeNull();
		expect(text()).not.toContain("CANARY");
	});
	it("R1: leaving and coming back, a heartbeat ahead of the first update, or an older update never vouch for it", () => {
		const clear = () => container.querySelector(".roles-useful-clear");
		mount();
		feed([role()]);
		expect(clear()).not.toBeNull();
		// Leave and come back: a new full watch; nothing is current until the server looks again.
		mount(false);
		mount(true);
		expect(clear()).toBeNull();
		heartbeat(); // already on its way before the watch: there is no first update yet
		expect(clear()).toBeNull();
		overview([role()]); // the first update since this watch, perhaps a replay
		expect(clear()).toBeNull();
		heartbeat();
		expect(clear()).not.toBeNull();
		// A full update older than the first one since the watch withdraws it.
		overview([role()], [], serverClock - 10_000);
		expect(clear()).toBeNull();
	});
	it("R2: the count shows only when something is listed or the page can tell; never 0 beside can't tell", () => {
		const heading = () => container.querySelector(".roles-useful-needs h2")?.textContent;
		mount();
		overview([role()]);
		expect(heading()).toBe("Needs you");
		heartbeat();
		expect(heading()).toBe("Needs you (0)");
		expect(container.querySelector(".roles-useful-clear")).not.toBeNull();
		receive({ type: "roles", asks: 0, error: "x" });
		expect(heading()).toBe("Needs you");
		overview([role("frontend", { problems: ["home chat"] })]);
		expect(text()).toContain("Can't tell right now: some roles, tasks or chats couldn't be read.");
		expect(heading()).toBe("Needs you");
		overview([role()]);
		expect(heading()).toBe("Needs you (0)");
		act(() => setAppGlobals({ status: "closed" }));
		expect(heading()).toBe("Needs you");
		act(() => setAppGlobals({ status: "open" }));
		overview([role()], [ask("frontend:tldr:a")]);
		act(() => setAppGlobals({ status: "closed" }));
		expect(heading()).toBe("Needs you (1)");
		expect(text()).toContain("Can't tell right now: this page isn't getting live updates.");
		expect(text()).not.toMatch(/\(0\)/);
	});
	it("source route: links only through onOpen, answers through the guarded dialog, no rich content or side-effect APIs", () => {
		const source = readFileSync(resolve(process.cwd(), "web/src/components/RolesUsefulView.tsx"), "utf8");
		const model = readFileSync(resolve(process.cwd(), "web/src/roles-useful-model.ts"), "utf8");
		const app = readFileSync(resolve(process.cwd(), "web/src/App.tsx"), "utf8");
		expect(source.match(/useRoles\(active \? "full" : "off"\)/g)).toHaveLength(1);
		expect(source.match(/useAppField\("status"\)/g)).toHaveLength(1);
		// roles-exact: the supplied design now uses this same closed model; the useful
		// list remains a tested rollback surface, not the app's mounted page.
		expect(app).toContain('import("./components/RolesExactView")');
		expect(app).not.toContain('import("./components/RolesView")');
		// roles-panel: About & rules opens Settings at the role, the way the old panel did.
		expect(app).toMatch(
			/<RolesExactView\s+active=\{view === "roles"\}\s+onOpen=\{openFromRolesPage\}\s+onAbout=\{aboutFromRoles\}\s+\/>/,
		);
		// The page's opens are remembered first (fixed words on failure), then go the existing way.
		expect(app).toMatch(/markRolesOpen\(target\.file\);\s*openFromRoles\(target\);/);
		// Two chat links, Details opens the panel, Answer opens only the guarded dialog.
		expect(source.match(/onClick=/g)).toHaveLength(4);
		expect(source.match(/onClick=\{\(e\) => onAnswer\(item, e\.currentTarget\)\}/g)).toHaveLength(1);
		expect(source).toContain('<RoleAnswerDialog item={answer.item} connected={connection === "open"}');
		expect(source.match(/onClick=\{\(\) => onOpen\(link\)\}/g)).toHaveLength(2);
		expect(source.match(/onClick=\{\(e\) => onDetails\(role\.roleId, e\.currentTarget\)\}/g)).toHaveLength(1);
		expect(source + model).not.toMatch(
			/localStorage|sessionStorage|fetch\(|WebSocket|setTimeout|appSend|reloadRoles|boardRequest|dangerouslySetInnerHTML|innerHTML|href|Markdown|react-icons|TaskLink|QueuedList|window\.open/,
		);
		expect(source + model).not.toMatch(/\.\.\./);
	});
	it("all eight locale packs carry the exact English fork copy", () => {
		const newKeys = Object.keys(en).filter((key) => /^(?:ru|ra)[A-Z]/.test(key)) as (keyof typeof en)[];
		expect(newKeys.length).toBeGreaterThan(60);
		for (const lang of ["de", "es", "fr", "it", "ja", "ko", "pt", "ru"]) {
			const pack = JSON.parse(readFileSync(resolve(process.cwd(), `locales/${lang}.json`), "utf8"));
			for (const key of newKeys) expect({ lang, key, value: pack.strings[key] }).toEqual({ lang, key, value: en[key] });
		}
	});
});
