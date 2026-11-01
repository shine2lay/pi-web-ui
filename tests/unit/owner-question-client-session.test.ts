// owner-question-wiring (Ops #685): the calls in ClientSession itself. ask_user_question, a permission prompt and a
// queued task's card go through the real ClientSession code into the real list of asks, with fake chats and fake
// windows: what each window is sent, what its snapshot shows, the chat list's "?", and the Queue tab's card. The
// router, rule and hold store are the real ones. No server, model or socket; temporary folders only.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientSession } from "../../server/agent-service.js";
import { askHub } from "../../server/asks.js";
import { noteOwnerInput } from "../../server/owner-input-time.js";
import {
	HOLD_SAFETY_NET_MS,
	OWNER_QUESTION_HOLDS_FILE,
	OwnerQuestionHolds,
} from "../../server/owner-question-holds.js";
import { OwnerQuestionRouter } from "../../server/owner-question-router.js";
import { HELD_FOR_COO_LINE } from "../../server/owner-question-surfaces.js";
import type {
	ServerMessage,
	UiQueueChatStatus,
	UiQuestion,
	UiState,
	UiTaskQueue,
	UiTaskQueueAnswerBinding,
	UiTldrLine,
} from "../../server/protocol.js";
import { requesterForAdmission } from "../../server/queue-requester.js";
import { collectRoleInput, newTurnRecord, type RoleTurnRecord } from "../../server/role-replies.js";

const MIN = 60_000;
const T0 = Date.parse("2026-10-31T16:00:00Z");
// The process-wide list of asks keeps the real clock (it took Date.now before the test faked it), so the minutes in
// its line are the real ones; the minutes themselves are checked on a fake clock in owner-question-wiring.test.ts.
const SAFETY_NET_LINE = expect.stringMatching(
	/^Came through COO; COO added nothing \(it reached you after \d+ minutes?\)$/,
);
const QUESTIONS: UiQuestion[] = [
	{ id: "port", question: "Which port?", options: [{ label: "8080" }, { label: "9090" }] },
];

interface FakeChat {
	id: string;
	title: string;
	cwd: string;
	isSubagent: boolean;
	session: { sessionFile: string; sessionManager: { getSessionFile(): string; getSessionId(): string } };
	turnRecord?: RoleTurnRecord;
	ownerLastWroteAt?: number;
}

interface Window {
	client: ClientSession;
	sent: ServerMessage[];
	/** How many times the window's chat list was pushed. */
	listed: () => number;
}

const statics = ClientSession as unknown as {
	liveSessions: Set<ClientSession>;
	sharedQuestions: Map<string, unknown>;
	sharedApprovals: Map<string, unknown>;
	sharedConvs: Map<string, unknown>;
	taskQueueOfConv(conv: unknown): UiTaskQueue;
	stuckAsks: Map<string, { askId: string; sig: string; target: string }>;
	stuckReconcileTimer: ReturnType<typeof setTimeout> | null;
	queueStatuses: ReadonlyMap<string, UiQueueChatStatus>;
	queueStatusesForOwner(): ReadonlyMap<string, UiQueueChatStatus>;
	lineAboutHeldAsk(conv: unknown, lines: readonly UiTldrLine[]): boolean;
	noticeAboutHeldCard(conv: unknown, message: string): boolean;
};
const call = <T>(client: ClientSession, name: string, ...args: unknown[]): T =>
	(Reflect.get(ClientSession.prototype, name) as (...a: unknown[]) => T).call(client, ...args);

let dir = "";
let on = true;
let seq = 0;
let router: OwnerQuestionRouter;
let stopRouted: () => void = () => {};
const cleanups: Array<() => void> = [];

function startRouter(): void {
	router?.dispose();
	stopRouted();
	router = new OwnerQuestionRouter({
		enabled: () => on,
		hub: askHub,
		holds: () => new OwnerQuestionHolds(join(dir, OWNER_QUESTION_HOLDS_FILE)),
	});
	// As AgentService wires it: the router, and the windows told when an ask is let through or handed back.
	ClientSession.ownerQuestions = router;
	stopRouted = askHub.observe((ev) => ClientSession.ownerAskRouted(ev));
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"], now: T0 });
	dir = mkdtempSync(join(tmpdir(), "owner-question-client-"));
	on = true;
	startRouter();
});
afterEach(() => {
	for (const undo of cleanups.splice(0).reverse()) undo();
	for (const id of [...statics.sharedQuestions.keys()]) statics.sharedQuestions.delete(id);
	for (const id of [...statics.sharedApprovals.keys()]) statics.sharedApprovals.delete(id);
	for (const a of [...askHub.list(), ...askHub.heldList()]) askHub.settle(a.id, { how: "gone", reason: "test over" });
	if (statics.stuckReconcileTimer) clearTimeout(statics.stuckReconcileTimer);
	statics.stuckReconcileTimer = null;
	router.dispose();
	stopRouted();
	ClientSession.ownerQuestions = null;
	vi.useRealTimers();
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
	};
}

/** The owner typed into the chat from a real page (index.ts browserRoleInput, then noteTurnCause). */
function ownerWrites(c: FakeChat, at: number): void {
	const rec = (c.turnRecord ??= newTurnRecord());
	const inputId = `ri-00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, "0")}`;
	const requester = requesterForAdmission({ cause: "browser", ownerChannel: "browser", inputId });
	collectRoleInput(rec, { requester, cause: "browser", ownerChannel: "browser" });
	noteOwnerInput(c, rec, true, at);
}

/** A role message started the chat's turn. */
function roleStarts(c: FakeChat): void {
	c.turnRecord = newTurnRecord();
	collectRoleInput(c.turnRecord, { cause: "role" });
}

/** A browser window looking at one chat; every chat is open in it, as the shared chats are. */
function window(convs: Map<string, FakeChat>, activeId: string): Window {
	const sent: ServerMessage[] = [];
	let listed = 0;
	const client: ClientSession = Object.create(ClientSession.prototype);
	Object.defineProperties(client, {
		convs: { value: convs },
		activeId: { value: activeId },
		disposed: { value: false },
		settingsSvc: { value: { current: { questionnaireEnabled: true, disabledAgentTools: [] }, push: () => {} } },
		emitLocal: { value: (m: ServerMessage) => sent.push(structuredClone(m)) },
		emit: { value: (m: ServerMessage) => sent.push(structuredClone(m)) },
		sinkCount: { value: () => 1 },
		flushSnapshot: { value: () => {} },
		emitConversations: { value: () => listed++ },
	});
	statics.liveSessions.add(client);
	cleanups.push(() => statics.liveSessions.delete(client));
	return { client, sent, listed: () => listed };
}

function twoWindows() {
	const asking = chat("asking");
	const convs = new Map<string, FakeChat>([[asking.id, asking]]);
	return { asking, convs, mine: window(convs, asking.id), other: window(convs, "conv-elsewhere") };
}

const ofType = <T extends ServerMessage["type"]>(w: Window, type: T) =>
	w.sent.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
const snapshotQuestion = (w: Window) => call<UiState["pendingQuestion"]>(w.client, "pendingQuestionForSnapshot");
const snapshotApproval = (w: Window) => call<UiState["pendingApproval"]>(w.client, "pendingApprovalForSnapshot");
const chatListQuestion = (w: Window, convId: string) =>
	call<{ id: string } | undefined>(w.client, "getPendingQuestionForConv", convId);
const heldIds = () => askHub.heldList().map((a) => a.id);
const listedIds = () => askHub.list().map((a) => a.id);

/** The lead's queue (read by the real ClientSession code): task 7 runs in a chat of its own and is stuck on a
 *  question for the owner. */
function stuckTaskSeven(lead: FakeChat): { queue: UiTaskQueue; taskChat: string } {
	const taskChat = join(dir, "task-7.jsonl");
	const queue: UiTaskQueue = {
		queueId: "q-685",
		available: true,
		running: true,
		tasks: [
			{
				id: 7,
				status: "stuck",
				addedAt: 1,
				lane: true,
				chat: { file: taskChat },
				question: "Which port?",
				choices: ["8080", "9090"],
				plan: { title: "Synthetic task", goal: "", doneWhen: "", decided: "", steps: "", verify: "", mustNot: "" },
			},
		],
	};
	const readQueue = statics.taskQueueOfConv;
	const statuses = statics.queueStatuses;
	statics.sharedConvs.set(lead.id, lead);
	statics.taskQueueOfConv = () => queue;
	// left-task-status: the task chat's row says "Needs decision", its tooltip the question.
	statics.queueStatuses = new Map([[taskChat, { kind: "stuck", text: "Needs decision: Which port?" }]]);
	cleanups.push(() => {
		statics.sharedConvs.delete(lead.id);
		statics.taskQueueOfConv = readQueue;
		statics.queueStatuses = statuses;
		statics.stuckAsks.clear();
	});
	return { queue, taskChat };
}

/** pi-queue's marks for the stuck task (its TL;DR line in the lead's chat, its notice), as the owner gets them. */
function taskSevenMarks(lead: FakeChat, taskChat: string) {
	const line: UiTldrLine = {
		id: "line-7",
		text: "Task #7 needs you: Which port?",
		needsYou: true,
		ts: T0,
		chat: { file: taskChat, title: "Task 7" },
	};
	return {
		lineInChatList: !statics.lineAboutHeldAsk(lead, [line]),
		needsDecisionLabel: statics.queueStatusesForOwner().has(taskChat),
		notice: !statics.noticeAboutHeldCard(lead, "Task #7 needs you: Which port?"),
	};
}

describe("ClientSession with the switch on", () => {
	it("ask_user_question from a turn the owner is chatting in: every window gets it at once, with its line", async () => {
		const { asking, mine, other } = twoWindows();
		ownerWrites(asking, T0 - MIN);
		const answer = mine.client.askUser(QUESTIONS, { toolCallId: "call-1" }, asking.id);
		const line = { line: "You were chatting here (you wrote 1 minute ago)" };
		for (const w of [mine, other]) {
			expect(ofType(w, "question_pending")).toMatchObject([{ conversationId: asking.id, route: line }]);
			expect(snapshotQuestion(w)).toMatchObject({ conversationId: asking.id, route: line });
			expect(chatListQuestion(w, asking.id)).toBeDefined();
		}
		const id = ofType(other, "question_pending")[0]!.id;
		expect(listedIds()).toContain(id);
		other.client.resolveQuestion(id, [{ id: "port", selected: ["8080"] }]);
		await expect(answer).resolves.toEqual([{ id: "port", selected: ["8080"] }]);
	});

	it("a question a role's turn raised waits for COO: only its own chat's page shows it, until COO lets it through", async () => {
		const { asking, mine, other } = twoWindows();
		roleStarts(asking);
		const answer = mine.client.askUser(QUESTIONS, { toolCallId: "call-2" }, asking.id);
		const [id] = heldIds();
		expect(id).toBeDefined();
		// Held: no pop-up in any window, no "?" in the chat list (Needs you, the lead bar), not in the list of asks.
		expect(ofType(mine, "question_pending")).toEqual([]);
		expect(ofType(other, "question_pending")).toEqual([]);
		expect(chatListQuestion(other, asking.id)).toBeUndefined();
		expect(chatListQuestion(mine, asking.id)).toBeUndefined();
		expect(listedIds()).not.toContain(id);
		// Its own chat's page shows it, marked, and can answer it there.
		expect(snapshotQuestion(mine)).toMatchObject({ id, route: { line: HELD_FOR_COO_LINE, held: true } });
		expect(snapshotQuestion(other)).toBeNull();
		expect(router.release(id!, "coo", "A deploy detail; 8080 is free.", "Pick 8080")).toEqual({ ok: true });
		const shown = { line: "Came through COO", note: "A deploy detail; 8080 is free.", recommendation: "Pick 8080" };
		for (const w of [mine, other]) {
			expect(ofType(w, "question_pending")).toMatchObject([{ id, route: shown }]);
			expect(snapshotQuestion(w)).toMatchObject({ id, route: shown });
			expect(chatListQuestion(w, asking.id)).toBeDefined();
		}
		expect(listedIds()).toContain(id);
		other.client.resolveQuestion(id!, [{ id: "port", selected: ["9090"] }]);
		await expect(answer).resolves.toEqual([{ id: "port", selected: ["9090"] }]);
	});

	it("answering a held question on its own page settles it", async () => {
		const { asking, mine } = twoWindows();
		roleStarts(asking);
		const answer = mine.client.askUser(QUESTIONS, {}, asking.id);
		const id = snapshotQuestion(mine)!.id;
		mine.client.resolveQuestion(id, [{ id: "port", selected: ["8080"] }]);
		await expect(answer).resolves.toEqual([{ id: "port", selected: ["8080"] }]);
		expect(heldIds()).toEqual([]);
		expect(snapshotQuestion(mine)).toBeNull();
	});

	it("COO hands it back: the call returns COO's note, the pop-up closes, and asking again goes straight to him", async () => {
		const { asking, mine, other } = twoWindows();
		roleStarts(asking);
		const first = mine.client.askUser(QUESTIONS, {}, asking.id);
		const [id] = heldIds();
		expect(router.returnToAsker(id!, "Use the port the plan names")).toEqual({ ok: true });
		await expect(first).resolves.toEqual({ returned: "Use the port the plan names" });
		expect(ofType(mine, "question_retracted")).toEqual([{ type: "question_retracted", id }]);
		expect(snapshotQuestion(mine)).toBeNull();
		const again = mine.client.askUser(QUESTIONS, {}, asking.id);
		const [pending] = ofType(other, "question_pending");
		expect(pending).toBeDefined();
		expect(pending).not.toHaveProperty("route"); // asked again: shown as before, no line (Ops #684's table)
		expect(heldIds()).toEqual([]);
		expect(listedIds()).toContain(pending!.id);
		other.client.resolveQuestion(pending!.id, [{ id: "port", selected: ["8080"] }]);
		await expect(again).resolves.toEqual([{ id: "port", selected: ["8080"] }]);
	});

	it("a permission prompt a role's turn raised waits for COO; the safety net lets it through after 30 minutes", async () => {
		const { asking, mine, other } = twoWindows();
		roleStarts(asking);
		const decision = mine.client.askApproval(
			"call-9",
			"bash",
			{ command: "rm -rf build" },
			"deletes",
			"deletes",
			asking.id,
		);
		const [id] = heldIds();
		expect(id).toMatch(/^appr-/);
		expect(ofType(mine, "tool_approval_pending")).toEqual([]);
		expect(ofType(other, "tool_approval_pending")).toEqual([]);
		expect(snapshotApproval(mine)).toMatchObject({ id, route: { line: HELD_FOR_COO_LINE, held: true } });
		expect(snapshotApproval(other)).toBeNull();
		vi.setSystemTime(T0 + HOLD_SAFETY_NET_MS - 1);
		expect(router.sweep()).toEqual([]);
		vi.setSystemTime(T0 + HOLD_SAFETY_NET_MS);
		expect(router.sweep()).toEqual([id]);
		const shown = { line: SAFETY_NET_LINE };
		for (const w of [mine, other]) {
			expect(ofType(w, "tool_approval_pending")).toMatchObject([{ id, route: shown }]);
			expect(snapshotApproval(w)).toMatchObject({ id, route: shown });
		}
		expect(other.client.resolveToolApproval(id!, "deny")).toBe(true);
		await expect(decision).resolves.toMatchObject({ decision: "deny" });
	});

	it("a queued task's card waits for COO, its Queue tab card says so, and a restart keeps it held from its first time", () => {
		const lead = chat("lead");
		const { queue } = stuckTaskSeven(lead);
		const { client } = window(new Map([[lead.id, lead]]), lead.id);
		const card = () => call<UiTaskQueueAnswerBinding[] | undefined>(client, "queueAnswerBindings", lead, queue)?.[0];
		ClientSession.reconcileStuckAsks();
		const [id] = heldIds();
		expect(askHub.get(id!)).toMatchObject({ kind: "stuck", route: { to: "coo", reason: "queued-work", heldAt: T0 } });
		expect(listedIds()).toEqual([]);
		expect(card()).toMatchObject({ questionId: id, route: { line: HELD_FOR_COO_LINE, held: true } });
		// A restart: the card leaves the list as the server stops, the store is read again, the card comes back.
		vi.setSystemTime(T0 + 10 * MIN);
		askHub.settle(id!, { how: "gone", reason: "server stopping" });
		statics.stuckAsks.clear();
		startRouter();
		ClientSession.reconcileStuckAsks();
		const [again] = heldIds();
		expect(askHub.get(again!)).toMatchObject({ route: { to: "coo", reason: "queued-work", heldAt: T0 } });
		expect(router.heldUntil(again!)).toBe(T0 + HOLD_SAFETY_NET_MS);
		vi.setSystemTime(T0 + HOLD_SAFETY_NET_MS);
		expect(router.sweep()).toEqual([again]);
		expect(listedIds()).toEqual([again]);
		expect(card()).toMatchObject({
			route: { line: SAFETY_NET_LINE },
		});
	});

	it("a held card's other needs-you marks wait with it: the chat list's line and label, and pi-queue's notice", () => {
		const lead = chat("lead");
		const { taskChat } = stuckTaskSeven(lead);
		const hidden = { lineInChatList: false, needsDecisionLabel: false, notice: false };
		// pi-queue writes them as the task goes stuck; the card is made a moment later (100 ms after the queue changes).
		expect(taskSevenMarks(lead, taskChat)).toEqual(hidden);
		ClientSession.reconcileStuckAsks();
		const [id] = heldIds();
		expect(id).toBeDefined();
		expect(taskSevenMarks(lead, taskChat)).toEqual(hidden);
		// Other notices, and another task's, show as before.
		expect(statics.noticeAboutHeldCard(lead, "Queue started: 3 tasks")).toBe(false);
		expect(statics.noticeAboutHeldCard(lead, "Task #8 needs you: Which port?")).toBe(false);
		// Once the card reaches him, every mark shows again.
		vi.setSystemTime(T0 + HOLD_SAFETY_NET_MS);
		expect(router.sweep()).toEqual([id]);
		expect(taskSevenMarks(lead, taskChat)).toEqual({ lineInChatList: true, needsDecisionLabel: true, notice: true });
	});

	it("a chat's own needs-you line about its held question waits with it; the chat list is redrawn as it's held and answered", async () => {
		const { asking, mine, other } = twoWindows();
		roleStarts(asking);
		const answer = mine.client.askUser(QUESTIONS, { toolCallId: "call-6" }, asking.id);
		const [held] = askHub.heldList();
		expect(other.listed()).toBe(1);
		// The chat writes its needs-you line just before it asks, or a moment after (the ask hub's clock is the real one).
		const line = (id: string, ts: number, more: Partial<UiTldrLine> = {}): UiTldrLine => ({
			id,
			text: "Needs you: which port?",
			needsYou: true,
			ts,
			...more,
		});
		const own = line("own", held!.createdAt - 1_000);
		expect(statics.lineAboutHeldAsk(asking, [own])).toBe(true);
		expect(statics.lineAboutHeldAsk(asking, [line("just-after", held!.createdAt + 5_000)])).toBe(true);
		// A later line is about something else; another chat's line, and one copied up from a task chat, show as before.
		expect(statics.lineAboutHeldAsk(asking, [own, line("later", held!.createdAt + 6_000)])).toBe(false);
		expect(statics.lineAboutHeldAsk(chat("elsewhere"), [own])).toBe(false);
		const copied = line("copied", held!.createdAt, { chat: { file: join(dir, "task-9.jsonl"), title: "Task 9" } });
		expect(statics.lineAboutHeldAsk(asking, [copied])).toBe(false);
		// Answered on its own page: the line shows again, and the chat list is redrawn.
		mine.client.resolveQuestion(snapshotQuestion(mine)!.id, [{ id: "port", selected: ["8080"] }]);
		await expect(answer).resolves.toEqual([{ id: "port", selected: ["8080"] }]);
		expect(other.listed()).toBeGreaterThan(1);
		expect(statics.lineAboutHeldAsk(asking, [own])).toBe(false);
	});

	it("a held permission prompt answered on its own page redraws the chat list; once let through, its line shows", async () => {
		const { asking, mine, other } = twoWindows();
		roleStarts(asking);
		const first = mine.client.askApproval("call-10", "bash", { command: "ls" }, "lists", "lists", asking.id);
		const [id] = heldIds();
		const own: UiTldrLine = {
			id: "own",
			text: "Needs you: may I run ls?",
			needsYou: true,
			ts: askHub.get(id!)!.createdAt,
		};
		expect(statics.lineAboutHeldAsk(asking, [own])).toBe(true);
		expect(mine.client.resolveToolApproval(id!, "approve")).toBe(true);
		await expect(first).resolves.toMatchObject({ decision: "approve" });
		expect(other.listed()).toBe(2);
		const second = mine.client.askApproval("call-11", "bash", { command: "ls" }, "lists", "lists", asking.id);
		const [again] = heldIds();
		expect(router.release(again!, "coo", "Harmless.")).toEqual({ ok: true });
		const ownAgain = { ...own, ts: askHub.get(again!)!.createdAt };
		expect(statics.lineAboutHeldAsk(asking, [ownAgain])).toBe(false);
		expect(other.client.resolveToolApproval(again!, "approve")).toBe(true);
		await expect(second).resolves.toMatchObject({ decision: "approve" });
	});
});

describe("ClientSession with the switch off", () => {
	it("a queued task's needs-you marks show as before, the label list unchanged", () => {
		on = false;
		const lead = chat("lead");
		const { taskChat } = stuckTaskSeven(lead);
		const shown = { lineInChatList: true, needsDecisionLabel: true, notice: true };
		expect(taskSevenMarks(lead, taskChat)).toEqual(shown);
		expect(statics.queueStatusesForOwner()).toBe(statics.queueStatuses);
		ClientSession.reconcileStuckAsks();
		expect(heldIds()).toEqual([]);
		expect(listedIds()).toHaveLength(1);
		expect(taskSevenMarks(lead, taskChat)).toEqual(shown);
		expect(statics.queueStatusesForOwner()).toBe(statics.queueStatuses);
	});

	it("asks show exactly as before: the same messages, no line anywhere, nothing written for COO", async () => {
		on = false;
		const { asking, mine, other } = twoWindows();
		roleStarts(asking);
		const answer = mine.client.askUser(QUESTIONS, { toolCallId: "call-3" }, asking.id);
		const decision = mine.client.askApproval("call-4", "bash", { command: "ls" }, "lists", "lists", asking.id);
		const [question] = ofType(other, "question_pending");
		const [approval] = ofType(other, "tool_approval_pending");
		expect(question).toEqual({
			type: "question_pending",
			id: question!.id,
			questions: QUESTIONS,
			conversationId: asking.id,
			conversationTitle: "asking",
		});
		expect(approval).toEqual({
			type: "tool_approval_pending",
			id: approval!.id,
			toolCallId: "call-4",
			toolName: "bash",
			params: { command: "ls" },
			reason: "lists",
			reasonEn: "lists",
			conversationId: asking.id,
			conversationTitle: "asking",
		});
		expect(heldIds()).toEqual([]);
		expect(askHub.list().every((a) => a.route === undefined)).toBe(true);
		expect(snapshotQuestion(other)).not.toHaveProperty("route");
		expect(snapshotApproval(other)).not.toHaveProperty("route");
		expect(chatListQuestion(other, asking.id)).toBeDefined();
		expect(router.sweep()).toEqual([]);
		expect(existsSync(join(dir, OWNER_QUESTION_HOLDS_FILE))).toBe(false);
		const own: UiTldrLine = { id: "own", text: "Needs you: which port?", needsYou: true, ts: Date.now() };
		expect(statics.lineAboutHeldAsk(asking, [own])).toBe(false);
		other.client.resolveQuestion(question!.id, [{ id: "port", selected: ["8080"] }]);
		other.client.resolveToolApproval(approval!.id, "approve");
		await expect(answer).resolves.toEqual([{ id: "port", selected: ["8080"] }]);
		await expect(decision).resolves.toMatchObject({ decision: "approve" });
	});
});
