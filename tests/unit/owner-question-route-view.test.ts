/**
 * owner-question routing (Ops #685), the page's side: which way an ask came, as a card shows it (only plain
 * lines), and when a card sounds (not while it is held for COO first).
 */
import { describe, expect, it } from "vitest";
import { cueIdOf, ownerQuestionRouteOf } from "../../web/src/owner-question-route.js";

describe("ownerQuestionRouteOf", () => {
	it("keeps the line, COO's note and recommendation, and the held mark", () => {
		expect(
			ownerQuestionRouteOf({ line: "Came through COO", note: "He set it Tuesday.", recommendation: "Pick 8080" }),
		).toEqual({ line: "Came through COO", note: "He set it Tuesday.", recommendation: "Pick 8080" });
		expect(ownerQuestionRouteOf({ line: "With COO first. You can answer here.", held: true })).toEqual({
			line: "With COO first. You can answer here.",
			held: true,
		});
	});

	it("shows nothing without a plain line, and leaves out a note or recommendation that isn't plain", () => {
		expect(ownerQuestionRouteOf(undefined)).toBeUndefined();
		expect(ownerQuestionRouteOf({ note: "a note alone" })).toBeUndefined();
		expect(ownerQuestionRouteOf({ line: "Came \u202ethrough COO" })).toBeUndefined();
		expect(ownerQuestionRouteOf({ line: "x".repeat(601) })).toBeUndefined();
		expect(ownerQuestionRouteOf({ line: "Came through COO", note: "bad\u0007", recommendation: 7 })).toEqual({
			line: "Came through COO",
		});
		expect(ownerQuestionRouteOf({ line: " Came\nthrough\tCOO ", held: "yes" })).toEqual({ line: "Came through COO" });
	});
});

describe("cueIdOf", () => {
	it("a held card doesn't sound; once let through, or with the setting off, it sounds under its id", () => {
		expect(cueIdOf({ id: "q-1", route: { line: "With COO first. You can answer here.", held: true } })).toBeNull();
		expect(cueIdOf({ id: "q-1", route: { line: "Came through COO" } })).toBe("q-1");
		expect(cueIdOf({ id: 4 })).toBe(4);
		expect(cueIdOf(null)).toBeNull();
		expect(cueIdOf(undefined)).toBeNull();
	});
});
