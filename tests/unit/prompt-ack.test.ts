/**
 * optimistic-send: the server's receipts for sends (server/prompt-ack.ts).
 *
 * The window shows a sent message at once and waits for exactly one `prompt_ack`. What must hold:
 *  - one answer per send, whatever path prompt() leaves by (the first answer wins);
 *  - the same id sent again (Retry after a reconnect) never adds the message twice;
 *  - a window that reconnects can ask what became of a send (`prompt_status`);
 *  - messages sent while the add-ons' "before the AI starts" step runs keep their order.
 */

import { AgentSession } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	NOT_RECEIVED_REASON,
	type PromptAckMsg,
	promptCatchingDeferred,
	PromptIdLedger,
	PromptReceipt,
	takePromptAdmission,
} from "../../server/prompt-ack.js";

function inbox(): { got: PromptAckMsg[]; deliver: (m: PromptAckMsg) => void } {
	const got: PromptAckMsg[] = [];
	return { got, deliver: (m) => got.push(m) };
}

/** Lets pending promise callbacks run. */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("PromptReceipt", () => {
	it("answers once: the first answer wins", () => {
		const box = inbox();
		const r = new PromptReceipt("p1", "c1", box.deliver);
		expect(r.answered).toBe(false);
		r.ok();
		r.fail("too late");
		r.ok();
		expect(r.answered).toBe(true);
		expect(box.got).toEqual([{ type: "prompt_ack", id: "p1", conversationId: "c1", ok: true }]);
	});

	it("a refusal carries its reason", () => {
		const box = inbox();
		new PromptReceipt("p1", "c1", box.deliver).fail("Stopped before it was sent.");
		expect(box.got).toEqual([
			{ type: "prompt_ack", id: "p1", conversationId: "c1", ok: false, reason: "Stopped before it was sent." },
		]);
	});

	it("a send without an id (plugins, old pages) is never acknowledged", () => {
		const deliver = vi.fn();
		const r = new PromptReceipt(undefined, "c1", deliver);
		r.fail("x");
		expect(r.answered).toBe(true);
		expect(deliver).not.toHaveBeenCalled();
		const none = PromptReceipt.none();
		none.ok();
		expect(none.answered).toBe(true);
	});

	it("a window that went away can't break the answer", () => {
		const onAnswer = vi.fn();
		const r = new PromptReceipt(
			"p1",
			"c1",
			() => {
				throw new Error("socket closed");
			},
			onAnswer,
		);
		expect(() => r.ok()).not.toThrow();
		expect(onAnswer).toHaveBeenCalledWith(expect.objectContaining({ id: "p1", ok: true }));
	});
});

describe("PromptIdLedger", () => {
	it("runs a send without an id every time", () => {
		const ledger = new PromptIdLedger();
		const a = ledger.begin(undefined, "c1", vi.fn());
		const b = ledger.begin(undefined, "c1", vi.fn());
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		expect(a?.id).toBeUndefined();
		expect(ledger.size).toBe(0);
	});

	it("an id still being handled doesn't run again; the second sender gets the same answer", () => {
		const ledger = new PromptIdLedger();
		const first = inbox();
		const again = inbox();
		const r = ledger.begin("p1", "c1", first.deliver);
		expect(ledger.stateOf("p1")).toBe("pending");
		expect(ledger.begin("p1", "c1", again.deliver)).toBeNull();
		r?.ok();
		expect(first.got).toEqual([{ type: "prompt_ack", id: "p1", conversationId: "c1", ok: true }]);
		expect(again.got).toEqual(first.got);
		expect(ledger.stateOf("p1")).toBe("ok");
	});

	it("an id already in the chat is acknowledged again at once and doesn't run", () => {
		const ledger = new PromptIdLedger();
		ledger.begin("p1", "c1", vi.fn())?.ok();
		const again = inbox();
		expect(ledger.begin("p1", "c9", again.deliver)).toBeNull();
		expect(again.got).toEqual([{ type: "prompt_ack", id: "p1", conversationId: "c1", ok: true }]);
	});

	it("a refused id is forgotten, so Retry with the same id runs again", () => {
		const ledger = new PromptIdLedger();
		const box = inbox();
		ledger.begin("p1", "c1", box.deliver)?.fail("The server is about to restart.");
		expect(ledger.stateOf("p1")).toBeUndefined();
		const retry = ledger.begin("p1", "c1", box.deliver);
		expect(retry).not.toBeNull();
		retry?.ok();
		expect(box.got.map((m) => m.ok)).toEqual([false, true]);
	});

	it("answers prompt_status: in the chat, still on its way, or never arrived", () => {
		const ledger = new PromptIdLedger();
		ledger.begin("done", "c1", vi.fn())?.ok();
		const running = ledger.begin("running", "c2", vi.fn());
		const box = inbox();
		ledger.status("done", box.deliver);
		ledger.status("running", box.deliver);
		ledger.status("lost", box.deliver);
		expect(box.got).toEqual([
			{ type: "prompt_ack", id: "done", conversationId: "c1", ok: true },
			{ type: "prompt_ack", id: "lost", conversationId: "", ok: false, reason: NOT_RECEIVED_REASON },
		]);
		running?.fail("Stopped before it was sent.");
		expect(box.got[2]).toEqual({
			type: "prompt_ack",
			id: "running",
			conversationId: "c2",
			ok: false,
			reason: "Stopped before it was sent.",
		});
	});

	it("stays small: the oldest answered ids go first", () => {
		const ledger = new PromptIdLedger(3);
		ledger.begin("a", "c1", vi.fn())?.ok();
		ledger.begin("b", "c1", vi.fn());
		ledger.begin("c", "c1", vi.fn())?.ok();
		ledger.begin("d", "c1", vi.fn());
		expect(ledger.size).toBe(3);
		expect(ledger.stateOf("a")).toBeUndefined();
		expect(ledger.stateOf("b")).toBe("pending");
		// Only ids still on their way left: the oldest of them goes.
		const all = new PromptIdLedger(2);
		all.begin("x", "c1", vi.fn());
		all.begin("y", "c1", vi.fn());
		all.begin("z", "c1", vi.fn());
		expect(all.stateOf("x")).toBeUndefined();
		expect(all.stateOf("z")).toBe("pending");
	});

	it("a sender that went away can't break an immediate answer", () => {
		const ledger = new PromptIdLedger();
		ledger.begin("p1", "c1", vi.fn())?.ok();
		const gone = () => {
			throw new Error("socket closed");
		};
		expect(() => ledger.begin("p1", "c1", gone)).not.toThrow();
		expect(() => ledger.status("p1", gone)).not.toThrow();
		expect(() => ledger.status("unknown", gone)).not.toThrow();
	});
});

describe("takePromptAdmission", () => {
	it("lets messages go in the order they came, each once the one before it is in", async () => {
		const chat: { promptAdmission?: Promise<void> } = {};
		const first = takePromptAdmission(chat);
		const second = takePromptAdmission(chat);
		const third = takePromptAdmission(chat);
		const order: string[] = [];
		void first.ready.then(() => order.push("first"));
		void second.ready.then(() => order.push("second"));
		void third.ready.then(() => order.push("third"));
		await settle();
		expect(order).toEqual(["first"]);
		first.release();
		first.release();
		await settle();
		expect(order).toEqual(["first", "second"]);
		second.release();
		await settle();
		expect(order).toEqual(["first", "second", "third"]);
	});

	it("counts a message as on its way until its place is given back (once)", () => {
		const chat: { promptAdmission?: Promise<void>; sendsInFlight?: number } = {};
		const first = takePromptAdmission(chat);
		const second = takePromptAdmission(chat);
		expect(chat.sendsInFlight).toBe(2);
		second.release();
		second.release();
		expect(chat.sendsInFlight).toBe(1);
		first.release();
		expect(chat.sendsInFlight).toBe(0);
	});

	it("doesn't hold the chat up for good when a place is never given back", async () => {
		const chat: { promptAdmission?: Promise<void> } = {};
		takePromptAdmission(chat, 20);
		const next = takePromptAdmission(chat, 20);
		let through = false;
		void next.ready.then(() => {
			through = true;
		});
		await settle();
		expect(through).toBe(false);
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(through).toBe(true);
	});
});

describe("promptCatchingDeferred", () => {
	type PutOff = () => Promise<void>;

	it("answers a text the real pi put off and then refused", async () => {
		// pi's own prompt() on a stand-in for a session that is telling the add-ons the last run has
		// settled: it puts the text off. If pi stops doing it this way, this test fails.
		const session = {
			prompt: AgentSession.prototype.prompt,
			_isEmittingAgentSettled: true,
			_deferredSettledActions: [] as PutOff[],
			_compactionAbortController: undefined as AbortController | undefined,
		};
		const preflightResult = vi.fn();
		const refused: unknown[] = [];
		const prompt = AgentSession.prototype.prompt as (this: unknown, ...args: unknown[]) => Promise<void>;
		await promptCatchingDeferred(
			session,
			() => prompt.call(session, "hello", { preflightResult }),
			(err) => refused.push(err),
		);
		expect(session._deferredSettledActions).toHaveLength(1);
		expect(preflightResult).not.toHaveBeenCalled();

		// Settled; pi runs the put-off text while a compaction runs, so it refuses it.
		session._isEmittingAgentSettled = false;
		session._compactionAbortController = new AbortController();
		await expect(session._deferredSettledActions[0]!()).resolves.toBeUndefined();
		expect(preflightResult).not.toHaveBeenCalled();
		expect(refused).toHaveLength(1);
		expect((refused[0] as Error).message).toMatch(/compaction is in progress/);
	});

	it("lets pi go on with its next put-off call after a refusal", async () => {
		const session = { _deferredSettledActions: [] as PutOff[] };
		const ran: string[] = [];
		const refused: unknown[] = [];
		await promptCatchingDeferred(
			session,
			async () => {
				session._deferredSettledActions.push(async () => {
					ran.push("mine");
					throw new Error("No API key found");
				});
			},
			(err) => refused.push(err),
		);
		session._deferredSettledActions.push(async () => {
			ran.push("next");
		});
		// What pi's _emitAgentSettled does with its list: one after the other, a throw ends the loop.
		for (const putOff of session._deferredSettledActions.splice(0)) await putOff();
		expect(ran).toEqual(["mine", "next"]);
		expect((refused[0] as Error).message).toBe("No API key found");
	});

	it("leaves pi's list alone when the text wasn't put off", async () => {
		const other: PutOff = async () => {};
		const session = { _deferredSettledActions: [other] };
		const onError = vi.fn();
		await expect(promptCatchingDeferred(session, async () => {}, onError)).resolves.toBeUndefined();
		await expect(
			promptCatchingDeferred(session, async () => Promise.reject(new Error("refused at once")), onError),
		).rejects.toThrow("refused at once");
		expect(session._deferredSettledActions).toEqual([other]);
		expect(onError).not.toHaveBeenCalled();
	});

	it("still sends when pi has no such list (and says so once)", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const send = vi.fn(async () => {});
			await promptCatchingDeferred({}, send, () => {});
			await promptCatchingDeferred({}, send, () => {});
			expect(send).toHaveBeenCalledTimes(2);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});
});
