import { describe, expect, it } from "vitest";
import { displayPreview, DISPLAY_PREVIEW_SCALARS } from "../../server/display-preview.js";

// Own synthetic display metadata, never transcripts or model-request fixtures.
describe("automatic display preview", () => {
	it("keeps empty, short, escaped and exactly-300-scalar strings unchanged", () => {
		for (const text of ["", "short", '"\\\n\t', "e\u0301", "🧪", "a".repeat(300), "🧪".repeat(300)]) {
			expect(displayPreview(text) === text).toBe(true);
		}
	});

	it("caps a long ASCII or supplementary prefix at 300 scalars plus one ellipsis", () => {
		for (const scalar of ["a", "🧪", "𐀀", '"', "\\", "\n"]) {
			const text = scalar.repeat(301);
			const result = displayPreview(text);
			expect(result === scalar.repeat(300) + "…").toBe(true);
			expect(Array.from(result).length).toBe(DISPLAY_PREVIEW_SCALARS + 1);
		}
	});

	it("counts combining and emoji-joiner sequences as scalars, not graphemes or UTF-16 units", () => {
		for (const text of ["e\u0301".repeat(201), "👩‍🔬".repeat(150)]) {
			const expected = Array.from(text).slice(0, 300).join("") + "…";
			expect(displayPreview(text) === expected).toBe(true);
			expect(Array.from(displayPreview(text)).length).toBe(301);
		}
	});

	it("does not split a surrogate pair at the boundary and repairs lone surrogates only in the display copy", () => {
		const text = "a".repeat(299) + "🧪suffix";
		expect(displayPreview(text) === "a".repeat(299) + "🧪…").toBe(true);
		const malformed = "\ud800x\udc00";
		expect(displayPreview(malformed) === "\ufffdx\ufffd").toBe(true);
		expect(malformed.length).toBe(3);
		expect(malformed.charCodeAt(0)).toBe(0xd800);
	});

	it("is idempotent, suffix-independent, and honors the existing smaller live-label budget", () => {
		const prefix = "🧪".repeat(300);
		const a = displayPreview(prefix + "a".repeat(8000));
		const b = displayPreview(prefix + "b".repeat(16000));
		expect(a === b).toBe(true);
		expect(displayPreview(a) === a).toBe(true);
		expect(displayPreview("🧪".repeat(31), 30) === "🧪".repeat(30) + "…").toBe(true);
		expect(displayPreview("x", 0) === "…").toBe(true);
		expect(displayPreview("", 0) === "").toBe(true);
	});

	it("rejects budgets that would exceed the frozen cap", () => {
		for (const budget of [-1, 301, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => displayPreview("x", budget)).toThrow(RangeError);
		}
	});
});
