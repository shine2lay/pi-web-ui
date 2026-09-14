import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { makeTerminalBashTool, type TerminalManager } from "../../server/terminals.js";

/** 终端接管 bash 的前置取值路径（issue #121）。
 *
 * `detectTrailingLimiter()` 对「没有尾部限输出管道」的命令返回 null（`date`、
 * `ls | head -5` 都算），而 issue #91 v2 的 hoist 重构把原本的可选链写成了
 * 非空断言 `limiter!.segment` —— 运行时直接 TypeError「Cannot read properties
 * of null (reading 'segment')」，几乎所有一次性 bash 调用全挂。
 *
 * 真 PTY 的端到端覆盖在 tests/terminal-bash-test.mjs；这里用桩 TerminalManager
 * 把流程顶到「命令已下发」这一步就收手（inputChecked 返回错误字符串 → 工具立即
 * 抛错返回），毫秒级、零 token、CI 必跑：只要 limiter 为 null 时再被裸解引用，
 * 抛出的就不会是这里的桩错误。 */

/** 桩：create/suspendIdleWatch/endCursor/setSentinelPending 只求不炸，
 *  inputChecked 记下真正下发的命令行并回一个错误让工具立刻收手。
 *
 *  命令现在跑在**脚本文件**里（MAX_CANON 截断修复，writeTerminalBashScript），
 *  PTY 里只输入一行短的 `: pi-bash-N; . '<file>'`——所以这里在 inputChecked
 *  里顺手把脚本内容读出来（工具的 finally 删掉它之前），断言直接打在
 *  「真正执行的脚本」上，比看回显行更硬。 */
function makeStub(): { mgr: TerminalManager; sent: string[]; scripts: string[] } {
	const sent: string[] = [];
	const scripts: string[] = [];
	const mgr = {
		create: () => "ai-bash-1",
		suspendIdleWatch: () => {},
		endCursor: () => 0,
		setSentinelPending: () => {},
		note: () => {},
		inputChecked: (_id: string, data: string): string | null => {
			sent.push(data);
			const file = /\. '(.+?)'/.exec(data)?.[1];
			if (file) scripts.push(readFileSync(file, "utf8"));
			return "stub: input halted";
		},
	} as unknown as TerminalManager;
	return { mgr, sent, scripts };
}

async function run(command: string): Promise<{ err: unknown; sent: string[]; scripts: string[] }> {
	const { mgr, sent, scripts } = makeStub();
	const tool = makeTerminalBashTool(mgr, {
		cwd: process.cwd(),
		defaultPersist: () => false,
		idleMs: () => 0,
		kills: new Set(),
		notifyBackgroundDone: () => {},
	});
	let err: unknown = null;
	try {
		await tool.execute("t1", { command }, undefined, undefined, undefined as never);
	} catch (e) {
		err = e;
	}
	return { err, sent, scripts };
}

describe("bash 工具：无尾部限输出管道时不崩（issue #121）", () => {
	it("裸命令（limiter=null）照常下发，不再抛 null 解引用", async () => {
		const { err, sent, scripts } = await run("date");
		expect((err as Error)?.message).toBe("stub: input halted");
		expect(sent).toHaveLength(1);
		expect(scripts[0]).toContain("date");
	});

	it("管道非限输出命令（| head）同样按原命令下发", async () => {
		const { err, scripts } = await run("ls | head -5");
		expect((err as Error)?.message).toBe("stub: input halted");
		expect(scripts[0]).toContain("ls | head -5");
	});

	it("尾部限输出管道（| tail -3）仍被拆掉：只跑底层命令", async () => {
		const { err, scripts } = await run("seq 1 30 | tail -3");
		expect((err as Error)?.message).toBe("stub: input halted");
		expect(scripts[0]).toContain("seq 1 30");
		expect(scripts[0]).not.toContain("| tail");
	});

	it("命令跑在脚本文件里：PTY 里只输入一行短的 source 行（MAX_CANON 修复）", async () => {
		const long = `echo ${"x".repeat(4000)}`;
		const { err, sent, scripts } = await run(long);
		expect((err as Error)?.message).toBe("stub: input halted");
		// 输入行远低于 macOS 的 1024 字节规范化模式缓冲上限，且不带命令本文。
		expect(sent[0].length).toBeLessThan(200);
		expect(sent[0]).not.toContain("xxxx");
		expect(sent[0]).toMatch(/^: pi-bash-\d+; \. '.+' \|\| printf /);
		// 脚本里才是完整命令 + 退出码护栏 + 哨兵。
		expect(scripts[0]).toContain(long);
		expect(scripts[0]).toContain("__pi_rc");
		expect(scripts[0]).toContain("[pi-exit:%s]");
	});
});
