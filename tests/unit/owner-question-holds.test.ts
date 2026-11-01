/**
 * owner-question-routing (Ops #684, H-OWNER-HOLD-STORE): the durable hold store and its safety-net
 * clock. Only temporary folders; never the app's real data folder.
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	COO_HOLD_MAX_MS,
	dueReleases,
	HOLD_FINISHED_KEEP_MS,
	HOLD_SAFETY_NET_MS,
	HOLD_TEXT_MAX,
	holdDue,
	holdKeyOfAsk,
	holdKeyOfStuck,
	HOLDS_READ_MAX,
	OWNER_QUESTION_HOLDS_FILE,
	OwnerQuestionHolds,
	type OwnerQuestionHold,
} from "../../server/owner-question-holds.js";
import { stuckKey, stuckSig } from "../../server/stuck-asks.js";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 31, 20, 0, 0);

let dir: string;
let file: string;
let errors: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "owner-question-holds-"));
	file = join(dir, OWNER_QUESTION_HOLDS_FILE);
	errors = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
	errors.mockRestore();
	rmSync(dir, { recursive: true, force: true });
});

const clockAt = (start = T0) => ({ now: start });
const storeOn = (clock: { now: number }, path = file, max?: number) =>
	new OwnerQuestionHolds(path, { now: () => clock.now, ...(max ? { max } : {}) });

const STUCK = holdKeyOfStuck(
	stuckKey("/home/x/.pi/agent/sessions/ops-home.jsonl", 684),
	stuckSig({ question: "Which way?", choices: ["Left", "Right"] }),
);

const held = (over: Partial<OwnerQuestionHold> = {}): OwnerQuestionHold => ({
	key: STUCK,
	kind: "stuck",
	reason: "queued-work",
	createdAt: T0,
	state: "held",
	...over,
});

describe("holdDue: the safety-net clock (pure)", () => {
	it("releases 30 minutes after it was held when COO hasn't acted, not a moment before", () => {
		expect(holdDue(held(), T0 + HOLD_SAFETY_NET_MS - 1)).toBeNull();
		expect(holdDue(held(), T0 + HOLD_SAFETY_NET_MS)).toBe("no-coo-action");
		expect(HOLD_SAFETY_NET_MS).toBe(30 * MIN);
		// Delivered to COO, its turn still going: the 30 minutes still apply.
		const delivered = held({ deliveredToCoo: { at: T0 + MIN } });
		expect(holdDue(delivered, T0 + 10 * MIN)).toBeNull();
		expect(holdDue(delivered, T0 + 30 * MIN)).toBe("no-coo-action");
	});

	it("releases as soon as the COO turn that got the card ends without COO acting", () => {
		const ended = held({ deliveredToCoo: { at: T0 + MIN, turnEndedAt: T0 + 4 * MIN } });
		expect(holdDue(ended, T0 + 4 * MIN)).toBe("coo-turn-ended");
	});

	it("a COO hold keeps it until its time, at most 2 hours ahead", () => {
		const kept = held({ deliveredToCoo: { at: T0 + MIN, turnEndedAt: T0 + 4 * MIN }, holdUntil: T0 + 90 * MIN });
		expect(holdDue(kept, T0 + 4 * MIN)).toBeNull();
		expect(holdDue(kept, T0 + 31 * MIN)).toBeNull();
		expect(holdDue(kept, T0 + 90 * MIN - 1)).toBeNull();
		expect(holdDue(kept, T0 + 90 * MIN)).toBe("hold-ended");
		expect(COO_HOLD_MAX_MS).toBe(2 * 60 * MIN);
		// A hold further ahead than any hold can be (a bad record, the clock set back) lets it through.
		expect(holdDue(held({ holdUntil: T0 + COO_HOLD_MAX_MS + 1 }), T0)).toBe("hold-ended");
	});

	it("a clock set back before the hold lets it through", () => {
		expect(holdDue(held(), T0 - 1)).toBe("clock-moved-back");
	});

	it("a clock that isn't a real time lets it through, even while COO holds it", () => {
		for (const now of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			expect(holdDue(held(), now), String(now)).toBe("clock-unusable");
			expect(holdDue(held({ holdUntil: T0 + 60 * MIN }), now), String(now)).toBe("clock-unusable");
			expect(holdDue(held({ deliveredToCoo: { at: T0 + MIN, turnEndedAt: T0 + 2 * MIN } }), now), String(now)).toBe(
				"clock-unusable",
			);
		}
	});

	it("a store that can't be read or written lets every held one through", () => {
		expect(holdDue(held(), T0, false)).toBe("store-failed");
		expect(holdDue(held({ holdUntil: T0 + 60 * MIN }), T0, false)).toBe("store-failed");
	});

	it("never touches one that isn't held", () => {
		for (const state of ["released", "returned", "gone"] as const) {
			const done = held({ state, finishedAt: T0 + MIN });
			expect(holdDue(done, T0 + 10 * 60 * MIN)).toBeNull();
			expect(holdDue(done, T0 + 10 * 60 * MIN, false)).toBeNull();
		}
	});

	it("dueReleases lists only the due ones, changes nothing and answers the same twice", () => {
		const list = [
			held({ key: "a" }),
			held({ key: "b", createdAt: T0 + 20 * MIN }),
			held({ key: "c", state: "released", releasedBy: "coo", finishedAt: T0 + MIN }),
			held({ key: "d", deliveredToCoo: { at: T0, turnEndedAt: T0 + MIN } }),
			held({ key: "e", holdUntil: T0 + 31 * MIN }),
		].map((h) =>
			Object.freeze({ ...h, ...(h.deliveredToCoo ? { deliveredToCoo: Object.freeze(h.deliveredToCoo) } : {}) }),
		);
		const frozen = Object.freeze(list);
		const first = dueReleases(frozen, T0 + 30 * MIN);
		expect(first).toEqual([
			{ key: "a", why: "no-coo-action" },
			{ key: "d", why: "coo-turn-ended" },
		]);
		expect(dueReleases(frozen, T0 + 30 * MIN)).toEqual(first);
		expect(dueReleases(frozen, T0 + 31 * MIN).map((d) => d.key)).toEqual(["a", "d", "e"]);
	});
});

describe("hold keys", () => {
	it("a stuck card: its ask key plus its signature, hashed (no path or question in the key)", () => {
		expect(STUCK).toMatch(/^stuck:[a-f0-9]{32}$/);
		expect(STUCK).not.toContain("ops-home");
		const otherSig = holdKeyOfStuck(
			stuckKey("/home/x/.pi/agent/sessions/ops-home.jsonl", 684),
			stuckSig({ question: "Which way now?", choices: ["Left", "Right"] }),
		);
		const otherTask = holdKeyOfStuck(
			stuckKey("/home/x/.pi/agent/sessions/ops-home.jsonl", 685),
			stuckSig({ question: "Which way?", choices: ["Left", "Right"] }),
		);
		expect(new Set([STUCK, otherSig, otherTask]).size).toBe(3);
	});

	it("a question, dialog or approval: its ask id", () => {
		expect(holdKeyOfAsk("q-123")).toBe("ask:q-123");
	});
});

describe("OwnerQuestionHolds: durable records", () => {
	it("holds a new ask once, writes the file whole with mode 0600 and no words of the question", () => {
		const clock = clockAt();
		const s = storeOn(clock);
		expect(s.ok).toBe(true);
		expect(existsSync(file)).toBe(false);
		expect(s.admit(STUCK, "stuck", "queued-work")).toEqual({ action: "hold", deliver: true, hold: held() });
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(readdirSync(dir)).toEqual([OWNER_QUESTION_HOLDS_FILE]);
		const text = readFileSync(file, "utf8");
		expect(JSON.parse(text)).toEqual({ v: 1, holds: [held()] });
		expect(text).not.toContain("Which way");
		expect(text).not.toContain("ops-home");
	});

	it("delivers a card to COO once only", () => {
		const clock = clockAt();
		const s = storeOn(clock);
		s.admit(STUCK, "stuck", "queued-work");
		clock.now += MIN;
		expect(s.delivered(STUCK)).toBe(true);
		expect(s.delivered(STUCK)).toBe(false);
		expect(s.get(STUCK)?.deliveredToCoo).toEqual({ at: T0 + MIN });
		expect(s.delivered("stuck:nope")).toBe(false);
	});

	it("rejects invalid delivery ids without recording a delivery", () => {
		const s = storeOn(clockAt());
		s.admit(STUCK, "stuck", "queued-work");
		const text = readFileSync(file, "utf8");
		for (const sendId of ["", "s".repeat(301)]) {
			expect(s.delivered(STUCK, sendId)).toBe(false);
			expect(s.get(STUCK)?.deliveredToCoo).toBeUndefined();
			expect(readFileSync(file, "utf8")).toBe(text);
		}
		expect(s.ok).toBe(true);
	});

	it("the COO turn that got it ends without COO acting: due at once", () => {
		const clock = clockAt();
		const s = storeOn(clock);
		s.admit(STUCK, "stuck", "queued-work");
		expect(s.cooTurnEnded(STUCK)).toBe(false); // never delivered: nothing to end
		s.delivered(STUCK);
		clock.now += 3 * MIN;
		expect(s.due()).toEqual([]);
		expect(s.cooTurnEnded(STUCK)).toBe(true);
		expect(s.due()).toEqual([{ key: STUCK, why: "coo-turn-ended" }]);
	});

	it("a COO hold is capped at 2 hours from now and can be renewed", () => {
		const clock = clockAt();
		const s = storeOn(clock);
		s.admit(STUCK, "stuck", "queued-work");
		s.delivered(STUCK);
		clock.now += 5 * MIN;
		expect(s.cooHold(STUCK, clock.now + 3 * 60 * MIN)).toBe(clock.now + COO_HOLD_MAX_MS);
		s.cooTurnEnded(STUCK);
		expect(s.due()).toEqual([]);
		clock.now += COO_HOLD_MAX_MS - MIN;
		expect(s.cooHold(STUCK, clock.now + 30 * MIN)).toBe(clock.now + 30 * MIN);
		clock.now += 30 * MIN;
		expect(s.due()).toEqual([{ key: STUCK, why: "hold-ended" }]);
		expect(s.cooHold("stuck:nope", clock.now + MIN)).toBeNull();
		expect(s.cooHold(STUCK, clock.now - 1)).toBeNull();
	});

	it("records how each hold ended", () => {
		const clock = clockAt();
		const s = storeOn(clock);
		const q = holdKeyOfAsk("q-1");
		const d = holdKeyOfAsk("d-1");
		s.admit(STUCK, "stuck", "queued-work");
		s.admit(q, "question", "not-started-by-owner");
		s.admit(d, "dialog", "not-started-by-owner");
		clock.now += 2 * MIN;
		expect(s.release(STUCK, "coo", "Temper needs it", "Pick Left")).toBe(true);
		expect(s.release(STUCK, "coo")).toBe(false);
		expect(s.returned(d, "no")).toBe(false); // only a question goes back
		expect(s.returned(q, "  Read Temper #243 first.  ")).toBe(true);
		expect(s.release(d, "owner-answered")).toBe(true);
		expect(s.gone(d)).toBe(true);
		expect(s.gone("ask:nope")).toBe(false);
		expect(s.list()).toEqual([
			held({
				state: "released",
				releasedBy: "coo",
				finishedAt: T0 + 2 * MIN,
				note: "Temper needs it",
				recommendation: "Pick Left",
			}),
			{
				key: q,
				kind: "question",
				reason: "not-started-by-owner",
				createdAt: T0,
				state: "returned",
				finishedAt: T0 + 2 * MIN,
				note: "Read Temper #243 first.",
			},
			{
				key: d,
				kind: "dialog",
				reason: "not-started-by-owner",
				createdAt: T0,
				state: "gone",
				releasedBy: "owner-answered",
				finishedAt: T0 + 2 * MIN,
			},
		]);
		expect(s.due(clock.now + 10 * 60 * MIN)).toEqual([]);
	});

	it("keeps COO's words bounded", () => {
		const clock = clockAt();
		const s = storeOn(clock);
		s.admit(STUCK, "stuck", "queued-work");
		expect(s.cooHold(STUCK, T0 + 60 * MIN, "w".repeat(HOLD_TEXT_MAX + 50))).toBe(T0 + 60 * MIN);
		expect(s.get(STUCK)?.holdWhy).toBe(`${"w".repeat(HOLD_TEXT_MAX - 1)}…`);
		expect(storeOn(clock).get(STUCK)?.holdWhy).toBe(s.get(STUCK)?.holdWhy);
		s.release(STUCK, "coo", "n".repeat(HOLD_TEXT_MAX + 50), "r".repeat(HOLD_TEXT_MAX + 1));
		expect(s.get(STUCK)?.note).toHaveLength(HOLD_TEXT_MAX);
		expect(s.get(STUCK)?.recommendation).toHaveLength(HOLD_TEXT_MAX);
	});

	it("prunes finished records once they are old, and the oldest finished first when full", () => {
		const clock = clockAt();
		const s = storeOn(clock, file, 4);
		const k = (n: number) => holdKeyOfAsk(`q-${n}`);
		s.admit(k(1), "question", "not-started-by-owner");
		s.gone(k(1));
		clock.now += MIN;
		s.admit(k(2), "question", "not-started-by-owner");
		s.release(k(2), "safety-net");
		clock.now += MIN;
		s.admit(k(3), "question", "not-started-by-owner");
		s.admit(k(4), "question", "not-started-by-owner");
		// Full: the oldest finished one (q-1) makes room.
		s.admit(k(5), "question", "not-started-by-owner");
		expect(s.list().map((h) => h.key)).toEqual([k(2), k(3), k(4), k(5)]);
		// Old finished records go at the next write.
		clock.now += HOLD_FINISHED_KEEP_MS + MIN;
		s.gone(k(3));
		expect(s.list().map((h) => h.key)).toEqual([k(3), k(4), k(5)]);
		const onDisk = JSON.parse(readFileSync(file, "utf8")) as { holds: OwnerQuestionHold[] };
		expect(onDisk.holds.map((h) => h.key)).toEqual([k(3), k(4), k(5)]);
	});

	it("when every record is still held and the store is full, a new one isn't held (shown as before)", () => {
		const s = storeOn(clockAt(), file, 2);
		s.admit(holdKeyOfAsk("q-1"), "question", "not-started-by-owner");
		s.admit(holdKeyOfAsk("q-2"), "question", "not-started-by-owner");
		expect(s.admit(holdKeyOfAsk("q-3"), "question", "not-started-by-owner")).toEqual({ action: "show", why: "full" });
		expect(s.get(holdKeyOfAsk("q-3"))).toBeUndefined();
		expect(s.ok).toBe(true);
	});
});

describe("OwnerQuestionHolds and its clock", () => {
	it("holds nothing while its clock isn't a real time, and writes nothing", () => {
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
			const clock = clockAt(bad);
			const s = storeOn(clock);
			expect(s.admit(STUCK, "stuck", "queued-work"), String(bad)).toEqual({ action: "show", why: "clock-unusable" });
			expect(s.list()).toEqual([]);
			expect(existsSync(file)).toBe(false);
			expect(s.ok).toBe(true);
		}
	});

	it("a clock with fractions of a millisecond: its records reload after a restart", () => {
		const clock = clockAt(T0 + 0.25);
		const before = storeOn(clock);
		before.admit(STUCK, "stuck", "queued-work");
		clock.now += 0.5;
		before.delivered(STUCK);
		const after = storeOn(clock);
		expect(after.ok).toBe(true);
		expect(after.get(STUCK)).toEqual(held({ createdAt: T0 + 0.25, deliveredToCoo: { at: T0 + 0.75 } }));
	});
});

describe("OwnerQuestionHolds after a restart", () => {
	it("keeps COO's hold reason and deadline across a restart", () => {
		const clock = clockAt();
		const before = storeOn(clock);
		before.admit(STUCK, "stuck", "queued-work");
		before.delivered(STUCK);
		clock.now += 5 * MIN;
		expect(before.cooHold(STUCK, T0 + 60 * MIN, "  Waiting for the review.  ")).toBe(T0 + 60 * MIN);
		before.cooTurnEnded(STUCK);
		const expected = held({
			deliveredToCoo: { at: T0, turnEndedAt: T0 + 5 * MIN },
			holdUntil: T0 + 60 * MIN,
			holdWhy: "Waiting for the review.",
		});
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 1, holds: [expected] });
		clock.now += 30 * MIN;
		const after = storeOn(clock);
		expect(after.ok).toBe(true);
		expect(after.admit(STUCK, "stuck", "queued-work")).toEqual({ action: "hold", deliver: false, hold: expected });
		expect(after.due()).toEqual([]);
	});

	it("a renewed hold replaces COO's reason durably", () => {
		const clock = clockAt();
		const before = storeOn(clock);
		before.admit(STUCK, "stuck", "queued-work");
		expect(before.cooHold(STUCK, T0 + 60 * MIN, "Waiting for the review.")).toBe(T0 + 60 * MIN);
		clock.now += 30 * MIN;
		const renewed = storeOn(clock);
		expect(renewed.cooHold(STUCK, T0 + 90 * MIN, "  Review arrived; checking its result.  ")).toBe(T0 + 90 * MIN);
		expect(storeOn(clock).get(STUCK)).toEqual(
			held({ holdUntil: T0 + 90 * MIN, holdWhy: "Review arrived; checking its result." }),
		);
	});

	it("a legacy version-1 hold without a reason still loads and renews without one", () => {
		const clock = clockAt();
		writeFileSync(file, JSON.stringify({ v: 1, holds: [held({ holdUntil: T0 + 60 * MIN })] }));
		clock.now += 30 * MIN;
		const s = storeOn(clock);
		expect(s.ok).toBe(true);
		expect(s.admit(STUCK, "stuck", "queued-work")).toEqual({
			action: "hold",
			deliver: true,
			hold: held({ holdUntil: T0 + 60 * MIN }),
		});
		expect(s.cooHold(STUCK, T0 + 90 * MIN)).toBe(T0 + 90 * MIN);
		expect(storeOn(clock).get(STUCK)).toEqual(held({ holdUntil: T0 + 90 * MIN }));
	});

	it("keeps a stuck card's delivery id across restart for COO turn settlement", () => {
		const clock = clockAt();
		const before = storeOn(clock);
		const sendId = "oqc-9f7b627e-38b5-4a11-80b6-6b1656e4efbd";
		before.admit(STUCK, "stuck", "queued-work");
		expect(before.delivered(STUCK, sendId)).toBe(true);
		const expected = held({ deliveredToCoo: { at: T0, sendId } });
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 1, holds: [expected] });
		clock.now += 5 * MIN;
		const after = storeOn(clock);
		expect(after.ok).toBe(true);
		expect(after.admit(STUCK, "stuck", "queued-work")).toEqual({ action: "hold", deliver: false, hold: expected });
		expect(after.delivered(STUCK, sendId)).toBe(false);
		const matches = after.list().filter((h) => h.deliveredToCoo?.sendId === sendId);
		expect(matches).toEqual([expected]);
		for (const h of matches) expect(after.cooTurnEnded(h.key)).toBe(true);
		expect(after.due()).toEqual([{ key: STUCK, why: "coo-turn-ended" }]);
		expect(storeOn(clock).get(STUCK)).toEqual(held({ deliveredToCoo: { at: T0, sendId, turnEndedAt: T0 + 5 * MIN } }));
	});

	it("a held card already delivered is never delivered to COO twice", () => {
		const clock = clockAt();
		const before = storeOn(clock);
		before.admit(STUCK, "stuck", "queued-work");
		before.delivered(STUCK);
		clock.now += 5 * MIN;
		const after = storeOn(clock);
		expect(after.admit(STUCK, "stuck", "queued-work")).toEqual({
			action: "hold",
			deliver: false,
			hold: held({ deliveredToCoo: { at: T0 } }),
		});
		expect(after.delivered(STUCK)).toBe(false);
	});

	it("a held card not yet delivered goes to COO", () => {
		const clock = clockAt();
		storeOn(clock).admit(STUCK, "stuck", "queued-work");
		clock.now += MIN;
		const after = storeOn(clock);
		expect(after.admit(STUCK, "stuck", "queued-work")).toMatchObject({ action: "hold", deliver: true });
		expect(after.delivered(STUCK)).toBe(true);
	});

	it("a card COO let through is shown at once, with what COO said", () => {
		const clock = clockAt();
		const before = storeOn(clock);
		before.admit(STUCK, "stuck", "queued-work");
		before.delivered(STUCK);
		clock.now += 6 * MIN;
		before.release(STUCK, "coo", "Temper needs it", "Pick Left");
		clock.now += 60 * MIN;
		const after = storeOn(clock);
		expect(after.admit(STUCK, "stuck", "queued-work")).toEqual({
			action: "show",
			why: "released",
			hold: held({
				deliveredToCoo: { at: T0 },
				state: "released",
				releasedBy: "coo",
				finishedAt: T0 + 6 * MIN,
				note: "Temper needs it",
				recommendation: "Pick Left",
			}),
		});
	});

	it("a card whose time ran out while the app was down is let through at once", () => {
		const clock = clockAt();
		const before = storeOn(clock);
		before.admit(STUCK, "stuck", "queued-work");
		before.delivered(STUCK);
		clock.now += 31 * MIN;
		const after = storeOn(clock);
		expect(after.admit(STUCK, "stuck", "queued-work")).toEqual({
			action: "show",
			why: "no-coo-action",
			hold: held({
				deliveredToCoo: { at: T0 },
				state: "released",
				releasedBy: "safety-net",
				finishedAt: T0 + 31 * MIN,
			}),
		});
		expect(storeOn(clock).get(STUCK)?.state).toBe("released");
	});

	it("questions, dialogs and approvals held before the restart died with it", () => {
		const clock = clockAt();
		const before = storeOn(clock);
		const q = holdKeyOfAsk("q-1");
		before.admit(q, "question", "not-started-by-owner");
		before.admit(STUCK, "stuck", "queued-work");
		clock.now += MIN;
		const after = storeOn(clock);
		expect(after.get(q)).toMatchObject({ state: "gone", finishedAt: T0 + MIN });
		expect(after.get(STUCK)?.state).toBe("held");
		expect(after.due()).toEqual([]);
		// The same id asked again in the new process is a new ask.
		clock.now += MIN;
		expect(after.admit(q, "question", "not-started-by-owner")).toEqual({
			action: "hold",
			deliver: true,
			hold: { key: q, kind: "question", reason: "not-started-by-owner", createdAt: T0 + 2 * MIN, state: "held" },
		});
	});

	it("keeps every reason the rule sends to COO across a restart, owner-away included", () => {
		const clock = clockAt();
		const before = storeOn(clock);
		const away = holdKeyOfAsk("q-away");
		const notHis = holdKeyOfAsk("d-not-his");
		before.admit(away, "question", "owner-away");
		before.admit(notHis, "dialog", "not-started-by-owner");
		before.admit(STUCK, "stuck", "queued-work");
		clock.now += MIN;
		before.release(away, "coo", "He left this an hour ago");
		before.release(notHis, "safety-net");
		const after = storeOn(clock);
		expect(after.ok).toBe(true);
		expect(after.list().map((h) => [h.reason, h.state])).toEqual([
			["owner-away", "released"],
			["not-started-by-owner", "released"],
			["queued-work", "held"],
		]);
	});

	it("a card that ended and is asked again is held afresh", () => {
		const clock = clockAt();
		const s = storeOn(clock);
		s.admit(STUCK, "stuck", "queued-work");
		s.delivered(STUCK);
		s.gone(STUCK);
		clock.now += MIN;
		expect(storeOn(clock).admit(STUCK, "stuck", "queued-work")).toEqual({
			action: "hold",
			deliver: true,
			hold: held({ createdAt: T0 + MIN }),
		});
	});
});

describe("OwnerQuestionHolds fails open", () => {
	const failsOpen = (s: OwnerQuestionHolds) => {
		expect(s.ok).toBe(false);
		expect(s.admit(STUCK, "stuck", "queued-work")).toEqual({ action: "show", why: "store-failed" });
		expect(s.delivered(STUCK)).toBe(false);
		expect(s.cooHold(STUCK, T0 + MIN)).toBeNull();
		expect(errors).toHaveBeenCalledTimes(1);
		expect(String(errors.mock.calls[0]?.[0])).toContain("reach you as before");
	};

	it("a file that isn't JSON: nothing held, the file left as it was", () => {
		writeFileSync(file, "{not json", { mode: 0o600 });
		failsOpen(storeOn(clockAt()));
		expect(readFileSync(file, "utf8")).toBe("{not json");
	});

	it("a record it doesn't know", () => {
		writeFileSync(file, JSON.stringify({ v: 1, holds: [{ ...held(), state: "parked" }] }));
		failsOpen(storeOn(clockAt()));
	});

	it.each([
		{ name: "null", holdWhy: null },
		{ name: "a number", holdWhy: 42 },
		{ name: "a boolean", holdWhy: false },
		{ name: "an array", holdWhy: [] },
		{ name: "an object", holdWhy: {} },
		{ name: "empty", holdWhy: "" },
		{ name: "too long", holdWhy: "w".repeat(HOLD_TEXT_MAX + 1) },
	])("a persisted hold reason that is $name fails open without rewriting the file", ({ holdWhy }) => {
		const text = JSON.stringify({ v: 1, holds: [{ ...held({ holdUntil: T0 + 60 * MIN }), holdWhy }] });
		writeFileSync(file, text);
		failsOpen(storeOn(clockAt()));
		expect(readFileSync(file, "utf8")).toBe(text);
	});

	it.each([
		{ name: "null", sendId: null },
		{ name: "a number", sendId: 42 },
		{ name: "a boolean", sendId: false },
		{ name: "an array", sendId: [] },
		{ name: "an object", sendId: {} },
		{ name: "empty", sendId: "" },
		{ name: "longer than a key", sendId: "s".repeat(301) },
	])("a persisted delivery id that is $name fails open without rewriting the file", ({ sendId }) => {
		const text = JSON.stringify({ v: 1, holds: [{ ...held(), deliveredToCoo: { at: T0, sendId } }] });
		writeFileSync(file, text);
		failsOpen(storeOn(clockAt()));
		expect(readFileSync(file, "utf8")).toBe(text);
	});

	it("the same key twice", () => {
		writeFileSync(file, JSON.stringify({ v: 1, holds: [held(), held()] }));
		failsOpen(storeOn(clockAt()));
	});

	it("another version", () => {
		writeFileSync(file, JSON.stringify({ v: 2, holds: [] }));
		failsOpen(storeOn(clockAt()));
	});

	it("a file too big to read", () => {
		writeFileSync(file, "");
		truncateSync(file, HOLDS_READ_MAX + 1);
		failsOpen(storeOn(clockAt()));
	});

	it("a folder where the file should be", () => {
		mkdirSync(file);
		failsOpen(storeOn(clockAt()));
	});

	it("a link where the file should be", () => {
		const real = join(dir, "real.json");
		writeFileSync(real, JSON.stringify({ v: 1, holds: [] }));
		symlinkSync(real, file);
		failsOpen(storeOn(clockAt()));
	});

	it("a missing file is an empty store, not a failure", () => {
		const s = storeOn(clockAt());
		expect(s.ok).toBe(true);
		expect(s.list()).toEqual([]);
		expect(errors).not.toHaveBeenCalled();
	});

	it("a write that fails lets every held one through and holds nothing new", () => {
		const sub = join(dir, "data");
		mkdirSync(sub);
		const path = join(sub, OWNER_QUESTION_HOLDS_FILE);
		const clock = clockAt();
		const s = storeOn(clock, path);
		const q = holdKeyOfAsk("q-1");
		expect(s.admit(q, "question", "not-started-by-owner")).toMatchObject({ action: "hold" });
		// The data folder becomes a plain file: no write can succeed now.
		rmSync(sub, { recursive: true });
		writeFileSync(sub, "not a folder");
		expect(s.admit(STUCK, "stuck", "queued-work")).toEqual({ action: "show", why: "store-failed" });
		expect(s.ok).toBe(false);
		expect(s.get(STUCK)).toBeUndefined();
		expect(s.due()).toEqual([{ key: q, why: "store-failed" }]);
		expect(errors).toHaveBeenCalledTimes(1);
	});
});
