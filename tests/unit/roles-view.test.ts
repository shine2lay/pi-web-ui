// roles-overview: the Roles page's client side: what a row shows (roles-view-model.ts), the owner's form
// (owner-fields.ts, checked against pi-identity's own parser), links into a chat (chat-focus.ts,
// open-chat-link.ts), and the page's markup for 14 and 20 roles. No server, no port, no model.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings, parseRoleConfig } from "../../server/identity-config.js";
import type { UiRoleAsk, UiRoleOverview, UiRoleReport, UiRolesOverview, UiRoleTask } from "../../server/protocol.js";
import { setAppSend } from "../../web/src/app-globals.js";
import { parseFocus } from "../../web/src/chat-focus.js";
import { RolesView } from "../../web/src/components/RolesView.js";
import { en, LanguageProvider, type Translate } from "../../web/src/i18n.js";
import { initChatLink, takeChatFocusLink, takeChatLink, takeViewLink } from "../../web/src/open-chat-link.js";
import {
	ownerFieldsProblems,
	readOwnerFields,
	writeOwnerFields,
	type OwnerFields,
	type OwnerGoalDraft,
} from "../../web/src/owner-fields.js";
import { receiveRoles, resetRolesState } from "../../web/src/roles-state.js";
import {
	ageOf,
	agoOf,
	chatHref,
	dayOfStamp,
	goalRest,
	goalsLine,
	groupRoles,
	isQuiet,
	leadTask,
	nowLineOf,
	oldestSince,
	queueCounts,
	queueStopped,
	readStripOpen,
	reportDay,
	reportGoal,
	reportReason,
	reportRoles,
	rolesSummary,
	saveStripOpen,
	taskLook,
	taskWord,
	whenIn,
} from "../../web/src/roles-view-model.js";

const t: Translate = (key, vars) => {
	let s: string = en[key];
	for (const [k, v] of Object.entries(vars ?? {})) s = s.replaceAll(`{${k}}`, String(v));
	return s;
};
const TZ = "America/Los_Angeles";
const NOW = Date.parse("2026-10-05T14:12:00Z"); // Mon 07:12 Pacific
const MIN = 60_000;
const HOME = (id: string) => `/s/${id}-home.jsonl`;

function role(id: string, over: Partial<UiRoleOverview> = {}): UiRoleOverview {
	return {
		id,
		title: id.charAt(0).toUpperCase() + id.slice(1),
		homeChat: { file: HOME(id) },
		workMode: "request-only",
		workModeFrom: "rules",
		goals: [],
		goalsFrom: "rules",
		status: "idle",
		asks: [],
		tldr: [],
		requests: { open: 0 },
		report: { state: "not-in-job" },
		...over,
	};
}
const line = (id: string, text: string, ts: number, extra: Partial<UiRoleOverview["tldr"][number]> = {}) => ({
	id,
	text,
	ts,
	chat: { file: HOME("x"), where: "home" as const },
	...extra,
});
const task = (id: number, status: UiRoleTask["status"], extra: Partial<UiRoleTask> = {}): UiRoleTask => ({
	id,
	status,
	title: `Task ${id}`,
	...extra,
});
const ask = (roleId: string, n: number, since?: number, extra: Partial<UiRoleAsk> = {}): UiRoleAsk => ({
	key: `${roleId}:tldr:${n}`,
	role: roleId,
	kind: "tldr",
	text: `${roleId} asks ${n}`,
	...(since !== undefined ? { since } : {}),
	chat: { file: HOME(roleId), where: "home" },
	focus: `tldr:l${n}`,
	...extra,
});
const REPORT: UiRoleReport = {
	state: "report",
	date: "2026-10-04",
	askedAt: Date.parse("2026-10-05T13:00:00Z"),
	sections: [
		{ heading: "Goal or hypothesis", text: "Ship the Roles page\nso the owner sees it all" },
		{ heading: "Done yesterday", text: "Built it." },
		{ heading: "Learned", text: "Small is fast." },
		{ heading: "Next", text: "Land it." },
	],
	chat: { file: HOME("design") },
	messageAt: Date.parse("2026-10-05T13:02:00Z"),
};

// ---------------------------------------------------------------------------------------------------------
describe("what a row shows", () => {
	it("groups the roles by how they work, alphabetical inside each, for 14 and 20 roles", () => {
		const ids = ["temper", "qa", "ops", "design", "backend", "product", "rollcall", "architecture", "data"];
		const roles = ids.map((id) =>
			role(id, { workMode: ["product", "design", "qa"].includes(id) ? "self-start" : "request-only" }),
		);
		const g = groupRoles(roles);
		expect(g.selfStart.map((r) => r.id)).toEqual(["design", "product", "qa"]);
		expect(g.onRequest.map((r) => r.id)).toEqual(["architecture", "backend", "data", "ops", "rollcall", "temper"]);
		const twenty = Array.from({ length: 20 }, (_, i) => role(`r${String(19 - i).padStart(2, "0")}`));
		expect(groupRoles(twenty).onRequest.map((r) => r.id)).toEqual(
			Array.from({ length: 20 }, (_, i) => `r${String(i).padStart(2, "0")}`),
		);
		// the order doesn't change with what a role is doing
		const busy = twenty.map((r, i) => ({ ...r, status: i % 2 ? ("busy" as const) : ("needs-you" as const) }));
		expect(groupRoles(busy).onRequest.map((r) => r.id)).toEqual(groupRoles(twenty).onRequest.map((r) => r.id));
	});

	it("says what a role is doing now: its newest ask, its newest line, an open request, or why nothing", () => {
		const asks = [ask("ops", 1, NOW - 9 * 60 * MIN), ask("ops", 2, NOW - 25 * MIN), ask("ops", 3)];
		expect(nowLineOf(role("ops", { asks }), NOW)).toEqual({ kind: "ask", ask: asks[1] });
		const fresh = line("a", "Checking the backup", NOW - 2 * 60 * MIN);
		expect(nowLineOf(role("ops", { tldr: [fresh] }), NOW)).toEqual({ kind: "line", line: fresh });
		const old = line("b", "Old news", NOW - 30 * 60 * MIN);
		expect(nowLineOf(role("ops", { tldr: [old] }), NOW)).toEqual({ kind: "waiting" });
		expect(
			nowLineOf(
				role("ops", {
					tldr: [old],
					requests: { open: 1, newest: { id: "rm-1", from: "Product", kind: "request", firstLine: "Fix it", at: NOW } },
				}),
				NOW,
			),
		).toEqual({ kind: "request", from: "Product", text: "Fix it" });
		expect(nowLineOf(role("design", { workMode: "self-start", tldr: [old] }), NOW)).toEqual({
			kind: "line",
			line: old,
		});
		expect(nowLineOf(role("design", { workMode: "self-start" }), NOW)).toEqual({ kind: "nothing" });
	});

	it("keeps a quiet role short, and a role with anything going on full", () => {
		expect(isQuiet(role("ops"), NOW)).toBe(true);
		expect(isQuiet(role("ops", { tldr: [line("a", "x", NOW - 25 * 60 * MIN)] }), NOW)).toBe(true);
		expect(isQuiet(role("ops", { tldr: [line("a", "x", NOW - 60 * MIN)] }), NOW)).toBe(false);
		expect(isQuiet(role("ops", { status: "paused" }), NOW)).toBe(false);
		expect(isQuiet(role("ops", { asks: [ask("ops", 1)] }), NOW)).toBe(false);
		const queue = {
			running: true,
			active: [task(4, "working")],
			queued: [],
			counts: { active: 1, queued: 0, done: 3 },
		};
		expect(isQuiet(role("ops", { queue }), NOW)).toBe(false);
	});

	it("shows the task that matters most, and every count in full", () => {
		const active = [task(1, "waiting", { waitsOn: "CI" }), task(2, "asking"), task(3, "working"), task(4, "stuck")];
		const queue = { running: true, active, queued: [task(9, "ready")], counts: { active: 4, queued: 2, done: 11 } };
		expect(leadTask(queue)?.id).toBe(4);
		expect(leadTask({ ...queue, active: active.slice(0, 3) })?.id).toBe(3);
		expect(leadTask({ ...queue, active: active.slice(0, 2) })?.id).toBe(2);
		expect(queueCounts(t, queue, true, true)).toBe("+3 active \u00b7 2 queued \u00b7 11 done");
		expect(queueCounts(t, { ...queue, counts: { active: 1, queued: 0, done: 0 } }, true, false)).toBe("");
		expect(queueCounts(t, { ...queue, counts: { active: 0, queued: 2, done: 41 } }, false, true)).toBe(
			"2 queued \u00b7 41 done",
		);
		expect(taskWord(t, task(1, "waiting", { waitsOn: "CI" }))).toBe("On hold: waits on CI");
		expect(taskWord(t, task(1, "blocked", { waitsOn: "temper #38" }))).toBe("Blocked: temper #38");
		// a tile's short word: the reason (often a paragraph) waits in the panel
		expect(taskWord(t, task(1, "waiting", { waitsOn: "CI" }), true)).toBe("On hold");
		expect(taskWord(t, task(1, "blocked", { waitsOn: "temper #38" }), true)).toBe("Blocked");
		expect(taskWord(t, task(1, "asking"))).toBe("Asking its main chat");
		expect(taskWord(t, task(1, "stuck"))).toBe("Needs you");
		expect(taskLook(task(1, "stuck"))).toBe("needs");
		expect(taskLook(task(1, "ready", { busy: true }))).toBe("working");
		expect(taskLook(task(1, "blocked"))).toBe("hold");
		expect(queueStopped({ ...queue, running: false })).toBe(true);
		expect(queueStopped({ ...queue, running: false, counts: { active: 0, queued: 0, done: 3 } })).toBe(false);
	});

	it("writes times, ages and the summary the way the design does", () => {
		expect(ageOf(NOW - 30_000, NOW)).toBe("now");
		expect(ageOf(NOW - 25 * MIN, NOW)).toBe("25m");
		expect(ageOf(NOW - 9 * 60 * MIN, NOW)).toBe("9h");
		expect(ageOf(NOW - 50 * 60 * MIN, NOW)).toBe("2d");
		expect(agoOf(NOW - 14 * MIN, NOW)).toBe("14m ago");
		expect(agoOf(NOW, NOW)).toBe("just now");
		expect(oldestSince([ask("a", 1), ask("a", 2, 50), ask("a", 3, 20)])).toBe(20);
		expect(rolesSummary(t, [role("a", { status: "busy" }), role("b", { status: "paused" }), role("c")])).toBe(
			"3 roles \u00b7 1 busy \u00b7 1 paused",
		);
		expect(rolesSummary(t, [role("a")])).toBe("1 role");
		expect(dayOfStamp("2026-10-04T22:20")).toBe("Oct 4");
		expect(goalRest(t, { name: "x", scope: "the CI cache", approvedAt: "2026-10-04", endsAt: "2026-12-31" })).toBe(
			"the CI cache \u00b7 approved Oct 4 \u00b7 until Dec 31",
		);
		const goals = [{ name: "a", scope: "s", approvedAt: "2026-10-04" }];
		expect(goalsLine(t, role("architecture", { goals: [...goals, { ...goals[0], name: "b" }] }))).toBe(
			"On request \u00b7 plus 2 goals you approved",
		);
		// the desktop board: its group says "on request" already; the names follow the line
		expect(goalsLine(t, role("architecture", { goals: [...goals, { ...goals[0], name: "b" }] }), true)).toBe(
			"Plus 2 goals you approved:",
		);
		expect(goalsLine(t, role("architecture", { goals }), true)).toBe("Plus 1 goal you approved:");
		expect(goalsLine(t, role("product", { workMode: "self-start", goals }))).toBe("");
	});

	it("dates the 6 am report in the job's time zone and says why there is none", () => {
		expect(reportDay(REPORT, TZ)).toBe("Mon");
		expect(reportDay({ state: "pending", date: "2026-10-04" }, TZ)).toBe("Mon");
		expect(whenIn(Date.parse("2026-10-06T13:00:00Z"), TZ)).toBe("Tue 6:00");
		expect(reportGoal(REPORT)).toBe("Ship the Roles page");
		expect(reportReason(t, REPORT, TZ)).toBeNull();
		expect(reportReason(t, { state: "first", next: Date.parse("2026-10-06T13:00:00Z") }, TZ)).toBe(
			"First report Tue 6:00",
		);
		expect(reportReason(t, { state: "not-active" }, TZ)).toBe("No report today (not active yesterday)");
		expect(reportReason(t, { state: "not-in-job" }, TZ)).toBe("Not asked for 6 am reports");
		expect(reportReason(t, { state: "failed", error: "the chat couldn't be opened" }, TZ)).toBe(
			"Couldn't ask for the report: the chat couldn't be opened",
		);
		expect(reportReason(t, { state: "no-answer" }, TZ)).toBe("The report request ended without an answer");
		expect(reportReason(t, { state: "pending", askedAt: Date.parse("2026-10-05T13:00:00Z") }, TZ)).toBe(
			"Report asked for Mon 6:00, not answered yet",
		);
		expect(reportRoles([role("ops"), role("design", { report: REPORT })]).map((r) => r.id)).toEqual(["design"]);
	});

	it("links to a chat (and an item of it) with the same address a new tab would open", () => {
		expect(chatHref("/s/a b.jsonl", "task:5")).toBe("?chat=%2Fs%2Fa+b.jsonl&focus=task%3A5");
		expect(chatHref("/s/x.jsonl")).toBe("?chat=%2Fs%2Fx.jsonl");
	});

	it("remembers whether the strip is open on this device, phone and desktop each their own", () => {
		const store = new Map<string, string>();
		const storage = {
			getItem: (k: string) => store.get(k) ?? null,
			setItem: (k: string, v: string) => void store.set(k, v),
			removeItem: (k: string) => void store.delete(k),
		};
		expect(readStripOpen("desktop", storage)).toBe(true);
		expect(readStripOpen("phone", storage)).toBe(false);
		saveStripOpen("desktop", false, storage);
		saveStripOpen("phone", true, storage);
		expect([readStripOpen("desktop", storage), readStripOpen("phone", storage)]).toEqual([false, true]);
	});
});

// ---------------------------------------------------------------------------------------------------------
describe("the owner's form for how a role works and its goals", () => {
	const FILE = `{\n  "id": "backend",\n  "title": "Backend",\n  "homeChat": "/s/backend.jsonl",\n  "zeta": {"keep": true},\n  "unique": true\n}\n`;
	const goal = (over: Partial<OwnerGoalDraft> = {}): OwnerGoalDraft => ({
		name: "Speed up builds",
		scope: "the CI cache",
		approvedAt: "2026-10-04",
		endsAt: "",
		...over,
	});

	it("changes only its two fields: other keys, unknown ones, their order, the indent and the last newline stay", () => {
		const out = writeOwnerFields(FILE, { workMode: "self-start", goals: [goal({ endsAt: "2026-12-31" })] });
		expect(out.endsWith("}\n")).toBe(true);
		expect(out).toContain('\n  "id": "backend"');
		expect(Object.keys(JSON.parse(out))).toEqual(["id", "title", "homeChat", "zeta", "unique", "workMode", "goals"]);
		expect(JSON.parse(out)).toMatchObject({
			zeta: { keep: true },
			workMode: "self-start",
			goals: [{ name: "Speed up builds", scope: "the CI cache", approvedAt: "2026-10-04", endsAt: "2026-12-31" }],
		});
		// set again: the fields keep their place; null takes a field out (the rules' default applies)
		const again = writeOwnerFields(out, { workMode: "request-only", goals: null });
		expect(Object.keys(JSON.parse(again))).toEqual(["id", "title", "homeChat", "zeta", "unique", "workMode"]);
		expect(writeOwnerFields(again, { workMode: null, goals: null })).toBe(
			`${JSON.stringify(JSON.parse(FILE), null, 2)}\n`,
		);
		expect(() => writeOwnerFields("[1]", { workMode: null, goals: null })).toThrow();
		expect(readOwnerFields("{ nope")).toEqual({ ok: false, reason: "not-json" });
		expect(readOwnerFields("[]")).toEqual({ ok: false, reason: "not-object" });
		expect(readOwnerFields(out)).toMatchObject({ ok: true, fields: { workMode: "self-start" }, problems: [] });
		expect(readOwnerFields('{"workMode": "always", "goals": {}}')).toMatchObject({
			ok: true,
			fields: { workMode: null, goals: [] },
			problems: ['"workMode" is "always"', '"goals" is not a list'],
		});
	});

	it("finds what pi-identity's own parser refuses, no more and no less", () => {
		const settings = defaultSettings({ HOME: "/nonexistent-home" });
		const cases: OwnerFields[] = [
			{ workMode: "self-start", goals: [goal()] },
			{ workMode: null, goals: [] },
			{ workMode: null, goals: [goal({ name: "" })] },
			{ workMode: null, goals: [goal({ name: "x".repeat(81) })] },
			{ workMode: null, goals: [goal({ name: "x".repeat(80) })] },
			{ workMode: null, goals: [goal({ scope: "two\nlines" })] },
			{ workMode: null, goals: [goal({ scope: "s".repeat(161) })] },
			{ workMode: null, goals: [goal({ approvedAt: "2026-02-30" })] },
			{ workMode: null, goals: [goal({ approvedAt: "2026-10-04T24:00" })] },
			{ workMode: null, goals: [goal({ approvedAt: "2026-10-04T22:20:05.123+02:00" })] },
			{ workMode: null, goals: [goal({ endsAt: "2026-10-03" })] },
			{ workMode: null, goals: [goal({ endsAt: "2026-10-04" })] },
			{ workMode: null, goals: [goal({ approvedAt: "2026-10-04T22:20", endsAt: "2026-10-04" })] },
			{ workMode: null, goals: [goal(), goal({ name: "speed UP builds" })] },
			{ workMode: null, goals: Array.from({ length: 13 }, (_, i) => goal({ name: `g${i}` })) },
			{ workMode: null, goals: Array.from({ length: 12 }, (_, i) => goal({ name: `g${i}` })) },
		];
		const base = '{\n\t"id": "backend",\n\t"title": "Backend",\n\t"unique": true\n}\n';
		expect(parseRoleConfig(JSON.parse(base), settings).problems).toEqual([]);
		for (const fields of cases) {
			const text = writeOwnerFields(base, fields);
			const server = parseRoleConfig(JSON.parse(text), settings).problems;
			const client = ownerFieldsProblems(fields);
			expect(client.length > 0, `${JSON.stringify(fields)}: client ${client} / server ${server}`).toBe(
				server.length > 0,
			);
		}
	});
});

// ---------------------------------------------------------------------------------------------------------
describe("links into a chat", () => {
	it("takes only the four kinds of item, each in its own shape", () => {
		expect(parseFocus("tldr:9f2c41aa")).toEqual({ kind: "tldr", id: "9f2c41aa" });
		expect(parseFocus("task:42")).toEqual({ kind: "task", id: "42" });
		expect(parseFocus("question:q-1.2_3")).toEqual({ kind: "question", id: "q-1.2_3" });
		expect(parseFocus("report:2026-10-04")).toEqual({ kind: "report", id: "2026-10-04" });
		for (const bad of [
			"task:x",
			"report:yesterday",
			"tool:1",
			"tldr:",
			"tldr:a/b",
			"tldr:<b>",
			null,
			undefined,
			"x".repeat(200),
		]) {
			expect(parseFocus(bad)).toBeNull();
		}
	});

	describe("the address bar", () => {
		let replaced: string[] = [];
		const setUrl = (href: string) => {
			replaced = [];
			vi.stubGlobal("window", {
				location: { href },
				history: { state: null, replaceState: (_s: unknown, _t: string, url: string) => replaced.push(url) },
			});
		};
		afterEach(() => {
			vi.unstubAllGlobals();
			takeChatLink();
			takeChatFocusLink();
			takeViewLink();
		});

		it("opens a chat at an item once, and takes the link off the address bar", () => {
			setUrl("https://pi.example/?chat=%2Fs%2Fa.jsonl&focus=task%3A5&x=1");
			initChatLink();
			expect(replaced).toEqual(["https://pi.example/?x=1"]);
			expect(takeChatLink()).toBe("/s/a.jsonl");
			expect(takeChatFocusLink()).toBe("task:5");
			expect([takeChatLink(), takeChatFocusLink(), takeViewLink()]).toEqual([null, null, null]);
		});

		it("opens the Roles page (at a role), and nothing for another view or a focus without a chat", () => {
			setUrl("https://pi.example/?view=roles#r-ops");
			initChatLink();
			expect(takeViewLink()).toEqual({ view: "roles", role: "ops" });
			expect(replaced).toEqual(["https://pi.example/"]);
			setUrl("https://pi.example/?view=Roles");
			initChatLink();
			expect(takeViewLink()).toEqual({ view: "roles" });
			setUrl("https://pi.example/?view=nope#r-ops");
			initChatLink();
			expect(takeViewLink()).toBeNull();
			setUrl("https://pi.example/?focus=task%3A5");
			initChatLink();
			expect(replaced).toEqual([]);
			expect(takeChatFocusLink()).toBeNull();
		});
	});
});

// ---------------------------------------------------------------------------------------------------------
describe("the page", () => {
	const SELF = ["design", "product", "qa"];
	const IDS = [
		"architecture",
		"backend",
		"data",
		"design",
		"docs",
		"frontend",
		"marketing",
		"ops",
		"product",
		"qa",
		"rollcall",
		"security",
		"systems",
		"temper",
	];
	function fourteen(): UiRolesOverview {
		const roles = IDS.map((id) =>
			role(id, {
				workMode: SELF.includes(id) ? "self-start" : "request-only",
				tldr: [line(`${id}-1`, `${id} line`, NOW - 30 * MIN, { chat: { file: HOME(id), where: "home" } })],
				report: id === "design" ? REPORT : { state: "not-in-job" },
			}),
		);
		const marketing = roles.find((r) => r.id === "marketing")!;
		marketing.status = "needs-you";
		marketing.asks = [
			ask("marketing", 1, NOW - 9 * 60 * MIN, {
				kind: "task",
				chat: { file: HOME("marketing"), where: 3 },
				focus: "task:3",
			}),
			ask("marketing", 2, NOW - 25 * MIN),
		];
		const ops = roles.find((r) => r.id === "ops")!;
		ops.status = "busy";
		ops.queue = {
			running: true,
			active: [task(69, "working", { title: "Roles page" })],
			queued: [task(70, "ready")],
			counts: { active: 1, queued: 2, done: 11 },
		};
		const architecture = roles.find((r) => r.id === "architecture")!;
		architecture.goals = [
			{ name: "Team in Temper", scope: "M1-M8 through the first real trial", approvedAt: "2026-10-04T22:20" },
			{ name: "Land check workflow (#23)", scope: "waves of at most 3", approvedAt: "2026-10-04T22:50" },
		];
		return { at: NOW, roles, asks: [...marketing.asks], paused: false, reportTz: TZ };
	}
	const render = (phone: boolean) =>
		renderToStaticMarkup(
			createElement(
				LanguageProvider,
				null,
				createElement(RolesView, { active: true, phone, onOpen: () => {}, onAbout: () => {} }),
			),
		);

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		setAppSend(() => true);
	});
	afterEach(() => {
		resetRolesState();
		setAppSend(null);
		vi.useRealTimers();
	});

	it("shows every role as a tile in two fixed groups, the asks oldest first, and links straight to the chat", () => {
		receiveRoles({ type: "roles", overview: fourteen(), asks: 2, checkedAt: NOW });
		const html = render(false);
		expect(html).toContain("Start their own work \u00b7 3");
		expect(html).toContain("Work on request \u00b7 11");
		const order = [...html.matchAll(/data-role-id="([a-z]+)"/g)].map((m) => m[1]);
		expect(order).toEqual([...SELF, ...IDS.filter((id) => !SELF.includes(id))]);
		expect(html).toContain("Waiting on you (2)");
		const first = html.indexOf("marketing asks 1");
		expect(first).toBeGreaterThan(-1);
		expect(first).toBeLessThan(html.indexOf("marketing asks 2"));
		expect(html).toContain(`href="${chatHref(HOME("marketing"), "task:3").replaceAll("&", "&amp;")}"`);
		expect(html).toContain("14 roles \u00b7 1 busy");
		// one tile per role, coloured by its status; each opens that role's details in a panel
		expect([...html.matchAll(/class="rv-tbtn" aria-haspopup="dialog"/g)]).toHaveLength(14);
		expect(html).toContain('class="rv-tile needs-you" data-role-id="marketing"');
		expect(html).toContain('class="rv-tile busy" data-role-id="ops"');
		// a tile's queue in a few words, its counts kept on one line; the full counts and goals wait in
		// the panel, closed at first
		const text = html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, "");
		expect(text).toContain("#69 Working \u00b7 2 queued");
		expect(html).toContain('<span class="rv-tqc">2 queued</span>');
		expect(html).not.toContain("11 done");
		expect(html).not.toContain("Team in Temper");
		expect(html).not.toContain("<dialog");
		// the reports are one switch away on the desktop too
		expect(html).toContain("6 am reports (1)");
		// no detail page, no jump chips, no "Open all"
		expect(html).not.toMatch(/Open all|Jump to/i);
	});

	it("lays out twenty roles and the phone's cards the same way", () => {
		const o = fourteen();
		for (let i = 0; i < 6; i++) o.roles.push(role(`zz${i}`));
		receiveRoles({ type: "roles", overview: o, asks: 2, checkedAt: NOW });
		const desk = render(false);
		expect([...desk.matchAll(/data-role-id="/g)]).toHaveLength(20);
		expect(desk).toContain("Work on request \u00b7 17");
		const phone = render(true);
		expect([...phone.matchAll(/data-role-id="/g)]).toHaveLength(20);
		expect(phone).toContain("6 am reports (1)");
	});

	it("says it is loading, and that the chats are fine when it can't load", () => {
		expect(render(false)).toContain("Loading roles\u2026");
		receiveRoles({ type: "roles", asks: 0, error: "disk trouble" });
		// (React writes ' as &#x27;)
		const html = render(false).replaceAll("&#x27;", "'");
		expect(html).toContain("Couldn't load the roles. Your chats and queues are not affected.");
		expect(html).toContain(">Reload<");
	});

	it("names the roles it could only read in part, and a paused message flow", () => {
		const o = fourteen();
		o.roles[1].problems = ["queue"];
		o.paused = true;
		receiveRoles({ type: "roles", overview: o, asks: 2, checkedAt: NOW });
		const html = render(false);
		expect(html).toContain("1 role could not be read fully (backend). Showing what is there.");
		expect(html).toContain("Role messages are paused (Settings)");
	});
});
