/**
 * role-message-fold: reads the text the server puts into a chat for a role message (message_role, see
 * server/role-messages.ts roleMessageText): a header line, a blank line, the sender's text, a blank
 * line, and a hint line for the model. The chat folds these messages into one row; the server's stamp
 * (UiMessage.roleMessage) says who sent one, and this parser covers the ones without a stamp (the
 * server's store only keeps the last 1000). Display only: nothing here changes what the model reads.
 *
 * Pure and dependency-free, so tests/unit can import it.
 */

/** board (task #76): "board" is a role chat's turn-start note about new posts on the roles' board (a
 *  custom message "board"); "board-order" is an order the board sent to the chat directly (a steer into a
 *  running turn, or a turn of its own). Both fold like role messages. */
export type ParsedRoleMessageKind =
	"question" | "request" | "fyi" | "reply" | "report" | "board" | "board-order" | "owner-question";

export interface ParsedRoleMessage {
	id: string;
	kind: ParsedRoleMessageKind;
	/** Sending role id, "owner" for an order, or an owner-question card's human source label. */
	from?: string;
	/** A board order the owner gave through a role (COO): that role. */
	via?: string;
	/** A board note's head, an order's time, or an owner-question header after its label. */
	what?: string;
	/** Sending role's title, as the header gives it. */
	title?: string;
	/** Sending chat's title, as the header gives it. */
	chat?: string;
	/** For a reply: the message it answers. */
	replyTo?: string;
	/** For the 6 am report request: the day it asks about. */
	reportDate?: string;
	/** progress-feed (task #85): the Initiatives page's ask for a progress update: the initiative's name. */
	poke?: { name: string };
	/** stall-wake (Ops #284): the work check's wake about stalled work: the items' names. */
	stall?: { names: string };
	/** ci-alert (Ops #720): the CI watch's alert about a CI run: the header's words (what happened, repo, workflow). */
	ci?: { title: string };
	/** script-notice (Ops #782): a script's notice: its id and name, and its kind (header word "notice" = fyi). */
	script?: ScriptSender;
	/** Body after the header and removable role hint; owner-question guidance stays in the body. */
	body: string;
	/** The hint line for the model, when there is one. */
	hint?: string;
}

/** script-notice (Ops #782): who sent a script's notice, and its kind: fyi (added without a turn) or request
 *  (starts a turn; no reply owed, the script can't read one). */
export interface ScriptSender {
	sender: string;
	title: string;
	kind: "fyi" | "request";
}

const ID = "rm-[0-9a-f]{8}";
const REPORT_RE = new RegExp(`^\\[Role message (${ID}) from the app \\u00b7 6 am report \\u00b7 ([^\\]]+)\\]$`);
/** progress-feed (task #85): server/role-messages.ts roleMessageHeader for a poke. */
const POKE_RE = new RegExp(
	`^\\[Role message (${ID}) from the Initiatives page \\u00b7 progress update \\u00b7 ([^\\]]+)\\]$`,
);
/** stall-wake (Ops #284): server/role-messages.ts roleMessageHeader for the work check's wake. */
const STALL_RE = new RegExp(`^\\[Role message (${ID}) from the work check \\u00b7 stalled work \\u00b7 ([^\\]]+)\\]$`);
/** ci-alert (Ops #720): server/role-messages.ts roleMessageHeader for the CI watch's alert. */
const CI_RE = new RegExp(`^\\[Role message (${ID}) from the CI watch \\u00b7 ([^\\]]+)\\]$`);
/** script-notice (Ops #782): server/role-messages.ts roleMessageHeader for a script's notice (script-notice.ts
 *  checks the id and the name: no brackets or line breaks). */
const SCRIPT_RE = new RegExp(
	`^\\[Role message (${ID}) from the script ([a-z0-9][a-z0-9-]{0,39}) \\u00b7 ([^\\[\\]\\n]{1,60}) \\u00b7 (notice|request)\\]$`,
);
const ROLE_RE = new RegExp(
	`^\\[Role message (${ID}) from ([a-z0-9][a-z0-9._-]*) \\((.*)\\), sent from its (.*) \\u00b7 (question|request|fyi|reply to (${ID})|reply)\\]$`,
);
/** The hint lines the server adds (roleMessageHint); anything else stays part of the body. */
const HINT_STARTS = [
	"(The app's 6 am report request:",
	"(The Initiatives page asks you,",
	"(The work check found",
	"(The CI watch found",
	"(A notice from a script on this machine",
	"(A request from a script on this machine",
	"(An FYI from another role,",
	"(The answer to your message",
	"(Answer it once, with message_role",
	"(A request: do it if",
];

const BOARD_ORDER_RE =
	/^\[Board order (bp-[0-9a-f]{8}) from ([a-z0-9][a-z0-9._-]*)(?: \(via ([a-z0-9][a-z0-9._-]*)\))? \u00b7 ([^\]]+)\]$/;
/** "[Board] 2 new posts", "[Board] 1 new post, 1 ended", "[Board] 2 posts ended" (role-board.ts boardNote). */
const BOARD_NOTE_RE = /^\[Board\] (\d+ new posts?(?:, \d+ ended)?|\d+ posts? ended)$/;
/** The hint paragraph that ends an order sent directly (server/role-board.ts boardOrderText). */
const BOARD_ORDER_HINT = "(The owner's order on the roles' board,";

/** Literal label from server/owner-question-card.ts; this is an app card, not an rm- message. */
export const OWNER_QUESTION_LABEL = "Owner question";
const OWNER_QUESTION_RE =
	/^\[Owner question\] (?:\d+ questions, )?from (.+) \[(oq-[0-9a-f]{8}(?:, oq-[0-9a-f]{8})*)\]$/;

function headAndRest(text: string): { head: string; rest: string } {
	const nl = text.indexOf("\n");
	const head = (nl === -1 ? text : text.slice(0, nl)).trimEnd();
	const rest = (nl === -1 ? "" : text.slice(nl + 1)).replace(/^\n+/, "").replace(/\s+$/, "");
	return { head, rest };
}

/** board: an order the board sent to a chat directly, or null when the first line isn't its header. */
export function parseBoardOrderText(text: string): ParsedRoleMessage | null {
	if (!text.startsWith("[Board order bp-")) return null;
	const { head, rest: all } = headAndRest(text);
	const m = BOARD_ORDER_RE.exec(head);
	if (!m) return null;
	let rest = all;
	let hint: string | undefined;
	const cut = rest.lastIndexOf("\n\n");
	const last = (cut === -1 ? rest : rest.slice(cut + 2)).trim();
	if (last.startsWith(BOARD_ORDER_HINT)) {
		hint = last;
		rest = cut === -1 ? "" : rest.slice(0, cut).replace(/\s+$/, "");
	}
	return {
		id: m[1],
		kind: "board-order",
		from: m[2],
		...(m[3] ? { via: m[3] } : {}),
		what: m[4],
		body: rest,
		...(hint ? { hint } : {}),
	};
}

/** board: a role chat's turn-start note ("[Board] 2 new posts" and the posts), or null. */
export function parseBoardNoteText(text: string): ParsedRoleMessage | null {
	if (!text.startsWith("[Board] ")) return null;
	const { head, rest } = headAndRest(text);
	const m = BOARD_NOTE_RE.exec(head);
	if (!m) return null;
	const ids = rest.match(/\bbp-[0-9a-f]{8}\b/);
	return { id: ids ? ids[0] : "board", kind: "board", what: m[1], body: rest };
}

/** COO's card for one or several held owner questions; keep every field and the final guidance. */
export function parseOwnerQuestionText(text: string): ParsedRoleMessage | null {
	const prefix = `[${OWNER_QUESTION_LABEL}] `;
	if (!text.startsWith(prefix)) return null;
	const { head, rest } = headAndRest(text);
	const m = OWNER_QUESTION_RE.exec(head);
	if (!m) return null;
	return { id: m[2], kind: "owner-question", from: m[1], what: head.slice(prefix.length), body: rest };
}

/** The role message in a chat message's text, or null when its first line isn't a whole header. */
export function parseRoleMessageText(text: string): ParsedRoleMessage | null {
	if (!text.startsWith("[Role message rm-")) return null;
	const nl = text.indexOf("\n");
	const head = (nl === -1 ? text : text.slice(0, nl)).trimEnd();
	let rest = nl === -1 ? "" : text.slice(nl + 1);
	let parsed: Omit<ParsedRoleMessage, "body" | "hint">;
	const report = REPORT_RE.exec(head);
	const poke = report ? null : POKE_RE.exec(head);
	const stall = report || poke ? null : STALL_RE.exec(head);
	const ci = report || poke || stall ? null : CI_RE.exec(head);
	const script = report || poke || stall || ci ? null : SCRIPT_RE.exec(head);
	if (report) {
		parsed = { id: report[1], kind: "report", reportDate: report[2] };
	} else if (stall) {
		parsed = { id: stall[1], kind: "report", stall: { names: stall[2] } };
	} else if (poke) {
		parsed = { id: poke[1], kind: "report", poke: { name: poke[2] } };
	} else if (ci) {
		parsed = { id: ci[1], kind: "report", ci: { title: ci[2] } };
	} else if (script) {
		const kind = script[4] === "request" ? "request" : "fyi";
		parsed = { id: script[1], kind: "report", script: { sender: script[2], title: script[3], kind } };
	} else {
		const m = ROLE_RE.exec(head);
		if (!m) return null;
		const what = m[5];
		const kind: ParsedRoleMessageKind = what.startsWith("reply") ? "reply" : (what as ParsedRoleMessageKind);
		parsed = { id: m[1], kind, from: m[2], title: m[3], chat: m[4], ...(m[6] ? { replyTo: m[6] } : {}) };
	}
	rest = rest.replace(/^\n+/, "").replace(/\s+$/, "");
	let hint: string | undefined;
	const cut = rest.lastIndexOf("\n\n");
	const last = (cut === -1 ? rest : rest.slice(cut + 2)).trim();
	if (last.endsWith(")") && HINT_STARTS.some((s) => last.startsWith(s))) {
		hint = last;
		rest = cut === -1 ? "" : rest.slice(0, cut).replace(/\s+$/, "");
	}
	return { ...parsed, body: rest, ...(hint ? { hint } : {}) };
}

/** What the chat shows for a role message: the server's stamp when it has one, else what the header
 *  says (`stamped` false: the server's record of it is gone, so the sender is the text's word). */
export interface RoleMessageView {
	id: string;
	kind: ParsedRoleMessageKind;
	from: string;
	fromTitle: string;
	fromChat: string;
	replyTo?: string;
	reportDate?: string;
	/** progress-feed (task #85): kind report from the Initiatives page: an ask for a progress update. */
	poke?: { name: string; initiative?: string };
	/** stall-wake (Ops #284): kind report from the work check: a wake about stalled work. */
	stall?: { names: string };
	/** ci-alert (Ops #720): kind report from the CI watch: an alert about a CI run. */
	ci?: { title: string };
	/** script-notice (Ops #782): kind report from a script on this machine: its id, name and kind. */
	script?: ScriptSender;
	/** board: an order the owner gave through a role (COO): that role. */
	via?: string;
	/** A board note's head, an order's time, or an owner-question header after its label. */
	what?: string;
	/** Body after the header and removable role hint; owner-question guidance stays visible. */
	text: string;
	stamped: boolean;
}

interface ChatMessageLike {
	role: string;
	customType?: string;
	roleMessage?: Omit<RoleMessageView, "stamped">;
}

/** The role message a chat message carries, or null. Only a user message or an FYI (custom message
 *  "role-message") can be one; `text` is the message's text, for the ones without a stamp.
 *  board (task #76): a board note (custom message "board") and an order the board sent directly (a user
 *  message) fold the same way. Only the server writes their headers, and the board itself is on the Roles
 *  page, so they count as stamped. The app's owner-question cards for COO use this same display path. */
export function roleMessageViewOf(message: ChatMessageLike, text: string): RoleMessageView | null {
	if (message.role === "custom" && message.customType === "board") {
		const note = parseBoardNoteText(text);
		return note ? appCardView(note) : null;
	}
	if (message.role !== "user" && !(message.role === "custom" && message.customType === "role-message")) return null;
	if (message.roleMessage) return { ...message.roleMessage, stamped: true };
	if (message.role === "user") {
		const appCard = parseBoardOrderText(text) ?? parseOwnerQuestionText(text);
		if (appCard) return appCardView(appCard);
	}
	const p = parseRoleMessageText(text);
	if (!p) return null;
	return {
		id: p.id,
		kind: p.kind,
		from: p.from ?? "",
		fromTitle: p.title ?? "",
		fromChat: p.chat ?? "",
		...(p.replyTo ? { replyTo: p.replyTo } : {}),
		...(p.reportDate ? { reportDate: p.reportDate } : {}),
		...(p.poke ? { poke: p.poke } : {}),
		...(p.stall ? { stall: p.stall } : {}),
		...(p.ci ? { ci: p.ci } : {}),
		...(p.script ? { script: p.script } : {}),
		text: p.body,
		stamped: false,
	};
}

function appCardView(p: ParsedRoleMessage): RoleMessageView {
	return {
		id: p.id,
		kind: p.kind,
		from: p.from ?? "",
		fromTitle: "",
		fromChat: "",
		...(p.via ? { via: p.via } : {}),
		...(p.what ? { what: p.what } : {}),
		text: p.body,
		stamped: true,
	};
}

/** message_role's arguments, as far as they have arrived (a call still streaming has half its JSON). */
export interface MessageRoleArgs {
	to?: string;
	kind?: string;
	replyTo?: string;
	text?: string;
	/** decision-records: the initiative it is tagged with. */
	initiative?: string;
}

export function parseMessageRoleArgs(argumentsText: string | undefined): MessageRoleArgs {
	if (!argumentsText) return {};
	try {
		const v = JSON.parse(argumentsText) as Record<string, unknown>;
		if (v && typeof v === "object") {
			const out: MessageRoleArgs = {};
			for (const k of ["to", "kind", "replyTo", "text", "initiative"] as const) {
				if (typeof v[k] === "string") out[k] = v[k] as string;
			}
			return out;
		}
	} catch {
		// still streaming: read the fields that are there
	}
	const out: MessageRoleArgs = {};
	for (const k of ["to", "kind", "replyTo", "text", "initiative"] as const) {
		const m = new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)("?)`).exec(argumentsText);
		if (!m) continue;
		let raw = m[1];
		if (!m[2]) raw = raw.replace(/\\(u[0-9a-fA-F]{0,3})?$/, "");
		try {
			out[k] = JSON.parse(`"${raw}"`) as string;
		} catch {
			out[k] = raw;
		}
	}
	return out;
}

/** The id message_role gave the message it sent ("Sent rm-\u2026") or held ("Held rm-\u2026"), from its
 *  result details or text; null while it runs or when it was refused. */
export function messageRoleSentOf(
	result:
		{ details?: unknown; content?: ReadonlyArray<{ type: string; text?: string }>; isError?: boolean } | undefined,
): { id: string; held: boolean } | null {
	if (!result || result.isError) return null;
	const d = result.details as { id?: unknown; state?: unknown } | undefined;
	if (d && typeof d.id === "string" && new RegExp(`^${ID}$`).test(d.id)) {
		return { id: d.id, held: d.state === "held" };
	}
	const text = (result.content ?? []).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
	const m = new RegExp(`^(Sent|Held) (${ID})\\b`).exec(text);
	return m ? { id: m[2], held: m[1] === "Held" } : null;
}

/** One line of plain text from the start of a message: Markdown marks dropped, spaces squeezed, cut
 *  at `max` characters with an ellipsis. */
/** What a folded row previews: the message's text; an order sent directly starts with its title in bold
 *  (server/role-board.ts boardOrderText), so its row reads "Title: first words". */
export function roleMessageRowText(view: { kind: string; text: string }): string {
	if (view.kind !== "board-order") return view.text;
	return view.text.replace(/^\*\*(.+?)\*\*\n+/, (_all, title: string) =>
		/[.!?:]$/.test(title) ? `${title} ` : `${title}: `,
	);
}

export function roleMessagePreview(text: string, max = 90): string {
	const plain = text
		.replace(/```[^\n]*\n?/g, " ")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
		.replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
		.replace(/(^|[\s(])[*_]([^*_\s][^*_]*?)[*_](?=[\s).,:;!?]|$)/g, "$1$2")
		.replace(/\s+/g, " ")
		.trim();
	if (plain.length <= max) return plain;
	return `${plain.slice(0, max).trimEnd()}\u2026`;
}
