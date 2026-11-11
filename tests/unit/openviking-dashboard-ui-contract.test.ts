/**
 * The gate's hold on the OpenViking dashboard UI acceptance suite (frontend #261, Task 1).
 *
 * The suite itself lives in `tests/openviking-dashboard/` and runs on its own config
 * (`npm run test:openviking-dashboard`), because its assertions are red until Task 2 (#258) builds
 * the page. This file runs inside the unit gate and holds Task 2 to the contract (Rule 18):
 *
 *   1. the suite may not shrink — Task 2 implements the seam, it does not delete or weaken checks;
 *   2. every assertion file keeps importing the real seam modules, so it cannot be turned into a stub;
 *   3. once the Task 1 stub is gone, the suite must join the unit gate (a wrapper under `tests/unit/`,
 *      as backend #132 did for `server/openviking-dashboard.test.ts`).
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const suiteDir = join(repoRoot, "tests/openviking-dashboard");
const seamDir = join(repoRoot, "web/src/openviking-dashboard");
const unitDir = join(repoRoot, "tests/unit");

/** Committed in Task 1: the floor each acceptance file has to stay above. */
const FLOOR = {
	"openviking-dashboard-seam.test.ts": { tests: 22, assertions: 104 },
	"openviking-dashboard-explorer-audit.test.ts": { tests: 21, assertions: 75 },
	"openviking-dashboard-page.test.ts": { tests: 16, assertions: 61 },
	"openviking-dashboard-drawer.test.ts": { tests: 11, assertions: 41 },
} as const;

const read = (dir: string, name: string): string => readFileSync(join(dir, name), "utf8");
const count = (source: string, needle: RegExp): number => source.match(needle)?.length ?? 0;

const seamFiles = (): string[] => readdirSync(seamDir).filter((n) => /\.(ts|tsx)$/.test(n));
const pendingMarker = ["OPENVIKING", "SEAM", "NOT", "IMPLEMENTED"].join("_");
const seamNotImplementedYet = (): boolean =>
	seamFiles().some((name) => read(seamDir, name).includes(pendingMarker)) ||
	seamFiles().some((name) => read(seamDir, name).includes('data-openviking-seam="not-implemented"'));

describe("openviking dashboard UI acceptance suite — held by the gate", () => {
	it("keeps every Task 1 assertion file", () => {
		const present = readdirSync(suiteDir).filter((n) => n.endsWith(".test.ts"));
		expect(present.sort()).toEqual(Object.keys(FLOOR).sort());
		expect(readdirSync(suiteDir)).toContain("openviking-dashboard-fixtures.ts");
		expect(readdirSync(suiteDir)).toContain("openviking-dashboard-dom.ts");
	});

	it.each(Object.entries(FLOOR))("%s never shrinks below its Task 1 counts", (name, floor) => {
		const source = read(suiteDir, name);
		expect(count(source, /^\s*it\(/gm)).toBeGreaterThanOrEqual(floor.tests);
		expect(count(source, /expect\(/g)).toBeGreaterThanOrEqual(floor.assertions);
	});

	it("keeps asserting against the real seam, never a copy of it", () => {
		for (const name of Object.keys(FLOOR)) {
			const source = read(suiteDir, name);
			expect(source).toMatch(/from "\.\.\/\.\.\/(web\/src|server)\/openviking[^"]*"/);
			expect(source).not.toMatch(/\bit\.(skip|todo|fails)\b/);
			expect(source).not.toMatch(/\bdescribe\.(skip|todo)\b/);
		}
	});

	it("keeps the production seam free of test fixtures (Rule 29)", () => {
		for (const name of seamFiles()) {
			const source = read(seamDir, name);
			expect(source).not.toMatch(/openviking-dashboard-fixtures/);
			expect(source).not.toMatch(/__OPENVIKING_FIXTURE__|openviking-fixture-data|data-st-state|stateStrip/);
		}
	});

	it("makes Task 2 move the suite into the gate once the page is built", () => {
		if (seamNotImplementedYet()) {
			expect(seamFiles().length).toBeGreaterThan(0);
			return;
		}
		const wrapperImport =
			/from "\.\.\/openviking-dashboard\/openviking-dashboard-[a-z-]+\.test\.js"|import "\.\.\/openviking-dashboard\/openviking-dashboard-[a-z-]+\.test\.js"/;
		const wrappers = readdirSync(unitDir)
			.filter((n) => n.endsWith(".test.ts"))
			.filter((n) => wrapperImport.test(read(unitDir, n)));
		// Red here means: the page is built, so its acceptance suite belongs in the gate — add a
		// tests/unit wrapper importing tests/openviking-dashboard/*.test.ts, as backend #132 did.
		expect(wrappers.length).toBeGreaterThan(0);
	});
});
