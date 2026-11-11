/**
 * OpenViking Memory Dashboard — the UI acceptance suite written in Task 1 (frontend #261).
 *
 * It runs on its own config, outside the unit gate's `tests/unit/**` include, for the same reason
 * Backend's Task 1 suite did (`server/openviking-dashboard.test.ts`, backend #131): the assertions
 * are written before the page exists, so they stay red until Task 2 (#258) builds the seam. Keeping
 * them out of the gate leaves `wt check` honest meanwhile, while
 * `tests/unit/openviking-dashboard-ui-contract.test.ts` holds the suite inside the gate: it may not
 * shrink, and it must join the gate once the page is built.
 *
 *   npm run test:openviking-dashboard
 *
 * Task 2 (#258): when the suite is green, add a wrapper under `tests/unit/` that imports each file
 * (with its own `@vitest-environment jsdom` docblock), exactly as backend #132 did.
 */

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { localVitestWorkers } from "../../scripts/vitest-workers.mjs";
import { HANG_GUARD_MS } from "../unit/load-independent.js";

export default defineConfig({
	root: fileURLToPath(new URL("../../", import.meta.url)),
	test: {
		include: ["tests/openviking-dashboard/**/*.test.ts"],
		// Node by default; the rendered-page files ask for jsdom in their own `@vitest-environment` docblock.
		environment: "node",
		maxWorkers: localVitestWorkers(),
		testTimeout: HANG_GUARD_MS,
		hookTimeout: HANG_GUARD_MS,
		expect: { poll: { timeout: HANG_GUARD_MS } },
		setupFiles: ["tests/unit/setup-hang-guards.ts"],
		silent: true,
		onConsoleLog: () => false,
	},
});
