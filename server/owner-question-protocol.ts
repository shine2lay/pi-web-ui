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
