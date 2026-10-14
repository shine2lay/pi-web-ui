import { describe, expect, it } from "vitest";
import { knownCases, decodePNG, encodeCase, compareRGBA } from "../roles-u0/rgba.mjs";

describe("U0 strict decoded-RGBA oracle (QA1)", () => {
	it("qualifies all six known cases", () => {
		const cases = knownCases();
		expect(cases).toHaveLength(6);
		expect(cases.every((c: { pass: boolean }) => c.pass)).toBe(true);
		const off = cases[1].result;
		expect(off.differing).toBe(1);
		expect(off.maxDelta).toBe(1);
		expect(off.coordinates).toEqual([[0, 1]]);
		expect(off.clusters).toEqual([{ x: 0, y: 1, width: 1, height: 1, pixels: 1 }]);
		expect(cases[3].result.reason).toBe("SIZE_MISMATCH");
	});
	it("rejects truncation, bad CRC and wrong signatures", () => {
		const png = encodeCase(1, 1, Buffer.from([1, 2, 3, 255]));
		expect(() => decodePNG(png.subarray(0, -1))).toThrow();
		const corrupted = Buffer.from(png);
		corrupted[20] ^= 1;
		expect(() => decodePNG(corrupted)).toThrow("CRC");
		expect(() => decodePNG(Buffer.alloc(8))).toThrow("signature");
	});
	it("does not ignore RGB under transparent pixels or mask regions", () => {
		const a = decodePNG(encodeCase(1, 1, Buffer.from([1, 2, 3, 0])));
		const b = decodePNG(encodeCase(1, 1, Buffer.from([2, 2, 3, 0])));
		const d = compareRGBA(a, b, [{ name: "all", x: 0, y: 0, width: 1, height: 1 }]);
		expect(d.pass).toBe(false);
		expect(d.regions?.[0].differing).toBe(1);
	});
});
