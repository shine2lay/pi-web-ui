/**
 * owner-requester (Ops #973, AGENTS.md rule 37): which owner a piece of work is for, Shine or Wai.
 *
 * Two people own this harness. Shine (m97633): "Wai's request goes to wai, and my request comes to me".
 * One optional `person` rides the existing requester records; absent means the default owner (Shine), so
 * everything written before this, and every alarm with no requester, stays his (m97662 "Only Shine", no
 * backfill). Sources, all server-stamped, never the model's words:
 * - a typed web message's sent-by (Ops #972) sets its turn's owner input (queue-requester requesterForAdmission);
 * - queue_add copies the turn's inputs into the task's origin, and the task's own chat gets that origin;
 * - message_role stamps the sending chat's person on its record; the receiving turn's role input carries it.
 * Owner asks (asks.ts Ask.requester) take it from their chat or task. Every web card then says
 * "For Wai" / "For Shine" (anyone may still answer); Telegram stays Shine's alone (m97662 "Web only for now"):
 * a Wai item never reaches a plugin, and telegram_send from a Wai chat sends nothing.
 * The one reader of "who is this for" is here; nothing else parses it.
 */
import type { UiTaskRequester } from "./protocol.js";
import type { SentBy } from "./sent-by.js";

/** The owner work belongs to when nothing says otherwise. */
export const DEFAULT_REQUESTER = "Shine";

/** Same as sent-by's display name: 1-80 characters, no brackets or line breaks. */
export function isPersonName(value: unknown): value is string {
	return typeof value === "string" && value.length >= 1 && value.length <= 80 && !/[[\]\r\n]/u.test(value);
}

/** The person a typed message records: undefined for the default owner (people.json `owner`) or no sender. */
export function personOfSentBy(sentBy: SentBy | undefined): string | undefined {
	return sentBy && !sentBy.owner && isPersonName(sentBy.name) ? sentBy.name : undefined;
}

/** A record's person: the latest owner or role input decides (the newest typed message of a turn). */
export function requesterPersonOf(requester: UiTaskRequester | undefined): string | undefined {
	const known = requester?.inputs.flatMap((input) => (input.kind === "unknown" ? [] : [input])) ?? [];
	return known[known.length - 1]?.person;
}

/** A chat's person now: its running turn's when that turn has an owner or role input, else its task's. */
export function chatPersonOf(
	turn: UiTaskRequester | undefined,
	taskOrigin: UiTaskRequester | undefined,
): string | undefined {
	return turn?.inputs.some((input) => input.kind !== "unknown")
		? requesterPersonOf(turn)
		: requesterPersonOf(taskOrigin);
}

/** The name a card shows: "For <name>". */
export function requesterName(person: string | undefined): string {
	return person ?? DEFAULT_REQUESTER;
}

/** Off-web owner channels (Telegram) are the default owner's alone; a named person's items stay in the web app. */
export function reachesOwnerChannels(person: string | undefined): boolean {
	return person === undefined;
}

/** What is recorded for an item kept off Telegram. */
export function webOnlyRoute(person: string): string {
	return `${person} (web only)`;
}

/** owner-requester fields on an owner's answer record (decision-records DecisionRecord). */
export interface AnswerOwnerFields {
	/** Who answered (a sent-by name; "Shine" through his own channels), when known. */
	answeredBy?: string;
	/** The owner the ask was for when not the default, and where it went ("Wai (web only)"). */
	requester?: string;
	routedTo?: string;
}

/** The answer record's owner fields: who answered, and for a named owner's ask whose it was and where it went. */
export function answerOwnerFields(requester: string | undefined, by: string | undefined): AnswerOwnerFields {
	return {
		...(by ? { answeredBy: by } : {}),
		...(requester ? { requester, routedTo: webOnlyRoute(requester) } : {}),
	};
}
