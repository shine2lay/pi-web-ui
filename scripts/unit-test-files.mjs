/**
 * unit-test-files.mjs: which files are the unit test files, the ones `npm test` (vitest.config.ts `include`) runs
 * (Ops #693, docs/gate-selected-tests.md). scripts/select-tests.mjs checks that vitest.config.ts still says the same.
 */
export const UNIT_TEST_INCLUDE = "tests/unit/**/*.test.ts";

/** Whether `path` (from the top of the repo) is a unit test file. */
export function isUnitTestFile(path) {
	return /^tests\/unit\/(?:[^/]+\/)*[^/]+\.test\.ts$/.test(path);
}
