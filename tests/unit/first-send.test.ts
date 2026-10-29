import { describe, expect, it } from "vitest";
import {
	advanceStartup,
	attachmentScope,
	composerIds,
	INITIAL_STARTUP,
	isStartupBind,
	pendingSendFate,
	requestPendingSend,
	type StartupAttempt,
	type StartupEvent,
} from "../../web/src/first-send.js";

const run = (s: StartupAttempt, ...events: StartupEvent[]) => events.reduce(advanceStartup, s);
const old = { conversationId: "c1", sessionId: "s1" };
const fresh = { conversationId: "c2", sessionId: "s2" };
const NONE = { conversationId: "", sessionId: "" };

describe("start-up attempt: page load (entry a)", () => {
	it("starts as generation 1, bound by the first snapshot that carries a session", () => {
		expect(INITIAL_STARTUP).toMatchObject({ generation: 1, via: "load", phase: "starting" });
		const noSession = run(INITIAL_STARTUP, { type: "snapshot", conversationId: "c1", sessionId: "" });
		expect(noSession.phase).toBe("starting");
		const bound = run(noSession, { type: "snapshot", ...old });
		expect(bound).toMatchObject({ generation: 1, phase: "bound", ...old });
	});

	it("a duplicate bind or a reconnect's snapshot changes nothing", () => {
		const bound = run(INITIAL_STARTUP, { type: "snapshot", ...old });
		expect(run(bound, { type: "snapshot", ...old })).toBe(bound);
		expect(run(bound, { type: "snapshot", ...fresh })).toBe(bound);
	});

	it("a real start-up failure fails the attempt with the ids it has", () => {
		const failed = run(INITIAL_STARTUP, { type: "startup_failed", current: { conversationId: "c1", sessionId: "" } });
		expect(failed).toMatchObject({ generation: 1, phase: "failed", conversationId: "c1", sessionId: "" });
	});

	it("navigation before the bind leaves the attempt with a new generation", () => {
		const left = run(INITIAL_STARTUP, { type: "navigate" });
		expect(left).toMatchObject({ generation: 2, phase: "left" });
		expect(run(left, { type: "snapshot", ...old }).phase).toBe("left");
	});
});

describe("start-up attempt: New chat (entry b)", () => {
	const bound = run(INITIAL_STARTUP, { type: "snapshot", ...old });
	const started = run(bound, { type: "new_chat", reqId: "r1" });

	it("New chat starts a new generation with its request id", () => {
		expect(started).toMatchObject({ generation: 2, via: "new_chat", phase: "starting", reqId: "r1" });
	});

	it("the old chat's snapshot never binds it; only the chat the server names does", () => {
		expect(run(started, { type: "snapshot", ...old })).toBe(started);
		expect(run(started, { type: "snapshot", ...fresh })).toBe(started);
		const named = run(started, { type: "new_chat_result", reqId: "r1", ok: true, conversationId: "c2", current: old });
		expect(named).toMatchObject({ phase: "starting", confirmedConversationId: "c2" });
		expect(run(named, { type: "snapshot", ...fresh })).toMatchObject({ generation: 2, phase: "bound", ...fresh });
	});

	it("binds at once when the server's answer comes after the new chat's snapshot", () => {
		const r = run(started, { type: "new_chat_result", reqId: "r1", ok: true, conversationId: "c2", current: fresh });
		expect(r).toMatchObject({ generation: 2, phase: "bound", ...fresh });
	});

	it("a reused blank chat (same ids as before) is a valid bind", () => {
		const r = run(started, { type: "new_chat_result", reqId: "r1", ok: true, conversationId: "c1", current: old });
		expect(r).toMatchObject({ phase: "bound", ...old });
	});

	it("an answer for another request is ignored", () => {
		expect(run(started, { type: "new_chat_result", reqId: "r0", ok: true, conversationId: "c2", current: fresh })).toBe(
			started,
		);
	});

	it("a failed New chat fails the attempt on the chat that stays current", () => {
		const r = run(started, { type: "new_chat_result", reqId: "r1", ok: false, current: old });
		expect(r).toMatchObject({ generation: 2, phase: "failed", ...old });
	});

	it("a second New chat or a navigation replaces it; the old answer then binds nothing", () => {
		const again = run(started, { type: "new_chat", reqId: "r2" });
		expect(again).toMatchObject({ generation: 3, reqId: "r2", phase: "starting" });
		expect(run(again, { type: "new_chat_result", reqId: "r1", ok: true, conversationId: "c2", current: fresh })).toBe(
			again,
		);
		const left = run(started, { type: "navigate" });
		expect(run(left, { type: "new_chat_result", reqId: "r1", ok: true, conversationId: "c2", current: fresh })).toBe(
			left,
		);
	});

	it("a load-style failure notice does not fail a New chat attempt", () => {
		expect(run(started, { type: "startup_failed", current: old })).toBe(started);
	});
});

describe("composer ids and attachment scope", () => {
	const started = run(run(INITIAL_STARTUP, { type: "snapshot", ...old }), { type: "new_chat", reqId: "r1" });

	it("while a chat starts the composer holds no ids (never the old chat's)", () => {
		expect(composerIds(started, old, false)).toEqual(NONE);
		expect(composerIds(started, old, true)).toEqual(old);
		const bound = run(started, {
			type: "new_chat_result",
			reqId: "r1",
			ok: true,
			conversationId: "c2",
			current: fresh,
		});
		expect(composerIds(bound, fresh, false)).toEqual(fresh);
	});

	it("attachments keep one scope from New chat through the bind or the failure, then follow the session", () => {
		expect(attachmentScope(started, "s1")).toBe("startup:2");
		const bound = run(started, {
			type: "new_chat_result",
			reqId: "r1",
			ok: true,
			conversationId: "c2",
			current: fresh,
		});
		expect(attachmentScope(bound, "s2")).toBe("startup:2");
		const failed = run(started, { type: "new_chat_result", reqId: "r1", ok: false, current: old });
		expect(attachmentScope(failed, "s1")).toBe("startup:2");
		expect(attachmentScope(bound, "s9")).toBe("s9");
		expect(attachmentScope(run(bound, { type: "navigate" }), "s9")).toBe("s9");
	});
});

describe("isStartupBind: bind versus navigation", () => {
	const started = run(run(INITIAL_STARTUP, { type: "snapshot", ...old }), { type: "new_chat", reqId: "r1" });
	const bound = run(started, { type: "new_chat_result", reqId: "r1", ok: true, conversationId: "c2", current: fresh });
	const seen = { ...NONE, generation: 2 };

	it("empty start-up ids to the ids the same generation bound on is a bind", () => {
		expect(isStartupBind(seen, fresh, bound)).toBe(true);
	});

	it("falling back to the old chat after a failed start-up keeps the draft too", () => {
		const failed = run(started, { type: "new_chat_result", reqId: "r1", ok: false, current: old });
		expect(isStartupBind(seen, old, failed)).toBe(true);
	});

	it("a bind from another attempt, other ids, or a still-starting attempt is not", () => {
		expect(isStartupBind({ ...NONE, generation: 1 }, fresh, bound)).toBe(false);
		expect(isStartupBind(seen, { conversationId: "c3", sessionId: "s3" }, bound)).toBe(false);
		expect(isStartupBind(seen, fresh, started)).toBe(false);
		expect(isStartupBind({ ...old, generation: 2 }, fresh, bound)).toBe(false);
		expect(isStartupBind(seen, fresh, run(bound, { type: "navigate" }))).toBe(false);
	});
});

describe("the pending send", () => {
	const started = run(INITIAL_STARTUP, { type: "snapshot", ...old }, { type: "new_chat", reqId: "r1" });

	it("Enter while a chat starts records one pending send; a second Enter is a no-op", () => {
		const p = requestPendingSend(null, started);
		expect(p).toEqual({ generation: 2 });
		expect(requestPendingSend(p, started)).toBe(p);
		expect(
			requestPendingSend(null, run(started, { type: "new_chat_result", reqId: "r1", ok: true, current: fresh })),
		).toBe(null);
	});

	it("waits while starting, and while bound but the composer can't send yet", () => {
		const p = { generation: 2 };
		expect(pendingSendFate(p, started, true)).toBe("wait");
		const bound = run(started, { type: "new_chat_result", reqId: "r1", ok: true, current: fresh });
		expect(pendingSendFate(p, bound, false)).toBe("wait");
		expect(pendingSendFate(p, bound, true)).toBe("release");
		expect(pendingSendFate(null, bound, true)).toBe("none");
	});

	it("is cancelled by a failure, a navigation or another attempt, never released for it", () => {
		const p = { generation: 2 };
		expect(
			pendingSendFate(p, run(started, { type: "new_chat_result", reqId: "r1", ok: false, current: old }), true),
		).toBe("cancel");
		expect(pendingSendFate(p, run(started, { type: "navigate" }), true)).toBe("cancel");
		const other = run(
			started,
			{ type: "new_chat", reqId: "r2" },
			{ type: "new_chat_result", reqId: "r2", ok: true, current: fresh },
		);
		expect(other.phase).toBe("bound");
		expect(pendingSendFate(p, other, true)).toBe("cancel");
	});
});
