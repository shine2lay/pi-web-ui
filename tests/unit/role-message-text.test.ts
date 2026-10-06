import { describe, expect, it } from "vitest";
import { roleMessageText } from "../../server/role-messages.js";
import {
	messageRoleSentOf,
	parseMessageRoleArgs,
	parseRoleMessageText,
	roleMessagePreview,
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
		expect(r?.hint).toBe("(The answer to your message rm-89abcdef: no need to answer it.)");
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
