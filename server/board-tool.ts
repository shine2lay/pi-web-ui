// ---------------------------------------------------------------------------
// board-tool.ts — board: a role chat reads, posts on, acks and closes posts on the roles' board
// (role-board.ts, task #76)
// ---------------------------------------------------------------------------
// Registered in every pi-engine chat like message_role; pi-identity offers it only in chats that have a
// role (its role-only tools), and this tool refuses a chat without one, and helper chats (subagents). The
// poster is the calling chat's role as the server knows it; an order needs the owner's words.
// ---------------------------------------------------------------------------

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { BOARD_TOOL_NAME } from "./tool-manager.js";
import {
	BOARD_NOTE_MAX,
	BOARD_OWNER_WORDS_MAX,
	BOARD_TEXT_MAX,
	BOARD_TITLE_MAX,
	boardTime,
	postIsFor,
	type BoardPostRecord,
	type RoleBoard,
} from "./role-board.js";
import type { RoleMessageSender } from "./role-messages.js";

export { BOARD_TOOL_NAME };

/** The owner's routing rule, as the board and message_role descriptions give it. */
export const BOARD_ROUTING_RULE =
	"The owner's routing rule: if a role has something waiting (a running turn, an open queue task or an unanswered request), a message goes directly to it, to wake its session; general info goes on the board.";

/** Implemented by ClientSession (the chat this runtime belongs to). */
export interface BoardToolHost {
	/** The calling chat as the server knows it; a string = why it can't use the board. */
	sender(): RoleMessageSender | string;
	/** The server's board (absent: not wired). */
	service(): RoleBoard | undefined;
}

/** Posts listed by a read without an id. */
const READ_LIST_MAX = 20;

function fromWords(p: BoardPostRecord): string {
	return p.via ? `${p.from} (via ${p.via})` : p.from;
}

function toWords(p: BoardPostRecord): string {
	return p.to === "all" ? "all roles" : p.to.join(", ");
}

/** One line per open post for a role (board read without an id). */
export function boardListText(board: RoleBoard, role: string): string {
	const posts = board.openFor(role);
	if (!posts.length) return "Nothing open on the board for you.";
	const shown = posts.slice(0, READ_LIST_MAX);
	const lines = shown.map((p) => {
		const mine = p.kind === "order" ? (p.done?.[role] ? " · you: done" : " · you: not done yet") : "";
		return `- ${p.kind} ${p.id} · from ${fromWords(p)} · ${boardTime(p.at)} · "${p.title}"${mine}`;
	});
	const more = posts.length - shown.length;
	return [
		`Open on the board for you (${posts.length}), newest first:`,
		...lines,
		...(more > 0 ? [`… and ${more} older`] : []),
		"board read <id> shows one in full.",
	].join("\n");
}

/** One post in full (board read <id>). */
export function boardPostText(board: RoleBoard, p: BoardPostRecord): string {
	const lines = [
		`${p.kind === "order" ? "Order" : "News"} ${p.id} · from ${fromWords(p)} · ${boardTime(p.at)} · to ${toWords(p)}`,
		p.closed
			? `Closed by ${p.closed.by} ${boardTime(p.closed.at)}${p.closed.note ? `: ${p.closed.note}` : ""}`
			: "Open",
		"",
		`**${p.title}**`,
		"",
		p.text,
	];
	if (p.ownerWords) lines.push("", `Owner's words: ${p.ownerWords}`);
	const audience = board.audience(p);
	if (p.kind === "order") {
		const done = audience.filter((r) => p.done?.[r]);
		const notDone = audience.filter((r) => !p.done?.[r]);
		lines.push("", `Done ${done.length}/${audience.length}:`);
		for (const r of done) lines.push(`- ${r} (${boardTime(p.done![r].at)}): ${p.done![r].note}`);
		if (notDone.length) lines.push(`Not done yet: ${notDone.join(", ")}`);
		const sent = Object.entries(p.sent ?? {});
		if (sent.length) {
			lines.push(
				`Reached directly: ${sent.map(([r, s]) => `${r} (${s.how === "turn" ? "a turn in its home chat" : "a steer into its running turn"})`).join(", ")}`,
			);
		}
	} else {
		const read = audience.filter((r) => p.reads?.[r]);
		lines.push("", `Read by ${read.length}/${audience.length}${read.length ? `: ${read.join(", ")}` : ""}`);
	}
	return lines.join("\n");
}

export function makeBoardTool(host: BoardToolHost): ToolDefinition {
	return defineTool({
		name: BOARD_TOOL_NAME,
		label: "Roles' board",
		description:
			"The roles' shared board: one post for news or the owner's orders that several roles need, instead of the same message to each. " +
			`${BOARD_ROUTING_RULE} ` +
			"Direct requests, questions and replies stay on message_role. " +
			"news: general info; it wakes nobody. order: only the owner's orders, in his words (ownerWords); the board sends it directly to listed roles with something waiting. " +
			'Others read posts at their next turn, as one "[Board]" note. No department directives. Ack an order once you have acted on it.',
		promptSnippet:
			"the roles' shared board: read posts, post news (or the owner's orders, in his words) for several roles, ack an order you did, close your post",
		parameters: Type.Object({
			action: Type.String({
				description:
					'"read" (no id: the open posts for your role; id: one post in full), "post" (kind, to, title, text; ownerWords for an order), "ack" (id, note: what you did; orders only; a second ack replaces your note; nothing is sent to the poster) or "close" (id, note; the post\'s author or the owner).',
			}),
			id: Type.Optional(Type.String({ description: "read (one post in full), ack, close: the post's id (bp-…)." })),
			kind: Type.Optional(
				Type.String({
					description:
						'post: "news" (general info for several roles; a request-only role posts only about requested work or changes that affect others) or "order" (only the owner\'s order, in his words, given to you directly or relayed by COO; ownerWords required). News shows in home chats; an order in every chat of the listed roles.',
				}),
			),
			to: Type.Optional(Type.Array(Type.String(), { description: 'post: the role ids it is for, or ["all"].' })),
			title: Type.Optional(
				Type.String({ description: `post: a short title (at most ${BOARD_TITLE_MAX} characters).` }),
			),
			text: Type.Optional(
				Type.String({
					description: `post: the text, Markdown, self-contained (at most ${BOARD_TEXT_MAX} characters). No secrets.`,
				}),
			),
			ownerWords: Type.Optional(
				Type.String({
					description: `post, an order: the owner's words and where they came from, e.g. 'Owner on Telegram 11:51, via COO: "pause it until Monday"' (at most ${BOARD_OWNER_WORDS_MAX} characters).`,
				}),
			),
			note: Type.Optional(
				Type.String({
					description: `ack: what you did; close: why it ends, e.g. "pause lifted" (at most ${BOARD_NOTE_MAX} characters).`,
				}),
			),
		}),
		execute: async (_id, p, _signal, _onUpdate, _ctx) => {
			const board = host.service();
			if (!board) throw new Error("The board isn't available in this app.");
			const sender = host.sender();
			if (typeof sender === "string") throw new Error(sender);
			const role = sender.role;
			const action = (p.action ?? "").trim();
			if (action === "read") {
				const id = (p.id ?? "").trim();
				if (!id) {
					const text = boardListText(board, role);
					board.markRead(
						role,
						board.openFor(role).map((x) => x.id),
					);
					return { content: [{ type: "text", text }], details: { action } };
				}
				const post = board.byId(id);
				if (!post) throw new Error(`No post ${id} on the board.`);
				if (postIsFor(post, role)) board.markRead(role, [post.id]);
				return { content: [{ type: "text", text: boardPostText(board, post) }], details: { action, id } };
			}
			if (action === "post") {
				const res = await board.post(
					{ role },
					{ kind: p.kind, to: p.to, title: p.title, text: p.text, ownerWords: p.ownerWords },
				);
				if (!res.ok) throw new Error(res.error);
				const post = res.post;
				const to = post.to === "all" ? "all roles" : post.to.join(", ");
				let text: string;
				if (post.kind === "news") {
					text = `Posted ${post.id} (news to ${to}). It wakes nobody: each listed role sees it at the start of its next turn, in its home chat.`;
				} else {
					const direct = res.direct.map(
						(d) =>
							`${d.role} (${d.how.map((h) => (h === "turn" ? "a turn in its home chat" : "a steer into its running turn")).join(" and ")}; it has ${d.why.join(", ")})`,
					);
					text =
						`Posted ${post.id} (order to ${to}).` +
						(direct.length
							? ` Sent directly: ${direct.join("; ")}.`
							: " No listed role has something waiting, so none was poked.") +
						(res.later.length ? ` The rest see it at their next turn: ${res.later.join(", ")}.` : "") +
						` Roles mark it done with board ack; nothing comes back to you: board read ${post.id} shows who is done.`;
				}
				return {
					content: [{ type: "text", text }],
					details: {
						action,
						id: post.id,
						kind: post.kind,
						direct: res.direct.map((d) => d.role),
						later: res.later,
					},
				};
			}
			if (action === "ack") {
				const res = board.ack(role, p.id, p.note);
				if (!res.ok) throw new Error(res.error);
				const closed = res.post.closed ? ` (it was already closed by ${res.post.closed.by})` : "";
				const text = `${res.replaced ? "Replaced your note on" : "Marked"} ${res.post.id} done for ${role}${closed}. Nothing is sent to the poster; the board shows it.`;
				return { content: [{ type: "text", text }], details: { action, id: res.post.id } };
			}
			if (action === "close") {
				const res = board.close({ role }, p.id, p.note);
				if (!res.ok) throw new Error(res.error);
				const text = `Closed ${res.post.id}. A chat that saw it is told once that it ended, at its next turn.`;
				return { content: [{ type: "text", text }], details: { action, id: res.post.id } };
			}
			throw new Error('action must be "read", "post", "ack" or "close".');
		},
	});
}
