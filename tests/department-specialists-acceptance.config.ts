import { defineConfig } from "vitest/config";

// department-specialists acceptance (Ops #1097, Rule 18 Task 1): red until Task 2 builds the seams, so it stays out of
// tests/unit (the land gate). Task 2 moves the file into tests/unit/ and deletes this config.
export default defineConfig({
	test: {
		include: ["tests/department-specialists-acceptance.test.ts"],
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
