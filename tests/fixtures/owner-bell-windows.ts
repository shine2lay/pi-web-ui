// owner-bell-windows: the harness of the waiting-questions bell acceptance cases (Ops #1089): fake chats and
// browser windows of one owner's login on the real ClientSession, the real ask_user_question tool and its bridge.
// No server, model or socket. tests/unit/waiting-questions-bell.test.ts
import { join } from "node:path";
import { expect } from "vitest";
import { ClientSession, makeAskUserQuestionTool } from "../../server/agent-service.js";
import { noteOwnerInput } from "../../server/owner-input-time.js";
import type { OwnerViewer } from "../../server/owner-requester.js";
import type { PendingQuestionsHost } from "../../server/pending-questions-store.js";
import type { ServerMessage, UiOwnerAskItem, UiQuestion } from "../../server/protocol.js";
import { requesterForAdmission } from "../../server/queue-requester.js";
import { collectRoleInput, newTurnRecord, type RoleTurnRecord } from "../../server/role-replies.js";
import type { SentBy } from "../../server/sent-by.js";

export const WAI_SENT: SentBy = { login: "sayswai@gmail.com", name: "Wai", owner: false };
export const SHINE_SENT: SentBy = { login: "aungshine@gmail.com", name: "Shine", owner: true };
export const PORT: UiQuestion = {
	id: "port",
	question: "Which port?",
	options: [{ label: "8080" }, { label: "9090" }],
};
export const DNS: UiQuestion = {
	id: "dns",
	question: "Create the address?",
	options: [{ label: "Yes" }, { label: "No" }],
};
export const NAME: UiQuestion = {
	id: "name",
	question: "Which name?",
	options: [{ label: "bell" }, { label: "inbox" }],
};

export interface FakeChat {
	id: string;
	title: string;
	cwd: string;
	isSubagent: boolean;
	session: { sessionFile: string; sessionManager: { getSessionFile(): string; getSessionId(): string } };
	dialogs: { current: null; cancelAll(): void };
	turnRecord?: RoleTurnRecord;
	ownerLastWroteAt?: number;
	unsubscribe?: () => void;
	toolWatchdogs: Map<string, ReturnType<typeof setTimeout>>;
	toolStartTimes: Map<string, number>;
	runtime: { session: { abort(): Promise<void> }; dispose(): Promise<void> };
}
export interface Win {
	client: ClientSession;
	sent: ServerMessage[];
}
export type SessionInfo = {
	path: string;
	name?: string;
	firstMessage: string;
	messageCount: number;
	modified: Date;
	cwd: string;
};

export const statics = ClientSession as unknown as {
	liveSessions: Set<ClientSession>;
	sharedQuestions: Map<string, { graceTimer?: unknown }>;
	sharedApprovals: Map<string, unknown>;
	pendingQuestionsHost?: PendingQuestionsHost | null;
	restorePendingQuestions(): Promise<unknown>;
};
/** What Task 2 adds to ClientSession for the bell (absent on 8629275e: the cases fail there). */
type BellSeam = {
	ownerAskOpen?: (reqId: string, askId: string) => unknown;
	ownerAskAnswer?: (reqId: string, askId: string, revision: string, answers: unknown) => unknown;
};
const call = <T>(client: ClientSession, name: string, ...args: unknown[]): T =>
	(Reflect.get(ClientSession.prototype, name) as (...a: unknown[]) => T).call(client, ...args);

let seq = 0;

/** A chat whose transcript is `<dir>/<name>.jsonl`. */
export function chat(dir: string, name: string): FakeChat {
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

/** A turn typed just now by these owners, or (none given) started by a role (COO routing, #685). */
export function turn(c: FakeChat, ...senders: SentBy[]): void {
	const rec = (c.turnRecord = newTurnRecord());
	if (senders.length === 0) collectRoleInput(rec, { cause: "role" });
	for (const sentBy of senders) {
		const inputId = `ri-00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, "0")}`;
		const requester = requesterForAdmission({ cause: "browser", ownerChannel: "browser", inputId, sentBy });
		collectRoleInput(rec, { requester, cause: "browser", ownerChannel: "browser" });
		noteOwnerInput(c, rec, true, Date.now()); // he is chatting there: his questions go straight to him
	}
}

/** A browser window of `viewer`'s login, looking at another chat (the bell answers in place); `onEnd` undoes it. */
export function win(
	convs: Map<string, FakeChat>,
	viewer: OwnerViewer,
	onEnd: (undo: () => void) => void,
	extra: PropertyDescriptorMap = {},
): Win {
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
		openManagerAndRuntime: { value: async () => Promise.reject(new Error("no runtime in this test")) },
		bindSession: { value: async () => {} },
		pushSlashCommands: { value: async () => {} },
		...extra,
	});
	client.ownerViewer = viewer;
	statics.liveSessions.add(client);
	onEnd(() => statics.liveSessions.delete(client));
	return { client, sent };
}

export async function turns(): Promise<void> {
	for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

/** `c`'s ask_user_question tool, on the real bridge of window `w`; resolves once the call returned (posted). */
export function asker(w: Win, c: FakeChat) {
	const bridge = call<Parameters<typeof makeAskUserQuestionTool>[0]>(w.client, "bridgeTarget", {}, c.id);
	const tool = makeAskUserQuestionTool(bridge, c.id);
	return async (toolCallId: string, questions: UiQuestion[]): Promise<void> => {
		const signal = new AbortController().signal;
		const r = (await tool.execute(toolCallId, { questions }, signal, undefined, {} as never)) as {
			content: { text: string }[];
		};
		expect(r.content[0]?.text).toContain("without waiting");
		await turns();
	};
}

export const ofType = <T extends ServerMessage["type"]>(w: Win, type: T) =>
	w.sent.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
/** The bell's list in window `w`: the newest `owner_asks` it got (undefined: none came). */
export const bell = (w: Win): UiOwnerAskItem[] | undefined => ofType(w, "owner_asks").at(-1)?.asks;
export const bellIds = (w: Win) =>
	bell(w)
		?.map((a) => a.askId)
		.sort();
export const bellItem = (w: Win, askId: string) => bell(w)?.find((a) => a.askId === askId);
export const everListed = (w: Win) => new Set(ofType(w, "owner_asks").flatMap((m) => m.asks.map((a) => a.askId)));

function seam(w: Win): Required<BellSeam> {
	const s = w.client as unknown as BellSeam;
	expect(typeof s.ownerAskOpen, "ClientSession.ownerAskOpen (Task 2 seam)").toBe("function");
	expect(typeof s.ownerAskAnswer, "ClientSession.ownerAskAnswer (Task 2 seam)").toBe("function");
	return s as Required<BellSeam>;
}
/** The bell's Answer dialog opens `askId` in window `w`: the `owner_ask` reply. */
export async function bellOpen(w: Win, askId: string) {
	const reqId = `req-${++seq}`;
	await seam(w).ownerAskOpen.call(w.client, reqId, askId);
	await turns();
	return ofType(w, "owner_ask").find((m) => m.reqId === reqId);
}
/** The bell's Answer dialog sends: the `owner_ask_result` reply. */
export async function bellAnswer(w: Win, askId: string, revision: string, answers: unknown) {
	const reqId = `req-${++seq}`;
	await seam(w).ownerAskAnswer.call(w.client, reqId, askId, revision, answers);
	await turns();
	return ofType(w, "owner_ask_result").find((m) => m.reqId === reqId);
}
