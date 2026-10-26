import { defineConfig } from "vitest/config";
import { BaseSequencer, type TestSpecification } from "vitest/node";

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
		// 纯函数单测：毫秒级、零 token、零端口 —— CI 必跑。
		// 端到端脚本（tests/*-test.mjs）不在这里：它们自起 server，用
		// `npm run test:smoke` / 单独 node 运行。
		include: ["tests/unit/**/*.test.ts"],
		environment: "node",
		setupFiles: ["tests/unit/setup-temp-pi-dirs.ts", "tests/unit/setup-chrome-i18n.ts"],
		silent: true,
		onConsoleLog: () => false,
	},
});
