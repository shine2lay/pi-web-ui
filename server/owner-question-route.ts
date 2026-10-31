// ---------------------------------------------------------------------------
// owner-question-route.ts — owner-question routing: where a question for the owner goes, and the
// plain line it is shown with (docs/owner-question-routing.md).
// ---------------------------------------------------------------------------
// The owner (via COO, 2026-10-31, rm-fbbc87f6 / rm-79d1a979): a question asked while he is chatting
// in a chat comes to him straight away, because he has the context; one raised halfway through work
// he didn't start goes to COO first, who gathers the context and asks him properly. "there must be a
// deterministic way to figure this out". How long he counts as chatting, he chose on 2026-10-31
// (dr-cb84e6f50755, via COO rm-1cf56478): "Through COO after 30 minutes". So a question in a turn he
// started goes through COO too once he hasn't written in that chat for OWNER_CHATTING_WINDOW_MS, or
// when the host doesn't know when he last wrote there ("owner-away").
//
// So the rule decides only from the host's own trusted record of the asking chat's turn (the
// RoleTurnRecord's requester inputs, filled at admission: an accepted, non-pseudo browser page's
// prompt, or the Telegram plugin's host.roles.send, is an owner input; a turn carried on after a
// restart keeps its saved inputs) and from facts and times the host sets itself (whose home chat
// asks, when he last wrote in the chat, a continuation-grant ask, a question COO handed back in this
// turn). Its input holds no text: it never reads words and never asks a model.
//
// Inert groundwork (Ops #684): no caller asks it yet. #685/#686 wire it, #687 switches it on.
// ---------------------------------------------------------------------------

import type { AskKind } from "./asks.js";
import { ownerInputIds } from "./owner-contacts.js";
import type { RequesterTurn } from "./queue-requester.js";

/** The identity whose home chat is COO's. */
export const COO_ROLE = "coo";

/**
 * How long after his last accepted input in a chat a question in a turn he started there still goes
 * straight to him. The owner's choice, 2026-10-31 (dr-cb84e6f50755): "Through COO after 30 minutes".
 */
export const OWNER_CHATTING_WINDOW_MS = 30 * 60_000;

/** Why an ask goes straight to the owner. */
export const OWNER_QUESTION_DIRECT_REASONS = [
	/** COO's own home chat asks. */
	"coo-chat",
	/** The asking chat's current turn holds his accepted input (he started it or typed into it), and he
	 *  last wrote there less than OWNER_CHATTING_WINDOW_MS ago. */
	"owner-chatting",
	/** A question asked again in the same turn after COO handed it back. */
	"asked-again-after-return",
	/** The role-message guard's continuation-grant asks: not routed (the owner chose doubled limits instead). */
	"grant-not-routed",
] as const;

/** Why an ask goes to COO first. */
export const OWNER_QUESTION_COO_REASONS = [
	/** A queued task's card (kind "stuck"). */
	"queued-work",
	/** The turn holds his accepted input, but he last wrote there OWNER_CHATTING_WINDOW_MS ago or more,
	 *  or the host doesn't know when. */
	"owner-away",
	/** Anything else: a role message, Board post, queue prompt or reminder, schedule wake-up, subagent,
	 *  extension message, or no record started the turn. */
	"not-started-by-owner",
] as const;

export type OwnerQuestionDirectReason = (typeof OWNER_QUESTION_DIRECT_REASONS)[number];
export type OwnerQuestionCooReason = (typeof OWNER_QUESTION_COO_REASONS)[number];
export type OwnerQuestionRouteReason = OwnerQuestionDirectReason | OwnerQuestionCooReason;

export type OwnerQuestionRoute =
	{ to: "direct"; reason: OwnerQuestionDirectReason } | { to: "coo"; reason: OwnerQuestionCooReason };

/** The closed list, in the order the rule tries them (ownerQuestionRoute). */
export const OWNER_QUESTION_ROUTE_REASONS: readonly OwnerQuestionRouteReason[] = [
	"coo-chat",
	"queued-work",
	"owner-chatting",
	"asked-again-after-return",
	"grant-not-routed",
	"owner-away",
	"not-started-by-owner",
];

/** What the host knows about an ask, from its own records only. No text. */
export interface OwnerQuestionRouteInput {
	kind: AskKind;
	/** The asking chat's current turn record (conv.turnRecord), as admission filled it; absent = none. */
	turn?: RequesterTurn;
	/** The host's own time (ms) of his latest accepted input in the asking chat (kept across a
	 *  carry-on); absent = not known. */
	ownerLastWroteAt?: number;
	/** The host's time now (ms). */
	now: number;
	/** The identity whose home chat asks (identities.ts homeChatOf), if any. */
	homeRole?: string;
	/** Host-set: one of the role-message guard's continuation-grant asks. */
	grant?: boolean;
	/** Host-set: COO handed this question back earlier in the same turn and the chat asks again. */
	askedAgainAfterReturn?: boolean;
}

/**
 * Where an ask goes, first rule that applies:
 *  1. COO's home chat asks -> direct "coo-chat" (COO never routes to itself);
 *  2. a queued task's card -> coo "queued-work" (raised by queued work, whichever chat it shows in);
 *  3. the turn holds an accepted owner input and he last wrote there under OWNER_CHATTING_WINDOW_MS
 *     ago -> direct "owner-chatting";
 *  4. a question asked again after COO handed it back -> direct "asked-again-after-return";
 *  5. a continuation-grant ask -> direct "grant-not-routed";
 *  6. the turn holds an accepted owner input, but he last wrote there 30 minutes ago or more, or when
 *     isn't known -> coo "owner-away";
 *  7. anything else -> coo "not-started-by-owner".
 * So a grant or a question asked again still goes straight to him in a turn he started long ago.
 * A turn whose input list overflowed (more than REQUESTER_INPUTS_MAX inputs) has no list left, so it
 * counts as not his (rule 7); COO's safety net still lets it through.
 */
export function ownerQuestionRoute(input: OwnerQuestionRouteInput): OwnerQuestionRoute {
	if (input.homeRole === COO_ROLE) return { to: "direct", reason: "coo-chat" };
	if (input.kind === "stuck") return { to: "coo", reason: "queued-work" };
	const ownerTurn = ownerInputIds(input.turn).length > 0;
	if (ownerTurn && ownerWroteRecently(input.ownerLastWroteAt, input.now)) {
		return { to: "direct", reason: "owner-chatting" };
	}
	if (input.kind === "question" && input.askedAgainAfterReturn === true) {
		return { to: "direct", reason: "asked-again-after-return" };
	}
	if (input.grant === true) return { to: "direct", reason: "grant-not-routed" };
	if (ownerTurn) return { to: "coo", reason: "owner-away" };
	return { to: "coo", reason: "not-started-by-owner" };
}

/**
 * He wrote in the chat less than OWNER_CHATTING_WINDOW_MS before `now`. Unknown (absent, not a
 * real time) is not recent. A time ahead of `now` (the clock was set back) counts as recent: he gets
 * the question straight away, as before routing.
 */
function ownerWroteRecently(lastWroteAt: number | undefined, now: number): boolean {
	if (lastWroteAt === undefined || !Number.isFinite(lastWroteAt) || !Number.isFinite(now)) return false;
	return now - lastWroteAt < OWNER_CHATTING_WINDOW_MS;
}

// ---------------------------------------------------------------------------
// The plain lines (fixed here for the surfaces that show them)
// ---------------------------------------------------------------------------

export const OWNER_CHATTING_LABEL = "You were chatting here";
export const FROM_COO_CHAT_LABEL = "From COO's chat";
export const CAME_THROUGH_COO_LABEL = "Came through COO";

/** "less than a minute", "1 minute", "12 minutes" (whole minutes, rounded down). */
export function minutesText(ms: number): string {
	const n = Math.floor(Math.max(0, ms) / 60_000);
	return n === 0 ? "less than a minute" : n === 1 ? "1 minute" : `${n} minutes`;
}

/** "You were chatting here", with how long ago he last wrote there when the host knows it. */
export function ownerChattingLabel(lastWroteAgoMs?: number): string {
	if (lastWroteAgoMs === undefined) return OWNER_CHATTING_LABEL;
	const ago = lastWroteAgoMs < 60_000 ? "just now" : `${minutesText(lastWroteAgoMs)} ago`;
	return `${OWNER_CHATTING_LABEL} (you wrote ${ago})`;
}

/**
 * A held ask let through. When COO added a note or a recommendation: "Came through COO" (both are
 * shown with it, from the ask's route). When COO added nothing (COO let it through bare, or the
 * safety net did): it says so, and how long the ask took to reach him.
 */
export function cameThroughCooLabel(cooAddedWords: boolean, heldForMs: number): string {
	return cooAddedWords
		? CAME_THROUGH_COO_LABEL
		: `${CAME_THROUGH_COO_LABEL}; COO added nothing (it reached you after ${minutesText(heldForMs)})`;
}

/** A direct route's line; none for the reasons that show as before (grants, asked again). */
export function directRouteLabel(reason: OwnerQuestionDirectReason, lastWroteAgoMs?: number): string | undefined {
	if (reason === "owner-chatting") return ownerChattingLabel(lastWroteAgoMs);
	if (reason === "coo-chat") return FROM_COO_CHAT_LABEL;
	return undefined;
}

/**
 * The plain words COO's card gives for why COO got the question first (#686 shows them).
 * `lastWroteAgoMs`: for "owner-away", how long ago he last wrote in the asking chat, if known.
 */
export function cooReasonWords(reason: OwnerQuestionCooReason, lastWroteAgoMs?: number): string {
	if (reason === "queued-work") return "a queued task's card";
	if (reason === "not-started-by-owner") return "raised by work the owner didn't start";
	return lastWroteAgoMs === undefined || !Number.isFinite(lastWroteAgoMs)
		? "the owner started this but it isn't known when he last wrote there"
		: `the owner started this but hasn't written there for ${minutesText(lastWroteAgoMs)}`;
}
