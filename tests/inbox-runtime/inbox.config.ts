import { defineConfig } from "vitest/config";
import base from "../../vitest.config.js";

// Opt-in RED suite, outside tests/unit defaults and ordinary CI.
export default defineConfig({ ...base, test: {
	...base.test,
	include: ["tests/inbox-runtime/inbox-*.test.ts"],
	maxWorkers: 10,
} });
