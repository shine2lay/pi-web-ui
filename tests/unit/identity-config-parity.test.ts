// C-PARITY-1 (department-specialists §4.5, R-SPEC-PARITY-1; Ops #1097): server/identity-config.ts is a copy of
// pi-identity's config.ts and must stay byte-identical. pi-identity's checkout is read from the case's path (the real
// user's ~/projects/pi-identity: the sealed gate's HOME is a temp folder), or PI_IDENTITY_PEER=<folder>.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { caseById, parityFiles } from "../lib/department-specialists-cases.js";

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

describe("C-PARITY-1: identity-config.ts is byte-identical to pi-identity's config.ts", () => {
	const c = caseById("C-PARITY-1");

	it("names the two files and expects them identical", () => {
		expect(c.kind).toBe("parity");
		expect(c.expect).toEqual({ result: "allow", identical: true });
	});

	it("the two files have the same bytes", () => {
		const { own, peer } = parityFiles(c);
		expect(own).toMatch(/server\/identity-config\.ts$/);
		expect(peer).toMatch(/config\.ts$/);
		const identical = sha256(own) === sha256(peer);
		if (!identical) {
			throw new Error(
				`E_PARITY_DRIFT: ${own} (${sha256(own)}) differs from ${peer} (${sha256(peer)}): copy pi-identity's config.ts over it in the same change`,
			);
		}
		expect(identical).toBe(c.expect.identical);
	});
});
