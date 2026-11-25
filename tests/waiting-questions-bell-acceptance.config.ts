import { defineConfig } from "vitest/config";

// waiting-questions bell (Ops #1089 Task 1): runs the WQ-1..WQ-6 acceptance cases on their own, outside the land gate
// (vitest.config.ts takes tests/unit/ only) while they are RED on the un-wired server and top bar. Task 2 moves the
// file into tests/unit/ and deletes this config.
//   TZ=UTC scripts/sealed.sh npx vitest run --config tests/waiting-questions-bell-acceptance.config.ts
export default defineConfig({
	test: {
		include: ["tests/waiting-questions-bell-acceptance.test.ts"],
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
