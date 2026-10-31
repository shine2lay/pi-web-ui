/**
 * owner-question-routing (Ops #684): AskHub's held state. An ask added with no route (every caller
 * today) or a direct route behaves exactly as before; one routed to COO is kept but neither listed
 * nor announced until COO or the safety net lets it through, or COO hands a question back.
 */
import { describe, expect, it } from "vitest";
import {
	AskHub,
	NOT_HELD,
	NOT_WAITING,
	approvalAsk,
	dialogAsk,
	questionAsk,
	stuckAsk,
	type Ask,
	type AskEvent,
} from "../../server/asks.js";

const meta = { conversationId: "c1", conversationTitle: "My chat", cwd: "/p", sessionFile: "/s/a.jsonl" };
const MIN = 60_000;

const question = (id: string): Ask =>
	questionAsk(id, [{ id: "q1", question: "Pick one", options: [{ label: "A" }, { label: "B" }] }], meta, 1);
const dialog = (id: string): Ask =>
	dialogAsk(id, { id: 1, kind: "confirm", title: "Approve the plan?", args: [] }, meta, 1);
const stuck = (id: string): Ask =>
	stuckAsk(id, { taskId: 7, taskTitle: "Fix it", question: "Which way?", choices: ["Left", "Right"] }, meta, 1);
const approval = (id: string): Ask => approvalAsk(id, { toolName: "bash", params: { command: "ls" } }, meta, 1);

function hubWithClock(start = 1_000_000) {
	const clock = { now: start };
	const hub = new AskHub(() => clock.now);
	const events: AskEvent[] = [];
	hub.on((e) => events.push(e));
	return { hub, clock, events };
}

describe("AskHub with no route: exactly as before", () => {
	it("gives the same events, list and objects whether the route is left out or undefined", () => {
		const { hub, events } = hubWithClock();
		const a1 = question("a1");
		const a2 = dialog("a2");
		const answered: string[] = [];
		expect(hub.add(a1, (answers, from) => (answered.push(`${answers[0]?.selected[0]} ${from}`), { ok: true }))).toBe(
			true,
		);
		expect(hub.add(a2, () => ({ ok: true }), undefined)).toBe(true);
		expect(hub.add(question("a1"), () => ({ ok: true }))).toBe(false);
		// The very objects the caller added, untouched.
		expect(hub.get("a1")).toBe(a1);
		expect(hub.list()).toEqual([a1, a2]);
		expect(hub.list()[0]).toBe(a1);
		expect(hub.heldList()).toEqual([]);
		expect("route" in a1).toBe(false);
		hub.settle("a1", { how: "answered", summary: "A", from: "browser" });
		hub.settle("a2", { how: "gone", reason: "closed" });
		expect(JSON.stringify(events)).toBe(
			JSON.stringify([
				{ type: "appeared", ask: a1 },
				{ type: "appeared", ask: a2 },
				{ type: "answered", ask: a1, summary: "A", from: "browser" },
				{ type: "gone", ask: a2, reason: "closed" },
			]),
		);
		expect(hub.list()).toEqual([]);
		expect(answered).toEqual([]);
	});

	it("answer() works as before", async () => {
		const { hub } = hubWithClock();
		const got: string[] = [];
		hub.add(question("a1"), (answers, from) => {
			got.push(`${answers[0]?.selected[0]} ${from}`);
			return { ok: true };
		});
		expect(await hub.answer("a1", [{ id: "q1", selected: ["B"] }], "telegram")).toEqual({ ok: true });
		expect(got).toEqual(["B telegram"]);
		expect(await hub.answer("nope", [{ id: "q1", selected: ["B"] }], "telegram")).toEqual({
			ok: false,
			error: NOT_WAITING,
		});
	});
});

describe("AskHub with a direct route", () => {
	it("appears and is listed as before, carrying its route and line", () => {
		const { hub, events } = hubWithClock();
		const a = question("a1");
		expect(
			hub.add(a, () => ({ ok: true }), { to: "direct", reason: "owner-chatting", label: "You were chatting here" }),
		).toBe(true);
		const shown = hub.get("a1")!;
		expect(shown.route).toEqual({ to: "direct", reason: "owner-chatting", label: "You were chatting here" });
		expect(events).toEqual([{ type: "appeared", ask: shown }]);
		expect(hub.list()).toEqual([shown]);
		expect(hub.heldList()).toEqual([]);
		expect("route" in a).toBe(false);
		expect(hub.release("a1", "coo")).toEqual({ ok: false, error: NOT_HELD });
		expect(hub.returnToAsker("a1", "not now")).toEqual({ ok: false, error: NOT_HELD });
	});

	it("a direct route without a line has no label", () => {
		const { hub } = hubWithClock();
		hub.add(dialog("d1"), () => ({ ok: true }), { to: "direct", reason: "grant-not-routed" });
		expect(hub.get("d1")!.route).toEqual({ to: "direct", reason: "grant-not-routed" });
	});
});

describe("AskHub with a COO route: held", () => {
	it("keeps it but neither lists it nor announces it", () => {
		const { hub, clock, events } = hubWithClock();
		const a = question("q1");
		expect(hub.add(a, () => ({ ok: true }), { to: "coo", reason: "not-started-by-owner" })).toBe(true);
		const held = hub.get("q1")!;
		expect(held.route).toEqual({ to: "coo", reason: "not-started-by-owner", heldAt: clock.now });
		expect(events).toEqual([{ type: "held", ask: held }]);
		expect(events.some((e) => e.type === "appeared")).toBe(false);
		expect(hub.list()).toEqual([]);
		expect(hub.heldList()).toEqual([held]);
		expect(hub.add(question("q1"), () => ({ ok: true }))).toBe(false);
	});

	it("holds every reason the rule sends to COO, owner-away included", () => {
		const { hub, clock } = hubWithClock();
		hub.add(stuck("s"), () => ({ ok: true }), { to: "coo", reason: "queued-work" });
		hub.add(approval("p"), () => ({ ok: true }), { to: "coo", reason: "owner-away" });
		hub.add(question("q"), () => ({ ok: true }), { to: "coo", reason: "not-started-by-owner" });
		expect(hub.list()).toEqual([]);
		expect(hub.heldList().map((x) => [x.id, x.route])).toEqual([
			["s", { to: "coo", reason: "queued-work", heldAt: clock.now }],
			["p", { to: "coo", reason: "owner-away", heldAt: clock.now }],
			["q", { to: "coo", reason: "not-started-by-owner", heldAt: clock.now }],
		]);
	});

	it("lists the others as before while one is held, oldest first", () => {
		const { hub } = hubWithClock();
		hub.add(question("a"), () => ({ ok: true }));
		hub.add(stuck("s"), () => ({ ok: true }), { to: "coo", reason: "queued-work" });
		hub.add(dialog("b"), () => ({ ok: true }));
		hub.add(question("c"), () => ({ ok: true }), { to: "coo", reason: "not-started-by-owner" });
		expect(hub.list().map((x) => x.id)).toEqual(["a", "b"]);
		expect(hub.heldList().map((x) => x.id)).toEqual(["s", "c"]);
		// Let through, it takes its first place in the list again.
		hub.release("s", "safety-net");
		expect(hub.list().map((x) => x.id)).toEqual(["a", "s", "b"]);
		expect(hub.heldList().map((x) => x.id)).toEqual(["c"]);
	});

	it("can still be answered on the asking chat's own page while held", async () => {
		const { hub, events } = hubWithClock();
		const got: string[] = [];
		hub.add(
			stuck("s1"),
			(answers, from) => {
				got.push(`${answers[0]?.selected[0]} ${from}`);
				return { ok: true };
			},
			{ to: "coo", reason: "queued-work" },
		);
		expect(await hub.answer("s1", [{ id: "answer", selected: ["Left"] }], "browser")).toEqual({ ok: true });
		expect(got).toEqual(["Left browser"]);
		// The owner of the ask settles it, as for every ask.
		hub.settle("s1", { how: "answered", summary: "Left", from: "browser" });
		expect(events.map((e) => e.type)).toEqual(["held", "answered"]);
		expect(hub.heldList()).toEqual([]);
		expect(hub.get("s1")).toBeUndefined();
	});

	it("a held ask that ends (cancelled, chat closed) is gone", () => {
		const { hub, events } = hubWithClock();
		hub.add(dialog("d1"), () => ({ ok: true }), { to: "coo", reason: "not-started-by-owner" });
		hub.settle("d1", { how: "gone", reason: "the chat closed" });
		expect(events.map((e) => e.type)).toEqual(["held", "gone"]);
		expect(hub.heldList()).toEqual([]);
	});
});

describe("AskHub.release", () => {
	it("lets a held ask through with COO's note and recommendation, then announces it", () => {
		const { hub, clock, events } = hubWithClock();
		hub.add(question("q1"), () => ({ ok: true }), { to: "coo", reason: "not-started-by-owner" });
		const heldAt = clock.now;
		clock.now += 7 * MIN;
		expect(hub.release("q1", "coo", "  Temper needs this to pick the test box.  ", "Pick A")).toEqual({ ok: true });
		const shown = hub.get("q1")!;
		expect(shown.route).toEqual({
			to: "coo",
			reason: "not-started-by-owner",
			heldAt,
			releasedBy: "coo",
			releasedAt: heldAt + 7 * MIN,
			label: "Came through COO",
			note: "Temper needs this to pick the test box.",
			recommendation: "Pick A",
		});
		expect(events.map((e) => e.type)).toEqual(["held", "released", "appeared"]);
		expect(events[1]).toEqual({ type: "released", ask: shown, by: "coo" });
		expect(events[2]).toEqual({ type: "appeared", ask: shown });
		expect(hub.list()).toEqual([shown]);
		expect(hub.heldList()).toEqual([]);
		expect(hub.release("q1", "coo")).toEqual({ ok: false, error: NOT_HELD });
		expect(hub.release("nope", "coo")).toEqual({ ok: false, error: NOT_WAITING });
	});

	it("the safety net lets it through saying COO added nothing and how long it took", () => {
		const { hub, clock } = hubWithClock();
		hub.add(stuck("s1"), () => ({ ok: true }), { to: "coo", reason: "queued-work" });
		clock.now += 30 * MIN;
		expect(hub.release("s1", "safety-net")).toEqual({ ok: true });
		expect(hub.get("s1")!.route).toMatchObject({
			releasedBy: "safety-net",
			label: "Came through COO; COO added nothing (it reached you after 30 minutes)",
		});
		expect(hub.get("s1")!.route).not.toHaveProperty("note");
	});

	it("a blank note counts as no note", () => {
		const { hub, clock } = hubWithClock();
		hub.add(question("q1"), () => ({ ok: true }), { to: "coo", reason: "not-started-by-owner" });
		clock.now += 2 * MIN;
		hub.release("q1", "coo", "   ", "  ");
		expect(hub.get("q1")!.route).toEqual({
			to: "coo",
			reason: "not-started-by-owner",
			heldAt: clock.now - 2 * MIN,
			releasedBy: "coo",
			releasedAt: clock.now,
			label: "Came through COO; COO added nothing (it reached you after 2 minutes)",
		});
	});

	it("after a restart, an ask released earlier appears at once with its line, never held again", () => {
		const { hub, clock, events } = hubWithClock();
		const heldAt = clock.now - 45 * MIN;
		hub.add(stuck("s1"), () => ({ ok: true }), {
			to: "coo",
			reason: "queued-work",
			heldAt,
			releasedBy: "safety-net",
			releasedAt: heldAt + 31 * MIN,
		});
		const shown = hub.get("s1")!;
		expect(shown.route).toEqual({
			to: "coo",
			reason: "queued-work",
			heldAt,
			releasedBy: "safety-net",
			releasedAt: heldAt + 31 * MIN,
			label: "Came through COO; COO added nothing (it reached you after 31 minutes)",
		});
		expect(events).toEqual([{ type: "appeared", ask: shown }]);
		expect(hub.list()).toEqual([shown]);
		expect(hub.heldList()).toEqual([]);
	});

	it("after a restart, a held one keeps the time it was first held", () => {
		const { hub, clock } = hubWithClock();
		const heldAt = clock.now - 10 * MIN;
		hub.add(stuck("s1"), () => ({ ok: true }), { to: "coo", reason: "queued-work", heldAt });
		clock.now += 5 * MIN;
		hub.release("s1", "safety-net");
		expect(hub.get("s1")!.route?.label).toBe("Came through COO; COO added nothing (it reached you after 15 minutes)");
	});
});

describe("AskHub.returnToAsker", () => {
	it("hands a held question back to the chat that asked it, with COO's note", () => {
		const { hub, events } = hubWithClock();
		hub.add(question("q1"), () => ({ ok: true }), { to: "coo", reason: "not-started-by-owner" });
		const held = hub.get("q1")!;
		expect(hub.returnToAsker("q1", "  The answer is in Temper #243's plan.  ")).toEqual({ ok: true });
		expect(events).toEqual([
			{ type: "held", ask: held },
			{ type: "returned", ask: held, note: "The answer is in Temper #243's plan." },
		]);
		expect(hub.get("q1")).toBeUndefined();
		expect(hub.list()).toEqual([]);
		expect(hub.heldList()).toEqual([]);
		// The asker's later settle is a no-op, as for any ask that isn't waiting.
		hub.settle("q1", { how: "gone", reason: "returned" });
		expect(events).toHaveLength(2);
	});

	it("works for questions only, held only, and needs a note", () => {
		const { hub, events } = hubWithClock();
		hub.add(dialog("d1"), () => ({ ok: true }), { to: "coo", reason: "not-started-by-owner" });
		hub.add(stuck("s1"), () => ({ ok: true }), { to: "coo", reason: "queued-work" });
		hub.add(question("q1"), () => ({ ok: true }), { to: "coo", reason: "not-started-by-owner" });
		hub.add(question("q2"), () => ({ ok: true }));
		const onlyQuestions = "only a question can go back to the chat that asked it";
		expect(hub.returnToAsker("d1", "no")).toEqual({ ok: false, error: onlyQuestions });
		expect(hub.returnToAsker("s1", "no")).toEqual({ ok: false, error: onlyQuestions });
		expect(hub.returnToAsker("q2", "no")).toEqual({ ok: false, error: NOT_HELD });
		expect(hub.returnToAsker("nope", "no")).toEqual({ ok: false, error: NOT_WAITING });
		expect(hub.returnToAsker("q1", "   ")).toEqual({ ok: false, error: "say what the chat should do instead" });
		expect(hub.heldList().map((a) => a.id)).toEqual(["d1", "s1", "q1"]);
		expect(events.filter((e) => e.type === "returned")).toEqual([]);
	});
});
