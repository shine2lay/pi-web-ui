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
export type ParsedRoleMessageKind = "question" | "request" | "fyi" | "reply" | "report" | "board" | "board-order";

export interface ParsedRoleMessage {
	id: string;
	kind: ParsedRoleMessageKind;
	/** Sending role id (absent for the 6 am report, which the app sends; "owner" or a role for a board order). */
	from?: string;
	/** A board order the owner gave through a role (COO): that role. */
	via?: string;
	/** A board note's head ("2 new posts, 1 ended"); a board order's time. */
	what?: string;
	/** Sending role's title, as the header gives it. */
	title?: string;
	/** Sending chat's title, as the header gives it. */
	chat?: string;
	/** For a reply: the message it answers. */
	replyTo?: string;
	/** For the 6 am report request: the day it asks about. */
	reportDate?: string;
	/** What the sender wrote (header and hint lines removed). */
	body: string;
	/** The hint line for the model, when there is one. */
	hint?: string;
}

const ID = "rm-[0-9a-f]{8}";
const REPORT_RE = new RegExp(`^\\[Role message (${ID}) from the app \\u00b7 6 am report \\u00b7 ([^\\]]+)\\]$`);
const ROLE_RE = new RegExp(
	`^\\[Role message (${ID}) from ([a-z0-9][a-z0-9._-]*) \\((.*)\\), sent from its (.*) \\u00b7 (question|request|fyi|reply to (${ID})|reply)\\]$`,
);
/** The hint lines the server adds (roleMessageHint); anything else stays part of the body. */
const HINT_STARTS = [
	"(The app's 6 am report request:",
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

/** The role message in a chat message's text, or null when its first line isn't a whole header. */
export function parseRoleMessageText(text: string): ParsedRoleMessage | null {
	if (!text.startsWith("[Role message rm-")) return null;
	const nl = text.indexOf("\n");
	const head = (nl === -1 ? text : text.slice(0, nl)).trimEnd();
	let rest = nl === -1 ? "" : text.slice(nl + 1);
	let parsed: Omit<ParsedRoleMessage, "body" | "hint">;
	const report = REPORT_RE.exec(head);
	if (report) {
		parsed = { id: report[1], kind: "report", reportDate: report[2] };
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
	/** board: an order the owner gave through a role (COO): that role. */
	via?: string;
	/** board: a note's head ("2 new posts"), an order's time. */
	what?: string;
	/** What the sender wrote (no header or hint line). */
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
 *  page, so they count as stamped. */
export function roleMessageViewOf(message: ChatMessageLike, text: string): RoleMessageView | null {
	if (message.role === "custom" && message.customType === "board") {
		const note = parseBoardNoteText(text);
		return note ? boardView(note) : null;
	}
	if (message.role !== "user" && !(message.role === "custom" && message.customType === "role-message")) return null;
	if (message.roleMessage) return { ...message.roleMessage, stamped: true };
	if (message.role === "user") {
		const order = parseBoardOrderText(text);
		if (order) return boardView(order);
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
		text: p.body,
		stamped: false,
	};
}

function boardView(p: ParsedRoleMessage): RoleMessageView {
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
}

export function parseMessageRoleArgs(argumentsText: string | undefined): MessageRoleArgs {
	if (!argumentsText) return {};
	try {
		const v = JSON.parse(argumentsText) as Record<string, unknown>;
		if (v && typeof v === "object") {
			const out: MessageRoleArgs = {};
			for (const k of ["to", "kind", "replyTo", "text"] as const) {
				if (typeof v[k] === "string") out[k] = v[k] as string;
			}
			return out;
		}
	} catch {
		// still streaming: read the fields that are there
	}
	const out: MessageRoleArgs = {};
	for (const k of ["to", "kind", "replyTo", "text"] as const) {
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
