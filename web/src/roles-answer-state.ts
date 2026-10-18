/** roles-answer: request/reply correlation only. Never retry a side effect, including after reconnect. */
import { appSend } from "./app-globals";
import type { ClientMessage, ServerMessage, UiRoleAskAnswer } from "./types";

export type RoleAskReply = Extract<ServerMessage, { type: "roles_ask" }>;
export type RoleAnswerReply = Extract<ServerMessage, { type: "roles_ask_result" }>;
type Reply = RoleAskReply | RoleAnswerReply;
type Request =
	| Omit<Extract<ClientMessage, { type: "roles_ask_open" }>, "reqId">
	| Omit<Extract<ClientMessage, { type: "roles_ask_answer" }>, "reqId">;
export const ROLE_ANSWER_WAIT_MS = 20_000;
let sequence = 0;
const waiting = new Map<string, { type: Reply["type"]; finish: (reply: Reply) => void; lost: () => void }>();

function request(ask: Request, waitMs: number): Promise<Reply> {
	const reqId = `role-ask-${Date.now().toString(36)}-${++sequence}`;
	const type = ask.type === "roles_ask_open" ? "roles_ask" : "roles_ask_result";
	return new Promise((resolve) => {
		const finish = (reply: Reply) => {
			clearTimeout(timer);
			waiting.delete(reqId);
			resolve(reply);
		};
		const lost = () =>
			finish({ type, reqId, ok: false, error: type === "roles_ask_result" ? "uncertain" : "unavailable" });
		const timer = setTimeout(lost, waitMs);
		waiting.set(reqId, { type, finish, lost });
		if (!appSend({ ...ask, reqId })) finish({ type, reqId, ok: false, error: "offline" });
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
export function receiveRoleAnswer(reply: Reply): void {
	const pending = waiting.get(reply.reqId);
	if (pending?.type === reply.type) pending.finish(reply);
}
/** A socket died or was replaced. Sent answers may have arrived: say unknown, never send them again. */
export function disconnectRoleAnswers(): void {
	for (const w of [...waiting.values()]) w.lost();
}
