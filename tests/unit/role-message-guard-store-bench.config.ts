import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Ops #233 (docs/guard-store-perf.md): the guard store benchmark runs only on this config, never in the suite.
export default defineConfig({
	root: fileURLToPath(new URL("../..", import.meta.url)),
	test: {
		include: ["tests/unit/role-message-guard-store-bench.ts"],
		environment: "node",
		setupFiles: ["tests/unit/setup-temp-pi-dirs.ts", "tests/unit/setup-chrome-i18n.ts"],
		testTimeout: 7_200_000,
	},
});
