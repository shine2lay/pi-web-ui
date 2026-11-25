// nonblocking-ask (Ops #1086 Task 1 of 2; Shine 2026-11-24, dr-36efc6499afe: "Non-blocking everywhere"): the
// acceptance cases NB-1..NB-6, written before the build. RED on the synchronous ask_user_question (6cece0d5); Task 2
// wires ClientSession to server/pending-questions-store.ts, moves this file into tests/unit/ and makes it GREEN
// without weakening an assertion. The tool runs through the real bridge (bridgeTarget), ClientSession.askUser, list of
// asks, per-owner split (#1079) and COO router (#685), in windows of Shine's and Wai's logins. Its own config
// (tests/nonblocking-ask-question-acceptance.config.ts) keeps it out of the land gate until then.
// The seam Task 2 adds to ClientSession: `static pendingQuestionsHost` (set by AgentService: the store in its data
// folder + delivery through sendRoleMessage) and `static restorePendingQuestions()` (at start-up).
// No server, model or socket; temporary folders only. "At once" = within a few event-loop turns, no timer: no
// wall-clock bar (load-independent; the plan's "< 50 ms" is met by construction).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientSession, makeAskUserQuestionTool } from "../server/agent-service.js";
import { ASK_USER_NO_CLIENT_ERROR } from "../server/ask-delivery.js";
import { sliceToolCallId, turnOwnersOf } from "../server/ask-question-owners.js";
import { type Ask, type AskEvent, askHub } from "../server/asks.js";
import { answerRecord } from "../server/decision-records.js";
import { OWNER_QUESTION_HOLDS_FILE, OwnerQuestionHolds } from "../server/owner-question-holds.js";
import { OwnerQuestionRouter, questionReturnedText } from "../server/owner-question-router.js";
import { pluginAnswer } from "../server/owner-question-surfaces.js";
import type { OwnerViewer } from "../server/owner-requester.js";
import {
	PENDING_QUESTIONS_FILE,
	type PendingQuestionsHost,
	PendingQuestionsStore,
	type QuestionWake,
	questionWakeOf,
} from "../server/pending-questions-store.js";
import type { ServerMessage, UiQuestion } from "../server/protocol.js";
import { requesterForAdmission } from "../server/queue-requester.js";
import { collectRoleInput, newTurnRecord, type RoleTurnRecord } from "../server/role-replies.js";
import { asAnswerer, PeopleBook, type SentBy, serveOwners, tailscaleSenderOf } from "../server/sent-by.js";

const WAI_SENT: SentBy = { login: "sayswai@gmail.com", name: "Wai", owner: false };
const SHINE_SENT: SentBy = { login: "aungshine@gmail.com", name: "Shine", owner: true };
const PORT: UiQuestion = { id: "port", question: "Which port?", options: [{ label: "8080" }, { label: "9090" }] };
const DNS: UiQuestion = { id: "dns", question: "Create the address?", options: [{ label: "Yes" }, { label: "No" }] };
const POSTED = "without waiting (non-blocking)";

interface FakeChat {
	id: string;
	title: string;
	cwd: string;
	isSubagent: boolean;
	session: { sessionFile: string; sessionManager: { getSessionFile(): string; getSessionId(): string } };
	dialogs: { current: null; cancelAll(): void };
	turnRecord?: RoleTurnRecord;
	unsubscribe?: () => void;
	toolWatchdogs: Map<string, ReturnType<typeof setTimeout>>;
	toolStartTimes: Map<string, number>;
	runtime: { session: { abort(): Promise<void> }; dispose(): Promise<void> };
}
interface Win {
	client: ClientSession;
	sent: ServerMessage[];
}
type ToolResult = { content: { text: string }[]; details?: Record<string, unknown> };

/** ClientSession's statics, and the seam Task 2 adds (absent on the synchronous code: the cases fail there). */
const statics = ClientSession as unknown as {
	liveSessions: Set<ClientSession>;
	sharedQuestions: Map<string, { conversationId?: string; resolve?: (v: unknown) => void; graceTimer?: unknown }>;
	sharedApprovals: Map<string, unknown>;
	pendingQuestionsHost?: PendingQuestionsHost | null;
	restorePendingQuestions?: () => Promise<unknown>;
};
const call = <T>(client: ClientSession, name: string, ...args: unknown[]): T =>
	(Reflect.get(ClientSession.prototype, name) as (...a: unknown[]) => T).call(client, ...args);

let dir = "";
let seq = 0;
let viewers: { shine: OwnerViewer; wai: OwnerViewer };
let events: AskEvent[] = [];
let wakes: QuestionWake[] = [];
let deliverOk = true;
let dataDir = "";
const cleanups: Array<() => void> = [];

const storeNow = () => PendingQuestionsStore.inDataDir(dataDir); // a fresh read of the file, as after a restart
const storeFile = () => join(dataDir, PENDING_QUESTIONS_FILE);

function wire(): PendingQuestionsHost {
	const host: PendingQuestionsHost = {
		store: PendingQuestionsStore.inDataDir(dataDir),
		deliver: async (wake) => {
			wakes.push(structuredClone(wake));
			return deliverOk ? { ok: true } : { ok: false, error: "the chat could not take it" };
		},
	};
	statics.pendingQuestionsHost = host;
	return host;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "nonblocking-ask-"));
	dataDir = join(dir, "data");
	const people = join(dir, "people.json");
	writeFileSync(
		people,
		JSON.stringify({ "aungshine@gmail.com": { name: "Shine", owner: true }, "sayswai@gmail.com": { name: "Wai" } }),
	);
	const book = serveOwners(new PeopleBook(people, { log: () => {}, warn: () => {} } as unknown as Console));
	const login = (l: string) => tailscaleSenderOf({ "tailscale-user-login": l, "tailscale-user-name": l });
	viewers = { shine: book.viewerOf(login("aungshine@gmail.com")), wai: book.viewerOf(login("sayswai@gmail.com")) };
	events = [];
	wakes = [];
	deliverOk = true;
	cleanups.push(askHub.observe((ev) => events.push(ev))); // observe: not a plugin listener (askHub.listening stays false)
	wire();
});
afterEach(() => {
	for (const undo of cleanups.splice(0).reverse()) undo();
	for (const [id, q] of [...statics.sharedQuestions]) {
		if (q.graceTimer) clearTimeout(q.graceTimer as ReturnType<typeof setTimeout>);
		statics.sharedQuestions.delete(id);
	}
	for (const id of [...statics.sharedApprovals.keys()]) statics.sharedApprovals.delete(id);
	for (const a of [...askHub.list(), ...askHub.heldList()]) askHub.settle(a.id, { how: "gone", reason: "test over" });
	statics.pendingQuestionsHost = null;
	ClientSession.ownerQuestions = null;
	rmSync(dir, { recursive: true, force: true });
});

function chat(name: string): FakeChat {
	const sessionFile = join(dir, `${name}.jsonl`);
	return {
		id: `conv-${name}`,
		title: name,
		cwd: dir,
		isSubagent: false,
		session: { sessionFile, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => `sid-${name}` } },
		dialogs: { current: null, cancelAll: () => {} },
		unsubscribe: () => {},
		toolWatchdogs: new Map(),
		toolStartTimes: new Map(),
		runtime: { session: { abort: async () => {} }, dispose: async () => {} },
	};
}

/** A turn's inputs: typed by these owners, or (none given) started by a role (COO routing, #685). */
function turn(c: FakeChat, ...senders: SentBy[]): void {
	const rec = (c.turnRecord = newTurnRecord());
	if (senders.length === 0) collectRoleInput(rec, { cause: "role" });
	for (const sentBy of senders) {
		const inputId = `ri-00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, "0")}`;
		const requester = requesterForAdmission({ cause: "browser", ownerChannel: "browser", inputId, sentBy });
		collectRoleInput(rec, { requester, cause: "browser", ownerChannel: "browser" });
	}
}

function win(convs: Map<string, FakeChat>, viewer: OwnerViewer, open = true): Win {
	const sent: ServerMessage[] = [];
	const client: ClientSession = Object.create(ClientSession.prototype);
	Object.defineProperties(client, {
		convs: { value: convs },
		activeId: { value: "conv-elsewhere" },
		conv: { get: () => undefined },
		disposed: { value: false },
		settingsSvc: { value: { current: { questionnaireEnabled: true, disabledAgentTools: [] }, push: () => {} } },
		emitLocal: { value: (m: ServerMessage) => sent.push(structuredClone(m)) },
		emit: { value: (m: ServerMessage) => sent.push(structuredClone(m)) },
		sinkCount: { value: () => (open ? 1 : 0) },
		flushSnapshot: { value: () => {} },
		emitConversations: { value: () => {} },
		openManagerAndRuntime: { value: async () => Promise.reject(new Error("no runtime in this test")) },
		bindSession: { value: async () => {} },
		pushSlashCommands: { value: async () => {} },
	});
	client.ownerViewer = viewer;
	statics.liveSessions.add(client);
	cleanups.push(() => statics.liveSessions.delete(client));
	return { client, sent };
}

/** COO's chat with Shine's and Wai's windows; its ask_user_question tool built on the real bridge. */
function setup(opts: { browsers?: boolean } = {}) {
	const asking = chat("coo");
	const convs = new Map<string, FakeChat>([[asking.id, asking]]);
	const open = opts.browsers ?? true;
	const shine = win(convs, viewers.shine, open);
	const wai = win(convs, viewers.wai, open);
	const bridge = call<Parameters<typeof makeAskUserQuestionTool>[0]>(shine.client, "bridgeTarget", {}, asking.id);
	const tool = makeAskUserQuestionTool(bridge, asking.id);
	const run = (toolCallId: string, questions: UiQuestion[]) => {
		const p = tool.execute(toolCallId, { questions }, new AbortController().signal, undefined, {} as never);
		const result = p as Promise<ToolResult>;
		result.catch(() => {}); // the synchronous code may end it later (a cancel); its outcome is read through outcomeNow
		return result;
	};
	return { asking, shine, wai, run };
}

/** A few event-loop turns: what is done "at once" is done by then; no timer, so no wall-clock bar. */
async function turns(): Promise<void> {
	for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}
/** How the call stands once the loop has turned: "posted" (returned), its error, or still waiting on an owner. */
async function outcomeNow(p: Promise<ToolResult>): Promise<ToolResult | string> {
	const late = Symbol("late");
	const won = await Promise.race([
		p.then(
			(r) => r,
			(e: Error) => `error: ${e.message}`,
		),
		turns().then(() => late),
	]);
	return won === late ? "still waiting for an answer" : (won as ToolResult | string);
}
/** The call returned at once, with the posted cards' text and no answers. */
async function postedNow(p: Promise<ToolResult>): Promise<ToolResult> {
	const out = await outcomeNow(p);
	expect(out).toMatchObject({ content: [{ text: expect.stringContaining(POSTED) }] });
	const r = out as ToolResult;
	expect(r.details ?? {}).not.toHaveProperty("answers");
	return r;
}
const askOf = (questionId: string): Ask =>
	[...askHub.list(), ...askHub.heldList()].find((a) => a.fields.some((f) => f.id === questionId))!;
const ofType = <T extends ServerMessage["type"]>(w: Win, type: T) =>
	w.sent.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
const retracted = (w: Win) => ofType(w, "question_retracted").map((m) => m.id);
const kept = () =>
	storeNow()
		.list()
		.map((r) => [r.id, r.state, r.owner]);
const answeredEvents = () => events.filter((e): e is Extract<AskEvent, { type: "answered" }> => e.type === "answered");

describe("NB-1: the call returns at once while the card waits", () => {
	it("posts the card everywhere, keeps it as waiting, and returns before anyone answers, with no answers", async () => {
		const { asking, shine, wai, run } = setup();
		turn(asking, SHINE_SENT);
		const r = await postedNow(run("toolu_1", [PORT]));
		expect(r.content[0]!.text).toMatch(/do NOT ask these again and do NOT wait/iu);
		const ask = askOf("port");
		expect(ask).toMatchObject({ toolCallId: "toolu_1" });
		expect(ofType(shine, "question_pending").map((m) => m.id)).toContain(ask.id);
		expect(ofType(wai, "question_pending").map((m) => m.id)).not.toContain(ask.id); // Shine's card: his windows (#1051)
		expect([...statics.sharedQuestions.keys()]).toEqual([ask.id]);
		expect(storeNow().waiting()).toEqual([
			expect.objectContaining({
				id: "toolu_1",
				askId: ask.id,
				toolCallId: "toolu_1",
				conversationId: asking.id,
				sessionFile: asking.session.sessionFile,
				owner: "Shine",
				questions: [PORT],
			}),
		]);
		expect(answeredEvents()).toEqual([]);
		expect(wakes).toEqual([]);
	});
});

describe("NB-2: the chat stays free while a card waits (COO, Shine + Wai)", () => {
	it("Wai's card waits; Shine's next turn in the same chat runs and posts without waiting on Wai", async () => {
		const { asking, run } = setup();
		turn(asking, WAI_SENT);
		await postedNow(run("toolu_1", [PORT]));
		const forWai = askOf("port");
		expect(forWai.requester).toBe("Wai");
		turn(asking, SHINE_SENT); // Shine's message runs in the same chat now: the first turn ended
		await postedNow(run("toolu_2", [DNS]));
		const forShine = askOf("dns");
		expect(forShine.requester).toBeUndefined();
		expect([...statics.sharedQuestions.keys()].sort()).toEqual([forWai.id, forShine.id].sort());
		expect(askHub.list().map((a) => a.id)).toContain(forWai.id);
		expect(kept()).toEqual([
			["toolu_1", "waiting", "Wai"],
			["toolu_2", "waiting", "Shine"],
		]);
		expect(wakes).toEqual([]);
	});
});

describe("NB-3: an answer wakes the chat as the owner, with its decision record", () => {
	it("in the browser: every window closes it, the hub settles it as Shine's, the chat gets it from Shine", async () => {
		const { asking, shine, wai, run } = setup();
		turn(asking, SHINE_SENT);
		await postedNow(run("toolu_1", [PORT]));
		const ask = askOf("port");
		await asAnswerer("Shine", () => wai.client.answerQuestion(ask.id, [{ id: "port", selected: ["8080"] }]));
		await turns();
		expect(retracted(shine)).toEqual([ask.id]);
		expect(retracted(wai)).toEqual([ask.id]);
		expect(statics.sharedQuestions.size).toBe(0);
		const [answered] = answeredEvents();
		expect(answerRecord(answered!.ask, answered!, Date.now())).toMatchObject({
			source: "answer",
			ref: "ask:toolu_1",
			answeredBy: "Shine",
			answeredIn: "browser",
		});
		expect(wakes).toHaveLength(1);
		const wake = wakes[0]!;
		expect(wake).toMatchObject({
			conversationId: asking.id,
			sessionFile: asking.session.sessionFile,
			requester: { kind: "owner", person: "Shine" },
		});
		expect(wake.text).toContain('answered your question "Which port?" in the browser (decision ref ask:toolu_1)');
		expect(wake.text).toContain("- Which port?: 8080");
		expect(turnOwnersOf({ v: 1, inputs: [wake.requester] }, undefined)).toEqual(["Shine"]);
		expect(kept()).toEqual([]); // admitted: gone from the file
	});

	it("on Telegram: the same, marked as from Telegram; a refused delivery keeps it to be delivered again", async () => {
		const { asking, shine, run } = setup();
		turn(asking, SHINE_SENT);
		await postedNow(run("toolu_1", [PORT]));
		const ask = askOf("port");
		deliverOk = false;
		expect(await pluginAnswer(ask.id, [{ id: "port", selected: ["9090"] }], "telegram")).toEqual({ ok: true });
		await turns();
		expect(retracted(shine)).toEqual([ask.id]);
		expect(answerRecord(answeredEvents()[0]!.ask, answeredEvents()[0]!, Date.now())).toMatchObject({
			ref: "ask:toolu_1",
			answeredIn: "telegram",
			answeredBy: "Shine",
		});
		expect(wakes).toEqual([
			expect.objectContaining({ cause: "telegram", requester: expect.objectContaining({ person: "Shine" }) }),
		]);
		expect(wakes[0]!.text).toContain("on telegram (decision ref ask:toolu_1)");
		expect(kept()).toEqual([["toolu_1", "delivering", "Shine"]]); // not admitted: kept for the next try
	});
});

describe("NB-4: no browser open, the last window closing, and a restart", () => {
	it("posts with no browser open and no listener, and the last window closing leaves the card waiting", async () => {
		const { asking, shine, run } = setup({ browsers: false });
		turn(asking, SHINE_SENT);
		expect(askHub.listening).toBe(false);
		const out = await outcomeNow(run("toolu_1", [PORT]));
		expect(out).not.toBe(`error: ${ASK_USER_NO_CLIENT_ERROR}`);
		expect(out).toMatchObject({ content: [{ text: expect.stringContaining(POSTED) }] });
		const ask = askOf("port");
		shine.client.cancelPendingQuestions(); // the last window's socket closed
		await turns();
		expect([...statics.sharedQuestions.keys()]).toEqual([ask.id]);
		expect(askHub.list().map((a) => a.id)).toEqual([ask.id]);
		expect(events.filter((e) => e.type === "gone")).toEqual([]);
		expect(kept()).toEqual([["toolu_1", "waiting", "Shine"]]);
	});

	it("a restart puts waiting cards back once and delivers a settled one once", async () => {
		const asking = chat("coo");
		const at = Date.parse("2026-11-24T18:00:00Z");
		const before = PendingQuestionsStore.inDataDir(dataDir);
		const base = { conversationId: asking.id, sessionFile: asking.session.sessionFile, conversationTitle: "COO lead" };
		before.post({
			...base,
			id: "toolu_1",
			askId: "q-1",
			toolCallId: "toolu_1",
			owner: "Wai",
			requester: "Wai",
			questions: [PORT],
			createdAt: at,
		});
		before.post({
			...base,
			id: "toolu_2",
			askId: "q-2",
			toolCallId: "toolu_2",
			owner: "Shine",
			questions: [DNS],
			createdAt: at + 1,
		});
		const settled = before.settle("toolu_2", {
			kind: "answered",
			answers: [{ id: "dns", selected: ["Yes"] }],
			summary: "Yes",
			from: "browser",
			by: "Shine",
		});
		if (!settled.ok) throw new Error(settled.reason);
		const host = wire(); // the new process: an empty list of asks, the same data folder
		win(new Map([[asking.id, asking]]), viewers.shine);
		await statics.restorePendingQuestions!();
		await statics.restorePendingQuestions!(); // a second start-up pass changes nothing
		const restored = askHub.list().filter((a) => a.toolCallId === "toolu_1");
		expect(restored).toHaveLength(1);
		expect(restored[0]).toMatchObject({ requester: "Wai" });
		expect([...statics.sharedQuestions.values()]).toEqual([expect.objectContaining({ conversationId: asking.id })]);
		expect(wakes).toEqual([questionWakeOf(settled.record)]);
		expect(kept()).toEqual([["toolu_1", "waiting", "Wai"]]);
		expect(host.store.get("toolu_2")).toBeUndefined();
		// The restored card is answered like any other: Wai's answer reaches the chat as Wai's.
		await asAnswerer("Wai", () => askHub.answer(restored[0]!.id, [{ id: "port", selected: ["8080"] }], "browser"));
		await turns();
		expect(wakes.map((w) => w.requester.person)).toEqual(["Shine", "Wai"]);
		expect(kept()).toEqual([]);
	});
});

describe("NB-5: a cancel in the browser, the chat closing, and COO handing it back", () => {
	it("a cancel in the browser closes it everywhere and tells the chat, which carries on", async () => {
		const { asking, shine, wai, run } = setup();
		turn(asking, SHINE_SENT);
		await postedNow(run("toolu_1", [PORT]));
		const ask = askOf("port");
		await shine.client.answerQuestion(ask.id, [], true);
		await turns();
		expect(retracted(wai)).toEqual([ask.id]);
		expect(wakes).toHaveLength(1);
		expect(wakes[0]!.text).toContain('Cancelled prompt "Which port?" — continue without re-asking immediately');
		expect(wakes[0]!.requester.person).toBe("Shine");
		expect(kept()).toEqual([]);
	});

	it("the chat closing (or a force-reset) takes its cards away without waking it", async () => {
		const { asking, shine, wai, run } = setup();
		turn(asking, SHINE_SENT);
		await postedNow(run("toolu_1", [PORT]));
		const ask = askOf("port");
		call<void>(shine.client, "cancelChatAsks", asking.id, "the chat was closed");
		await turns();
		expect(retracted(wai)).toEqual([ask.id]);
		expect(statics.sharedQuestions.size).toBe(0);
		expect(askHub.list()).toEqual([]);
		expect(wakes).toEqual([]);
		expect(kept()).toEqual([]);
	});

	it("COO hands it back: the card closes and the asking chat gets COO's note", async () => {
		const router = new OwnerQuestionRouter({
			enabled: () => true,
			hub: askHub,
			holds: () => new OwnerQuestionHolds(join(dir, OWNER_QUESTION_HOLDS_FILE)),
		});
		ClientSession.ownerQuestions = router;
		cleanups.push(
			askHub.observe((ev) => ClientSession.ownerAskRouted(ev)),
			() => router.dispose(),
		);
		const { asking, shine, run } = setup();
		turn(asking); // a role's message: the card goes to COO first
		await postedNow(run("toolu_1", [PORT]));
		const ask = askOf("port");
		expect(askHub.heldList().map((a) => a.id)).toEqual([ask.id]);
		expect(router.returnToAsker(ask.id, "Use the port the plan names")).toEqual({ ok: true });
		await turns();
		expect(retracted(shine)).toContain(ask.id);
		expect(statics.sharedQuestions.size).toBe(0);
		expect(wakes).toHaveLength(1);
		expect(wakes[0]!.text).toContain(questionReturnedText("Use the port the plan names"));
		expect(wakes[0]!.conversationId).toBe(asking.id);
		expect(kept()).toEqual([]);
	});
});

describe("NB-6: one call for Shine and Wai posts two cards that end on their own", () => {
	it("each owner's card waits on its own; Shine's answer wakes the chat while Wai's still waits", async () => {
		const { asking, shine, wai, run } = setup();
		turn(asking, SHINE_SENT, WAI_SENT);
		const r = await postedNow(
			run("toolu_1", [
				{ ...PORT, owner: "Shine" },
				{ ...DNS, owner: "Wai" },
			]),
		);
		const [forShine, forWai] = [sliceToolCallId("toolu_1", "Shine"), sliceToolCallId("toolu_1", "Wai")];
		expect(r.content[0]!.text).toContain(`For Shine (decision ref ask:${forShine})`);
		expect(r.content[0]!.text).toContain(`For Wai (decision ref ask:${forWai})`);
		const [shineAsk, waiAsk] = [askOf("port"), askOf("dns")];
		expect(shineAsk).toMatchObject({ toolCallId: forShine });
		expect(shineAsk.requester).toBeUndefined();
		expect(ofType(wai, "question_pending").map((m) => m.id)).toEqual([waiAsk.id]); // "For Wai": web only
		expect(waiAsk).toMatchObject({ toolCallId: forWai, requester: "Wai" });
		const tgOnly = askHub.list().filter((a) => a.requester === undefined); // what Telegram is sent (pluginAsks)
		expect(tgOnly.map((a) => a.id)).toEqual([shineAsk.id]);
		expect(kept()).toEqual([
			[forShine, "waiting", "Shine"],
			[forWai, "waiting", "Wai"],
		]);
		await asAnswerer("Shine", () => shine.client.answerQuestion(shineAsk.id, [{ id: "port", selected: ["9090"] }]));
		await turns();
		expect(wakes).toHaveLength(1);
		expect(wakes[0]!.requester.person).toBe("Shine");
		expect(wakes[0]!.text).toContain(`(decision ref ask:${forShine})`);
		expect(askHub.list().map((a) => a.id)).toEqual([waiAsk.id]);
		expect([...statics.sharedQuestions.keys()]).toEqual([waiAsk.id]);
		expect(kept()).toEqual([[forWai, "waiting", "Wai"]]);
		expect(JSON.parse(readFileSync(storeFile(), "utf8")).records).toHaveLength(1);
	});
});
