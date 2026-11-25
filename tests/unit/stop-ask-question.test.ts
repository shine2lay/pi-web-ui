// stop-cancels-ask (Ops #1085; Shine 2026-11-24 m104239: "why cant i stop coo lead's chat, it seems to be stuck for
// the past 13 hours"). nonblocking-ask (Ops #1087, dr-36efc6499afe) removed the wait itself: the call returns as it
// posts, so Stop has nothing to end and the question keeps waiting for its owner; a force-reset still leaves no
// question or permission prompt behind, with no wake. The tool runs through the real ClientSession.postQuestion, the
// real list of asks and the real per-owner split (#1079), in windows of Shine's and Wai's logins. No server, model or
// socket; temporary folders only.
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
			postQuestion: (q, id, conversationId, owner) => shine.client.postQuestion(q, id, conversationId, owner),
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

const askOf = (questionId: string): Ask => askHub.list().find((a) => a.fields.some((f) => f.id === questionId))!;
const retracted = (w: Win) => w.sent.flatMap((m) => (m.type === "question_retracted" ? [m.id] : []));

describe("Stop after ask_user_question posted (nonblocking-ask, Ops #1087)", () => {
	it("the call returned as it posted: nothing waits on Stop, and the question keeps waiting for its owner", async () => {
		const { asking, shine, wai, run, stop } = setup();
		typedBy(asking, SHINE_SENT);
		const result = await run([PORT]);
		expect(result.content[0]!.text).toContain("non-blocking");
		const ask = askOf("port");
		stop.abort();
		expect(statics.sharedQuestions.size).toBe(1);
		expect(askHub.list().map((a) => a.id)).toEqual([ask.id]);
		expect(gone).toEqual([]);
		expect(retracted(shine)).toEqual([]);
		expect(retracted(wai)).toEqual([]);
		// The chat is not stuck on it: its turn ended, so it is not "waiting on the owner" for the stall watch.
		expect(call<boolean>(shine.client, "isWaitingOnUser", asking.id)).toBe(false);
	});

	it("Shine and Wai: one card each, both still open after Stop", async () => {
		const { asking, run, stop } = setup();
		typedBy(asking, SHINE_SENT, WAI_SENT);
		await run([
			{ ...PORT, owner: "Shine" },
			{ id: "dns", question: "Create the address?", options: [{ label: "Yes" }, { label: "No" }], owner: "Wai" },
		]);
		stop.abort();
		expect(
			askHub
				.list()
				.map((a) => a.requester ?? "Shine")
				.sort(),
		).toEqual(["Shine", "Wai"]);
		expect(gone).toEqual([]);
	});
});

describe("force-reset of a chat with a waiting question", () => {
	it("cancels its questions and permission prompts: 0 left waiting on the owner", async () => {
		const { asking, shine, run } = setup();
		typedBy(asking, SHINE_SENT);
		await run([PORT]);
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
		expect([...statics.sharedQuestions.values()].filter((q) => q.conversationId === asking.id)).toEqual([]);
		expect(statics.sharedApprovals.size).toBe(0);
		expect(denied).toBe(true);
		expect(askHub.list()).toEqual([]);
		expect(gone).toEqual([{ id: ask.id, reason: "the run was force-stopped" }]);
		expect(retracted(shine)).toEqual([ask.id]);
		expect(call<boolean>(shine.client, "isWaitingOnUser", asking.id)).toBe(false);
	});
});
