import { describe, expect, it } from "vitest";
import {
	BlankChatSweep,
	blankCloseHold,
	blankSweepTiming,
	type CloseFacts,
	type CloseHold,
	countsTowardCap,
	isBlankChat,
	OPEN_CHATS_FULL_MESSAGE,
} from "../../server/chat-slots.js";
import { MAX_OPEN_CONVERSATIONS } from "../../server/conversation-limits.js";

/** A blank chat nothing needs: the only kind that may close by itself. */
const blank = (): CloseFacts => ({
	messageCount: 0,
	terminalCount: 0,
	hasQueueEntries: false,
	participant: false,
	sending: false,
	isSubagent: false,
	isEphemeral: false,
	running: false,
	openInWindow: false,
	homeChat: false,
	taskChat: false,
	draft: false,
	liveChild: false,
	prompted: false,
	listed: false,
	backgroundWork: false,
});

describe("chat-slots: the limit and its message", () => {
	it("is 40 open chats per project, with one message everywhere", () => {
		expect(MAX_OPEN_CONVERSATIONS).toBe(40);
		expect(OPEN_CHATS_FULL_MESSAGE).toBe(
			"This project has 40 open chats, the most it can hold. Close one in the left list (✕) to open another.",
		);
	});
});

describe("chat-slots: which chats take a slot (countsTowardCap)", () => {
	it("a chat in use takes a slot", () => {
		expect(countsTowardCap({ isSubagent: false, isEphemeral: false, blank: false })).toBe(true);
	});

	it("a blank chat, a subagent and a throwaway chat don't", () => {
		expect(countsTowardCap({ isSubagent: false, isEphemeral: false, blank: true })).toBe(false);
		expect(countsTowardCap({ isSubagent: true, isEphemeral: false, blank: false })).toBe(false);
		expect(countsTowardCap({ isSubagent: false, isEphemeral: true, blank: false })).toBe(false);
		expect(countsTowardCap({ isSubagent: false, blank: false })).toBe(true);
	});

	it("blank is the reuse test of a new chat: no messages, terminals or queue entries, not a Team participant, nothing on its way", () => {
		expect(isBlankChat(blank())).toBe(true);
		expect(isBlankChat({ ...blank(), messageCount: 1 })).toBe(false);
		expect(isBlankChat({ ...blank(), terminalCount: 1 })).toBe(false);
		expect(isBlankChat({ ...blank(), hasQueueEntries: true })).toBe(false);
		expect(isBlankChat({ ...blank(), participant: true })).toBe(false);
		// queue-e2e-load (Ops #276): a first message on its way isn't saved yet, but New chat must not reuse the chat.
		expect(isBlankChat({ ...blank(), sending: true })).toBe(false);
	});

	it("39 chats in use and 5 blank ones leave a slot; 40 in use don't", () => {
		const chats = [
			...Array.from({ length: 39 }, () => ({ isSubagent: false, isEphemeral: false, blank: false })),
			...Array.from({ length: 5 }, () => ({ isSubagent: false, isEphemeral: false, blank: true })),
		];
		const used = chats.filter(countsTowardCap).length;
		expect(used).toBe(39);
		expect(used >= MAX_OPEN_CONVERSATIONS).toBe(false);
		expect(used + 1 >= MAX_OPEN_CONVERSATIONS).toBe(true);
	});
});

describe("chat-slots: what keeps a blank chat open (blankCloseHold)", () => {
	it("a blank chat nothing needs may close", () => {
		expect(blankCloseHold(blank())).toBeNull();
	});

	const holds: [CloseHold, Partial<CloseFacts>][] = [
		["messages", { messageCount: 2 }],
		["terminals", { terminalCount: 1 }],
		["queue entries", { hasQueueEntries: true }],
		["participant", { participant: true }],
		["subagent", { isSubagent: true }],
		["ephemeral", { isEphemeral: true }],
		["running", { running: true }],
		["open in a window", { openInWindow: true }],
		["home chat", { homeChat: true }],
		["task chat", { taskChat: true }],
		["draft", { draft: true }],
		["live subagent", { liveChild: true }],
		["send tried", { prompted: true }],
		["listed", { listed: true }],
		["background work", { backgroundWork: true }],
	];
	it.each(holds)("never closes a chat held by: %s", (hold, facts) => {
		expect(blankCloseHold({ ...blank(), ...facts })).toBe(hold);
	});

	it("stops at the first hold, so a chat with messages costs one count (the rest are read lazily)", () => {
		let read = 0;
		const facts = {
			...blank(),
			messageCount: 3,
			get openInWindow() {
				read++;
				return false;
			},
		};
		expect(blankCloseHold(facts)).toBe("messages");
		expect(read).toBe(0);
	});
});

describe("chat-slots: the sweep's clock (BlankChatSweep)", () => {
	const idle = 10 * 60_000;

	it("gives a chat seen for the first time the full idle time, then closes it", () => {
		const sweep = new BlankChatSweep(idle);
		expect(sweep.tick(0, [{ id: "a", closable: true }])).toEqual([]);
		expect(sweep.tick(idle - 1, [{ id: "a", closable: true }])).toEqual([]);
		expect(sweep.tick(idle, [{ id: "a", closable: true }])).toEqual(["a"]);
	});

	it("restarts the clock whenever the chat is needed (shown in a window, used, any hold)", () => {
		const sweep = new BlankChatSweep(idle);
		sweep.tick(0, [{ id: "a", closable: true }]);
		sweep.tick(idle - 60_000, [{ id: "a", closable: false }]);
		expect(sweep.tick(idle, [{ id: "a", closable: true }])).toEqual([]);
		expect(sweep.tick(2 * idle - 60_000, [{ id: "a", closable: true }])).toEqual(["a"]);
	});

	it("never closes a chat that stays needed, and forgets chats that are gone", () => {
		const sweep = new BlankChatSweep(idle);
		sweep.tick(0, [
			{ id: "kept", closable: false },
			{ id: "gone", closable: true },
		]);
		expect(sweep.size).toBe(2);
		expect(sweep.tick(5 * idle, [{ id: "kept", closable: false }])).toEqual([]);
		expect(sweep.size).toBe(1);
	});

	it("runs every minute and closes after 10 minutes, unless the environment says otherwise", () => {
		expect(blankSweepTiming({})).toEqual({ idleMs: 600_000, everyMs: 60_000 });
		expect(blankSweepTiming({ PI_WEB_BLANK_CHAT_IDLE_MS: "1500", PI_WEB_BLANK_CHAT_SWEEP_MS: "200" })).toEqual({
			idleMs: 1500,
			everyMs: 200,
		});
		expect(blankSweepTiming({ PI_WEB_BLANK_CHAT_IDLE_MS: "soon", PI_WEB_BLANK_CHAT_SWEEP_MS: "-5" })).toEqual({
			idleMs: 600_000,
			everyMs: 60_000,
		});
	});
});
