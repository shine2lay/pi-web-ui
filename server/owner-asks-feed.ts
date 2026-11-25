// ---------------------------------------------------------------------------
// owner-asks-feed.ts — the top bar's waiting-questions bell (Ops #1089, Shine 2026-11-25 m104486 + m104524)
// ---------------------------------------------------------------------------
// "We need a way to see questions waiting for us tho" / "Top bar maybe a notification icon ?". One canonical
// projection of the list of asks (asks.ts) for one owner's window: every ask waiting on him, from any chat (a role's
// or not, open or closed, kept for later), newest first, in plain words; and the bell's open / answer, through the
// same form checks as the Roles page (roles-asks.ts askViewOf + answersFromPage, reused, never copied).
// Never another owner's ask nor one held for COO (owner-window.ts askHiddenFrom): refused as "no longer waiting", so a
// window can't tell another owner's ask from a gone one. owner-asks-push.ts pushes `owner_asks` and serves
// owner_ask_open / owner_ask_answer with these for ClientSession (Ops #1090). docs/hypotheses/2026-11-25-ops-1089-waiting-questions-bell.md
// ---------------------------------------------------------------------------

import { resolve } from "node:path";
import { type Ask, type AskHub, type AskResult, FROM_BROWSER, NOT_WAITING } from "./asks.js";
import { askHiddenFrom } from "./owner-window.js";
import { type OwnerViewer, requesterName } from "./owner-requester.js";
import type { SessionSummary, UiOwnerAskItem, UiRoleAskView } from "./protocol.js";
import { answersFromPage, askViewOf } from "./roles-asks.js";
import { asAnswerer } from "./sent-by.js";

/** What the list of asks doesn't know, looked up by the caller. */
export interface OwnerAskLookup {
	/** Kept for later on its card (pending-questions store, ClientSession.questionLater). */
	later(ask: Ask): boolean;
	/** The department whose home chat or queued task chat `sessionFile` (the ask's, `ask`) is. */
	roleOf(sessionFile: string, ask: Ask): { id: string; title: string } | undefined;
}

/** The bell refuses an answer to an ask that changed since it was opened (wording, choices, a restart). */
export const OWNER_ASK_CHANGED = "it changed since you opened it: open it again";
/** An ask the bell lists but can't answer in place (an approval, an extension's pop-up): its chat can. */
export const OWNER_ASK_IN_CHAT = "open this question in its chat";

const TEXT_MAX = 200;
// Control, format, private-use and unassigned characters, and line/paragraph separators: shown as a space.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u2028\u2029]/gu;
// An absolute or home path ("/home/x/a/b.ts", "~/a/b", "C:\a\b"), not part of a web address: its last part only.
const UNIX_PATH = /(?<![\w:/.~-])~?\/(?:[\w.@+-]+\/)+([\w.@+-]+)/g;
const WINDOWS_PATH = /(?<![\w])[A-Za-z]:\\(?:[^\\\s]+\\)+([^\\\s]+)/g;

/** One plain line: no paths, no control characters, collapsed spaces, at most TEXT_MAX characters. */
export function plainLine(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const line = value
		.replace(UNSAFE, " ")
		.replace(UNIX_PATH, "$1")
		.replace(WINDOWS_PATH, "$1")
		.replace(/\s+/g, " ")
		.trim();
	if (!line) return undefined;
	return line.length > TEXT_MAX ? `${line.slice(0, TEXT_MAX - 1).trimEnd()}…` : line;
}

/** Whether `viewer`'s windows may see, open or answer `ask` at all. */
function visibleTo(ask: Ask | undefined, viewer: OwnerViewer): ask is Ask {
	return ask !== undefined && !askHiddenFrom(ask, viewer);
}

/** Newest first; the same moment by id, so every window lists them alike. */
function newestFirst(a: UiOwnerAskItem, b: UiOwnerAskItem): number {
	if (a.createdAt !== b.createdAt) return b.createdAt - a.createdAt;
	return a.askId < b.askId ? -1 : a.askId > b.askId ? 1 : 0;
}

/** One ask as the bell lists it. */
function itemOf(ask: Ask, lookup: OwnerAskLookup): UiOwnerAskItem {
	const view = askViewOf(ask);
	const role = ask.sessionFile ? lookup.roleOf(ask.sessionFile, ask) : undefined;
	const summary = plainLine(ask.fields[0]?.text);
	const conversationTitle = plainLine(ask.conversationTitle);
	return {
		askId: ask.id,
		kind: ask.kind,
		title: plainLine(ask.title) ?? "Question",
		...(summary ? { summary } : {}),
		createdAt: ask.createdAt,
		...(lookup.later(ask) ? { later: true } : {}),
		answerable: Boolean(view),
		...(role ? { roleId: role.id, roleTitle: role.title } : {}),
		...(ask.conversationId ? { conversationId: ask.conversationId } : {}),
		...(conversationTitle ? { conversationTitle } : {}),
		...(ask.sessionFile ? { sessionFile: ask.sessionFile } : {}),
		...(view?.route ? { route: view.route } : {}),
	};
}

/** The bell's list for `viewer`: the asks waiting on him (`asks` = askHub.list()), newest first. */
export function projectOwnerAsksForViewer(
	asks: readonly Ask[],
	viewer: OwnerViewer,
	lookup: OwnerAskLookup,
): UiOwnerAskItem[] {
	return asks
		.filter((ask) => visibleTo(ask, viewer))
		.map((ask) => itemOf(ask, lookup))
		.sort(newestFirst);
}

/** The whole form of one ask the bell lists, for its Answer dialog (it only reads). */
export function openOwnerAskForViewer(
	hub: AskHub,
	askId: unknown,
	viewer: OwnerViewer,
): { ok: true; ask: UiRoleAskView } | { ok: false; error: string } {
	const ask = typeof askId === "string" ? hub.get(askId) : undefined;
	if (!visibleTo(ask, viewer)) return { ok: false, error: NOT_WAITING };
	const view = askViewOf(ask);
	return view ? { ok: true, ask: view } : { ok: false, error: OWNER_ASK_IN_CHAT };
}

/** `viewer`'s answer from the bell. It goes through the list of asks as answered in the browser, by him, so the ask's
 *  owner delivers, settles and records it as if given in its chat. Refused, with nothing sent, when the ask isn't his
 *  (or is held for COO), left the list, changed since he opened it, or the answers don't fit the form. */
export async function answerOwnerAskForViewer(
	hub: AskHub,
	askId: unknown,
	revision: unknown,
	answers: unknown,
	viewer: OwnerViewer,
): Promise<AskResult> {
	const ask = typeof askId === "string" ? hub.get(askId) : undefined;
	if (!visibleTo(ask, viewer)) return { ok: false, error: NOT_WAITING };
	const view = askViewOf(ask);
	if (!view) return { ok: false, error: OWNER_ASK_IN_CHAT };
	if (typeof revision !== "string" || view.revision !== revision) return { ok: false, error: OWNER_ASK_CHANGED };
	const clean = answersFromPage(answers, view);
	if ("error" in clean) return { ok: false, error: clean.error };
	return asAnswerer(requesterName(viewer.person), () => hub.answer(ask.id, clean.answers, FROM_BROWSER));
}

/** The chat list's saved rows for `viewer`, each marked whether a question waits on him there (`asks` =
 *  askHub.list()). New row objects: the rows are shared by every window (session-index), never marked in place. */
export function sessionsWithQuestionsFor(
	sessions: readonly SessionSummary[],
	asks: readonly Ask[],
	viewer: OwnerViewer,
): SessionSummary[] {
	const waiting = new Set<string>();
	for (const ask of asks) if (ask.sessionFile && visibleTo(ask, viewer)) waiting.add(resolve(ask.sessionFile));
	return sessions.map((s) => ({ ...s, hasQuestion: waiting.has(resolve(s.path)) }));
}
