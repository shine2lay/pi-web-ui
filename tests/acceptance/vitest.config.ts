/** Ops #1055: stall watch whole-list acceptance (npm run test:stall-watch-whole-list). Outside the land gate's
 *  tests/unit until step 2 builds it; then step 2 moves the test into tests/unit and deletes this config. */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { HANG_GUARD_MS } from "../unit/load-independent.js";

export default defineConfig({
	root: fileURLToPath(new URL("../..", import.meta.url)),
	test: {
		include: ["tests/acceptance/stall-watch-whole-list.test.ts"],
		environment: "node",
		testTimeout: HANG_GUARD_MS,
		hookTimeout: HANG_GUARD_MS,
		setupFiles: ["tests/unit/setup-temp-pi-dirs.ts", "tests/unit/setup-hang-guards.ts"],
		silent: true,
		onConsoleLog: () => false,
	},
});
