/**
 * owner-question-routing (Ops #686, H-OWNER-COO-CARD): COO's desk. A held question gets a card in
 * COO's home chat (several waiting at delivery time share one; a gone one never gets one); nothing is
 * delivered with the switch off; and when the COO turn that got a card settles, every question in it
 * still held with no action from COO goes to the owner at once. The desk never answers an ask.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dialogAsk, stuckAsk } from "../../server/asks.js";
import { CARD_BATCH_MS, CARD_RETRY_MS } from "../../server/owner-question-coo.js";
import { HOLD_SAFETY_NET_MS, holdKeyOfAsk } from "../../server/owner-question-holds.js";
import { deskFixture, MIN, portQuestion as q, T0 } from "./owner-question-desk-fixture.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "oq-coo-"));
	vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
	vi.useRealTimers();
	rmSync(dir, { recursive: true, force: true });
});

const setup = () => deskFixture(dir);

describe("delivery: a card in COO's home chat", () => {
	it("one held question: one card after the batch window, with its tag; marked delivered", async () => {
		const { s, holds, hold } = setup();
		const tag = hold(q("q-1"));
		await vi.advanceTimersByTimeAsync(CARD_BATCH_MS - 1);
		expect(s.sent).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(s.sent).toHaveLength(1);
		expect(s.sent[0]!.text.split("\n")[0]).toBe(`[Owner question] from Design's home chat [${tag}]`);
		expect(s.sent[0]!.sendId).toMatch(/^oqc-/);
		expect(holds.get(holdKeyOfAsk("q-1"))?.deliveredToCoo?.at).toBe(T0);
	});

	it("several held before it goes share one card", async () => {
		const { s, hold } = setup();
		const a = hold(q("q-1"));
		await vi.advanceTimersByTimeAsync(500);
		const b = hold(stuckAsk("st-2", { taskId: 12, taskTitle: "Fonts", question: "Buy it?" }, {}, T0), "queued-work");
		await vi.advanceTimersByTimeAsync(CARD_BATCH_MS);
		expect(s.sent).toHaveLength(1);
		expect(s.sent[0]!.text.split("\n")[0]).toContain(`2 questions`);
		expect(s.sent[0]!.text.split("\n")[0]).toContain(`[${a}, ${b}]`);
	});

	it("one held while a card is on its way gets the next card; none goes twice", async () => {
		const { s, hold } = setup();
		let open!: () => void;
		s.gate = new Promise((r) => {
			open = r;
		});
		const a = hold(q("q-1"));
		await vi.advanceTimersByTimeAsync(CARD_BATCH_MS);
		const b = hold(q("q-2"));
		s.gate = undefined;
		open();
		await vi.advanceTimersByTimeAsync(CARD_BATCH_MS);
		expect(s.sent).toHaveLength(2);
		expect(s.sent[0]!.text.split("\n")[0]).toContain(`[${a}]`);
		expect(s.sent[1]!.text.split("\n")[0]).toContain(`[${b}]`);
		await vi.advanceTimersByTimeAsync(10 * CARD_BATCH_MS);
		expect(s.sent).toHaveLength(2);
	});

	it("a question answered or gone before its card goes never gets one", async () => {
		const { s, hub, hold } = setup();
		hold(q("q-1"));
		hold(q("q-2"));
		hub.settle("q-1", { how: "answered", summary: "8080", from: "browser" });
		hub.settle("q-2", { how: "gone", reason: "the chat closed" });
		await vi.advanceTimersByTimeAsync(5 * CARD_BATCH_MS);
		expect(s.sent).toHaveLength(0);
	});

	it("one already delivered before a restart gets no second card", async () => {
		const { s, hub, holds, keys } = setup();
		const ask = stuckAsk("st-9", { taskId: 9, taskTitle: "T", question: "Go?" }, {}, T0);
		const key = holdKeyOfAsk(ask.id);
		holds.admit(key, "stuck", "queued-work");
		holds.delivered(key);
		keys.set(ask.id, key);
		hub.add(ask, () => ({ ok: true }), { to: "coo", reason: "queued-work" });
		await vi.advanceTimersByTimeAsync(5 * CARD_BATCH_MS);
		expect(s.sent).toHaveLength(0);
	});

	it("with the switch off nothing is delivered", async () => {
		const { s, hold, desk } = setup();
		s.on = false;
		hold(q("q-1"));
		await vi.advanceTimersByTimeAsync(10 * CARD_BATCH_MS);
		await desk.flush();
		expect(s.sent).toHaveLength(0);
	});

	it("switched off while a card waits for its batch: nothing goes", async () => {
		const { s, hold } = setup();
		hold(q("q-1"));
		s.on = false;
		await vi.advanceTimersByTimeAsync(10 * CARD_BATCH_MS);
		expect(s.sent).toHaveLength(0);
	});

	it("a card that couldn't go for now is tried again later", async () => {
		const { s, hold, holds } = setup();
		s.delivery = { ok: false, error: "busy" };
		hold(q("q-1"));
		await vi.advanceTimersByTimeAsync(CARD_BATCH_MS);
		expect(s.sent).toHaveLength(0);
		expect(holds.get(holdKeyOfAsk("q-1"))?.deliveredToCoo).toBeUndefined();
		s.delivery = { ok: true };
		await vi.advanceTimersByTimeAsync(CARD_RETRY_MS);
		expect(s.sent).toHaveLength(1);
		expect(holds.get(holdKeyOfAsk("q-1"))?.deliveredToCoo).toBeDefined();
	});

	it("a card that can never reach COO lets its questions through to the owner at once", async () => {
		const { s, hub, hold } = setup();
		s.delivery = { ok: false, error: "the coo role has no home chat", final: true };
		hold(q("q-1"));
		await vi.advanceTimersByTimeAsync(CARD_BATCH_MS);
		expect(hub.heldList()).toHaveLength(0);
		expect(hub.list().map((a) => a.id)).toEqual(["q-1"]);
		expect(s.events).toContainEqual(expect.objectContaining({ type: "released", by: "safety-net" }));
	});
});

describe("the safety net on COO's side: the turn that got the card ends", () => {
	async function delivered(n = 1) {
		const t = setup();
		const tags = Array.from({ length: n }, (_, i) => t.hold(q(`q-${i + 1}`)));
		await vi.advanceTimersByTimeAsync(CARD_BATCH_MS);
		return { ...t, tags, sendId: t.s.sent[0]!.sendId };
	}

	it("no action: it goes to the owner at once, by the safety net", async () => {
		const { s, hub, holds, desk, sendId } = await delivered();
		s.now = T0 + 3 * MIN;
		expect(desk.turnSettled(["rs-other", sendId])).toEqual(["q-1"]);
		expect(hub.heldList()).toHaveLength(0);
		expect(hub.list().map((a) => a.id)).toEqual(["q-1"]);
		const rec = holds.get(holdKeyOfAsk("q-1"))!;
		expect(rec.state).toBe("released");
		expect(rec.releasedBy).toBe("safety-net");
		expect(rec.deliveredToCoo?.turnEndedAt).toBe(T0 + 3 * MIN);
	});

	it("held by COO in that turn: it stays held", async () => {
		const { s, hub, desk, tags, sendId } = await delivered();
		expect(desk.hold(tags[0]!, T0 + 60 * MIN, "asking Design")).toEqual({ ok: true, until: T0 + 60 * MIN });
		s.now = T0 + 2 * MIN;
		expect(desk.turnSettled([sendId])).toEqual([]);
		expect(hub.heldList().map((a) => a.id)).toEqual(["q-1"]);
	});

	it("released or returned by COO in that turn: nothing more happens", async () => {
		const { s, desk, tags, sendId } = await delivered(2);
		expect(desk.release(tags[0]!, "Design needs a port picked.").ok).toBe(true);
		expect(desk.returnToAsker(tags[1]!, "Pick the usual port yourself.").ok).toBe(true);
		const before = s.events.length;
		expect(desk.turnSettled([sendId])).toEqual([]);
		expect(s.events.length).toBe(before);
	});

	it("two in one card, one held by COO: only the other goes", async () => {
		const { hub, desk, tags, sendId } = await delivered(2);
		desk.hold(tags[0]!, T0 + 30 * MIN, "waiting on Design");
		expect(desk.turnSettled([sendId])).toEqual(["q-2"]);
		expect(hub.heldList().map((a) => a.id)).toEqual(["q-1"]);
	});

	it("a turn without a card changes nothing; a card's turn counts once", async () => {
		const { hub, desk, sendId } = await delivered();
		expect(desk.turnSettled(["rs-1", "rs-2"])).toEqual([]);
		expect(hub.heldList()).toHaveLength(1);
		expect(desk.turnSettled([sendId])).toEqual(["q-1"]);
		expect(desk.turnSettled([sendId])).toEqual([]);
	});

	it("the desk never answers an ask", async () => {
		const { s, desk, tags, sendId } = await delivered(2);
		desk.release(tags[0]!, "Plain note.");
		desk.turnSettled([sendId]);
		expect(s.answered).not.toHaveBeenCalled();
		expect(s.events.some((e) => e.type === "answered")).toBe(false);
	});
});

describe("where a question stands", () => {
	it("held, with the owner, answered, handed back, gone, or unknown", async () => {
		const { hub, desk, hold } = setup();
		const a = hold(q("q-1"));
		const b = hold(q("q-2"));
		const c = hold(q("q-3"));
		const d = hold(dialogAsk("d-4", { id: 4, kind: "confirm", title: "Run it?", args: [] }, {}, T0));
		expect(desk.where(a).at).toBe("held");
		desk.release(a, "Plain note.");
		expect(desk.where(a)).toMatchObject({ at: "owner", by: "coo" });
		desk.where(b);
		hub.settle("q-2", { how: "answered", summary: "8080", from: "browser" });
		expect(desk.where(b).at).toBe("answered");
		desk.returnToAsker(c, "Your call.");
		expect(desk.where(c).at).toBe("returned");
		desk.where(d);
		hub.settle("d-4", { how: "gone", reason: "closed" });
		expect(desk.where(d).at).toBe("gone");
		expect(desk.where("oq-00000000").at).toBe("unknown");
	});

	it("only a question goes back; the desk refuses the rest", () => {
		const { desk, hub, hold } = setup();
		const st = hold(stuckAsk("st-1", { taskId: 1, taskTitle: "T", question: "Go?" }, {}, T0), "queued-work");
		expect(desk.returnToAsker(st, "Yours.")).toMatchObject({ ok: false });
		expect(hub.heldList()).toHaveLength(1);
	});

	it("list: every held question with its tag and when it goes", () => {
		const { desk, hold } = setup();
		const a = hold(q("q-1"));
		desk.hold(a, T0 + 90 * MIN, "asking Design");
		const b = hold(q("q-2"));
		const l = desk.list();
		expect(l.map((h) => h.handle)).toEqual([a, b]);
		expect(l[0]).toMatchObject({ holdUntil: T0 + 90 * MIN, holdWhy: "asking Design", goesAt: T0 + 90 * MIN });
		expect(l[1]).toMatchObject({ goesAt: T0 + HOLD_SAFETY_NET_MS });
		expect(l[1]!.cardAt).toBeUndefined();
	});
});
