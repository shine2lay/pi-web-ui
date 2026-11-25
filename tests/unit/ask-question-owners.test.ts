// ask-question-owners (Ops #1079; Wai 2026-11-22 via Backend rm-8b704195, decision dr-1452e9e255d8): each
// ask_user_question question goes to its own owner, from data; one dialog never carries two owners' questions.
// nonblocking-ask (Ops #1087): the call posts one card per owner and returns at once; each owner's answer reaches the
// chat later as its own wake (no combined result).
// The tool runs through the real ClientSession.postQuestion, the real list of asks, the real per-viewer rule, the plugin
// (Telegram) filter and a real decision store, in windows of Shine's and Wai's logins. No server, model or socket;
// temporary folders only.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientSession, makeAskUserQuestionTool } from "../../server/agent-service.js";
import { toolCallIdOfSlice } from "../../server/ask-question-owners.js";
import { type Ask, askHub } from "../../server/asks.js";
import { answerRecord, DecisionRecords } from "../../server/decision-records.js";
import { pluginAsks } from "../../server/owner-question-surfaces.js";
import { askIsForViewer, type OwnerViewer } from "../../server/owner-requester.js";
import { PendingQuestionsStore, type QuestionWake } from "../../server/pending-questions-store.js";
import type { QuestionAnswer, ServerMessage, UiQuestion } from "../../server/protocol.js";
import { requesterForAdmission } from "../../server/queue-requester.js";
import { collectRoleInput, newTurnRecord, type RoleTurnRecord } from "../../server/role-replies.js";
import { PeopleBook, type SentBy, serveOwners, tailscaleSenderOf } from "../../server/sent-by.js";

const WAI_SENT: SentBy = { login: "sayswai@gmail.com", name: "Wai", owner: false };
const SHINE_SENT: SentBy = { login: "aungshine@gmail.com", name: "Shine", owner: true };

/** The two questions of dr-1452e9e255d8, as COO sent them (no owner). */
const ROLLCALL: UiQuestion = {
	id: "rollcall_trim",
	header: "Shine: RollCall cleanup",
	question: "Shine: Docs finished the cleanup plan for RollCall. Go ahead?",
	options: [{ label: "Yes, carry it out" }, { label: "Not now" }],
};
const WATCH: UiQuestion = {
	id: "watch_dns",
	header: "Wai: watch web address",
	question: "Wai (Shine can also OK it, as the domain is shared): OK to create it?",
	options: [{ label: "Yes, random address" }, { label: "Not yet" }],
};
const PORT: UiQuestion = { id: "port", question: "Which port?", options: [{ label: "8080" }, { label: "9090" }] };

interface FakeChat {
	id: string;
	title: string;
	cwd: string;
	isSubagent: boolean;
	session: { sessionFile: string; sessionManager: { getSessionFile(): string; getSessionId(): string } };
	dialogs: { current: null };
	turnRecord?: RoleTurnRecord;
}
interface Win {
	client: ClientSession;
	sent: ServerMessage[];
	viewer: OwnerViewer;
}

const statics = ClientSession as unknown as { liveSessions: Set<ClientSession>; sharedQuestions: Map<string, unknown> };

let dir = "";
let seq = 0;
let viewers: { shine: OwnerViewer; wai: OwnerViewer };
let records: DecisionRecords;
let wakes: QuestionWake[] = [];
const cleanups: Array<() => void> = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ask-question-owners-"));
	// The live people.json's shape: Shine is the owner, Wai is listed.
	const people = join(dir, "people.json");
	writeFileSync(
		people,
		JSON.stringify({ "aungshine@gmail.com": { name: "Shine", owner: true }, "sayswai@gmail.com": { name: "Wai" } }),
	);
	const book = serveOwners(new PeopleBook(people, { log: () => {}, warn: () => {} } as unknown as Console));
	const login = (l: string) => tailscaleSenderOf({ "tailscale-user-login": l, "tailscale-user-name": l });
	viewers = { shine: book.viewerOf(login("aungshine@gmail.com")), wai: book.viewerOf(login("sayswai@gmail.com")) };
	// As AgentService.startDecisionRecords keeps an owner's answer.
	records = new DecisionRecords(join(dir, "decisions"));
	wakes = [];
	const store = PendingQuestionsStore.inDataDir(join(dir, "data"));
	ClientSession.pendingQuestionsHost = {
		store,
		deliver: async (wake) => {
			wakes.push(wake);
			return { ok: true };
		},
	};
	cleanups.push(() => {
		ClientSession.pendingQuestionsHost = null;
	});
	cleanups.push(
		askHub.on((ev) => {
			if (ev.type === "answered") records.append(answerRecord(ev.ask, ev, Date.now())!);
		}),
	);
});
afterEach(() => {
	for (const undo of cleanups.splice(0).reverse()) undo();
	for (const id of [...statics.sharedQuestions.keys()]) statics.sharedQuestions.delete(id);
	for (const a of [...askHub.list(), ...askHub.heldList()]) askHub.settle(a.id, { how: "gone", reason: "test over" });
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
		dialogs: { current: null },
	};
}

/** `sentBy` typed into the chat from a real page (index.ts browserRoleInput); several = a batched turn. */
function typedBy(c: FakeChat, ...senders: SentBy[]): void {
	const rec = (c.turnRecord ??= newTurnRecord());
	for (const sentBy of senders) {
		const inputId = `ri-00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, "0")}`;
		const requester = requesterForAdmission({ cause: "browser", ownerChannel: "browser", inputId, sentBy });
		collectRoleInput(rec, { requester, cause: "browser", ownerChannel: "browser" });
	}
}

function win(convs: Map<string, FakeChat>, viewer: OwnerViewer): Win {
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
		sinkCount: { value: () => 1 },
		flushSnapshot: { value: () => {} },
		emitConversations: { value: () => {} },
	});
	client.ownerViewer = viewer;
	statics.liveSessions.add(client);
	cleanups.push(() => statics.liveSessions.delete(client));
	return { client, sent, viewer };
}

/** COO's chat with Shine's and Wai's windows, and its ask_user_question tool wired as bridgeTarget wires it. */
function setup() {
	const asking = chat("coo");
	const convs = new Map<string, FakeChat>([[asking.id, asking]]);
	const shine = win(convs, viewers.shine);
	const wai = win(convs, viewers.wai);
	const tool = makeAskUserQuestionTool(
		{
			postQuestion: (q, id, conversationId, owner) => shine.client.postQuestion(q, id, conversationId, owner),
			questionOwners: (conversationId) => shine.client.questionOwners(conversationId),
		},
		asking.id,
	);
	const run = (questions: UiQuestion[], id = "toolu_1") =>
		tool.execute(id, { questions }, undefined, undefined, {} as never) as Promise<{
			content: { text: string }[];
			details?: unknown;
		}>;
	return { asking, shine, wai, run };
}

const pending = (w: Win) =>
	w.sent.flatMap((m) => (m.type === "question_pending" ? [m.questions.map((q) => q.id)] : []));
const askOf = (questionId: string): Ask => askHub.list().find((a) => a.fields.some((f) => f.id === questionId))!;
const answer = (w: Win, ask: Ask, answers: QuestionAnswer[], cancelled = false) =>
	w.client.resolveQuestion(ask.id, answers, cancelled); // no takeover here: the question's id is its ask's
const settle = () => new Promise((r) => setTimeout(r, 0));

describe("a call with questions for Shine and Wai", () => {
	it("becomes one card each: Shine's to his windows and Telegram, Wai's to Wai's window only, two records", async () => {
		const { asking, shine, wai, run } = setup();
		typedBy(asking, SHINE_SENT, WAI_SENT);
		const out = await run([
			{ ...ROLLCALL, owner: "Shine" },
			{ ...WATCH, owner: "Wai" },
		]);
		// Posted, not answered: the call returned at once with no answers (decision-records backfill has none to mix).
		expect(out.content[0]!.text).toContain("non-blocking");
		expect(out.details).not.toHaveProperty("answers");
		const asks = askHub.list();
		expect(asks).toHaveLength(2);
		const forShine = askOf("rollcall_trim");
		const forWai = askOf("watch_dns");
		expect(forShine.fields.map((f) => f.id)).toEqual(["rollcall_trim"]);
		expect(forShine.requester).toBeUndefined(); // "For Shine"
		expect(forWai.fields.map((f) => f.id)).toEqual(["watch_dns"]);
		expect(forWai.requester).toBe("Wai"); // "For Wai"
		// Windows: each owner gets only his own question; 0 cross-owner leakage.
		expect(pending(shine)).toEqual([["rollcall_trim"]]);
		expect(pending(wai)).toEqual([["watch_dns"]]);
		expect(askIsForViewer(forShine.requester, viewers.wai)).toBe(false);
		expect(askIsForViewer(forWai.requester, viewers.shine)).toBe(false);
		// Telegram (plugins): Shine's only.
		expect(pluginAsks().map((a) => a.id)).toEqual([forShine.id]);
		answer(wai, forWai, [{ id: "watch_dns", selected: [], custom: "Use the Mac's IP" }]);
		answer(shine, forShine, [{ id: "rollcall_trim", selected: ["Not now"] }]);
		await settle();
		// Each owner's answer wakes the chat as his own message.
		expect(wakes.map((w) => [w.id, w.requester.person])).toEqual([
			["toolu_1#Wai", "Wai"],
			["toolu_1#Shine", "Shine"],
		]);
		expect(wakes[0]!.text).toContain("Use the Mac's IP");
		expect(wakes[1]!.text).toContain("Not now");
		const kept = records.list().filter((r) => r.source === "answer");
		expect(kept).toHaveLength(2);
		const byQuestion = (id: string) => kept.find((r) => r.questions?.some((q) => q.id === id))!;
		expect(byQuestion("rollcall_trim").questions!.map((q) => q.id)).toEqual(["rollcall_trim"]);
		expect(byQuestion("rollcall_trim")).not.toHaveProperty("requester");
		expect(byQuestion("watch_dns").questions!.map((q) => q.id)).toEqual(["watch_dns"]);
		expect(byQuestion("watch_dns")).toMatchObject({ requester: "Wai", routedTo: "Wai (web only)" });
		// Both records still lead back to the one tool call (decision-previews reads previews by it).
		expect(kept.map((r) => toolCallIdOfSlice(r.ref.slice(4)))).toEqual(["toolu_1", "toolu_1"]);
	});

	it("one owner cancels: the other's answer stands and is recorded; each wake says what its owner did", async () => {
		const { asking, shine, wai, run } = setup();
		typedBy(asking, SHINE_SENT, WAI_SENT);
		await run([
			{ ...ROLLCALL, owner: "Shine" },
			{ ...WATCH, owner: "Wai" },
		]);
		answer(shine, askOf("rollcall_trim"), [], true);
		answer(wai, askOf("watch_dns"), [{ id: "watch_dns", selected: ["Not yet"] }]);
		await settle();
		expect(wakes.map((w) => w.requester.person)).toEqual(["Shine", "Wai"]);
		expect(wakes[0]!.text).toMatch(/^Cancelled prompt/);
		expect(wakes[1]!.text).toContain("Not yet");
		expect(records.list().filter((r) => r.source === "answer")).toMatchObject([{ requester: "Wai" }]);
	});
});

describe("refused before anything is shown", () => {
	const nothingShown = (s: ReturnType<typeof setup>) => {
		expect(askHub.list()).toEqual([]);
		expect([...pending(s.shine), ...pending(s.wai)]).toEqual([]);
	};

	it("dr-1452e9e255d8: two untagged questions in a turn batched from Shine and Wai", async () => {
		const s = setup();
		typedBy(s.asking, SHINE_SENT, WAI_SENT);
		await expect(s.run([ROLLCALL, WATCH])).rejects.toThrow(/no owner.*Shine, Wai/s);
		nothingShown(s);
	});

	it('an untagged "Shine: ..." question in a Wai turn, and "Wai: ..." in a Shine turn', async () => {
		const s = setup();
		typedBy(s.asking, WAI_SENT);
		await expect(s.run([ROLLCALL])).rejects.toThrow(/addressed to Shine.*owner: "Shine"/s);
		nothingShown(s);
		const t = setup();
		typedBy(t.asking, SHINE_SENT);
		await expect(t.run([{ ...PORT, header: "Wai: watch web address" }])).rejects.toThrow(/addressed to Wai/);
		nothingShown(t);
	});

	it("an owner nobody lists", async () => {
		const s = setup();
		typedBy(s.asking, WAI_SENT);
		await expect(s.run([{ ...PORT, owner: "Bob" }])).rejects.toThrow(/"Bob".*Shine, Wai/s);
		nothingShown(s);
	});

	it("a question depending on another owner's question", async () => {
		const s = setup();
		typedBy(s.asking, SHINE_SENT, WAI_SENT);
		const dependent = { ...PORT, owner: "Wai", dependsOn: { questionId: "rollcall_trim" } };
		await expect(s.run([{ ...ROLLCALL, owner: "Shine" }, dependent])).rejects.toThrow(/depends on "rollcall_trim"/);
		nothingShown(s);
	});
});

describe("one owner", () => {
	it('a Wai turn asking { owner: "Shine" }: For Shine, to Shine and Telegram, not Wai', async () => {
		const { asking, shine, wai, run } = setup();
		typedBy(asking, WAI_SENT);
		await run([{ ...PORT, owner: "Shine" }]);
		const ask = askOf("port");
		expect(ask.requester).toBeUndefined();
		expect(pending(shine)).toEqual([["port"]]);
		expect(pending(wai)).toEqual([]);
		expect(pluginAsks().map((a) => a.id)).toEqual([ask.id]);
		answer(shine, ask, [{ id: "port", selected: ["8080"] }]);
		await settle();
		expect(wakes).toHaveLength(1);
		expect(wakes[0]!.requester.person).toBe("Shine");
		expect(wakes[0]!.text).toContain("8080");
	});

	it("an untagged question in a Wai turn is Wai's (one ask, the tool call id unchanged)", async () => {
		const { asking, shine, wai, run } = setup();
		typedBy(asking, WAI_SENT);
		await run([WATCH], "toolu_9");
		const ask = askOf("watch_dns");
		expect(ask.requester).toBe("Wai");
		expect(ask.toolCallId).toBe("toolu_9");
		expect(pending(wai)).toEqual([["watch_dns"]]);
		expect(pending(shine)).toEqual([]);
		expect(pluginAsks()).toEqual([]);
		answer(wai, ask, [{ id: "watch_dns", selected: ["Not yet"] }]);
		await settle();
		expect(wakes.map((w) => [w.id, w.requester.person])).toEqual([["toolu_9", "Wai"]]);
		expect(wakes[0]!.text).toContain("Not yet");
	});
});
