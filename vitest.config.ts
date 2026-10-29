import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";
import { HANG_GUARD_MS } from "./tests/unit/load-independent.js";

// Ops #230 (docs/test-speed.md): the slowest test files start first, so they never wait behind the larger files
// (vitest's own order puts larger files first when it has no timings from an earlier run, as in a land's fresh copy).
// Ops #558 (H-SOAK-ALS-2): the late-handoff soak, the land's longest file, in a file of its own, then worst-window.
const SLOWEST_FIRST = [
	"tests/unit/role-message-guard-host-late-handoff-soak.test.ts",
	"tests/unit/role-message-guard-host-worst-window.test.ts",
];
class SlowestFirst extends BaseSequencer {
	override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
		const sorted = await super.sort(files);
		const slow = (f: TestSpecification) => SLOWEST_FIRST.some((name) => f.moduleId.endsWith(`/${name}`));
		return [...sorted.filter(slow), ...sorted.filter((f) => !slow(f))];
	}
}

export default defineConfig({
	test: {
		sequence: { sequencer: SlowestFirst },
		// Ops #639 (docs/gate-time.md): a test's time limit is only a hang guard, never its verdict. vitest's
		// defaults (5 s a test, 10 s a hook) failed tests that were merely sharing a busy machine; 5 minutes is
		// far past any test's run at load 100, and still ends a test that hangs. A test that needs longer sets its
		// own, larger guard; none sets a smaller one. What a test checks about speed it checks on a CPU clock or a
		// work count (tests/unit/load-independent.ts).
		testTimeout: HANG_GUARD_MS,
		hookTimeout: HANG_GUARD_MS,
		// expect.poll's default 1 s likewise; vi.waitFor/vi.waitUntil get theirs in setup-hang-guards.ts.
		expect: { poll: { timeout: HANG_GUARD_MS } },
		// 纯函数单测：毫秒级、零 token、零端口 —— CI 必跑。
		// 端到端脚本（tests/*-test.mjs）不在这里：它们自起 server，用
		// `npm run test:smoke` / 单独 node 运行。
		include: ["tests/unit/**/*.test.ts"],
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
