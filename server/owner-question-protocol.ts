/**
 * owner-question wire types (Ops #685, #973, #1051). Types only, like protocol.ts, which re-exports this file
 * (`export type *`), so `web/src/types.ts` sees every name here. docs/owner-question-routing.md.
 */

/** Whose an owner ask is and which way it came, as every card shows it first: "For <name>" (Ops #973), its line
 *  ("You were chatting here …", "Came through COO", HELD_FOR_COO_LINE while held; Ops #685), then COO's note. */
export interface UiOwnerQuestionRoute {
	requester?: string; // whose question it is, shown "For <name>" ("Shine" when no one else asked)
	line?: string; // which way it came; absent while owner-question routing gave it no line
	note?: string;
	recommendation?: string;
	held?: true; // still with COO: shown only on the asking chat's page and the Queue tab, answerable there
}

/** owner-requester (Ops #1051): a chat or task waits on the other owner's answer. This window gets only the passive
 *  line ("Waiting on Wai"), never the question, its options or an answer form. */
export interface UiOwnerWaitingOn {
	waitingOn?: string;
}

// ---------------------------------------------------------------------------
// waiting-questions bell (Ops #1089, Shine 2026-11-25): the top bar's bell lists every ask waiting on the window's
// owner, from any chat (role or not, open or closed, kept for later), and answers it in place. Projection in
// server/owner-asks-feed.ts; docs/hypotheses/2026-11-25-ops-1089-waiting-questions-bell.md.
// ---------------------------------------------------------------------------

/** One waiting ask as the bell lists it: plain words only (no paths), newest first. */
export interface UiOwnerAskItem {
	askId: string;
	kind: "question" | "dialog" | "approval" | "stuck";
	title: string;
	/** The first question's words, one plain line (paths shortened to their last part). */
	summary?: string;
	createdAt: number;
	/** Kept for later (Later / X / Esc on its card): still waiting, no longer pops up. */
	later?: boolean;
	/** The bell can answer it in place (owner_ask_open); false: only its chat can (approvals, other pop-ups). */
	answerable: boolean;
	/** The department whose home or task chat asked, when one did. */
	roleId?: string;
	roleTitle?: string;
	conversationId?: string;
	conversationTitle?: string;
	/** The asking chat's transcript, to open it from the bell (never shown as text). */
	sessionFile?: string;
	route?: UiOwnerQuestionRoute;
}

/** The bell's server messages: the window owner's whole list on every change, an opened ask, an answer's result. */
export type OwnerAskServerMessage =
	| { type: "owner_asks"; asks: UiOwnerAskItem[] }
	| { type: "owner_ask"; reqId: string; ok: true; ask: import("./protocol.js").UiRoleAskView }
	| { type: "owner_ask"; reqId: string; ok: false; error: string }
	| { type: "owner_ask_result"; reqId: string; ok: boolean; error?: string };

/** The bell's commands: open one ask's form (-> owner_ask), answer it (-> owner_ask_result; a changed ask is refused). */
export type OwnerAskClientCommand =
	| { type: "owner_ask_open"; reqId: string; askId: string }
	| {
			type: "owner_ask_answer";
			reqId: string;
			askId: string;
			revision: string;
			answers: import("./protocol.js").UiRoleAskAnswer[];
	  };

/** The chat list's "?" on a saved (closed) chat: a question waits on this window's owner there. */
export interface UiSessionQuestionMark {
	hasQuestion?: boolean;
}
