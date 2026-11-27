/**
 * Frontend #364: the case map (department-specialists-explorer.case-map.json) names a test for each of M-106..M-113,
 * every one of the pinned cases, and every test it names exists under that exact title, so the map cannot rot.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../lib/department-specialists-cases.js";
import { memoryCase } from "../lib/department-specialists-memory-cases.js";

interface CaseMap {
	cases: Record<string, { server: string[]; page: string[] }>;
	page_also: string[];
}
const MAP = JSON.parse(
	readFileSync(join(REPO_ROOT, "tests", "unit", "department-specialists-explorer.case-map.json"), "utf8"),
) as CaseMap;
const EXPLORER_CASES = ["M-106", "M-107", "M-108", "M-109", "M-110", "M-111", "M-112", "M-113"];

/** `<file> > <title>`: the file holds a test (it or notBuilt) with exactly that title. */
function exists(ref: string): boolean {
	const [file, title] = ref.split(" > ");
	const source = readFileSync(join(REPO_ROOT, file), "utf8");
	const quoted = JSON.stringify(title).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`\\b(?:it|notBuilt)\\(\\s*${quoted}`).test(source);
}

describe("case map: M-106..M-113 (v2 §5l.15-5l.17)", () => {
	it("maps exactly the eight pinned explorer cases, each to at least one server test", () => {
		expect(Object.keys(MAP.cases).sort()).toEqual(EXPLORER_CASES);
		for (const id of EXPLORER_CASES) {
			expect(memoryCase(id).id).toBe(id);
			expect(MAP.cases[id].server.length, id).toBeGreaterThan(0);
		}
	});

	it("every named test exists under that exact title", () => {
		const refs = [...Object.values(MAP.cases).flatMap((c) => [...c.server, ...c.page]), ...MAP.page_also];
		expect(refs.filter((ref) => !exists(ref))).toEqual([]);
	});
});
