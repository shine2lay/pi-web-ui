/**
 * chat-title (fork patch, PATCHES.md): the name at the top of the middle pane, from the chat's own state
 * (what useChat gives App: the open chat, its start-up, its snapshot, a switch and its cached messages).
 *
 * It is the left bar's own name for the chat on screen, never a new naming rule:
 *  1. the open chat: its row's title in the running list (what the left bar's current row shows),
 *     so a rename shows the moment the list has the new title;
 *  2. while another chat opens with its cached messages on screen: that chat's name, the one the left
 *     bar's highlighted row shows (switchTargetTitle's rules, uncut); without cached messages the overlay
 *     covers the pane and you're still in the old chat, so its title stays;
 *  3. an open chat not in the running list yet: the same fallbacks by its file (name, first message,
 *     a live row with that file), but never the file's own name;
 *  4. nothing to name (a blank new chat, New chat starting, no snapshot yet): null, no title.
 */
import { describe, expect, it } from "vitest";
import { chatTitleOnScreen, type ChatOnScreen } from "../../web/src/chat-title.js";
import { en } from "../../web/src/i18n.js";
import type { SwitchTarget } from "../../web/src/types.js";
import { buildUiSlots, CHAT_TITLE_ENTRY_ID } from "../../web/src/ui-slots.js";

const P = "/home/me/.pi/agent/sessions/--home-me--/2026-10-30T09-01-00-000Z_abc.jsonl";
const Q = "/home/me/.pi/agent/sessions/--home-me--/2026-10-30T09-02-00-000Z_def.jsonl";
const QUEUE_TITLE = "Queue #644: Make the queue's task list load fast";

const conversations = [
	{ id: "c1", title: QUEUE_TITLE, sessionPath: Q },
	{ id: "c2", title: "tooling", sessionPath: P },
];

const BOUND = { via: "load", phase: "bound" } as const;
const NEW_CHAT_STARTING = { via: "new_chat", phase: "starting" } as const;

/** The page is in chat c2 ("tooling"), started up, nothing being switched. */
const view = (over: Partial<ChatOnScreen>): ChatOnScreen => ({
	activeConversationId: "c2",
	startup: BOUND,
	state: { sessionFile: P },
	preview: null,
	pendingSwitch: null,
	conversations,
	sessions: [],
	...over,
});
/** A switch to `target` whose cached messages are on screen (chat.preview). */
const opening = (target: SwitchTarget): Partial<ChatOnScreen> => ({ preview: {}, pendingSwitch: { target } });

describe("chat-title", () => {
	it("the open chat: its row's title in the running list, as the left bar shows it", () => {
		expect(chatTitleOnScreen(view({}))).toBe("tooling");
		expect(chatTitleOnScreen(view({ activeConversationId: "c1", state: { sessionFile: Q } }))).toBe(QUEUE_TITLE);
	});

	it("follows a rename: the new title in the list is the title", () => {
		const renamed = [conversations[0], { ...conversations[1], title: "tooling, renamed" }];
		expect(chatTitleOnScreen(view({ conversations: renamed }))).toBe("tooling, renamed");
	});

	it("the running list wins over History's name for the same file", () => {
		const sessions = [{ path: P, name: "older name", firstMessage: "hello there" }];
		expect(chatTitleOnScreen(view({ sessions }))).toBe("tooling");
	});

	it("a blank new chat (not in the list, no words in History) has no title", () => {
		expect(
			chatTitleOnScreen(view({ activeConversationId: "c3", state: { sessionFile: "/home/me/new.jsonl" } })),
		).toBeNull();
		expect(chatTitleOnScreen(view({ activeConversationId: "c3", state: { sessionFile: undefined } }))).toBeNull();
		expect(chatTitleOnScreen(view({ activeConversationId: "c3", state: null }))).toBeNull();
	});

	it("while New chat starts, no title: the left bar has no current row either", () => {
		// The page is still in the chat it left (c2) until the new one binds (first-send).
		expect(chatTitleOnScreen(view({ startup: NEW_CHAT_STARTING }))).toBeNull();
		expect(chatTitleOnScreen(view({ activeConversationId: "" }))).toBeNull();
	});

	it("an open chat not in the list yet: History's name, then its first message, then a live row with its file", () => {
		const missing = { activeConversationId: "c9", conversations: [] };
		expect(chatTitleOnScreen(view({ ...missing, sessions: [{ path: P, name: "temper", firstMessage: "hi" }] }))).toBe(
			"temper",
		);
		expect(chatTitleOnScreen(view({ ...missing, sessions: [{ path: P, firstMessage: "hello there" }] }))).toBe(
			"hello there",
		);
		expect(chatTitleOnScreen(view({ activeConversationId: "c9", sessions: [] }))).toBe("tooling");
	});

	it("never shows a file's own name", () => {
		expect(chatTitleOnScreen(view({ activeConversationId: "c9", conversations: [], sessions: [] }))).toBeNull();
		expect(chatTitleOnScreen(view(opening({ kind: "session", path: "/home/me/elsewhere.jsonl" })))).toBeNull();
	});

	it("while another chat opens with its cached messages on screen: that chat's name, never the old one's", () => {
		expect(chatTitleOnScreen(view(opening({ kind: "conversation", id: "c1" })))).toBe(QUEUE_TITLE);
		const older = { kind: "session" as const, path: "/home/me/older.jsonl" };
		expect(chatTitleOnScreen(view({ ...opening(older), sessions: [{ path: older.path, name: "temper" }] }))).toBe(
			"temper",
		);
		// Whole, as the left bar's History row has it (the 60-character cut is the overlay's).
		const long = "Queue #651: Show which model each chat is using and let me switch it from the chat header";
		expect(chatTitleOnScreen(view({ ...opening(older), sessions: [{ path: older.path, name: long }] }))).toBe(long);
		const first = "x".repeat(200);
		expect(chatTitleOnScreen(view({ ...opening(older), sessions: [{ path: older.path, firstMessage: first }] }))).toBe(
			first,
		);
	});

	it("switching without cached messages: the overlay covers the pane and you're still in the old chat", () => {
		expect(chatTitleOnScreen(view({ pendingSwitch: { target: { kind: "conversation", id: "c1" } } }))).toBe("tooling");
	});

	it("is a Chat header entry, first by default, that Settings > UI layout can hide or move", () => {
		const t = (key: string) => (en as Record<string, string>)[key] ?? `#${key}`;
		const header = buildUiSlots([], { locale: "en", t })["chat.header"];
		expect(CHAT_TITLE_ENTRY_ID).toBe("host:chat-title");
		const entry = header.find((e) => e.id === CHAT_TITLE_ENTRY_ID);
		expect(entry).toMatchObject({ source: "host", label: "Chat title", hidden: false });
		expect(header[0]?.id).toBe(CHAT_TITLE_ENTRY_ID);
		const hidden = buildUiSlots([], { locale: "en", t, layout: { hidden: [CHAT_TITLE_ENTRY_ID] } })["chat.header"];
		expect(hidden.find((e) => e.id === CHAT_TITLE_ENTRY_ID)?.hidden).toBe(true);
		const moved = buildUiSlots([], { locale: "en", t, layout: { order: ["host:chat-identity", CHAT_TITLE_ENTRY_ID] } })[
			"chat.header"
		];
		expect(moved.map((e) => e.id)).toEqual(["host:chat-identity", CHAT_TITLE_ENTRY_ID]);
	});

	it("a title that is only spaces is no title", () => {
		const blankTitle = [{ id: "c2", title: "   ", sessionPath: P }];
		expect(chatTitleOnScreen(view({ conversations: blankTitle }))).toBeNull();
	});
});
