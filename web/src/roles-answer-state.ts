/** roles-answer: request/reply correlation only. Never retry a side effect, including after reconnect.
 *  The waiting-questions bell (Ops #1090) opens and answers its asks through the same correlation
 *  (owner_ask_open -> owner_ask, owner_ask_answer -> owner_ask_result). */
import { appSend } from "./app-globals";
import type { ClientMessage, ServerMessage, UiRoleAskAnswer, UiRoleAskView } from "./types";

export type RoleAskReply = Extract<ServerMessage, { type: "roles_ask" }>;
export type RoleAnswerReply = Extract<ServerMessage, { type: "roles_ask_result" }>;
type OwnerAskReply = Extract<ServerMessage, { type: "owner_ask" }>;
type OwnerAnswerReply = Extract<ServerMessage, { type: "owner_ask_result" }>;
type Reply = RoleAskReply | RoleAnswerReply | OwnerAskReply | OwnerAnswerReply;
type Request =
	| Omit<Extract<ClientMessage, { type: "roles_ask_open" }>, "reqId">
	| Omit<Extract<ClientMessage, { type: "roles_ask_answer" }>, "reqId">
	| Omit<Extract<ClientMessage, { type: "owner_ask_open" }>, "reqId">
	| Omit<Extract<ClientMessage, { type: "owner_ask_answer" }>, "reqId">;
export const ROLE_ANSWER_WAIT_MS = 20_000;
const REPLY_OF: Record<Request["type"], Reply["type"]> = {
	roles_ask_open: "roles_ask",
	roles_ask_answer: "roles_ask_result",
	owner_ask_open: "owner_ask",
	owner_ask_answer: "owner_ask_result",
};
let sequence = 0;
const waiting = new Map<string, { type: Reply["type"]; finish: (reply: Reply) => void; lost: () => void }>();

function request(ask: Request, waitMs: number): Promise<Reply> {
	const reqId = `role-ask-${Date.now().toString(36)}-${++sequence}`;
	const type = REPLY_OF[ask.type];
	const answering = type === "roles_ask_result" || type === "owner_ask_result";
	return new Promise((resolve) => {
		const finish = (reply: Reply) => {
			clearTimeout(timer);
			waiting.delete(reqId);
			resolve(reply);
		};
		const lost = () => finish({ type, reqId, ok: false, error: answering ? "uncertain" : "unavailable" } as Reply);
		const timer = setTimeout(lost, waitMs);
		waiting.set(reqId, { type, finish, lost });
		if (!appSend({ ...ask, reqId })) finish({ type, reqId, ok: false, error: "offline" } as Reply);
	});
}
export function openRoleAsk(key: string, waitMs = ROLE_ANSWER_WAIT_MS): Promise<RoleAskReply> {
	return request({ type: "roles_ask_open", key }, waitMs) as Promise<RoleAskReply>;
}
export function answerRoleAsk(
	key: string,
	askId: string,
	revision: string,
	answers: UiRoleAskAnswer[],
	waitMs = ROLE_ANSWER_WAIT_MS,
): Promise<RoleAnswerReply> {
	return request({ type: "roles_ask_answer", key, askId, revision, answers }, waitMs) as Promise<RoleAnswerReply>;
}

/** How an answer dialog opens and answers its ask: the Roles page's (by feed key) or the bell's (by ask id). */
export interface AskAnswerChannel {
	open(key: string): Promise<{ ok: boolean; ask?: UiRoleAskView; error?: string }>;
	answer(
		key: string,
		askId: string,
		revision: string,
		answers: UiRoleAskAnswer[],
	): Promise<{ ok: boolean; error?: string }>;
}
export const ROLES_ANSWER_CHANNEL: AskAnswerChannel = {
	open: (key) => openRoleAsk(key),
	answer: (key, askId, revision, answers) => answerRoleAsk(key, askId, revision, answers),
};
/** The waiting-questions bell's: `key` is the ask's id (owner_ask_open / owner_ask_answer). */
export const OWNER_ASK_CHANNEL: AskAnswerChannel = {
	open: (askId) => request({ type: "owner_ask_open", askId }, ROLE_ANSWER_WAIT_MS) as Promise<OwnerAskReply>,
	answer: (_key, askId, revision, answers) =>
		request({ type: "owner_ask_answer", askId, revision, answers }, ROLE_ANSWER_WAIT_MS) as Promise<OwnerAnswerReply>,
};

export function receiveRoleAnswer(reply: Reply): void {
	const pending = waiting.get(reply.reqId);
	if (pending?.type === reply.type) pending.finish(reply);
}
/** A socket died or was replaced. Sent answers may have arrived: say unknown, never send them again. */
export function disconnectRoleAnswers(): void {
	for (const w of [...waiting.values()]) w.lost();
}
