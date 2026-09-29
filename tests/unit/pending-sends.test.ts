/**
 * optimistic-send: the window's list of sent messages the server hasn't confirmed yet
 * (web/src/pending-sends.ts).
 *
 * Pressing Send draws the message at once, faded ("Sending…"), and the copy goes when the server's
 * copy shows up (no gap, no duplicate) or when the server confirms it. What can go wrong:
 *  - the faded copy is dropped too early (an older message with the same text is taken for it);
 *  - it is never dropped (the server's copy looks a little different, or its snapshot was lost);
 *  - two quick sends of the same text are both dropped by one server copy;
 *  - a refusal loses the text (it must stay, marked "Not sent", with Retry and ×);
 *  - a reload or reconnect forgets what is still on its way.
 */

import { describe, expect, it } from "vitest";
import {
	applyPromptAck,
	attachmentsLandedIds,
	failPending,
	idsToCheck,
	isSlashText,
	newPendingSend,
	normalizeSentText,
	onReconnect,
	parsePending,
	type PendingSend,
	pendingFor,
	reconcilePending,
	removePending,
	retryPending,
	runStartingFor,
	sameChat,
	seenPendingIds,
	serializePending,
	userMessageShows,
} from "../../web/src/pending-sends.js";
import type { UiMessage, UiState } from "../../web/src/types.js";

function user(id: string, text: string, extra: Partial<UiMessage> = {}): UiMessage {
	return { id, role: "user", content: [{ type: "text", text }], ...extra } as UiMessage;
}

function assistant(id: string, text: string): UiMessage {
	return { id, role: "assistant", content: [{ type: "text", text }] } as UiMessage;
}

/** A chat's state; its pi session is "s-<chat id>" unless given (another chat, another session). */
function ui(over: Partial<UiState> = {}): UiState {
	return {
		conversationId: "c1",
		sessionId: `s-${over.conversationId ?? "c1"}`,
		rev: 1,
		messages: [],
		messagesStart: 0,
		isStreaming: false,
		queue: { steering: [], followUp: [] },
		...over,
	} as UiState;
}

function pending(id: string, text: string, state: UiState, now = 1, extra: Partial<PendingSend> = {}): PendingSend {
	return { ...newPendingSend({ id, text, state, now }), ...extra };
}

describe("isSlashText / normalizeSentText", () => {
	it("treats a leading slash (after spaces) as a command", () => {
		expect(isSlashText("/compact")).toBe(true);
		expect(isSlashText("  /model x")).toBe(true);
		expect(isSlashText("hello /compact")).toBe(false);
		expect(isSlashText("")).toBe(false);
	});

	it("evens out line ends and trims", () => {
		expect(normalizeSentText("  a\r\nb\rc \n")).toBe("a\nb\nc");
	});
});

describe("userMessageShows", () => {
	it("matches the same text, whatever the line ends", () => {
		expect(userMessageShows(user("u1", "one\ntwo"), normalizeSentText("one\r\ntwo"))).toBe(true);
	});

	it("does not match another text, a longer text, or an assistant message", () => {
		expect(userMessageShows(user("u1", "hello world"), "hello")).toBe(false);
		expect(userMessageShows(user("u1", "hello"), "hello world")).toBe(false);
		expect(userMessageShows(assistant("a1", "hello"), "hello")).toBe(false);
	});

	it("matches a text the server cut short by its beginning", () => {
		const m = {
			id: "u1",
			role: "user",
			content: [{ type: "text", text: "abc def\n\n… [truncated]", truncated: true }],
		} as UiMessage;
		expect(userMessageShows(m, "abc def ghi jkl")).toBe(true);
		expect(userMessageShows(m, "xyz")).toBe(false);
	});

	it("matches a message with a picture that pi added a note to", () => {
		const withNote = {
			id: "u1",
			role: "user",
			content: [
				{ type: "text", text: "look at this\n\n[Image resized]" },
				{ type: "image", dataUrl: "data:image/png;base64,AA" },
			],
		} as UiMessage;
		expect(userMessageShows(withNote, "look at this")).toBe(true);
		expect(userMessageShows(withNote, "look")).toBe(false);
		// The same text without a picture is somebody else's message.
		expect(userMessageShows(user("u2", "look at this\n\n[Image resized]"), "look at this")).toBe(false);
	});

	it("matches a message of only pictures when only pictures were sent", () => {
		const onlyPicture = {
			id: "u1",
			role: "user",
			content: [{ type: "image", dataUrl: "data:image/png;base64,AA" }],
		} as UiMessage;
		expect(userMessageShows(onlyPicture, "")).toBe(true);
		const noteOnly = {
			id: "u2",
			role: "user",
			content: [
				{ type: "text", text: "\n\n[Image resized]" },
				{ type: "image", dataUrl: "data:image/png;base64,AA" },
			],
		} as UiMessage;
		expect(userMessageShows(noteOnly, "")).toBe(true);
	});
});

describe("newPendingSend", () => {
	it("remembers where the chat stood: its last message, same-text messages and queue", () => {
		const state = ui({
			messages: [user("u1", "hi"), assistant("a1", "hello"), user("u2", "hi"), assistant("a2", "again")],
			queue: { steering: ["hi"], followUp: ["other", " hi "] },
		});
		const p = newPendingSend({ id: "p1", text: "hi", queue: true, state, now: 42 });
		expect(p).toMatchObject({
			id: "p1",
			conversationId: "c1",
			text: "hi",
			queue: true,
			createdAt: 42,
			status: "sending",
			anchorId: "a2",
			sameTextBefore: ["u1", "u2"],
			queueBase: 2,
		});
		expect(p.attachments).toBeUndefined();
	});

	it("keeps attachments, and has no anchor in an empty chat", () => {
		const p = newPendingSend({
			id: "p1",
			text: "",
			attachments: [{ path: "", imageData: "AA", mimeType: "image/png", name: "a.png" }],
			state: ui(),
			now: 1,
		});
		expect(p.anchorId).toBeUndefined();
		expect(p.attachments).toHaveLength(1);
		expect(p.queue).toBe(false);
	});

	it("remembers whether the AI was working (then the message joins the queue)", () => {
		expect(newPendingSend({ id: "p1", text: "hi", state: ui(), now: 1 }).whileWorking).toBe(false);
		expect(newPendingSend({ id: "p2", text: "hi", state: ui({ isStreaming: true }), now: 1 }).whileWorking).toBe(true);
	});
});

describe("runStartingFor", () => {
	const idle = ui({ messages: [user("u1", "hi"), assistant("a1", "hello")] });
	const file = (id: string): UiMessage =>
		({ id, role: "custom", customType: "file", content: [] }) as unknown as UiMessage;

	it("is the run a message sent to an idle chat starts, until that message is in", () => {
		const list = [pending("p1", "next", idle)];
		expect(runStartingFor(list, idle)).toBe(false);
		const starting = ui({ messages: idle.messages, isStreaming: true });
		expect(runStartingFor(list, starting)).toBe(true);
		// Its pictures and files came in first: still starting.
		expect(runStartingFor(list, ui({ messages: [...idle.messages, file("f1")], isStreaming: true }))).toBe(true);
		// The answer is coming in: the message is in.
		expect(
			runStartingFor(list, ui({ messages: idle.messages, isStreaming: true, streamingMessage: assistant("s", "") })),
		).toBe(false);
	});

	it("is not when another message started the run, or the AI was already working", () => {
		const list = [pending("p1", "next", idle)];
		const other = ui({ messages: [...idle.messages, user("u2", "from another window")], isStreaming: true });
		expect(runStartingFor(list, other)).toBe(false);
		const busy = ui({ messages: idle.messages, isStreaming: true });
		expect(runStartingFor([pending("p2", "more", busy)], busy)).toBe(false);
	});

	it("is not for a message that wasn't sent, another chat's, or when the chat was compacted", () => {
		const starting = ui({ messages: idle.messages, isStreaming: true });
		expect(runStartingFor([pending("p1", "next", idle, 1, { status: "failed" })], starting)).toBe(false);
		const elsewhere = pending("p1", "next", ui({ conversationId: "c2", messages: idle.messages }));
		expect(runStartingFor([elsewhere], starting)).toBe(false);
		const compacted = ui({ messages: [assistant("sum", "summary")], isStreaming: true });
		expect(runStartingFor([pending("p1", "next", idle)], compacted)).toBe(false);
	});

	it("is not for a copy kept from before this was known (no record of how it was sent)", () => {
		const starting = ui({ messages: idle.messages, isStreaming: true });
		expect(runStartingFor([pending("p1", "next", idle, 1, { whileWorking: undefined })], starting)).toBe(false);
	});
});

describe("seenPendingIds / reconcilePending", () => {
	const before = ui({ messages: [user("u1", "hi"), assistant("a1", "hello")] });

	it("drops the copy once the chat shows the message after where it stood", () => {
		const list = [pending("p1", "hi", before)];
		expect(reconcilePending(list, before)).toBe(list);
		const after = ui({ rev: 2, messages: [...before.messages, user("u2", "hi")] });
		expect(reconcilePending(list, after)).toEqual([]);
	});

	it("does not take an older message with the same text for the copy", () => {
		const list = [pending("p1", "hi", before)];
		expect(seenPendingIds(list, before).size).toBe(0);
		// A new assistant message alone doesn't count either.
		const moreAnswer = ui({ messages: [...before.messages, assistant("a2", "hi")] });
		expect(seenPendingIds(list, moreAnswer).size).toBe(0);
	});

	it("needs one server copy per send when the same text is sent twice", () => {
		const list = [pending("p1", "again", before, 1), pending("p2", "again", before, 2)];
		const one = ui({ messages: [...before.messages, user("u2", "again")] });
		expect(reconcilePending(list, one).map((p) => p.id)).toEqual(["p2"]);
		const two = ui({ messages: [...one.messages, assistant("a2", "ok"), user("u3", "again")] });
		expect(reconcilePending(list, two)).toEqual([]);
	});

	it("drops a copy sent while the AI works once the text waits in the queue", () => {
		const working = ui({ isStreaming: true, messages: before.messages, queue: { steering: ["later"], followUp: [] } });
		const list = [pending("p1", "later", working)];
		expect(list[0].queueBase).toBe(1);
		expect(reconcilePending(list, working)).toBe(list);
		const queued = ui({
			isStreaming: true,
			messages: before.messages,
			queue: { steering: ["later"], followUp: ["later"] },
		});
		expect(reconcilePending(list, queued)).toEqual([]);
	});

	it("still finds the copy when the anchor message is gone (the chat was compacted)", () => {
		const list = [pending("p1", "hi", before)];
		const compacted = ui({ messages: [user("u1", "hi"), assistant("s1", "summary"), user("u9", "hi")] });
		expect(reconcilePending(list, compacted)).toEqual([]);
		const onlyOld = ui({ messages: [user("u1", "hi"), assistant("s1", "summary")] });
		expect(reconcilePending(list, onlyOld)).toBe(list);
	});

	it("leaves other chats' copies alone", () => {
		const list = [pending("p1", "hi", before)];
		const other = ui({ conversationId: "c2", messages: [user("x1", "hi")] });
		expect(reconcilePending(list, other)).toBe(list);
		expect(reconcilePending(list, null)).toBe(list);
	});

	it("drops a 'Not sent' copy whose message got there after all", () => {
		const list = [pending("p1", "hi", before, 1, { status: "failed", reason: "x" })];
		const after = ui({ messages: [...before.messages, user("u2", "hi")] });
		expect(reconcilePending(list, after)).toEqual([]);
	});

	it("keeps a confirmed copy until the window's state is as new as the confirming snapshot", () => {
		const list = [pending("p1", "changed by an add-on", before, 1, { confirmedRev: 5 })];
		expect(reconcilePending(list, ui({ rev: 4, messages: before.messages }))).toBe(list);
		expect(reconcilePending(list, ui({ rev: 5, messages: before.messages }))).toEqual([]);
		// Another chat is shown: the window can't wait for that chat's snapshot.
		expect(reconcilePending(list, ui({ conversationId: "c2", rev: 1 }))).toEqual([]);
	});
});

describe("attachmentsLandedIds", () => {
	const before = ui({ messages: [user("u1", "hi"), assistant("a1", "hello")] });
	const card = (id: string) => ({ id, role: "custom", customType: "file", content: [] }) as unknown as UiMessage;
	const pic = { path: "", imageData: "AA", mimeType: "image/png", name: "a.png" };

	it("says when the chat already shows a send's files as cards", () => {
		const list = [pending("p1", "look", before, 1, { attachments: [pic] })];
		expect(attachmentsLandedIds(list, before).size).toBe(0);
		const withCard = ui({ messages: [...before.messages, card("f1")] });
		expect([...attachmentsLandedIds(list, withCard)]).toEqual(["p1"]);
	});

	it("doesn't count cards from before the send, or sends without files", () => {
		const old = ui({ messages: [card("f0"), user("u1", "hi")] });
		const list = [pending("p1", "look", old, 1, { attachments: [pic] }), pending("p2", "plain", old, 2)];
		expect(attachmentsLandedIds(list, old).size).toBe(0);
		const later = ui({ messages: [...old.messages, card("f1")] });
		expect([...attachmentsLandedIds(list, later)]).toEqual(["p1"]);
	});

	it("gives each send as many cards as it has files, in sending order", () => {
		const list = [
			pending("p1", "two", before, 1, { attachments: [pic, pic] }),
			pending("p2", "one", before, 2, { attachments: [pic] }),
		];
		const twoCards = ui({ messages: [...before.messages, card("f1"), card("f2")] });
		expect([...attachmentsLandedIds(list, twoCards)]).toEqual(["p1"]);
		const threeCards = ui({ messages: [...twoCards.messages, user("u2", "two"), card("f3")] });
		expect([...attachmentsLandedIds(list, threeCards)].sort()).toEqual(["p1", "p2"]);
	});

	it("leaves 'Not sent' copies and other chats alone", () => {
		const list = [pending("p1", "look", before, 1, { attachments: [pic], status: "failed" })];
		expect(attachmentsLandedIds(list, ui({ messages: [...before.messages, card("f1")] })).size).toBe(0);
		const other = [pending("p2", "look", before, 1, { attachments: [pic] })];
		expect(attachmentsLandedIds(other, ui({ conversationId: "c2", messages: [card("f1")] })).size).toBe(0);
	});
});

describe("applyPromptAck", () => {
	const state = ui({ rev: 7, messages: [user("u1", "hi")] });

	it("drops the copy on ok", () => {
		const list = [pending("p1", "x", state), pending("p2", "y", state)];
		expect(applyPromptAck(list, { id: "p1", conversationId: "c1", ok: true }, state).map((p) => p.id)).toEqual(["p2"]);
		expect(applyPromptAck(list, { id: "p1", conversationId: "c1", ok: true, rev: 7 }, state).map((p) => p.id)).toEqual([
			"p2",
		]);
	});

	it("keeps the copy when the window hasn't got the snapshot that shows the message", () => {
		const list = [pending("p1", "x", state)];
		const next = applyPromptAck(list, { id: "p1", conversationId: "c1", ok: true, rev: 9 }, state);
		expect(next).toHaveLength(1);
		expect(next[0]).toMatchObject({ status: "sending", confirmedRev: 9 });
		expect(reconcilePending(next, ui({ rev: 9, messages: state.messages }))).toEqual([]);
	});

	it("does not wait for a snapshot of a chat the window no longer shows", () => {
		const list = [pending("p1", "x", state)];
		const other = ui({ conversationId: "c2", rev: 1 });
		expect(applyPromptAck(list, { id: "p1", conversationId: "c1", ok: true, rev: 9 }, other)).toEqual([]);
	});

	it("marks a refused send 'Not sent' with the reason, and keeps everything else", () => {
		const list = [pending("p1", "x", state), pending("p2", "y", state)];
		const next = applyPromptAck(
			list,
			{ id: "p1", conversationId: "c1", ok: false, reason: "Stopped before it was sent." },
			state,
		);
		expect(next[0]).toMatchObject({ id: "p1", status: "failed", reason: "Stopped before it was sent.", text: "x" });
		expect(next[1]).toBe(list[1]);
	});

	it("ignores a late refusal of a send the server already confirmed", () => {
		const list = [pending("p1", "x", state, 1, { confirmedRev: 9 })];
		expect(applyPromptAck(list, { id: "p1", conversationId: "c1", ok: false, reason: "late" }, state)).toBe(list);
	});

	it("drops a 'Not sent' copy the server confirms after all", () => {
		const list = [pending("p1", "x", state, 1, { status: "failed", reason: "r" })];
		expect(applyPromptAck(list, { id: "p1", conversationId: "c1", ok: true }, state)).toEqual([]);
	});

	it("changes nothing for an id it doesn't know (already gone, or another window's)", () => {
		const list = [pending("p1", "x", state)];
		expect(applyPromptAck(list, { id: "zz", conversationId: "c1", ok: false }, state)).toBe(list);
	});
});

describe("retryPending / failPending / removePending", () => {
	const state = ui({ messages: [user("u1", "hi"), assistant("a1", "hello")] });

	it("Retry sends it again as 'Sending', measured from the chat as it is now", () => {
		const list = [pending("p1", "hi", state, 1, { status: "failed", reason: "r", needsCheck: true })];
		const now = ui({
			messages: [...state.messages, user("u2", "hi"), assistant("a2", "ok")],
			queue: { steering: [], followUp: ["hi"] },
		});
		const next = retryPending(list, "p1", now);
		expect(next[0]).toMatchObject({
			id: "p1",
			status: "sending",
			anchorId: "a2",
			sameTextBefore: ["u1", "u2"],
			queueBase: 1,
		});
		expect(next[0].reason).toBeUndefined();
		expect(next[0].needsCheck).toBeUndefined();
		// The earlier "hi" (u2) doesn't make the retried copy vanish; a new one does.
		expect(reconcilePending(next, now)).toBe(next);
		expect(reconcilePending(next, ui({ messages: [...now.messages, user("u3", "hi")] }))).toEqual([]);
	});

	it("Retry keeps the old measure when another chat is shown", () => {
		const list = [pending("p1", "hi", state, 1, { status: "failed" })];
		const next = retryPending(list, "p1", ui({ conversationId: "c2", messages: [user("x", "y")] }));
		expect(next[0]).toMatchObject({ status: "sending", anchorId: "a1" });
		expect(retryPending(list, "nope", state)).toBe(list);
	});

	it("marks a send 'Not sent' and removes it", () => {
		const list = [pending("p1", "hi", state)];
		expect(failPending(list, "p1", "Not connected to the server.")[0]).toMatchObject({
			status: "failed",
			reason: "Not connected to the server.",
		});
		expect(failPending(list, "zz", "r")).toBe(list);
		expect(removePending(list, "p1")).toEqual([]);
		expect(removePending(list, "zz")).toBe(list);
	});
});

describe("onReconnect / idsToCheck / pendingFor", () => {
	const state = ui();

	it("after a reconnect: confirmed copies go, the rest still 'Sending' is asked about", () => {
		const list = [
			pending("p1", "a", state, 1),
			pending("p2", "b", state, 2, { confirmedRev: 3 }),
			pending("p3", "c", state, 3, { status: "failed", reason: "r" }),
		];
		const next = onReconnect(list);
		expect(next.map((p) => p.id)).toEqual(["p1", "p3"]);
		expect(next[0].needsCheck).toBe(true);
		expect(next[1].needsCheck).toBeUndefined();
		expect(idsToCheck(next)).toEqual(["p1"]);
		expect(idsToCheck(list)).toEqual([]);
		expect(onReconnect([])).toEqual([]);
	});

	it("draws only the shown chat's copies, oldest first", () => {
		const list = [
			pending("p2", "b", state, 2),
			pending("x", "x", ui({ conversationId: "c2" }), 0),
			pending("p1", "a", state, 1),
		];
		expect(pendingFor(list, { conversationId: "c1", sessionId: "s-c1" }).map((p) => p.id)).toEqual(["p1", "p2"]);
		expect(pendingFor(list, { conversationId: "c1" }).map((p) => p.id)).toEqual(["p1", "p2"]);
		expect(pendingFor(list, undefined)).toEqual([]);
		expect(pendingFor(list, null)).toEqual([]);
	});
});

describe("after a server restart (chats numbered afresh)", () => {
	const before = ui({ messages: [user("u1", "hi"), assistant("a1", "hello")] });

	it("knows a chat by its pi session, and by its id when a session is missing", () => {
		expect(sameChat({ conversationId: "c1", sessionId: "s1" }, { conversationId: "c9", sessionId: "s1" })).toBe(true);
		expect(sameChat({ conversationId: "c1", sessionId: "s1" }, { conversationId: "c1", sessionId: "s2" })).toBe(false);
		expect(sameChat({ conversationId: "c1" }, { conversationId: "c1", sessionId: "s2" })).toBe(true);
		expect(sameChat({ conversationId: "c1", sessionId: "s1" }, { conversationId: "c2" })).toBe(false);
	});

	it("keeps the copy with its chat under the chat's new id, never with the chat that got its old id", () => {
		const list = [pending("p1", "hi", before, 1, { status: "failed", reason: "r" })];
		expect(list[0].sessionId).toBe("s-c1");
		expect(pendingFor(list, { conversationId: "c7", sessionId: "s-c1" }).map((p) => p.id)).toEqual(["p1"]);
		expect(pendingFor(list, { conversationId: "c1", sessionId: "s-other" })).toEqual([]);
		// The chat under its new id shows the message: the copy goes.
		const renumbered = ui({
			conversationId: "c7",
			sessionId: "s-c1",
			messages: [...before.messages, user("u2", "hi")],
		});
		expect(reconcilePending(list, renumbered)).toEqual([]);
		// Another chat that got the old id doesn't make it go.
		const impostor = ui({ conversationId: "c1", sessionId: "s-other", messages: [user("z1", "hi")] });
		expect(reconcilePending(list, impostor)).toBe(list);
	});

	it("Retry takes the chat's new id", () => {
		const list = [pending("p1", "hi", before, 1, { status: "failed", reason: "r" })];
		const renumbered = ui({ conversationId: "c7", sessionId: "s-c1", messages: before.messages });
		expect(retryPending(list, "p1", renumbered)[0]).toMatchObject({
			conversationId: "c7",
			sessionId: "s-c1",
			status: "sending",
		});
	});
});

describe("serializePending / parsePending (reload)", () => {
	const state = ui({ messages: [user("u1", "hi")] });

	it("keeps the list across a reload; copies still on their way are asked about again", () => {
		const list = [
			pending("p1", "one", state, 1, { attachments: [{ path: "/w/a.txt", name: "a.txt" }], queue: true }),
			pending("p2", "two", state, 2, { status: "failed", reason: "Stopped before it was sent." }),
			pending("p3", "three", state, 3, { confirmedRev: 4 }),
		];
		const back = parsePending(serializePending(list));
		expect(back.map((p) => p.id)).toEqual(["p1", "p2"]);
		expect(back[0]).toMatchObject({
			text: "one",
			queue: true,
			status: "sending",
			needsCheck: true,
			anchorId: "u1",
			sameTextBefore: [],
			queueBase: 0,
			whileWorking: false,
		});
		expect(back[0].attachments).toEqual([{ path: "/w/a.txt", name: "a.txt" }]);
		expect(back[1]).toMatchObject({ status: "failed", reason: "Stopped before it was sent." });
		expect(back[1].needsCheck).toBeUndefined();
	});

	it("leaves out pictures and files when they are too big to keep, never the text", () => {
		const big = "A".repeat(1_600_000);
		const list = [
			pending("p1", "with picture", state, 1, {
				attachments: [
					{ path: "", imageData: big, mimeType: "image/png", name: "big.png" },
					{ path: "/w/notes.md", name: "notes.md" },
				],
			}),
		];
		const raw = serializePending(list);
		expect(raw.length).toBeLessThan(10_000);
		const back = parsePending(raw);
		expect(back[0].text).toBe("with picture");
		expect(back[0].attachments).toEqual([{ path: "/w/notes.md", name: "notes.md" }]);
	});

	it("ignores anything it can't read", () => {
		expect(parsePending(null)).toEqual([]);
		expect(parsePending("not json")).toEqual([]);
		expect(parsePending('{"a":1}')).toEqual([]);
		expect(parsePending(JSON.stringify([null, 3, { id: "x" }, { id: "p", conversationId: "c1", text: "t" }]))).toEqual([
			{
				id: "p",
				conversationId: "c1",
				text: "t",
				queue: false,
				createdAt: 0,
				status: "sending",
				sameTextBefore: [],
				queueBase: 0,
				needsCheck: true,
			},
		]);
	});
});
