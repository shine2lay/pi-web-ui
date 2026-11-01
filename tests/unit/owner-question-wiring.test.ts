// owner-question-wiring (Ops #685): every owner ask routed at the moment it is asked, with fake chats and a fake
// clock. Real modules end to end: the rule and hold store (Ops #684) through OwnerQuestionRouter, the list of asks,
// the owner's input times, the running-chats list a restart carries on from, the plugin feed and the Telegram bridge
// (a fake Bot API), the Roles reader with its Needs-you projection, roles_overview's text and the ask_user_question
// tool. No server, provider or model is started; temporary folders only; no question words decide anything.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAskUserQuestionTool } from "../../server/agent-service.js";
import {
	AskHub,
	approvalAsk,
	dialogAsk,
	questionAsk,
	stuckAsk,
	type Ask,
	type AskEvent,
	type AskFieldAnswer,
	type AskRouteInput,
} from "../../server/asks.js";
import type { IdentityDef } from "../../server/identities.js";
import { noteOwnerInput, ownerLastWroteOf } from "../../server/owner-input-time.js";
import {
	HOLD_SAFETY_NET_MS,
	OWNER_QUESTION_HOLDS_FILE,
	OwnerQuestionHolds,
} from "../../server/owner-question-holds.js";
import {
	OwnerQuestionRouter,
	SAFETY_NET_SWEEP_MS,
	isQuestionReturned,
	questionReturnedText,
	type OwnerAskFacts,
} from "../../server/owner-question-router.js";
import {
	HELD_FOR_COO_LINE,
	ownerQuestionRouteView,
	ownerSeesAskEvent,
	routeOfAsk,
	shownToWindow,
} from "../../server/owner-question-surfaces.js";
import type { UiQuestion, UiRolesOverview } from "../../server/protocol.js";
import { requesterForAdmission } from "../../server/queue-requester.js";
import { collectRoleInput, newTurnRecord, type RoleTurnRecord } from "../../server/role-replies.js";
import { formatRolesOverview } from "../../server/roles-overview-tool.js";
import { RolesOverviewReader, type RolesOverviewHost } from "../../server/roles-overview.js";
import { RunningChats, carriedTurnOf, readRunningChatsFile } from "../../server/running-chats.js";
import { createBridge, createTelegramApi } from "../../plugins/telegram/index.mjs";
import { projectUsefulRoles } from "../../web/src/roles-useful-model.js";

const MIN = 60_000;
const T0 = Date.parse("2026-10-31T16:00:00Z");
let now = T0;
let on = true;
let dir = "";
let sessions = "";
let seq = 0;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "owner-question-wiring-"));
	sessions = join(dir, "sessions");
	mkdirSync(sessions, { recursive: true });
	now = T0;
	on = true;
	seq = 0;
});
afterEach(() => {
	vi.useRealTimers();
	rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fake chats: a turn record filled the way admission fills it, and the owner's input times.
// ---------------------------------------------------------------------------

interface FakeChat {
	id: string;
	sessionFile: string;
	title: string;
	turnRecord?: RoleTurnRecord;
	ownerLastWroteAt?: number;
}

const inputId = () => `ri-00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, "0")}`;

function chat(name: string): FakeChat {
	const sessionFile = join(sessions, `${name}.jsonl`);
	if (!existsSync(sessionFile)) writeFileSync(sessionFile, "");
	return { id: `conv-${name}`, sessionFile, title: name };
}

/** The owner typed into the chat in a real browser page (index.ts browserRoleInput, then noteTurnCause). */
function ownerWrites(c: FakeChat, at = now): void {
	const rec = (c.turnRecord ??= newTurnRecord());
	const requester = requesterForAdmission({ cause: "browser", ownerChannel: "browser", inputId: inputId() });
	collectRoleInput(rec, { requester, cause: "browser", ownerChannel: "browser" });
	noteOwnerInput(c, rec, requester.kind === "owner", at);
}

/** A role message started the chat's turn (role-messages delivery). */
function roleStarts(c: FakeChat): void {
	const rec = (c.turnRecord = newTurnRecord());
	collectRoleInput(rec, { cause: "role" });
	noteOwnerInput(c, rec, false, now);
}

const factsOf = (c: FakeChat, homeRole?: string): OwnerAskFacts => ({
	turn: c.turnRecord,
	ownerLastWroteAt: ownerLastWroteOf(c, c.turnRecord),
	...(c.turnRecord ? { turnKey: c.turnRecord } : {}),
	...(homeRole ? { homeRole } : {}),
});
const metaOf = (c: FakeChat) => ({ conversationId: c.id, conversationTitle: c.title, sessionFile: c.sessionFile });

const QUESTIONS: UiQuestion[] = [
	{ id: "port", question: "Which port?", options: [{ label: "8080" }, { label: "9090" }] },
];

// ---------------------------------------------------------------------------
// The app around it: the list of asks, the router, a plugin's feed (as plugins.ts gives it) and the Telegram bridge.
// ---------------------------------------------------------------------------

interface World {
	hub: AskHub;
	router: OwnerQuestionRouter;
	holdsFile: string;
	events: AskEvent[];
	feed: AskEvent[];
	sent: Array<{ text: string }>;
	settle: () => Promise<void>;
	/** Add an ask the way agent-service does: route it (the switch decides), then hand it to the list. */
	ask: (a: Ask, facts: OwnerAskFacts, stuck?: { key: string; sig: string }) => AskRouteInput | undefined;
	answers: Map<string, AskFieldAnswer[]>;
}

function world(opts: { holdsFile?: string; router?: boolean } = {}): World {
	const hub = new AskHub(() => now);
	const holdsFile = opts.holdsFile ?? join(dir, "data", OWNER_QUESTION_HOLDS_FILE);
	mkdirSync(join(holdsFile, ".."), { recursive: true });
	const router = new OwnerQuestionRouter({
		enabled: () => on,
		hub,
		holds: () => new OwnerQuestionHolds(holdsFile, { now: () => now }),
		now: () => now,
	});
	const events: AskEvent[] = [];
	hub.on((ev) => events.push(structuredClone(ev)));
	// What a plugin gets (plugins.ts host.asks): the list, and only the events that reached the owner.
	const feed: AskEvent[] = [];
	const handlers = new Set<(ev: AskEvent) => void>();
	hub.on((ev) => {
		if (!ownerSeesAskEvent(ev)) return;
		const copy = { ...ev, ask: structuredClone(ev.ask) } as AskEvent;
		feed.push(copy);
		for (const h of [...handlers]) h(copy);
	});
	const pluginAsks = {
		list: () => hub.list().map((a) => structuredClone(a)),
		on: (h: (ev: AskEvent) => void) => {
			handlers.add(h);
			return () => handlers.delete(h);
		},
		answer: (id: string, answers: AskFieldAnswer[]) => hub.answer(id, answers, "telegram"),
	};
	const sent: Array<{ text: string }> = [];
	let messageId = 500;
	const fetchImpl: typeof fetch = async (url, init) => {
		const method = String(url).split("/").pop();
		const params = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
		if (method === "sendMessage") sent.push(params);
		const result = method === "sendMessage" ? { message_id: messageId++, chat: { id: 1, type: "private" } } : true;
		return new Response(JSON.stringify({ ok: true, result }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	const store: Record<string, unknown> = {};
	const bridge = createBridge({
		api: createTelegramApi({ base: "http://fake-telegram", token: "1:fake", fetchImpl }),
		asks: pluginAsks,
		storage: {
			get: (k: string, fb?: unknown) => (k in store ? store[k] : fb),
			set: (k: string, v: unknown) => {
				store[k] = JSON.parse(JSON.stringify(v));
			},
			delete: (k: string) => {
				delete store[k];
			},
		},
		ownerId: "1",
		webAppAddress: "https://pi.example/",
		sleep: async () => {},
	});
	pluginAsks.on((ev) => bridge.onAskEvent(ev));
	const settle = async () => {
		for (;;) {
			const tail = bridge.idle();
			await tail;
			if (tail === bridge.idle()) return;
		}
	};
	const answers = new Map<string, AskFieldAnswer[]>();
	const ask = (a: Ask, facts: OwnerAskFacts, stuck?: { key: string; sig: string }) => {
		const route = opts.router === false ? undefined : router.routeAsk({ id: a.id, kind: a.kind }, facts, stuck);
		hub.add(
			a,
			(given) => {
				answers.set(a.id, given);
				hub.settle(a.id, { how: "answered", summary: given[0]?.selected[0] ?? "", from: "browser", answers: given });
				return { ok: true };
			},
			route,
		);
		return route;
	};
	return { hub, router, holdsFile, events, feed, sent, settle, ask, answers };
}

const question = (id: string, c: FakeChat) => questionAsk(id, QUESTIONS, metaOf(c), now);

// ---------------------------------------------------------------------------
// The Roles reader (temp transcripts, fake host), as the Roles page and roles_overview read it.
// ---------------------------------------------------------------------------

type Line = Record<string, unknown>;
const iso = (ms: number) => new Date(ms).toISOString();
const id8 = () => (++seq).toString(16).padStart(8, "0");
function transcript(c: FakeChat, lines: Line[]): void {
	const head = { type: "session", version: 3, id: c.title, timestamp: iso(T0 - 3_600_000), cwd: dir };
	writeFileSync(c.sessionFile, `${[head, ...lines].map((l) => JSON.stringify(l)).join("\n")}\n`);
}
const needsLine = (text: string, ts: number, id = id8()): Line => ({
	type: "custom",
	customType: "tldr",
	data: { v: 1, text, needsYou: true, ts },
	id,
	parentId: null,
	timestamp: iso(ts),
});
const queueLine = (op: Line, ts: number): Line => ({
	type: "custom",
	customType: "queue",
	data: { v: 1, ts, ...op },
	id: id8(),
	parentId: null,
	timestamp: iso(ts),
});
const roleDef = (id: string, homeChat: string): IdentityDef =>
	({
		id,
		title: `${id.charAt(0).toUpperCase()}${id.slice(1)} role`,
		homeChat,
		pastHomeChats: [],
		raw: {},
		dir: join(dir, "identities", id),
		role: { config: { workMode: null, goals: null }, problems: [] },
	}) as unknown as IdentityDef;
function rolesReader(w: World, roles: IdentityDef[], withHeld = true): RolesOverviewReader {
	const host: RolesOverviewHost = {
		identities: () => roles,
		chatState: () => "closed",
		asks: () => w.hub.list(),
		...(withHeld ? { heldAsks: () => w.router.heldAsks() } : {}),
		openRequestsTo: () => ({ open: 0 }),
		latestReportTo: () => undefined,
		rolePaused: () => false,
		sessionRoots: () => [sessions],
		reportRunsFile: () => join(dir, "state", "runs.json"),
		schedulerJobsFile: () => join(dir, "scheduler", "jobs.json"),
		now: () => now,
	};
	return new RolesOverviewReader(host);
}
const needsYou = (overview: UiRolesOverview) =>
	projectUsefulRoles(
		{ status: "ready", overview, checkedAt: overview.at, heardAt: overview.at, appliedAt: overview.at },
		"open",
		overview.at,
	).needsYou;
/** "14:35" in the overview's time zone. */
const clock = (ms: number, tz: string) =>
	new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
		new Date(ms),
	);

// ---------------------------------------------------------------------------

describe("owner asks with the switch on", () => {
	it("an owner-started question, his last input 1 minute old: shown at once, with its label first", async () => {
		const w = world();
		const lead = chat("ops-home");
		ownerWrites(lead);
		now = T0 + MIN;
		const route = w.ask(question("q-1", lead), factsOf(lead, "ops"));
		expect(route).toEqual({
			to: "direct",
			reason: "owner-chatting",
			label: "You were chatting here (you wrote 1 minute ago)",
		});
		expect(w.events.map((e) => e.type)).toEqual(["appeared"]);
		expect(w.hub.list().map((a) => a.id)).toEqual(["q-1"]);
		expect(ownerQuestionRouteView(w.hub.get("q-1"))).toEqual({
			line: "You were chatting here (you wrote 1 minute ago)",
		});
		// Every window shows it; Telegram gets it with the label before the question.
		expect(shownToWindow(false, lead.id, "conv-elsewhere")).toBe(true);
		await w.settle();
		expect(w.sent).toHaveLength(1);
		const text = w.sent[0].text;
		expect(text).toContain("You were chatting here (you wrote 1 minute ago)");
		expect(text.indexOf("You were chatting here")).toBeLessThan(text.indexOf("Which port?"));
		// Nothing was held, so nothing was written for COO.
		expect(existsSync(w.holdsFile)).toBe(false);
	});

	it("the same turn once his last input is 31 minutes old: held for COO as owner-away", async () => {
		const w = world();
		const lead = chat("ops-home");
		ownerWrites(lead);
		now = T0 + 31 * MIN;
		const route = w.ask(question("q-2", lead), factsOf(lead, "ops"));
		expect(route).toEqual({ to: "coo", reason: "owner-away", heldAt: now });
		expect(w.events.map((e) => e.type)).toEqual(["held"]);
		expect(w.hub.list()).toEqual([]);
		expect(w.hub.heldList().map((a) => a.id)).toEqual(["q-2"]);
		await w.settle();
		expect(w.sent).toEqual([]);
		expect(w.feed).toEqual([]);
		// Read as written (opening a second store would count a held question as died with its process).
		const hold = (JSON.parse(readFileSync(w.holdsFile, "utf8")) as { holds: unknown[] }).holds;
		expect(hold).toMatchObject([{ kind: "question", reason: "owner-away", state: "held", createdAt: now }]);
	});

	it("a carried-on owner turn after a restart keeps his time", () => {
		const lead = chat("ops-home");
		ownerWrites(lead);
		// The running list keeps the turn's requester and his time (running-chats.json).
		const listFile = join(dir, "running-chats.json");
		const list = new RunningChats(listFile, () => now);
		list.start({ sessionFile: lead.sessionFile, title: lead.title, cwd: dir });
		list.setRequester(lead.sessionFile, lead.turnRecord!);
		const saved = readRunningChatsFile(listFile)!.chats[0];
		expect(saved.ownerLastWroteAt).toBe(T0);
		// After the restart: a new chat object, its carry-on turn admitted with the saved inputs.
		const carried = carriedTurnOf(saved);
		expect(carried?.ownerLastWroteAt).toBe(T0);
		const again: FakeChat = { id: "conv-after-restart", sessionFile: lead.sessionFile, title: lead.title };
		again.turnRecord = newTurnRecord();
		collectRoleInput(again.turnRecord, { cause: "other", carried });
		noteOwnerInput(again, again.turnRecord, false, now);
		expect(ownerLastWroteOf(again, again.turnRecord)).toBe(T0);
		now = T0 + 5 * MIN;
		const w = world();
		expect(w.ask(question("q-3", again), factsOf(again, "ops"))).toEqual({
			to: "direct",
			reason: "owner-chatting",
			label: "You were chatting here (you wrote 5 minutes ago)",
		});
		now = T0 + 30 * MIN;
		expect(w.ask(question("q-4", again), factsOf(again, "ops"))).toMatchObject({ to: "coo", reason: "owner-away" });
		// A list written before his time was kept (an older build): the turn is still his, the time unknown.
		const old = { ...saved };
		delete old.ownerLastWroteAt;
		const unknown = carriedTurnOf(old);
		expect(unknown?.requesterInputs).toEqual(saved.requester?.inputs);
		expect(unknown?.ownerLastWroteAt).toBeUndefined();
		// A bad time is dropped, never trusted.
		expect(
			carriedTurnOf({ ...saved, ownerLastWroteAt: "soon" as unknown as number })?.ownerLastWroteAt,
		).toBeUndefined();
	});

	it("a question in a turn a role message started is held: not on Telegram, Needs you or the counts; on its own page", async () => {
		const w = world();
		const design = chat("design-home");
		transcript(design, [needsLine("Need you: pick a port", T0 - 1000, "line0001")]);
		roleStarts(design);
		const route = w.ask(question("q-5", design), factsOf(design, "design"));
		expect(route).toMatchObject({ to: "coo", reason: "not-started-by-owner" });
		await w.settle();
		// Telegram's input: neither its list nor its events have it, and nothing was sent.
		expect(w.hub.list()).toEqual([]);
		expect(w.feed).toEqual([]);
		expect(w.sent).toEqual([]);
		// Needs you and the counts: the question and the needs-you line written for it are both out.
		const reader = rolesReader(w, [roleDef("design", design.sessionFile)]);
		const overview = await reader.read();
		expect(overview.asks).toEqual([]);
		expect(overview.roles[0].asks).toEqual([]);
		expect(needsYou(overview)).toMatchObject({ total: 0, items: [] });
		expect(overview.roles[0].tldr.map((l) => l.text)).not.toContain("Need you: pick a port");
		// roles_overview (COO reads it) says it is with COO first, and until when.
		const until = T0 + HOLD_SAFETY_NET_MS;
		expect(w.router.heldUntil("q-5")).toBe(until);
		const text = formatRolesOverview(overview, { role: "design", now });
		expect(text).toContain(`with COO first until ${clock(until, overview.reportTz)}`);
		expect(text).toContain("Need you: pick a port");
		// The asking chat's own page still shows it, marked, and an answer there settles it.
		expect(shownToWindow(true, design.id, design.id)).toBe(true);
		expect(shownToWindow(true, design.id, "conv-another-window")).toBe(false);
		expect(ownerQuestionRouteView(w.hub.get("q-5"))).toEqual({ line: HELD_FOR_COO_LINE, held: true });
		expect(HELD_FOR_COO_LINE).toBe("With COO first. You can answer here.");
		expect(routeOfAsk(w.hub.get("q-5"))).toEqual({ route: { line: HELD_FOR_COO_LINE, held: true } });
		expect(await w.hub.answer("q-5", [{ id: "port", selected: ["8080"] }], "browser")).toEqual({ ok: true });
		await w.settle();
		expect(w.feed).toEqual([]);
		expect(w.sent).toEqual([]);
		const record = new OwnerQuestionHolds(w.holdsFile, { now: () => now }).list();
		expect(record).toMatchObject([{ state: "gone" }]);
	});

	it("dialogs and approvals take the same rule; an approval a role's turn raised is held", () => {
		const w = world();
		const lead = chat("qa-home");
		ownerWrites(lead);
		now = T0 + 2 * MIN;
		const dialog = dialogAsk(
			"dlg-1",
			{ id: 1, kind: "confirm", title: "Approve the plan?", args: ["Plan"] },
			metaOf(lead),
			now,
		);
		expect(w.ask(dialog, factsOf(lead, "qa"))).toMatchObject({ to: "direct", reason: "owner-chatting" });
		const worker = chat("qa-task");
		roleStarts(worker);
		const approval = approvalAsk("appr-1", { toolName: "bash", params: { command: "ls" } }, metaOf(worker), now);
		expect(w.ask(approval, factsOf(worker))).toMatchObject({ to: "coo", reason: "not-started-by-owner" });
		expect(w.hub.list().map((a) => a.id)).toEqual(["dlg-1"]);
		expect(w.hub.heldList().map((a) => a.id)).toEqual(["appr-1"]);
	});

	it("COO's release shows its note and recommendation, the label first, everywhere", async () => {
		const w = world();
		const design = chat("design-home");
		transcript(design, [needsLine("Need you: pick a port", T0 - 1000, "line0006")]);
		roleStarts(design);
		w.ask(question("q-6", design), factsOf(design, "design"));
		const roles = rolesReader(w, [roleDef("design", design.sessionFile)]);
		const tldr = async () => (await roles.read()).roles[0].tldr.map((l) => l.text);
		expect(await tldr()).not.toContain("Need you: pick a port");
		now = T0 + 7 * MIN;
		expect(w.router.release("q-6", "coo", "He set the port rule on Tuesday.", "Pick 8080")).toEqual({ ok: true });
		expect(w.events.map((e) => e.type)).toEqual(["held", "released", "appeared"]);
		expect(ownerQuestionRouteView(w.hub.get("q-6"))).toEqual({
			line: "Came through COO",
			note: "He set the port rule on Tuesday.",
			recommendation: "Pick 8080",
		});
		await w.settle();
		expect(w.sent).toHaveLength(1);
		const text = w.sent[0].text;
		const at = (s: string) => text.indexOf(s);
		expect(at("Came through COO")).toBeGreaterThan(-1);
		expect(at("Came through COO")).toBeLessThan(at("He set the port rule on Tuesday."));
		expect(at("He set the port rule on Tuesday.")).toBeLessThan(at("Pick 8080"));
		expect(at("Pick 8080")).toBeLessThan(at("Which port?"));
		const overview = await roles.read();
		expect(overview.asks).toHaveLength(1);
		expect(overview.asks[0].route).toEqual(ownerQuestionRouteView(w.hub.get("q-6")));
		expect(overview.roles[0].tldr.map((l) => l.text)).toContain("Need you: pick a port");
		expect(new OwnerQuestionHolds(w.holdsFile, { now: () => now }).list()).toMatchObject([
			{ state: "released", releasedBy: "coo", note: "He set the port rule on Tuesday.", recommendation: "Pick 8080" },
		]);
	});

	it("the safety net lets a held ask through after 30 minutes on a fake clock", async () => {
		const w = world();
		const design = chat("design-home");
		roleStarts(design);
		w.ask(question("q-7", design), factsOf(design, "design"));
		now = T0 + 30 * MIN - 1;
		expect(w.router.sweep()).toEqual([]);
		expect(w.hub.list()).toEqual([]);
		now = T0 + 30 * MIN;
		expect(w.router.sweep()).toEqual(["q-7"]);
		expect(ownerQuestionRouteView(w.hub.get("q-7"))).toEqual({
			line: "Came through COO; COO added nothing (it reached you after 30 minutes)",
		});
		await w.settle();
		expect(w.sent).toHaveLength(1);
		expect(new OwnerQuestionHolds(w.holdsFile, { now: () => now }).list()).toMatchObject([
			{ state: "released", releasedBy: "safety-net" },
		]);
	});

	it("the server's interval runs the safety net at least once a minute", () => {
		vi.useFakeTimers({ now: T0 });
		now = T0;
		const w = world();
		const design = chat("design-home");
		roleStarts(design);
		w.ask(question("q-8", design), factsOf(design, "design"));
		expect(SAFETY_NET_SWEEP_MS).toBeLessThanOrEqual(60_000);
		w.router.start();
		now = T0 + 30 * MIN;
		vi.advanceTimersByTime(SAFETY_NET_SWEEP_MS);
		expect(w.hub.list().map((a) => a.id)).toEqual(["q-8"]);
		w.router.stop();
	});

	it("a restart reload follows the store: a held card stays held from its first time, a released one shows with COO's words", () => {
		const holdsFile = join(dir, "data", OWNER_QUESTION_HOLDS_FILE);
		const ops = chat("ops-home");
		const card = (id: string, taskId: number) =>
			stuckAsk(
				id,
				{ taskId, taskTitle: `Task ${taskId}`, question: "Which port?", choices: ["8080", "9090"] },
				metaOf(ops),
				now,
			);
		const before = world({ holdsFile });
		expect(before.ask(card("stuck-1", 12), {}, { key: "k12", sig: "s12" })).toEqual({
			to: "coo",
			reason: "queued-work",
			heldAt: T0,
		});
		before.ask(card("stuck-2", 13), {}, { key: "k13", sig: "s13" });
		now = T0 + 4 * MIN;
		before.router.release("stuck-2", "coo", "Already agreed with Design.");
		before.ask(question("q-9", ops), {});
		before.router.stop();
		// The restart: a new list of asks and router on the same store; the queue shows its cards again.
		now = T0 + 10 * MIN;
		const after = world({ holdsFile });
		expect(after.ask(card("stuck-1b", 12), {}, { key: "k12", sig: "s12" })).toEqual({
			to: "coo",
			reason: "queued-work",
			heldAt: T0,
		});
		expect(after.ask(card("stuck-2b", 13), {}, { key: "k13", sig: "s13" })).toMatchObject({
			to: "coo",
			releasedBy: "coo",
			note: "Already agreed with Design.",
		});
		expect(after.hub.list().map((a) => a.id)).toEqual(["stuck-2b"]);
		expect(ownerQuestionRouteView(after.hub.get("stuck-2b"))).toEqual({
			line: "Came through COO",
			note: "Already agreed with Design.",
		});
		// The question died with the old process; its record is gone, never shown again.
		const records = new OwnerQuestionHolds(holdsFile, { now: () => now }).list();
		expect(records.filter((h) => h.kind === "question")).toMatchObject([{ state: "gone" }]);
		// The held card's clock kept its first time: through 30 minutes after it was first held.
		now = T0 + 30 * MIN;
		expect(after.router.sweep()).toEqual(["stuck-1b"]);
		// A card that went away (its chat closed) keeps its record: shown at once when it comes back.
		after.hub.settle("stuck-1b", { how: "gone", reason: "its chat closed" });
		expect(after.ask(card("stuck-1c", 12), {}, { key: "k12", sig: "s12" })).toMatchObject({ releasedBy: "safety-net" });
	});

	it("COO hands a question back: the tool call gets the return text, and asking again goes straight to him", async () => {
		const w = world();
		const design = chat("design-home");
		roleStarts(design);
		w.ask(question("q-10", design), factsOf(design, "design"));
		const note = "Use the default port; it is in the plan.";
		expect(w.router.returnToAsker("q-10", note)).toEqual({ ok: true });
		expect(w.events.map((e) => e.type)).toEqual(["held", "returned"]);
		expect(w.feed).toEqual([]);
		const text = questionReturnedText(note);
		expect(text).toBe(
			"Not the owner's answer. COO handed this back as your own call: Use the default port; it is in the plan. If only the owner can give it, ask again: it goes straight to him.",
		);
		// The tool call itself resolves with it (no error, no answers).
		const tool = makeAskUserQuestionTool({ askUser: async () => ({ returned: note }) });
		const result = (await tool.execute(
			"call-1",
			{ questions: QUESTIONS },
			undefined,
			undefined,
			undefined as never,
		)) as {
			content: Array<{ type: string; text: string }>;
		};
		expect(result.content).toEqual([{ type: "text", text }]);
		expect(isQuestionReturned({ returned: note })).toBe(true);
		expect(isQuestionReturned([])).toBe(false);
		// Asked again in the same turn: straight to him, with no line.
		expect(w.ask(question("q-11", design), factsOf(design, "design"))).toEqual({
			to: "direct",
			reason: "asked-again-after-return",
		});
		expect(w.hub.list().map((a) => a.id)).toEqual(["q-11"]);
		// The next turn starts afresh: through COO again.
		roleStarts(design);
		expect(w.ask(question("q-12", design), factsOf(design, "design"))).toMatchObject({ to: "coo" });
		expect(new OwnerQuestionHolds(w.holdsFile, { now: () => now }).list()[0]).toMatchObject({
			state: "returned",
			note,
		});
	});

	it("a held card's needs-you line stays out of the Roles TL;DR and Needs you, and comes back once the card reaches him", async () => {
		const w = world();
		const ops = chat("ops-home");
		const task = chat("task-7");
		const plan = { title: "Task 7", goal: "g", doneWhen: "d", decided: "x", steps: "s", verify: "v", mustNot: "m" };
		const at = T0 - 5 * MIN;
		const text = "Task #7 needs you: Which port?";
		// pi-queue's record in the lead's chat: task 7 runs in its own chat, got stuck, and its "needs you" line.
		transcript(ops, [
			queueLine({ op: "add", id: 7, plan }, at),
			queueLine({ op: "start", id: 7, lane: true }, at),
			queueLine({ op: "chat", id: 7, file: task.sessionFile, title: "Task 7" }, at),
			queueLine({ op: "stuck", id: 7, question: "Which port?", choices: ["8080", "9090"] }, at),
			{
				...needsLine(text, at, "line0007"),
				data: { v: 1, text, needsYou: true, ts: at, chat: { file: task.sessionFile, title: "Task 7" } },
			},
		]);
		transcript(task, []);
		const card = stuckAsk(
			"stuck-7",
			{ taskId: 7, taskTitle: "Task 7", question: "Which port?", choices: ["8080", "9090"] },
			metaOf(task),
			now,
		);
		expect(w.ask(card, {}, { key: "k7", sig: "s7" })).toMatchObject({ to: "coo", reason: "queued-work" });
		const reader = rolesReader(w, [roleDef("ops", ops.sessionFile)]);
		const lines = (o: UiRolesOverview) => o.roles[0].tldr.map((l) => l.text);
		const held = await reader.read();
		expect(lines(held)).not.toContain(text);
		expect(needsYou(held)).toMatchObject({ total: 0, items: [] });
		expect(formatRolesOverview(held, { role: "ops", now })).toContain(
			`with COO first until ${clock(T0 + HOLD_SAFETY_NET_MS, held.reportTz)}`,
		);
		expect(w.router.release("stuck-7", "coo", "Pick 8080 unless Design objects.")).toEqual({ ok: true });
		const released = await reader.read();
		expect(lines(released)).toContain(text);
		expect(needsYou(released).total).toBeGreaterThan(0);
	});

	it("switching it off lets everything held through at the next sweep, as before routing", () => {
		const w = world();
		const design = chat("design-home");
		roleStarts(design);
		w.ask(question("q-13", design), factsOf(design, "design"));
		on = false;
		expect(w.router.sweep()).toEqual(["q-13"]);
		expect(w.hub.list().map((a) => a.id)).toEqual(["q-13"]);
		// New asks are routed no more.
		expect(w.ask(question("q-14", design), factsOf(design, "design"))).toBeUndefined();
	});
});

describe("owner asks with the switch off", () => {
	/** One run of every kind of ask through the app, with or without the router in the path. */
	async function run(router: boolean) {
		on = false;
		now = T0 + 45 * MIN;
		seq = 0;
		const w = world({ router });
		const lead = chat("ops-home");
		const design = chat("design-home");
		transcript(design, [needsLine("Need you: pick a port", now - 1000, "line0001")]);
		lead.turnRecord = undefined;
		ownerWrites(lead, T0);
		roleStarts(design);
		const routes = [
			w.ask(question("q-1", lead), factsOf(lead, "ops")),
			w.ask(question("q-2", design), factsOf(design, "design")),
			w.ask(
				dialogAsk("dlg-1", { id: 1, kind: "confirm", title: "Approve?", args: ["Plan"] }, metaOf(design), now),
				factsOf(design, "design"),
			),
			w.ask(
				approvalAsk("appr-1", { toolName: "bash", params: { command: "ls" } }, metaOf(design), now),
				factsOf(design),
			),
			w.ask(
				stuckAsk(
					"stuck-1",
					{ taskId: 4, taskTitle: "Task 4", question: "Which?", choices: ["A", "B"] },
					metaOf(lead),
					now,
				),
				{},
				{ key: "k4", sig: "s4" },
			),
		];
		await w.settle();
		await w.hub.answer("q-2", [{ id: "port", selected: ["9090"] }], "browser");
		await w.settle();
		const overview = await rolesReader(
			w,
			[roleDef("design", design.sessionFile), roleDef("ops", lead.sessionFile)],
			router,
		).read();
		const swept = router ? w.router.sweep() : [];
		return {
			routes,
			events: w.events,
			list: w.hub.list(),
			held: w.hub.heldList(),
			feed: w.feed,
			telegram: w.sent,
			overview,
			needsYou: needsYou(overview),
			text: formatRolesOverview(overview, { now }),
			views: w.hub.list().map((a) => ownerQuestionRouteView(a) ?? null),
			swept,
			holdsFile: existsSync(w.holdsFile),
		};
	}

	it("is byte-identical to today on every surface, and writes nothing for COO", async () => {
		const today = await run(false);
		const off = await run(true);
		// Only the wall clock differs between two runs (a transcript's write time, Telegram's button refs).
		const wallClock = (v: unknown) =>
			JSON.stringify(v)
				.replace(/"lastActivity":\d+/g, '"lastActivity":0')
				.replace(/"callback_data":"\d+:/g, '"callback_data":"0:')
				.replace(/Last activity: [^\n"]*/g, "Last activity: 0");
		expect(wallClock(off)).toBe(wallClock(today));
		expect(off.routes).toEqual([undefined, undefined, undefined, undefined, undefined]);
		expect(off.held).toEqual([]);
		expect(off.list.every((a) => !("route" in a))).toBe(true);
		expect(off.holdsFile).toBe(false);
		expect(off.telegram.length).toBeGreaterThan(0);
		// Still recorded while off: his time (bookkeeping only, read only when the switch is on).
		const c = chat("ops-home");
		ownerWrites(c, T0);
		expect(ownerLastWroteOf(c, c.turnRecord)).toBe(T0);
	});
});
