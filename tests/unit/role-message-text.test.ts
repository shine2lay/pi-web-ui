import { describe, expect, it } from "vitest";
import { BOARD_CUSTOM_TYPE, type BoardPostRecord, boardNote, boardOrderText } from "../../server/role-board.js";
import { roleMessageText } from "../../server/role-messages.js";
import {
	messageRoleSentOf,
	parseBoardNoteText,
	parseBoardOrderText,
	parseMessageRoleArgs,
	parseRoleMessageText,
	roleMessagePreview,
	roleMessageRowText,
	roleMessageViewOf,
} from "../../web/src/role-message-text.js";

// role-message-fold (owner 2026-10-06: "Make the agent to agent messages collapsed by default"): the chat
// folds role messages into one row; this parser reads the text the server puts into a chat.

type Parts = Parameters<typeof roleMessageText>[0];
const from = { role: "temper", title: "Temper engine", chat: "Queue #12" };
const text = (p: Partial<Parts> & { kind: Parts["kind"] }, body = "Line one **bold**.\n\nLine two.") =>
	roleMessageText({ id: "rm-0123abcd", from, text: body, ...p } as Parts);

describe("role-message-fold: parseRoleMessageText", () => {
	it("reads every kind: sender, title, chat, kind, the body, and the hint line apart", () => {
		for (const kind of ["question", "request", "fyi"] as const) {
			const p = parseRoleMessageText(text({ kind }));
			expect(p).toEqual({
				id: "rm-0123abcd",
				kind,
				from: "temper",
				title: "Temper engine",
				chat: "Queue #12",
				body: "Line one **bold**.\n\nLine two.",
				hint: expect.stringMatching(/^\(.*\)$/),
			});
		}
		const r = parseRoleMessageText(text({ kind: "reply", replyTo: "rm-89abcdef" }));
		expect(r).toMatchObject({ kind: "reply", replyTo: "rm-89abcdef", from: "temper" });
		expect(r?.hint).toBe(
			"(The answer to your message rm-89abcdef: no need to answer it. The owner doesn't read this turn: write nothing for him. If the sender needs an answer, send it with message_role; otherwise end the turn without a summary.)",
		);
		// quiet-turns: the hint of an answer to a question asked for the owner is a hint too
		const forHim = roleMessageText(
			{ id: "rm-0123abcd", from, text: "Body.", kind: "reply", replyTo: "rm-89abcdef" } as Parts,
			{ ownerAnswer: true },
		);
		expect(parseRoleMessageText(forHim)).toMatchObject({
			body: "Body.",
			hint: expect.stringContaining("goes to him in full"),
		});
		expect(r?.body).toBe("Line one **bold**.\n\nLine two.");
	});

	it("reads a home chat and a titled chat", () => {
		const home = roleMessageText({
			id: "rm-0000beef",
			from: { role: "coo", title: "COO", chat: "home chat" },
			kind: "fyi",
			text: "hi",
		} as Parts);
		expect(parseRoleMessageText(home)).toMatchObject({ from: "coo", title: "COO", chat: "home chat", body: "hi" });
		const titled = roleMessageText({
			id: "rm-0000beef",
			from: { role: "ops", title: "ops/tooling", chat: `chat "Fold role (x)"` },
			kind: "request",
			text: "do it",
		} as Parts);
		expect(parseRoleMessageText(titled)).toMatchObject({
			from: "ops",
			title: "ops/tooling",
			chat: `chat "Fold role (x)"`,
			kind: "request",
		});
	});

	it("reads the app's 6 am report request", () => {
		const p = parseRoleMessageText(
			roleMessageText({
				id: "rm-00c0ffee",
				from,
				kind: "report",
				report: { date: "2026-10-06" },
				text: "Report please.",
			} as Parts),
		);
		expect(p).toEqual({
			id: "rm-00c0ffee",
			kind: "report",
			reportDate: "2026-10-06",
			body: "Report please.",
			hint: expect.stringMatching(/^\(The app's 6 am report request:/),
		});
		expect(p?.from).toBeUndefined();
	});

	it("leaves a broken or foreign first line alone", () => {
		expect(parseRoleMessageText("[Role message rm-0123abcd from temper")).toBeNull();
		expect(
			parseRoleMessageText("[Role message rm-XYZ from temper (T), sent from its home chat \u00b7 fyi]\n\nx"),
		).toBeNull();
		expect(
			parseRoleMessageText("[Role message rm-0123abcd from temper (T), sent from its home chat \u00b7 gossip]\n\nx"),
		).toBeNull();
		expect(parseRoleMessageText("[Queue] Task #4: do it")).toBeNull();
		expect(
			parseRoleMessageText("Hello [Role message rm-0123abcd from temper (T), sent from its home chat \u00b7 fyi]"),
		).toBeNull();
		expect(parseRoleMessageText("")).toBeNull();
	});

	it("keeps a last paragraph that isn't one of the server's hints in the body", () => {
		const p = parseRoleMessageText(
			"[Role message rm-0123abcd from temper (T), sent from its home chat \u00b7 fyi]\n\nBody.\n\n(Just a note in brackets.)",
		);
		expect(p?.body).toBe("Body.\n\n(Just a note in brackets.)");
		expect(p?.hint).toBeUndefined();
	});
});

describe("role-message-fold: roleMessageViewOf", () => {
	const t = text({ kind: "question" });
	it("prefers the server's stamp, and reads the header only when there is none", () => {
		const stamp = {
			id: "rm-0123abcd",
			from: "temper",
			fromTitle: "Temper engine",
			fromChat: "Queue #12",
			kind: "question" as const,
			text: "stamped body",
		};
		expect(roleMessageViewOf({ role: "user", roleMessage: stamp }, t)).toEqual({ ...stamp, stamped: true });
		expect(roleMessageViewOf({ role: "user" }, t)).toEqual({
			id: "rm-0123abcd",
			kind: "question",
			from: "temper",
			fromTitle: "Temper engine",
			fromChat: "Queue #12",
			text: "Line one **bold**.\n\nLine two.",
			stamped: false,
		});
		expect(roleMessageViewOf({ role: "custom", customType: "role-message" }, t)?.stamped).toBe(false);
	});

	it("only a user message or an FYI can be one", () => {
		expect(roleMessageViewOf({ role: "assistant" }, t)).toBeNull();
		expect(roleMessageViewOf({ role: "custom", customType: "file" }, t)).toBeNull();
		expect(roleMessageViewOf({ role: "toolResult" }, t)).toBeNull();
		expect(roleMessageViewOf({ role: "user" }, "[Queue] Task #75: fold")).toBeNull();
		expect(roleMessageViewOf({ role: "user" }, "just the owner typing")).toBeNull();
	});
});

// board (task #76): a role chat's turn-start note about new posts (custom message "board") and an order the
// board sent to a chat directly (a user message) fold like role messages. The texts come from the server's
// own writers (server/role-board.ts), so the two sides can't drift apart.
describe("board: notes and orders fold like role messages", () => {
	const AT = Date.parse("2026-10-06T19:10:00Z");
	const post = (over: Partial<BoardPostRecord> = {}): BoardPostRecord => ({
		id: "bp-00c0ffee",
		seq: 1,
		at: AT,
		from: "owner",
		kind: "order",
		to: ["backend", "frontend"],
		title: "Pause new work",
		text: "Finish what you have, **start nothing new**.",
		...over,
	});
	const store = (posts: BoardPostRecord[]) => ({ epoch: "e1", seq: posts.length, posts });

	it("reads an order sent directly: its id, the owner, the role that relayed it, the time, the body and the hint apart", () => {
		const relayed = boardOrderText(
			post({ via: "coo", ownerWords: "Telegram 12:25: pause new work" }),
			"America/Los_Angeles",
		);
		const p = parseBoardOrderText(relayed);
		expect(p).toEqual({
			id: "bp-00c0ffee",
			kind: "board-order",
			from: "owner",
			via: "coo",
			what: "2026-10-06 12:10 PDT",
			body: "**Pause new work**\n\nFinish what you have, **start nothing new**.\n\nOwner's words: Telegram 12:25: pause new work",
			hint: expect.stringContaining('board ack bp-00c0ffee "<what you did>"'),
		});
		const own = parseBoardOrderText(boardOrderText(post(), "America/Los_Angeles"));
		expect(own?.from).toBe("owner");
		expect(own?.via).toBeUndefined();
		expect(own?.body).toBe("**Pause new work**\n\nFinish what you have, **start nothing new**.");
		// Not one: a broken header, a role message, or text that only starts the same way.
		expect(parseBoardOrderText("[Board order bp-00c0ffee from owner]\n\nx")).toBeNull();
		expect(parseBoardOrderText("[Board order bp-xyz from owner \u00b7 now]")).toBeNull();
		expect(parseBoardOrderText(text({ kind: "request" }))).toBeNull();
		// The folded row reads "Title: first words" (a title ending in punctuation keeps its own).
		const row = (t: string) => roleMessagePreview(roleMessageRowText({ kind: "board-order", text: t }));
		expect(row(own?.body ?? "")).toBe("Pause new work: Finish what you have, start nothing new.");
		expect(row("**Ready?**\n\nSay so.")).toBe("Ready? Say so.");
		expect(roleMessageRowText({ kind: "request", text: "**Bold** start" })).toBe("**Bold** start");
	});

	it("reads a turn-start note: its head and the posts, whatever it holds", () => {
		const one = boardNote(store([post()]), { role: "backend", isHome: true, got: [] }, AT, "UTC");
		const p = parseBoardNoteText(one!.text);
		expect(p).toMatchObject({ id: "bp-00c0ffee", kind: "board", what: "1 new post" });
		expect(p?.body).toContain("Order bp-00c0ffee \u00b7 from owner");
		expect(p?.body).toContain('board ack bp-00c0ffee "<what you did>"');

		// Two new posts and one that ended since the chat saw it; then only the ended one.
		const closed = post({ id: "bp-0000dead", seq: 1, closed: { at: AT + 60_000, by: "owner", note: "pause lifted" } });
		const two = [
			closed,
			post({ id: "bp-00000002", seq: 2, kind: "news", title: "Deploy at 15:00", text: "FYI." }),
			post({ id: "bp-00000003", seq: 3 }),
		];
		const mark = { v: 1 as const, epoch: "e1", upTo: 1, open: ["bp-0000dead"] };
		const both = boardNote(store(two), { role: "backend", isHome: true, mark, got: [] }, AT, "UTC");
		expect(parseBoardNoteText(both!.text)?.what).toBe("2 new posts, 1 ended");
		const endedOnly = boardNote(store([closed]), { role: "backend", isHome: true, mark, got: [] }, AT, "UTC");
		expect(parseBoardNoteText(endedOnly!.text)).toMatchObject({
			id: "bp-0000dead",
			kind: "board",
			what: "1 post ended",
		});

		expect(parseBoardNoteText("[Board] whatever")).toBeNull();
		expect(parseBoardNoteText("[Board]")).toBeNull();
	});

	it("roleMessageViewOf: a 'board' note and an order sent directly fold; other messages stay as they are", () => {
		const note = boardNote(store([post()]), { role: "backend", isHome: false, got: [] }, AT, "UTC")!.text;
		expect(roleMessageViewOf({ role: "custom", customType: BOARD_CUSTOM_TYPE }, note)).toMatchObject({
			id: "bp-00c0ffee",
			kind: "board",
			what: "1 new post",
			stamped: true,
		});
		const order = boardOrderText(post({ via: "coo", ownerWords: "his words" }), "UTC");
		expect(roleMessageViewOf({ role: "user" }, order)).toMatchObject({
			id: "bp-00c0ffee",
			kind: "board-order",
			from: "owner",
			via: "coo",
			stamped: true,
		});
		// Only the server's own kinds: an assistant quoting an order, or a note in another custom type, stay.
		expect(roleMessageViewOf({ role: "assistant" }, order)).toBeNull();
		expect(roleMessageViewOf({ role: "custom", customType: "role-message" }, note)).toBeNull();
		expect(roleMessageViewOf({ role: "custom", customType: BOARD_CUSTOM_TYPE }, "[Board] hello")).toBeNull();
		expect(roleMessageViewOf({ role: "user" }, "[Board] 1 new post\n\nthe owner typing this")).toBeNull();
	});
});

describe("role-message-fold: previews and message_role cards", () => {
	it("roleMessagePreview: plain text, one line, cut with an ellipsis", () => {
		expect(roleMessagePreview("## Title\n\n- **Bold** item with `code` and [a link](http://x)\n> quote")).toBe(
			"Title Bold item with code and a link quote",
		);
		const long = "word ".repeat(40);
		const p = roleMessagePreview(long, 20);
		expect(p.endsWith("\u2026")).toBe(true);
		expect(p.length).toBeLessThanOrEqual(21);
		expect(roleMessagePreview("snake_case_name and *em*")).toBe("snake_case_name and em");
	});

	it("parseMessageRoleArgs: whole JSON, and as much as has arrived while it streams", () => {
		expect(
			parseMessageRoleArgs('{"to":"coo","kind":"reply","replyTo":"rm-89abcdef","text":"Done: \\"x\\"\\nok"}'),
		).toEqual({
			to: "coo",
			kind: "reply",
			replyTo: "rm-89abcdef",
			text: 'Done: "x"\nok',
		});
		expect(parseMessageRoleArgs('{"to":"coo","kind":"question","text":"Half a sen')).toEqual({
			to: "coo",
			kind: "question",
			text: "Half a sen",
		});
		expect(parseMessageRoleArgs('{"to":"coo","text":"cut in an escape \\u00')).toEqual({
			to: "coo",
			text: "cut in an escape ",
		});
		expect(parseMessageRoleArgs("")).toEqual({});
		expect(parseMessageRoleArgs(undefined)).toEqual({});
	});

	it("messageRoleSentOf: the id from details or text; nothing while running or when refused", () => {
		expect(messageRoleSentOf({ details: { id: "rm-0123abcd", state: "waiting" } })).toEqual({
			id: "rm-0123abcd",
			held: false,
		});
		expect(messageRoleSentOf({ details: { id: "rm-0123abcd", state: "held" } })).toEqual({
			id: "rm-0123abcd",
			held: true,
		});
		expect(
			messageRoleSentOf({ content: [{ type: "text", text: "Sent rm-0123abcd (fyi to coo). It's added" }] }),
		).toEqual({
			id: "rm-0123abcd",
			held: false,
		});
		expect(
			messageRoleSentOf({ content: [{ type: "text", text: "Held rm-0123abcd (question to qa): paused" }] }),
		).toEqual({
			id: "rm-0123abcd",
			held: true,
		});
		expect(messageRoleSentOf({ isError: true, content: [{ type: "text", text: "Sent rm-0123abcd" }] })).toBeNull();
		expect(messageRoleSentOf({ content: [{ type: "text", text: "Refused: chain limit" }] })).toBeNull();
		expect(messageRoleSentOf(undefined)).toBeNull();
	});
});
