// department-specialists Phase 2 acceptance (Ops #1113): its own config, outside scripts/check.sh, because the suite
// is red until Ops #1117 (Task 2) builds the seam; #1117 moves the test into tests/unit and deletes this config.
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/department-specialists-collab-acceptance.test.ts"],
		environment: "node",
		setupFiles: [
			"tests/unit/setup-temp-pi-dirs.ts",
			"tests/unit/setup-chrome-i18n.ts",
			"tests/unit/setup-hang-guards.ts",
		],
		silent: true,
		onConsoleLog: () => false,
	},
});
