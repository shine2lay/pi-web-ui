/** Opt-in local proof only: never imports a user's installed queue or starts a server/model. */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { HANG_GUARD_MS } from "./tests/unit/load-independent.js";
import { queueSourcePath } from "./tests/coupled/queue-source-path.js";

const source = queueSourcePath();
export default defineConfig({
	resolve: {
		// pi-queue has no local dependencies: use this host's real packages, never its test stubs.
		alias: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "typebox"].map((name) => ({
			find: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
			replacement: fileURLToPath(import.meta.resolve(name)),
		})),
	},
	test: {
		include: ["tests/coupled/queue-question-native.test.ts", "tests/coupled/queue-owner-relay-native.test.ts"],
		environment: "node",
		fileParallelism: false,
		server: { deps: { inline: [new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))] } },
		testTimeout: HANG_GUARD_MS,
		hookTimeout: HANG_GUARD_MS,
		setupFiles: ["tests/coupled/setup-question-sandbox.ts", "tests/unit/setup-hang-guards.ts"],
		silent: true,
		onConsoleLog: () => false,
	},
});
