/**
 * owner-input-time (Ops #685): when the owner last wrote in a chat, by the host's own clock.
 *
 * Admission (agent-service.ts noteTurnCause) notes the time of each owner input it accepts into a
 * chat's turn: a real browser page (index.ts browserRoleInput) or Telegram (host.roles.send), the
 * same place the turn's requester inputs are collected. The time goes on the chat and on the turn
 * record; a restart's running list (running-chats.ts) saves the turn's time with its requester
 * inputs, so a carried-on turn keeps it. Owner-question routing (owner-question-route.ts, its
 * 30-minute window) reads it when an ask is made. Nothing here reads words.
 */

/** A chat (agent-service Conversation) or a turn record (role-replies RoleTurnRecord, RequesterTurn). */
export interface OwnerInputTimes {
	/** The host's time (ms) of the owner's latest accepted input there. */
	ownerLastWroteAt?: number;
}

/** A real time the host could have taken: a finite number of ms after 1970. */
export function isOwnerInputTime(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/** Admission took an input into `turn` (in `chat`): an owner's input sets both times to `at`. */
export function noteOwnerInput(chat: OwnerInputTimes, turn: OwnerInputTimes, ownerInput: boolean, at: number): void {
	if (!ownerInput || !isOwnerInputTime(at)) return;
	chat.ownerLastWroteAt = at;
	turn.ownerLastWroteAt = at;
}

/** Keep the later of two times on `into` (a pending turn merged into the running one, a carry-on). */
export function mergeOwnerLastWrote(into: OwnerInputTimes, from: OwnerInputTimes): void {
	const at = from.ownerLastWroteAt;
	if (!isOwnerInputTime(at)) return;
	if (!isOwnerInputTime(into.ownerLastWroteAt) || into.ownerLastWroteAt < at) into.ownerLastWroteAt = at;
}

/** When he last wrote in the chat: the later of the chat's and its turn's time; undefined = not known. */
export function ownerLastWroteOf(chat: OwnerInputTimes, turn?: OwnerInputTimes): number | undefined {
	const times = [chat.ownerLastWroteAt, turn?.ownerLastWroteAt].filter(isOwnerInputTime);
	return times.length ? Math.max(...times) : undefined;
}
