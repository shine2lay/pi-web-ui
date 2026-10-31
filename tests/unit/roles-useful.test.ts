// @vitest-environment jsdom
// roles-needs-you (task #200): fixed cases for the closed projection (task names, blockers, links,
// "Needs you") and for the actual store projected the way the mounted Roles page projects it.
// Server reader -> projection for answered asks and live dialogs: roles-useful-asks.test.ts.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAppGlobals, resetAppGlobals, setAppGlobals, setAppSend } from "../../web/src/app-globals.js";
import { en } from "../../web/src/i18n.js";
import {
	receiveRoles,
	resendRolesWatch,
	resetRolesState,
	rolesSnapshot,
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
		keys(item, ["key", "roleId", "answer", "roleLabel", "text", "since", "link", "chatAnswer"]);
		if (item.answer) keys(item.answer, ["key", "id"]);
		if (item.chatAnswer) keys(item.chatAnswer, ["key"]);
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

const sent: unknown[] = [];
/** The Roles page's own watch, held the way its useRoles(active ? "full" : "off") holds it. */
let stopPageWatch: (() => void) | null = null;
function showPage(active = true) {
	if (active && !stopPageWatch) stopPageWatch = watchRoles(true);
	if (!active && stopPageWatch) {
		stopPageWatch();
		stopPageWatch = null;
	}
}
/** The store as the page projects it: its snapshot, the app's connection, the time now. */
const page = () => projectUsefulRoles(rolesSnapshot(), getAppGlobals().status, Date.now());
/** When the page may say all clear: it can tell, nothing is listed, and it knows as of when. */
function allClear() {
	const { tell, total, asOf } = page().needsYou;
	return tell === "can-tell" && total === 0 && asOf !== null;
}
function receive(value: unknown) {
	receiveRoles(value as RolesPayload);
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
beforeEach(() => {
	resetRolesState();
	resetAppGlobals();
	setAppGlobals({ status: "open" });
	sent.length = 0;
	serverClock = Date.now();
	setAppSend((message) => {
		sent.push(message);
		return true;
	});
});
afterEach(() => {
	showPage(false);
	setAppSend(null);
	resetRolesState();
	resetAppGlobals();
	vi.restoreAllMocks();
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
	});
	it("stop reason only when stopped, from the fixed list only", () => {
		const stopped = project([role("frontend", { queue: queue({ running: false, pausedReason: "user" }) })]);
		expect(stopped.roles[0]).toMatchObject({ queueEnabled: false, stopReason: "user", hold: "not-reported" });
		const odd = project([role("frontend", { queue: queue({ running: false, pausedReason: "CANARY" }) })]);
		expect(odd.roles[0].stopReason).toBeNull();
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
				chatAnswer: { key: "frontend:question:q1" },
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
	});
	it("empty while current: 'none reported', as of when the server was last heard looking again", () => {
		const model = project([role()], []);
		expect(model.needsYou).toEqual({ tell: "can-tell", asOf: NOW, total: 0, items: [], more: 0 });
		expect(model.lastReceived).toBe(false);
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
	});
	it("configured role labels clip at 120, flagged for the note, with no hidden full label", () => {
		const model = project([role("ops", { title: "x".repeat(121) })]);
		expect(model.roles[0].labelTruncated).toBe(true);
		expect(JSON.stringify(model)).not.toContain("x".repeat(121));
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
		// The same raw update through the actual store, as the page receives and projects it.
		showPage();
		feed([rawRole], [rawAsk]);
		const fed = page();
		expect(byId(fed, 1).name).toBe("Visible name");
		expect(fed.needsYou.items.map((item) => item.text)).toContain("Visible ask");
		expect(JSON.stringify(fed)).not.toContain("CANARY");
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
		showPage();
		feed([r]);
		expect(byId(page(), 1).name).toBe("Name of 1");
	});
	it("one happy path shares the badge watch; leave/return, rewatch and cleanup send no extra watch", () => {
		const badge = watchRoles(false);
		showPage();
		feed([role()]);
		expect(byId(page(), 1).name).toBe("Name of 1");
		expect(page().source).toBe("connected-source-unverified");
		showPage(false);
		showPage(true);
		resendRolesWatch();
		expect(sent).toEqual([
			{ type: "roles_watch", full: false },
			{ type: "roles_watch", full: true },
			{ type: "roles_watch", full: false },
			{ type: "roles_watch", full: true },
			{ type: "roles_watch", full: true },
		]);
		showPage(false);
		expect(sent.at(-1)).toEqual({ type: "roles_watch", full: false });
		badge();
		expect(sent.at(-1)).toEqual({ type: "roles_unwatch" });
	});
	it("error, count-only receipts and reconnects never make a cached snapshot read as current", () => {
		showPage();
		feed([role()]);
		expect(allClear()).toBe(true);
		receive({ type: "roles", asks: 0, error: "CANARY-ERROR" });
		expect(page().source).toBe("cached-error");
		expect(page().needsYou.tell).toBe("feed-error");
		expect(byId(page(), 1).name).toBe("Name of 1");
		expect(page().lastReceived).toBe(true);
		receive({ type: "roles", asks: 5 });
		expect(page().needsYou.tell).not.toBe("can-tell");
		expect(allClear()).toBe(false);
		setAppGlobals({ status: "closed" });
		expect(page().source).toBe("cached");
		expect(page().needsYou.tell).toBe("not-live");
		expect(allClear()).toBe(false);
		setAppGlobals({ status: "open" });
		feed([role("backend", { title: "Backend", queue: queue({ active: [started(4)], queued: [] }) })]);
		expect(page().lastReceived).toBe(false);
		expect(allClear()).toBe(true);
		// Reconnected: the app watches again; until the server has looked again since, the old update
		// isn't current, and neither a count-only receipt nor a heartbeat ahead of the first update makes it so.
		resendRolesWatch();
		expect(page().needsYou.tell).toBe("awaiting");
		expect(page().lastReceived).toBe(true);
		expect(allClear()).toBe(false);
		receive({ type: "roles", asks: 0 });
		heartbeat();
		expect(allClear()).toBe(false);
		feed([role("backend", { title: "Backend", queue: queue({ active: [started(4)], queued: [] }) })]);
		expect(page().roles.map((r) => r.roleId)).not.toContain("frontend");
		expect(byId(page(), 4).name).toBe("Name of 4");
		expect(allClear()).toBe(true);
		expect(JSON.stringify(page())).not.toContain("CANARY");
		feed([]);
		expect(page().roster).toBe("unavailable");
		expect(page().needsYou.tell).toBe("partial");
	});
	it("R1: a replayed update isn't current until the server has looked again (strictly newer checkedAt)", () => {
		showPage();
		// Replay only: on a watch the server first sends its last look again, with that look's old time.
		const old = serverClock - 600_000;
		overview([role()], [], old);
		expect(byId(page(), 1).name).toBe("Name of 1");
		expect(page().needsYou.tell).toBe("awaiting");
		expect(allClear()).toBe(false);
		// Not newer: the same look again, an older one, or no usable time.
		for (const checkedAt of [old, old - 1, Number.NaN, -1, 1.5, "later"]) heartbeat(0, checkedAt as number);
		expect(allClear()).toBe(false);
		// A newer heartbeat: the server read again and nothing changed.
		heartbeat();
		expect(allClear()).toBe(true);
		// An error, then a rewatch, then the replay of the server's last look: still can't tell.
		receive({ type: "roles", asks: 0, error: "CANARY-ERROR" });
		expect(allClear()).toBe(false);
		resendRolesWatch();
		overview([role()], [], serverClock);
		expect(allClear()).toBe(false);
		expect(page().needsYou.tell).not.toBe("can-tell");
		// A newer full update (the next look found a change) is current again.
		overview([role()]);
		expect(allClear()).toBe(true);
		expect(JSON.stringify(page())).not.toContain("CANARY");
	});
	it("R1: leaving and coming back, a heartbeat ahead of the first update, or an older update never vouch for it", () => {
		showPage();
		feed([role()]);
		expect(allClear()).toBe(true);
		// Leave and come back: a new full watch; nothing is current until the server looks again.
		showPage(false);
		showPage(true);
		expect(allClear()).toBe(false);
		heartbeat(); // already on its way before the watch: there is no first update yet
		expect(allClear()).toBe(false);
		overview([role()]); // the first update since this watch, perhaps a replay
		expect(allClear()).toBe(false);
		heartbeat();
		expect(allClear()).toBe(true);
		// A full update older than the first one since the watch withdraws it.
		overview([role()], [], serverClock - 10_000);
		expect(allClear()).toBe(false);
	});
	it("R2: what the count is shown from: listed asks, and whether the page can tell; never can-tell on error", () => {
		// The page shows a count only when something is listed or it can tell (Security R2); these are
		// the facts it decides from, through the actual store.
		const needs = () => {
			const { tell, total } = page().needsYou;
			return { tell, total };
		};
		showPage();
		overview([role()]);
		expect(needs()).toEqual({ tell: "awaiting", total: 0 });
		heartbeat();
		expect(needs()).toEqual({ tell: "can-tell", total: 0 });
		expect(allClear()).toBe(true);
		receive({ type: "roles", asks: 0, error: "x" });
		expect(needs()).toEqual({ tell: "feed-error", total: 0 });
		overview([role("frontend", { problems: ["home chat"] })]);
		expect(needs()).toEqual({ tell: "partial", total: 0 });
		overview([role()]);
		expect(needs()).toEqual({ tell: "can-tell", total: 0 });
		setAppGlobals({ status: "closed" });
		expect(needs()).toEqual({ tell: "not-live", total: 0 });
		setAppGlobals({ status: "open" });
		overview([role()], [ask("frontend:tldr:a")]);
		setAppGlobals({ status: "closed" });
		expect(needs()).toEqual({ tell: "not-live", total: 1 });
	});
	it("source route: the app mounts the exact page; the closed model has no rich content or side-effect APIs", () => {
		const model = readFileSync(resolve(process.cwd(), "web/src/roles-useful-model.ts"), "utf8");
		const app = readFileSync(resolve(process.cwd(), "web/src/App.tsx"), "utf8");
		// roles-exact: the supplied design uses this same closed model.
		expect(app).toContain('import("./components/RolesExactView")');
		// roles-panel: About & rules opens Settings at the role, the way the old panel did.
		expect(app).toMatch(
			/<RolesExactView\s+active=\{view === "roles"\}\s+dialogs=\{chat.ready \? nativeDialogs : \[\]\}\s+onOpen=\{openFromRolesPage\}\s+onAbout=\{aboutFromRoles\}\s+\/>/,
		);
		// The page's opens are remembered first (fixed words on failure), then go the existing way.
		expect(app).toMatch(/markRolesOpen\(target\.file\);\s*openFromRoles\(target\);/);
		expect(model).not.toMatch(
			/localStorage|sessionStorage|fetch\(|WebSocket|setTimeout|appSend|reloadRoles|boardRequest|dangerouslySetInnerHTML|innerHTML|href|Markdown|react-icons|TaskLink|QueuedList|window\.open/,
		);
		expect(model).not.toMatch(/\.\.\./);
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
