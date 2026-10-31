// The Roles page's own-v1 spend reader (server/roles-spend.ts) and its tests may change only with a re-pin.
// Moved unchanged from tests/unit/roles-requested.test.ts ("S07 own-v1 implementation/tests bytes unchanged,
// additive sidecar has no production importer or aggregate") by roles-inert-cleanup (2026-10-31), which removed
// the inert roles-requested* sidecar; its no-importer and no-aggregate half went with it.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("roles-spend own-v1 baseline", () => {
	it("S07 own-v1 implementation/tests bytes unchanged", () => {
		for (const [file, hash] of [
			["../../server/roles-spend.ts", "38fb25ea8903c7abfd9694a0b94531a49f92105975f26023660193987e30c858"],
			["./roles-spend.test.ts", "d7c8feb802567765a7ea11f7570b30a08980170fa4b4da8fe8b4ac0dd3c0c914"],
		]) {
			expect(
				createHash("sha256")
					.update(readFileSync(new URL(file, import.meta.url)))
					.digest("hex"),
			).toBe(hash);
		}
	});
});
