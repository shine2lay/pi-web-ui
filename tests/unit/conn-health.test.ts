import { describe, expect, it } from "vitest";
import {
	BACK_PROBE_MS,
	BIG_BACK_MS,
	ConnHealth,
	MIN_CHARS_PER_SEC,
	NOTE_AFTER_MS,
	QUIET_MS,
	STEADY_MS,
	reconnectingNote,
	setReconnectingNote,
	subscribeReconnectingNote,
} from "../../web/src/conn-health.js";
import { keyboardIsUp, needsFallback } from "../../web/src/mobile-viewport.js";

/**
 * mobile-fixes: telling a dead chat connection from a slow one (web/src/conn-health.ts).
 * The server says something every 2 s; a phone's connection dies quietly (screen off, frozen tab,
 * Wi-Fi <-> mobile data). Dead must be found within seconds, but a slow link must never be mistaken for
 * dead over and over (a reconnect loop).
 */
describe("ConnHealth", () => {
	const T0 = 1_000_000;
	const fresh = () => {
		const h = new ConnHealth();
		h.opened(T0);
		return h;
	};

	it("a socket that keeps talking is fine; one quiet for QUIET_MS is dead", () => {
		const h = fresh();
		for (let t = T0; t < T0 + 60_000; t += 2_000) {
			h.heard(t);
			expect(h.verdict(t + 1_999)).toBe("ok");
		}
		const last = T0 + 58_000;
		expect(h.verdict(last + QUIET_MS - 1)).toBe("ok");
		expect(h.verdict(last + QUIET_MS + 1)).toBe("dead");
	});

	it("a big message announced first gets time to come through on a slow link", () => {
		const h = fresh();
		const chars = 2_000_000;
		h.heard(T0, chars);
		const needed = (chars / MIN_CHARS_PER_SEC) * 1000;
		expect(h.verdict(T0 + QUIET_MS + needed - 1)).toBe("ok");
		expect(h.verdict(T0 + QUIET_MS + needed + 1)).toBe("dead");
		// Once the big message is in, the usual limit applies again.
		h.heard(T0 + 10_000);
		expect(h.verdict(T0 + 10_000 + QUIET_MS + 1)).toBe("dead");
	});

	it("after coming back only the answer to its own ping counts", () => {
		const h = fresh();
		h.heard(T0);
		const back = T0 + 60_000;
		const id = h.cameBack(back);
		expect(id).not.toBeNull();
		expect(h.checking).toBe(true);
		// Messages the browser held while the page was frozen prove nothing.
		h.heard(back + 10);
		expect(h.checking).toBe(true);
		expect(h.verdict(back + NOTE_AFTER_MS - 1)).toBe("ok");
		expect(h.verdict(back + NOTE_AFTER_MS + 1)).toBe("doubt");
		// An old answer (another id) doesn't count either.
		h.answered((id ?? 0) + 100);
		expect(h.checking).toBe(true);
		h.answered(id ?? undefined);
		expect(h.checking).toBe(false);
		expect(h.verdict(back + 1_000)).toBe("ok");
	});

	it("no answer after coming back: dead after BACK_PROBE_MS, long before the quiet limit", () => {
		const h = fresh();
		const back = T0 + 1_000;
		h.heard(back - 500);
		h.cameBack(back);
		expect(h.verdict(back + BACK_PROBE_MS - 1)).not.toBe("dead");
		expect(h.verdict(back + BACK_PROBE_MS + 1)).toBe("dead");
		expect(BACK_PROBE_MS).toBeLessThan(QUIET_MS);
	});

	it("coming back again while a ping waits restarts its clock (time the page slept doesn't count)", () => {
		const h = fresh();
		const first = h.cameBack(T0 + 1_000);
		expect(h.cameBack(T0 + 30_000)).toBeNull();
		expect(h.verdict(T0 + 30_000 + BACK_PROBE_MS - 1)).not.toBe("dead");
		h.answered(first ?? undefined);
		expect(h.checking).toBe(false);
	});

	it("a big message on its way when the page comes back holds the answer up, within BIG_BACK_MS", () => {
		const h = fresh();
		h.heard(T0, 1_000_000); // 40 s at the slowest speed waited for
		h.cameBack(T0 + 100);
		expect(h.verdict(T0 + 100 + BACK_PROBE_MS + 1)).not.toBe("dead");
		expect(h.verdict(T0 + 100 + BIG_BACK_MS - 1)).not.toBe("dead");
		expect(h.verdict(T0 + 100 + BIG_BACK_MS + 1)).toBe("dead");
	});

	it("sockets dropped for unexplained silence make the next ones more patient, up to 8x", () => {
		const h = fresh();
		expect(h.patience).toBe(1);
		for (const want of [2, 4, 8, 8]) {
			h.droppedForSilence();
			h.opened(T0);
			expect(h.patience).toBe(want);
		}
		h.heard(T0);
		expect(h.verdict(T0 + 8 * QUIET_MS - 1)).toBe("ok");
		expect(h.verdict(T0 + 8 * QUIET_MS + 1)).toBe("dead");
	});

	it("every STEADY_MS of a socket working normally takes one step of patience back", () => {
		const h = fresh();
		h.droppedForSilence();
		h.droppedForSilence();
		h.opened(T0);
		expect(h.patience).toBe(4);
		// The heartbeat every 2 s.
		let t = T0;
		const beatUntil = (end: number) => {
			for (; t + 2_000 <= end; t += 2_000) h.heard(t + 2_000);
		};
		beatUntil(T0 + STEADY_MS - 2_000);
		expect(h.patience).toBe(4);
		beatUntil(T0 + STEADY_MS + 2_000);
		expect(h.patience).toBe(2);
		beatUntil(T0 + 2 * STEADY_MS + 4_000);
		expect(h.patience).toBe(1);
		// A socket dropped before it had worked that long gives nothing back.
		h.droppedForSilence();
		t = T0 + 100_000;
		h.opened(t);
		beatUntil(T0 + 100_000 + STEADY_MS - 2_000);
		expect(h.patience).toBe(2);
	});

	it("a slow link can't loop: false drops double the wait until the link fits, and it stays", () => {
		// A link so busy that the socket is quiet for 18 s at a time, for an hour.
		const gap = 18_000;
		const h = new ConnHealth();
		let now = T0;
		h.opened(now);
		let drops = 0;
		while (now < T0 + 3_600_000) {
			const next = now + gap;
			// The watchdog looks every 500 ms.
			let dead = false;
			for (let t = now + 500; t <= next; t += 500) {
				if (h.verdict(t) === "dead") {
					dead = true;
					now = t + 1_000;
					break;
				}
			}
			if (dead) {
				drops++;
				h.droppedForSilence();
				h.opened(now);
			} else {
				now = next;
				h.heard(now);
			}
		}
		expect(drops).toBe(2);
		expect(h.patience).toBe(4);
	});
});

describe("the Reconnecting note store", () => {
	it("tells listeners only about changes", () => {
		let calls = 0;
		const off = subscribeReconnectingNote(() => calls++);
		setReconnectingNote(true);
		setReconnectingNote(true);
		expect(reconnectingNote()).toBe(true);
		setReconnectingNote(false);
		expect(reconnectingNote()).toBe(false);
		expect(calls).toBe(2);
		off();
		setReconnectingNote(true);
		expect(calls).toBe(2);
		setReconnectingNote(false);
	});
});

describe("mobile-viewport (the on-screen keyboard)", () => {
	it("follows the visible part only when the browser didn't shrink the page for the keyboard", () => {
		// Android Chrome with interactive-widget=resizes-content: the page itself got shorter.
		expect(needsFallback(500, 500, 1)).toBe(false);
		// A browser that only shrank the visible part.
		expect(needsFallback(915, 500, 1)).toBe(true);
		// The browser's own bars coming and going: small differences don't count.
		expect(needsFallback(915, 860, 1)).toBe(false);
		// Pinch-zoomed in: the visible part is smaller for another reason.
		expect(needsFallback(915, 400, 2)).toBe(false);
	});

	it("the keyboard is up while editing on a clearly shorter screen", () => {
		expect(keyboardIsUp(915, 500, true)).toBe(true);
		expect(keyboardIsUp(915, 500, false)).toBe(false);
		expect(keyboardIsUp(915, 860, true)).toBe(false);
	});
});
