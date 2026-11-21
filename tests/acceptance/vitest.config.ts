/** Ops #1058: silence watch acceptance (npm run test:silence-watch). Outside the land gate's tests/unit until
 *  step 2 (Ops #1059) builds it; then step 2 moves the test and its fixture folder into tests/unit and deletes
 *  this config. */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { HANG_GUARD_MS } from "../unit/load-independent.js";

export default defineConfig({
	root: fileURLToPath(new URL("../..", import.meta.url)),
	test: {
		include: ["tests/acceptance/silence-watch.test.ts"],
		environment: "node",
		testTimeout: HANG_GUARD_MS,
		hookTimeout: HANG_GUARD_MS,
		setupFiles: ["tests/unit/setup-temp-pi-dirs.ts", "tests/unit/setup-hang-guards.ts"],
		silent: true,
		onConsoleLog: () => false,
	},
});
