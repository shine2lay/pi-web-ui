/**
 * script-notice (Ops #782): what a script's notice to a role's home chat may hold. A script or systemd unit on this
 * machine (first: RollCall's continuous deployer) sends a short message into a role's home chat through the control
 * socket's script_notice (with the app token), like message_role. Beside ci-alert.ts: CI alerts are the server's
 * own words from fixed fields; a notice is the script's own plain text and sender name, checked here. docs/
 * script-notice.md is the contract.
 *
 * Here: checkScriptNotice (every field, each with the reason it is refused), scriptNoticeKey (the dedupe key),
 * scriptNoticeHeader (the header's words) and scriptNoticeHint (what the receiving chat does). Pure:
 * role-messages.ts RoleMessages.requestScriptNotice sends it on the app-report path.
 */
import { statusHint } from "./turn-status.js";

/** fyi: added to the chat without a turn (read with its next message); request: starts a turn of its own once
 *  the running turn has settled (Systems rm-e2634da5: the caller's contract is fyi|request). A script can't read a
 *  reply, so neither kind owes one. */
export type ScriptNoticeKind = "fyi" | "request";

/** A checked notice. `role` is as the caller gave it (role-messages.ts resolves it). */
export interface ScriptNotice {
	role: string;
	kind: ScriptNoticeKind;
	/** Who the script is: a short id and the name the chat and the page show. */
	sender: { id: string; title: string };
	text: string;
	/** Optional: a repeat of the same sender.id + role + key is the first notice (nothing is sent). */
	key?: string;
}

export type ScriptNoticeCheck = { ok: true; notice: ScriptNotice } | { ok: false; error: string };

export const SCRIPT_NOTICE_TEXT_MAX = 1500;
export const SCRIPT_NOTICE_TITLE_MAX = 60;
export const SCRIPT_NOTICE_KEY_MAX = 200;

const KINDS: readonly ScriptNoticeKind[] = ["fyi", "request"];
const SENDER_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Control characters, and the Unicode line and paragraph separators (they break a line like \n). */
const CONTROL_RE = /[\p{Cc}\u2028\u2029]/u;
/** The same, but a line break (\n) is allowed: the text may run over several lines. */
const CONTROL_BUT_NEWLINE_RE = /[^\P{Cc}\n]|[\u2028\u2029]/u;
/** The app's own headers: a line of the text starting with one would read to the chat as the app's. */
const APP_HEADERS = ["[Role message", "[Board", "[Queue]", "[System", "[Owner question]", "[Scheduled task"] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function codePoint(ch: string): string {
	return `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** The app header a line of the text starts with (case aside, after its leading spaces), if any. */
function appHeaderIn(text: string): string | undefined {
	for (const line of text.split("\n")) {
		const head = line.trimStart().toLowerCase();
		const found = APP_HEADERS.find((h) => head.startsWith(h.toLowerCase()));
		if (found) return found;
	}
	return undefined;
}

/** Every field of a notice, or what is wrong with the first bad one and how to fix it. Lengths are checked
 *  before any pattern runs. */
export function checkScriptNotice(input: {
	role?: unknown;
	kind?: unknown;
	sender?: unknown;
	text?: unknown;
	key?: unknown;
}): ScriptNoticeCheck {
	const { role, kind, sender, text, key } = input;
	if (typeof role !== "string" || !role.trim()) return { ok: false, error: "role must be a role id" };
	if (!KINDS.includes(kind as ScriptNoticeKind))
		return {
			ok: false,
			error: 'kind must be "fyi" (added without a turn) or "request" (starts a turn; a script can\'t read a reply)',
		};
	if (!isPlainObject(sender)) return { ok: false, error: "sender must be an object with id and title" };
	const extra = Object.keys(sender).filter((k) => k !== "id" && k !== "title");
	if (extra.length) return { ok: false, error: `sender takes only id and title (not ${extra.join(", ")})` };
	const { id, title } = sender;
	if (typeof id !== "string" || id.length > 40 || !SENDER_ID_RE.test(id))
		return {
			ok: false,
			error: "sender.id must be 1-40 lower-case letters, digits or dashes, starting with a letter or digit",
		};
	if (typeof title !== "string" || title.length < 1 || title.length > SCRIPT_NOTICE_TITLE_MAX)
		return { ok: false, error: `sender.title must be 1-${SCRIPT_NOTICE_TITLE_MAX} characters` };
	if (!title.trim()) return { ok: false, error: "sender.title can't be blank" };
	if (CONTROL_RE.test(title)) return { ok: false, error: "sender.title must be one line, without control characters" };
	if (/[[\]]/.test(title))
		return { ok: false, error: "sender.title can't hold [ or ]: it goes into the message's header" };
	if (typeof text !== "string" || text.length < 1 || text.length > SCRIPT_NOTICE_TEXT_MAX)
		return { ok: false, error: `text must be 1-${SCRIPT_NOTICE_TEXT_MAX} characters` };
	if (!text.trim()) return { ok: false, error: "text can't be blank" };
	const control = CONTROL_BUT_NEWLINE_RE.exec(text);
	if (control)
		return {
			ok: false,
			error: `text may hold line breaks (\\n) but no other control characters (found ${codePoint(control[0])})`,
		};
	const header = appHeaderIn(text);
	if (header)
		return {
			ok: false,
			error: `text can't have a line starting with "${header}": the chat would take it for the app's own header`,
		};
	if (
		key !== undefined &&
		(typeof key !== "string" || key.length < 1 || key.length > SCRIPT_NOTICE_KEY_MAX || CONTROL_RE.test(key))
	)
		return {
			ok: false,
			error: `key must be 1-${SCRIPT_NOTICE_KEY_MAX} characters on one line, without control characters`,
		};
	return {
		ok: true,
		notice: {
			role,
			kind: kind as ScriptNoticeKind,
			sender: { id, title },
			text,
			...(key !== undefined ? { key: key as string } : {}),
		},
	};
}

/** The dedupe key: the sender, the role (resolved) and the caller's key. The sender id can't hold ":", and the
 *  role is escaped, so no two different triples meet. */
export function scriptNoticeKey(sender: string, role: string, key: string): string {
	return `${encodeURIComponent(sender)}:${encodeURIComponent(role)}:${key}`;
}

/** The header's words after "from ": the script's id and name, and what kind of notice it is. */
export function scriptNoticeHeader(s: { sender: string; title: string; kind: ScriptNoticeKind }): string {
	return `the script ${s.sender} \u00b7 ${s.title} \u00b7 ${s.kind === "request" ? "request" : "notice"}`;
}

/** The hint under a notice: what the receiving chat does with it. An fyi is read with the chat's next message, so
 *  it asks for nothing; a request's turn ends with one status line (turn-status, Ops #688), like a CI alert's,
 *  and owes no reply: the script can't read one. */
export function scriptNoticeHint(kind: ScriptNoticeKind): string {
	if (kind === "fyi")
		return "(A notice from a script on this machine (its sender is in the header), added without a turn of its own: no reply needed, and a script can't read one. Write nothing for the owner about it; if it asks for something in your area, do it with your tools.)";
	return `(A request from a script on this machine (its sender is in the header). A script can't read a reply, so none is owed: do what it asks with your tools if it is in your area, or queue it. ${statusHint("poke")})`;
}
