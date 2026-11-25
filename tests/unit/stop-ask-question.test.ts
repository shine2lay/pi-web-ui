// stop-cancels-ask (Ops #1085; Shine 2026-11-24 m104239: "why cant i stop coo lead's chat, it seems to be stuck for
// the past 13 hours"): Stop ends a waiting ask_user_question at once, and a force-reset leaves no question or
// permission prompt behind. The tool runs through the real ClientSession.askUser, the real list of asks and the real
// per-owner split (#1079), in windows of Shine's and Wai's logins. No server, model or socket; temporary folders only.
import { getEventListeners } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientSession, makeAskUserQuestionTool } from "../../server/agent-service.js";
import { type Ask, type AskEvent, askHub } from "../../server/asks.js";
import type { OwnerViewer } from "../../server/owner-requester.js";
import type { ServerMessage, UiQuestion } from "../../server/protocol.js";
import { requesterForAdmission } from "../../server/queue-requester.js";
import { collectRoleInput, newTurnRecord, type RoleTurnRecord } from "../../server/role-replies.js";
import { PeopleBook, type SentBy, serveOwners, tailscaleSenderOf } from "../../server/sent-by.js";

const WAI_SENT: SentBy = { login: "sayswai@gmail.com", name: "Wai", owner: false };
const SHINE_SENT: SentBy = { login: "aungshine@gmail.com", name: "Shine", owner: true };
const PORT: UiQuestion = { id: "port", question: "Which port?", options: [{ label: "8080" }, { label: "9090" }] };
const DNS: UiQuestion = { id: "dns", question: "Create the address?", options: [{ label: "Yes" }, { label: "No" }] };
const ABORTED = "ask_user_question aborted";

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

const statics = ClientSession as unknown as {
	liveSessions: Set<ClientSession>;
	sharedQuestions: Map<string, { conversationId?: string }>;
	sharedApprovals: Map<string, unknown>;
};
const call = <T>(client: ClientSession, name: string, ...args: unknown[]): T =>
	(Reflect.get(ClientSession.prototype, name) as (...a: unknown[]) => T).call(client, ...args);

let dir = "";
let seq = 0;
let viewers: { shine: OwnerViewer; wai: OwnerViewer };
let gone: Array<{ id: string; reason: string }> = [];
const cleanups: Array<() => void> = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "stop-ask-question-"));
	const people = join(dir, "people.json");
	writeFileSync(
		people,
		JSON.stringify({ "aungshine@gmail.com": { name: "Shine", owner: true }, "sayswai@gmail.com": { name: "Wai" } }),
	);
	const book = serveOwners(new PeopleBook(people, { log: () => {}, warn: () => {} } as unknown as Console));
	const login = (l: string) => tailscaleSenderOf({ "tailscale-user-login": l, "tailscale-user-name": l });
	viewers = { shine: book.viewerOf(login("aungshine@gmail.com")), wai: book.viewerOf(login("sayswai@gmail.com")) };
	gone = [];
	cleanups.push(
		askHub.on((ev: AskEvent) => {
			if (ev.type === "gone") gone.push({ id: ev.ask.id, reason: ev.reason });
		}),
	);
});
afterEach(() => {
	for (const undo of cleanups.splice(0).reverse()) undo();
	for (const id of [...statics.sharedQuestions.keys()]) statics.sharedQuestions.delete(id);
	for (const id of [...statics.sharedApprovals.keys()]) statics.sharedApprovals.delete(id);
	for (const a of [...askHub.list(), ...askHub.heldList()]) askHub.settle(a.id, { how: "gone", reason: "test over" });
	rmSync(dir, { recursive: true, force: true });
});

function chat(name: string): FakeChat {
	const sessionFile = join(dir, `${name}.jsonl`);
	return {
		id: `conv-${name}`,
		title: name,
		cwd: dir,
		isSubagent: true, // no place on the working list to give back in a force-reset
		session: { sessionFile, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => `sid-${name}` } },
		dialogs: { current: null, cancelAll: () => {} },
		unsubscribe: () => {},
		toolWatchdogs: new Map(),
		toolStartTimes: new Map(),
		runtime: { session: { abort: async () => {} }, dispose: async () => {} },
	};
}

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
		// force-reset: rebuilding the runtime is out of scope here; it fails and is reported, as a real failure is.
		openManagerAndRuntime: { value: async () => Promise.reject(new Error("no runtime in this test")) },
		bindSession: { value: async () => {} },
		pushSlashCommands: { value: async () => {} },
	});
	client.ownerViewer = viewer;
	statics.liveSessions.add(client);
	cleanups.push(() => statics.liveSessions.delete(client));
	return { client, sent };
}

/** COO's chat with Shine's and Wai's windows, its ask_user_question tool wired as bridgeTarget wires it. */
function setup() {
	const asking = chat("coo");
	const convs = new Map<string, FakeChat>([[asking.id, asking]]);
	const shine = win(convs, viewers.shine);
	const wai = win(convs, viewers.wai);
	const tool = makeAskUserQuestionTool(
		{
			askUser: (q, sig, conversationId, owner) => shine.client.askUser(q, sig, conversationId, owner),
			questionOwners: (conversationId) => shine.client.questionOwners(conversationId),
		},
		asking.id,
	);
	const stop = new AbortController();
	const run = (questions: UiQuestion[]) =>
		tool.execute("toolu_1", { questions }, stop.signal, undefined, {} as never) as Promise<{
			content: { text: string }[];
		}>;
	return { asking, shine, wai, run, stop };
}

/** How the call stands one timer turn later: Stop must not wait for anything (no hard-abort timer, no force-reset). */
const outcomeNow = (p: Promise<unknown>) =>
	Promise.race([
		p.then(
			() => "answered",
			(e: Error) => e.message,
		),
		new Promise((r) => setTimeout(() => r("still waiting"), 0)),
	]);
const askOf = (questionId: string): Ask => askHub.list().find((a) => a.fields.some((f) => f.id === questionId))!;
const retracted = (w: Win) => w.sent.flatMap((m) => (m.type === "question_retracted" ? [m.id] : []));
const abortListeners = (s: AbortSignal) => getEventListeners(s, "abort").length;

describe("Stop while ask_user_question waits", () => {
	it("one owner: the call fails at once, the question leaves every list and every window closes it", async () => {
		const { asking, shine, wai, run, stop } = setup();
		typedBy(asking, SHINE_SENT);
		const result = run([PORT]);
		const ask = askOf("port");
		expect(statics.sharedQuestions.size).toBe(1);
		stop.abort();
		expect(await outcomeNow(result)).toBe(ABORTED);
		expect(statics.sharedQuestions.size).toBe(0);
		expect(askHub.list()).toEqual([]);
		expect(gone).toEqual([{ id: ask.id, reason: "the run was stopped" }]);
		expect(retracted(shine)).toEqual([ask.id]);
		expect(retracted(wai)).toEqual([ask.id]);
		expect(call<boolean>(shine.client, "isWaitingOnUser", asking.id)).toBe(false);
		expect(abortListeners(stop.signal)).toBe(0);
	});

	it("Shine and Wai: Shine answered, Wai's dialog still open: the call fails and Wai's dialog closes", async () => {
		const { asking, shine, wai, run, stop } = setup();
		typedBy(asking, SHINE_SENT, WAI_SENT);
		const result = run([
			{ ...PORT, owner: "Shine" },
			{ ...DNS, owner: "Wai" },
		]);
		const [forShine, forWai] = [askOf("port"), askOf("dns")];
		shine.client.resolveQuestion(forShine.id, [{ id: "port", selected: ["8080"] }]);
		stop.abort();
		expect(await outcomeNow(result)).toBe(ABORTED);
		expect(statics.sharedQuestions.size).toBe(0);
		expect(askHub.list()).toEqual([]);
		expect(gone).toEqual([{ id: forWai.id, reason: "the run was stopped" }]);
		expect(retracted(wai)).toEqual([forShine.id, forWai.id]);
		expect(abortListeners(stop.signal)).toBe(0);
	});

	it("Shine and Wai, both still open: both dialogs close and the call fails", async () => {
		const { asking, shine, run, stop } = setup();
		typedBy(asking, SHINE_SENT, WAI_SENT);
		const result = run([
			{ ...PORT, owner: "Shine" },
			{ ...DNS, owner: "Wai" },
		]);
		const ids = [askOf("port").id, askOf("dns").id];
		stop.abort();
		expect(await outcomeNow(result)).toBe(ABORTED);
		expect(statics.sharedQuestions.size).toBe(0);
		expect(askHub.list()).toEqual([]);
		expect(gone.map((g) => g.id).sort()).toEqual([...ids].sort());
		expect(retracted(shine).sort()).toEqual([...ids].sort());
		expect(abortListeners(stop.signal)).toBe(0);
	});

	it("an answer before any Stop works as before and leaves no abort listener behind", async () => {
		const { asking, shine, run, stop } = setup();
		typedBy(asking, SHINE_SENT);
		const result = run([PORT]);
		expect(abortListeners(stop.signal)).toBe(1);
		shine.client.resolveQuestion(askOf("port").id, [{ id: "port", selected: ["9090"] }]);
		expect((await result).content[0]!.text).toBe("port: 9090");
		expect(abortListeners(stop.signal)).toBe(0);
		stop.abort(); // a later Stop finds nothing to end
		expect(gone).toEqual([]);
	});

	it("a cancel in the browser still ends the call as cancelled, with no abort listener left", async () => {
		const { asking, shine, run, stop } = setup();
		typedBy(asking, SHINE_SENT);
		const result = run([PORT]);
		shine.client.resolveQuestion(askOf("port").id, [], true);
		await expect(result).rejects.toThrow("User cancelled the question.");
		expect(abortListeners(stop.signal)).toBe(0);
	});
});

describe("force-reset of a chat waiting on a question", () => {
	it("cancels its questions and permission prompts: 0 left waiting on the owner", async () => {
		const { asking, shine, run } = setup();
		typedBy(asking, SHINE_SENT);
		const result = run([PORT]);
		const ask = askOf("port");
		let denied = false;
		statics.sharedApprovals.set("ap-1", {
			conversationId: asking.id,
			resolve: () => {
				denied = true;
			},
		});
		expect(call<boolean>(shine.client, "isWaitingOnUser", asking.id)).toBe(true);
		await call<Promise<void>>(shine.client, "forceResetConversation", asking, "test: the run did not stop");
		expect(await outcomeNow(result)).toBe("User cancelled the question.");
		expect([...statics.sharedQuestions.values()].filter((q) => q.conversationId === asking.id)).toEqual([]);
		expect(statics.sharedApprovals.size).toBe(0);
		expect(denied).toBe(true);
		expect(askHub.list()).toEqual([]);
		expect(gone).toEqual([{ id: ask.id, reason: "the run was force-stopped" }]);
		expect(retracted(shine)).toEqual([ask.id]);
		expect(call<boolean>(shine.client, "isWaitingOnUser", asking.id)).toBe(false);
	});
});
