import { defineConfig } from "vitest/config";
import { join } from "node:path";

// The old-code control uses the same assertions, with only the four reviewed modules replaced.
const baseline = process.env.DURABLE_REVIEW_SOURCE_ROOT;
export default defineConfig({
	resolve: {
		alias: baseline
			? ["durable-driver", "addon-bridges", "session-state", "models-adapter"].map((name) => ({
					find: `../server/durable/${name}.js`,
					replacement: join(baseline, "server", "durable", `${name}.ts`),
				}))
			: [],
	},
	test: {
		include: ["tests/durable-driver-review.test.ts", "tests/durable-driver.test.ts"],
		environment: "node",
		setupFiles: ["tests/unit/setup-temp-pi-dirs.ts", "tests/unit/setup-chrome-i18n.ts"],
		silent: true,
		onConsoleLog: () => false,
	},
});
