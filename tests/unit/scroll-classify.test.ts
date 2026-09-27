import { describe, expect, it } from "vitest";
import { classifyScroll } from "../../web/src/components/scroll-classify.js";

/**
 * MUTATION-PROOF PIN for the scroll layout-shift discriminator (5cd680b).
 *
 * The synthetic E2E harness self-recovers (the lazy-window sweep re-clears
 * escapedRef), so reverting the dSh<0 branch still shows 9/9 green there.
 * These unit tests do NOT self-recover: if you simulate the pre-fix behavior
 * by deleting/commenting the `if (dSh < 0)` branch in classifyScroll
 * (web/src/components/scroll-classify.ts) — i.e. always treating a moderate
 * negative dSt as user intent (flipEscape = true) — the tests marked
 * [MUTATION-KILL] below MUST fail.
 *
 * Mutation check procedure:
 *   1. Comment out `if (dSh < 0) { ... return ...; }` in classifyScroll.
 *   2. npx vitest run tests/unit/scroll-classify.test.ts  → expect RED.
 *   3. Restore the branch.
 *   4. npx vitest run tests/unit/scroll-classify.test.ts  → expect GREEN.
 */
const base = {
	escaped: false,
	graceActive: false,
	stuck: true,
};

function run(over: Partial<Parameters<typeof classifyScroll>[0]>) {
	return classifyScroll({ ...base, ...over } as Parameters<typeof classifyScroll>[0]);
}

describe("classifyScroll — layout-shift discriminator decision table", () => {
	it("[MUTATION-KILL] dSt in (-500,-4), dSh < 0, escaped=false, stuck → NO flipEscape, reassert=true (layout collapse while stuck: follow the bottom)", () => {
		const d = run({ dSt: -120, dSh: -300 });
		expect(d.flipEscape).toBe(false);
		expect(d.reassert).toBe(true);
	});

	it("[MUTATION-KILL] dSt in (-500,-4), dSh < 0, escaped=true → stays escaped (collapsed while reading: no drag, no reassert)", () => {
		const d = run({ dSt: -120, dSh: -300, escaped: true });
		expect(d.flipEscape).toBe(false);
		expect(d.reassert).toBe(false);
	});

	it("[MUTATION-KILL] dSt in (-500,-4), dSh >= 0 (true user wheel-up) → flipEscape=true", () => {
		const d = run({ dSt: -120, dSh: 0 });
		expect(d.flipEscape).toBe(true);
		expect(d.reassert).toBe(false);

		const growing = run({ dSt: -120, dSh: 50 });
		expect(growing.flipEscape).toBe(true);
	});

	it("dSt < -500 (large jump = native clamp after layout collapse) → escape preserved: no flip, no reassert", () => {
		const collapse = run({ dSt: -800, dSh: -600 });
		expect(collapse.flipEscape).toBe(false);
		expect(collapse.reassert).toBe(false);

		const largeUser = run({ dSt: -800, dSh: 0 });
		expect(largeUser.flipEscape).toBe(false); // existing behavior for that band
	});

	it("dSt >= -4 → no-op", () => {
		for (const dSt of [0, 5, -4]) {
			const d = run({ dSt, dSh: 0 });
			expect(d.flipEscape).toBe(false);
			expect(d.reassert).toBe(false);
		}
	});

	it("graceActive=true + negative dSt → no flip, no reassert (programmatic jumps are never user intent)", () => {
		const d = run({ dSt: -120, dSh: -300, graceActive: true });
		expect(d.flipEscape).toBe(false);
		expect(d.reassert).toBe(false);
	});

	it("not stuck → no reassert even on layout collapse", () => {
		const d = run({ dSt: -120, dSh: -300, stuck: false });
		expect(d.reassert).toBe(false);
		expect(d.flipEscape).toBe(false);
	});
});

// Fork (sealed-tests): the user's own hand on the wheel / finger / keys wins over the size and
// grace rules. scroll-attr-collapse-test: one 600 px flick while a run ended landed as a single
// scroll event, was read as a layout collapse, and the stream-end snap pulled the user back down.
describe("classifyScroll — user input wins", () => {
	it("a large upward jump right after the user's wheel-up → flipEscape (not a collapse)", () => {
		const d = run({ dSt: -554, dSh: 46, userInput: true });
		expect(d.flipEscape).toBe(true);
		expect(d.reassert).toBe(false);
	});

	it("user input during the programmatic grace window or a shrink → still escapes", () => {
		expect(run({ dSt: -120, dSh: 0, graceActive: true, userInput: true }).flipEscape).toBe(true);
		const shrink = run({ dSt: -120, dSh: -300, userInput: true });
		expect(shrink.flipEscape).toBe(true);
		expect(shrink.reassert).toBe(false);
	});

	it("user input but no upward move (dSt >= -4) → no-op", () => {
		for (const dSt of [0, 30, -4]) {
			const d = run({ dSt, dSh: 0, userInput: true });
			expect(d.flipEscape).toBe(false);
			expect(d.reassert).toBe(false);
		}
	});

	it("without user input the old table is unchanged (large jump = collapse, no flip)", () => {
		expect(run({ dSt: -554, dSh: 46, userInput: false }).flipEscape).toBe(false);
		expect(run({ dSt: -554, dSh: 46 }).flipEscape).toBe(false);
	});
});
