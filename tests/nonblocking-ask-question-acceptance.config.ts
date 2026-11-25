import { defineConfig } from "vitest/config";

// nonblocking-ask (Ops #1086 Task 1): runs the NB-1..NB-6 acceptance cases on their own, outside the land gate
// (vitest.config.ts takes tests/unit/ only) while they are RED on the synchronous ask_user_question. Task 2 moves the
// file into tests/unit/ and deletes this config.
//   TZ=UTC scripts/sealed.sh npx vitest run --config tests/nonblocking-ask-question-acceptance.config.ts
export default defineConfig({
	test: {
		include: ["tests/nonblocking-ask-question-acceptance.test.ts"],
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
