// owner-requester (Ops #1051): an owner question shows only to the owner it is for. Shine, 2026-11-20: "this is
// Shine, why are you showing it to me? this question should only show up for Wai". Three windows (Shine's login,
// Wai's login, no login) go through the real ClientSession code, the real list of asks and the real projections;
// each surface of the inventory (~/ops-checks/owner-question-per-viewer/hypothesis.md) is checked per window.
// No server, model or socket; temporary folders only.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { type AskEvent, askHub, dialogAsk } from "../../server/asks.js";
import { noteOwnerInput } from "../../server/owner-input-time.js";
import { pluginAsks, pluginSeesAskEvent } from "../../server/owner-question-surfaces.js";
import { askIsForViewer, DEFAULT_VIEWER, type OwnerViewer } from "../../server/owner-requester.js";
import { queueForViewer, rolesOverviewForViewer } from "../../server/owner-viewer.js";
import type {
	ServerMessage,
	UiQueueChatStatus,
	UiQuestion,
	UiRoleAsk,
	UiState,
	UiTaskQueue,
	UiTaskRequester,
	UiTldrLine,
} from "../../server/protocol.js";
import { requesterForAdmission } from "../../server/queue-requester.js";
import type { UiRolesOverview } from "../../server/roles-board-protocol.js";
import { RolesWatch } from "../../server/roles-watch.js";
import { collectRoleInput, newTurnRecord, type RoleTurnRecord } from "../../server/role-replies.js";
import { PeopleBook, type SentBy, tailscaleSenderOf } from "../../server/sent-by.js";

const QUESTIONS: UiQuestion[] = [
	{ id: "port", question: "Which port?", options: [{ label: "8080" }, { label: "9090" }] },
];
const WAI_SENT: SentBy = { login: "sayswai@gmail.com", name: "Wai", owner: false };
const SHINE_SENT: SentBy = { login: "aungshine@gmail.com", name: "Shine", owner: true };
const waiOrigin: UiTaskRequester = {
	v: 1,
	inputs: [{ kind: "owner", channel: "browser", id: "ri-12345678", person: "Wai" }],
};
const shineOrigin: UiTaskRequester = { v: 1, inputs: [{ kind: "owner", channel: "browser", id: "ri-abcdef12" }] };

interface FakeChat {
	id: string;
	title: string;
	cwd: string;
	isSubagent: boolean;
	session: { sessionFile: string; sessionManager: { getSessionFile(): string; getSessionId(): string } };
	dialogs: { current: { id: number; kind: "confirm"; title: string; args: string[] } | null };
	turnRecord?: RoleTurnRecord;
	ownerLastWroteAt?: number;
}
interface Win {
	name: string;
	client: ClientSession;
	sent: ServerMessage[];
	viewer: OwnerViewer;
}

const statics = ClientSession as unknown as {
	liveSessions: Set<ClientSession>;
	sharedQuestions: Map<string, unknown>;
	sharedApprovals: Map<string, unknown>;
	sharedConvs: Map<string, unknown>;
	taskQueueOfConv(conv: unknown): UiTaskQueue;
	queueStatuses: ReadonlyMap<string, UiQueueChatStatus>;
	stuckTaskChats: ReadonlyMap<string, unknown>;
	queueStatusesForOwner(viewer: OwnerViewer): ReadonlyMap<string, UiQueueChatStatus>;
	lineAboutHeldAsk(conv: unknown, lines: readonly UiTldrLine[], viewer: OwnerViewer): boolean;
	noticeAboutHeldCard(conv: unknown, message: string, viewer: OwnerViewer): boolean;
};
const call = <T>(client: ClientSession, name: string, ...args: unknown[]): T =>
	(Reflect.get(ClientSession.prototype, name) as (...a: unknown[]) => T).call(client, ...args);

let dir = "";
let seq = 0;
let viewers: { shine: OwnerViewer; wai: OwnerViewer; none: OwnerViewer };
const cleanups: Array<() => void> = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "owner-per-viewer-"));
	// The live people.json's shape: Shine is the owner, Wai is listed.
	const people = join(dir, "people.json");
	writeFileSync(
		people,
		JSON.stringify({ "aungshine@gmail.com": { name: "Shine", owner: true }, "sayswai@gmail.com": { name: "Wai" } }),
	);
	const book = new PeopleBook(people, { log: () => {}, warn: () => {} } as unknown as Console);
	const login = (l: string) => tailscaleSenderOf({ "tailscale-user-login": l, "tailscale-user-name": l });
	viewers = {
		shine: book.viewerOf(login("aungshine@gmail.com")),
		wai: book.viewerOf(login("sayswai@gmail.com")),
		none: book.viewerOf(undefined),
	};
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
		isSubagent: false,
		session: { sessionFile, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => `sid-${name}` } },
		dialogs: { current: null },
	};
}

/** `sentBy` typed into the chat from a real page (index.ts browserRoleInput). */
function typedBy(c: FakeChat, sentBy: SentBy): void {
	const rec = (c.turnRecord ??= newTurnRecord());
	const inputId = `ri-00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, "0")}`;
	const requester = requesterForAdmission({ cause: "browser", ownerChannel: "browser", inputId, sentBy });
	collectRoleInput(rec, { requester, cause: "browser", ownerChannel: "browser" });
	noteOwnerInput(c, rec, true, Date.now() - 60_000);
}

/** A browser window of `viewer`, looking at `activeId`; every chat is open in it, as the shared chats are. */
function win(name: string, convs: Map<string, FakeChat>, activeId: string, viewer: OwnerViewer): Win {
	const sent: ServerMessage[] = [];
	const client: ClientSession = Object.create(ClientSession.prototype);
	Object.defineProperties(client, {
		convs: { value: convs },
		activeId: { value: activeId },
		conv: { get: () => convs.get(activeId) },
		disposed: { value: false },
		settingsSvc: { value: { current: { questionnaireEnabled: true, disabledAgentTools: [] }, push: () => {} } },
		emitLocal: { value: (m: ServerMessage) => sent.push(structuredClone(m)) },
		emit: { value: (m: ServerMessage) => sent.push(structuredClone(m)) },
		sinkCount: { value: () => 1 },
		flushSnapshot: { value: () => {} },
		emitConversations: { value: () => {} },
	});
	client.setViewer(viewer);
	statics.liveSessions.add(client);
	cleanups.push(() => statics.liveSessions.delete(client));
	return { name, client, sent, viewer };
}

/** Shine's, Wai's and a no-login window looking elsewhere, plus Shine's and Wai's window on the asking chat. */
function windows() {
	const asking = chat("asking");
	const convs = new Map<string, FakeChat>([[asking.id, asking]]);
	const away = (n: keyof typeof viewers) => win(n, convs, "conv-elsewhere", viewers[n]);
	return {
		asking,
		shine: away("shine"),
		wai: away("wai"),
		none: away("none"),
		shineHere: win("shineHere", convs, asking.id, viewers.shine),
		waiHere: win("waiHere", convs, asking.id, viewers.wai),
	};
}

const ofType = (w: Win, type: ServerMessage["type"]) => w.sent.filter((m) => m.type === type);
const snapshotQuestion = (w: Win) => call<UiState["pendingQuestion"]>(w.client, "pendingQuestionForSnapshot");
const snapshotApproval = (w: Win) => call<UiState["pendingApproval"]>(w.client, "pendingApprovalForSnapshot");
const chatListQuestion = (w: Win, convId: string) =>
	call<{ id: string } | undefined>(w.client, "getPendingQuestionForConv", convId);
const waitingOn = (w: Win) => call<string | null>(w.client, "waitingOnHere");
const seesAsk = (w: Win, id: string) => call<boolean>(w.client, "seesAsk", askHub.get(id));

/** What a window got of the open question: pop-up, snapshot dialog, chat list "?", the page's passive line. */
function questionSurfaces(w: Win, convId: string) {
	return {
		popup: ofType(w, "question_pending").length,
		snapshot: snapshotQuestion(w) ? 1 : 0,
		chatList: chatListQuestion(w, convId) ? 1 : 0,
	};
}
const GOT = { popup: 1, snapshot: 1, chatList: 1 };
const NOTHING = { popup: 0, snapshot: 0, chatList: 0 };

describe("the viewer rule", () => {
	it("a connection is its login's person; no login, Shine's login or an unknown login is the default owner", () => {
		expect(viewers.wai.person).toBe("Wai");
		expect(viewers.shine.person).toBeUndefined();
		expect(viewers.none.person).toBeUndefined();
		expect(askIsForViewer("Wai", viewers.wai)).toBe(true);
		expect(askIsForViewer("Wai", viewers.shine)).toBe(false);
		expect(askIsForViewer("Wai", viewers.none)).toBe(false);
		expect(askIsForViewer(undefined, viewers.shine)).toBe(true);
		expect(askIsForViewer(undefined, viewers.wai)).toBe(false);
		// A person people.json doesn't list counts as the default owner's: nothing is shown to nobody.
		expect(askIsForViewer("Stranger", viewers.shine)).toBe(true);
		expect(askIsForViewer("Stranger", viewers.wai)).toBe(false);
		// A session no browser attached (DEFAULT_VIEWER) sees what it always did.
		expect(askIsForViewer("Wai", DEFAULT_VIEWER)).toBe(true);
	});
});

describe("ask_user_question", () => {
	it("Wai's question: dialog, snapshot and chat-list mark only in Wai's window; Shine's says 'Waiting on Wai'", () => {
		const w = windows();
		typedBy(w.asking, WAI_SENT);
		void w.wai.client.askUser(QUESTIONS, { toolCallId: "call-w" }, w.asking.id);
		expect(questionSurfaces(w.wai, w.asking.id)).toEqual(GOT);
		expect(questionSurfaces(w.shine, w.asking.id)).toEqual(NOTHING);
		expect(questionSurfaces(w.none, w.asking.id)).toEqual(NOTHING);
		expect(waitingOn(w.shineHere)).toBe("Waiting on Wai");
		expect(waitingOn(w.waiHere)).toBeNull();
		expect(snapshotQuestion(w.shineHere)).toBeNull();
		// The passive line carries nothing of the question.
		expect(waitingOn(w.shineHere)).not.toMatch(/port|8080|9090/);
	});

	it("Shine's question: everywhere but Wai's window; Wai's page says 'Waiting on Shine'", () => {
		const w = windows();
		typedBy(w.asking, SHINE_SENT);
		void w.shine.client.askUser(QUESTIONS, { toolCallId: "call-s" }, w.asking.id);
		expect(questionSurfaces(w.shine, w.asking.id)).toEqual(GOT);
		expect(questionSurfaces(w.none, w.asking.id)).toEqual(GOT);
		expect(questionSurfaces(w.wai, w.asking.id)).toEqual(NOTHING);
		expect(waitingOn(w.waiHere)).toBe("Waiting on Shine");
		expect(waitingOn(w.shineHere)).toBeNull();
	});

	it("an old question with no requester is Shine's: not in Wai's window", () => {
		const w = windows();
		void w.shine.client.askUser(QUESTIONS, { toolCallId: "call-o" }, w.asking.id);
		const [ask] = askHub.list();
		expect(ask?.requester).toBeUndefined();
		expect(questionSurfaces(w.shine, w.asking.id)).toEqual(GOT);
		expect(questionSurfaces(w.wai, w.asking.id)).toEqual(NOTHING);
		expect(waitingOn(w.waiHere)).toBe("Waiting on Shine");
	});

	it("either owner's answer still counts (no new lock)", async () => {
		const w = windows();
		typedBy(w.asking, WAI_SENT);
		const answer = w.wai.client.askUser(QUESTIONS, { toolCallId: "call-a" }, w.asking.id);
		const [ask] = askHub.list();
		w.shine.client.resolveQuestion(ask!.id, [{ id: "port", selected: ["8080"] }]);
		await expect(answer).resolves.toEqual([{ id: "port", selected: ["8080"] }]);
	});
});

describe("permission prompts and extension dialogs (plan approval)", () => {
	it("Wai's permission prompt: pop-up and snapshot only in Wai's window", () => {
		const w = windows();
		typedBy(w.asking, WAI_SENT);
		void w.wai.client.askApproval("call-p", "bash", { command: "ls" }, "lists", "lists", w.asking.id);
		const count = (x: Win) => ofType(x, "tool_approval_pending").length + (snapshotApproval(x) ? 1 : 0);
		expect(count(w.wai)).toBe(2);
		expect(count(w.shine)).toBe(0);
		expect(count(w.none)).toBe(0);
		expect(waitingOn(w.shineHere)).toBe("Waiting on Wai");
	});

	it("Wai's plan-approval dialog is Wai's window's only; Shine's page says 'Waiting on Wai'", () => {
		const w = windows();
		const dialog = { id: 41, kind: "confirm" as const, title: "Add this task?", args: ["The plan"] };
		w.asking.dialogs.current = dialog;
		askHub.add(dialogAsk("dlg-41", dialog, { conversationId: w.asking.id, requester: "Wai" }), () => ({ ok: true }));
		expect(seesAsk(w.waiHere, "dlg-41")).toBe(true);
		expect(seesAsk(w.shineHere, "dlg-41")).toBe(false);
		expect(seesAsk(w.none, "dlg-41")).toBe(false);
		expect(waitingOn(w.shineHere)).toBe("Waiting on Wai");
		expect(waitingOn(w.waiHere)).toBeNull();
	});
});

/** A lead's queue with task 7 (its own chat) stuck on a question of `origin`'s owner. */
function stuckTask(origin: UiTaskRequester) {
	const lead = chat("lead");
	const taskChat = join(dir, "task-7.jsonl");
	const queue: UiTaskQueue = {
		queueId: "q-1051",
		available: true,
		running: true,
		tasks: [
			{
				id: 7,
				status: "stuck",
				addedAt: 1,
				lane: true,
				chat: { file: taskChat },
				origin,
				question: "Which port?",
				choices: ["8080", "9090"],
				detail: "The whole package",
				plan: { title: "Synthetic task", goal: "", doneWhen: "", decided: "", steps: "", verify: "", mustNot: "" },
			},
		],
		answerBindings: [
			{ conversationId: lead.id, queueId: "q-1051", taskId: 7, questionId: "stuck-7", question: "Which port?" },
		] as UiTaskQueue["answerBindings"],
	};
	const was = { read: statics.taskQueueOfConv, statuses: statics.queueStatuses, stuck: statics.stuckTaskChats };
	statics.taskQueueOfConv = () => queue;
	statics.queueStatuses = new Map([[taskChat, { kind: "stuck", text: "Needs decision: Which port?" }]]);
	statics.stuckTaskChats = new Map([[taskChat, queue.tasks[0]]]);
	cleanups.push(() => {
		statics.taskQueueOfConv = was.read;
		statics.queueStatuses = was.statuses;
		statics.stuckTaskChats = was.stuck;
	});
	const line: UiTldrLine = {
		id: "line-7",
		text: "Task #7 needs you: Which port?",
		needsYou: true,
		ts: Date.now(),
		chat: { file: taskChat, title: "Task 7" },
	};
	/** The chat-row / lead-bar highlight, the "Needs decision" row label and pi-queue's pop-up notice. */
	const marks = (viewer: OwnerViewer) => ({
		highlight: !statics.lineAboutHeldAsk(lead, [line], viewer),
		needsDecision: statics.queueStatusesForOwner(viewer).has(taskChat),
		notice: !statics.noticeAboutHeldCard(lead, "Task #7 needs you: Which port?", viewer),
	});
	return { queue, marks };
}

const ALL_MARKS = { highlight: true, needsDecision: true, notice: true };
const NO_MARKS = { highlight: false, needsDecision: false, notice: false };

describe("a queued task's card (Queue tab, chat rows, notices)", () => {
	it("Wai's card: full in Wai's Queue tab; Shine's row says only 'Waiting on Wai', no question or answer form", () => {
		const { queue, marks } = stuckTask(waiOrigin);
		expect(queueForViewer(queue, viewers.wai)).toBe(queue);
		const shown = queueForViewer(queue, viewers.shine);
		const t = shown.tasks[0]!;
		expect(t.waitingOn).toBe("Waiting on Wai");
		expect([t.question, t.choices, t.detail]).toEqual([undefined, undefined, undefined]);
		expect(shown.answerBindings).toBeUndefined();
		expect(JSON.stringify(t)).not.toMatch(/Which port|8080|whole package/);
		expect(marks(viewers.wai)).toEqual(ALL_MARKS);
		expect(marks(viewers.shine)).toEqual(NO_MARKS);
		expect(marks(viewers.none)).toEqual(NO_MARKS);
	});

	it("Shine's card: the reverse", () => {
		const { queue, marks } = stuckTask(shineOrigin);
		expect(queueForViewer(queue, viewers.shine)).toBe(queue);
		expect(queueForViewer(queue, viewers.wai).tasks[0]!.waitingOn).toBe("Waiting on Shine");
		expect(marks(viewers.shine)).toEqual(ALL_MARKS);
		expect(marks(viewers.none)).toEqual(ALL_MARKS);
		expect(marks(viewers.wai)).toEqual(NO_MARKS);
	});
});

const roleAsk = (key: string, requester: string | undefined): UiRoleAsk =>
	({
		key,
		role: "ops",
		kind: "question",
		text: `Question ${key}`,
		chat: { file: "/ops.jsonl" },
		focus: `ask:${key}`,
		askId: key,
		...(requester ? { route: { requester } } : {}),
	}) as unknown as UiRoleAsk;

function overview(): UiRolesOverview {
	const asks = [roleAsk("q-wai", "Wai"), roleAsk("q-shine", "Shine"), roleAsk("q-old", undefined)];
	return {
		at: Date.now(),
		asks,
		roles: [
			{
				id: "ops",
				asks,
				tldr: [],
				queue: { active: [{ id: 5, status: "stuck", origin: waiOrigin, stuck: { question: "Which?" } }] },
			},
		],
	} as unknown as UiRolesOverview;
}

describe("Roles page, Needs you and the top bar's count", () => {
	it("each viewer's overview lists only its own asks; another owner's stuck task waits", () => {
		const o = overview();
		const keys = (v: OwnerViewer) => rolesOverviewForViewer(o, v).asks.map((a) => a.key);
		expect(keys(viewers.wai)).toEqual(["q-wai"]);
		expect(keys(viewers.shine)).toEqual(["q-shine", "q-old"]);
		expect(keys(viewers.none)).toEqual(["q-shine", "q-old"]);
		const task = (v: OwnerViewer) => rolesOverviewForViewer(o, v).roles[0]!.queue!.active[0]!;
		expect(task(viewers.shine)).toMatchObject({ waitingOn: "Waiting on Wai" });
		expect(task(viewers.shine).stuck).toBeUndefined();
		expect(task(viewers.wai).stuck).toEqual({ question: "Which?" });
	});

	it("RolesWatch counts per window: the top bar never counts the other owner's asks", async () => {
		const o = overview();
		const watch = new RolesWatch<string, OwnerViewer>(async () => o, {}, rolesOverviewForViewer);
		const got: Record<string, ServerMessage[]> = { shine: [], wai: [], page: [] };
		watch.watch("shine", false, (m) => got.shine!.push(m), viewers.shine);
		watch.watch("wai", false, (m) => got.wai!.push(m), viewers.wai);
		watch.watch("page", true, (m) => got.page!.push(m), viewers.wai);
		await watch.look();
		watch.stop();
		expect(got.shine).toEqual([{ type: "roles", asks: 2 }]);
		expect(got.wai).toEqual([{ type: "roles", asks: 1 }]);
		expect(got.page![0]).toMatchObject({ type: "roles", asks: 1 });
	});
});

describe("Telegram is unchanged", () => {
	it("Wai's asks never reach plugins; Shine's and old ones do", () => {
		const w = windows();
		typedBy(w.asking, WAI_SENT);
		void w.wai.client.askUser(QUESTIONS, { toolCallId: "call-t1" }, w.asking.id);
		const waiAsk = askHub.list()[0]!;
		const other = chat("other");
		void w.shine.client.askUser(QUESTIONS, { toolCallId: "call-t2" }, other.id);
		const ids = pluginAsks().map((a) => a.id);
		expect(ids).not.toContain(waiAsk.id);
		expect(ids).toHaveLength(1);
		const added: AskEvent = { type: "appeared", ask: waiAsk };
		expect(pluginSeesAskEvent(added)).toBe(false);
	});
});
