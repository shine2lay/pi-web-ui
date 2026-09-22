import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalManager } from "../../server/terminals.js";
import type { ServerMessage, TerminalInfo } from "../../server/protocol.js";

/**
 * 终端启动目录（terminal-cwd-anywhere 补丁）。
 *
 * 上游把 PTY 的启动目录限制在工作区内（safeCwd 做 relative() 包含检查），越界
 * 报「Terminal cwd must be inside the current workspace」。但终端是交互式
 * shell：开出来第一件事就可以 `cd /anywhere`，所以这个检查拦不住任何东西，只
 * 是让「在另一个仓库开个终端」这种日常操作做不了（多仓库工作流、agent 的
 * terminal_create 想去别的 checkout 跑命令）。真正的边界是访问控制：服务端默认
 * 只听 127.0.0.1 且每条连接都要 token。
 *
 * 保留的约束只有一条：目录必须真实存在（否则 PTY 根本起不来），报错要说清楚是
 * 哪个路径不存在，而不是谎称「必须在工作区内」。
 *
 * 零端口、零真 PTY：只桩掉 spawnShell，其余走真实现。
 */

const managers: TerminalManager[] = [];
const tmpDirs: string[] = [];
afterEach(() => {
	for (const tm of managers.splice(0)) tm.killAll();
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpDir(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	tmpDirs.push(d);
	return d;
}

interface Fixture {
	tm: TerminalManager;
	events: ServerMessage[];
	spawnedCwds: string[];
	workspace: string;
}

function fixture(): Fixture {
	const events: ServerMessage[] = [];
	const spawnedCwds: string[] = [];
	const workspace = tmpDir("pi-ws-");
	const tm = new TerminalManager(
		(event) => events.push(event),
		workspace,
		() => "en",
	);
	managers.push(tm);
	// 只假装分配 PTY：记录真正拿到的启动目录。
	(tm as unknown as { spawnShell: unknown }).spawnShell = function (
		this: TerminalManager,
		id: string,
		cwd: string,
		cols: number,
		rows: number,
		title: string,
		_command?: string,
		_forceBash?: boolean,
		agentBash?: boolean,
	): boolean {
		spawnedCwds.push(cwd);
		const entry = {
			id,
			cwd,
			cols,
			rows,
			title,
			command: undefined,
			agentBash: agentBash ?? false,
			locale: undefined,
			exited: false,
			exitCode: null,
			output: "",
			outputOffset: 0,
			waiters: new Set(),
			pendingOut: "",
			flushTimer: null,
			agentTouched: false,
			lastActivityAt: Date.now(),
			idleTimer: null,
			watches: [],
			pty: Object.assign(new EventEmitter(), {
				pid: 1234,
				write() {},
				resize() {},
				kill() {},
				onData() {
					return { dispose() {} };
				},
				onExit() {
					return { dispose() {} };
				},
			}),
		};
		(this as unknown as { terms: Map<string, unknown> }).terms.set(id, entry);
		return true;
	};
	(tm as unknown as { writeWhenReady: unknown }).writeWhenReady = () => {};
	return { tm, events, spawnedCwds, workspace };
}

/** 失败反馈（fail() 会发一条 terminal_error / notice 类消息）。 */
function errorTexts(events: ServerMessage[]): string[] {
	return events
		.map((e) => (e as { text?: string; textEn?: string }).textEn ?? (e as { text?: string }).text ?? "")
		.filter(Boolean);
}

describe("terminal start directory", () => {
	it("starts a terminal in a directory OUTSIDE the workspace", () => {
		const { tm, spawnedCwds, workspace } = fixture();
		const elsewhere = tmpDir("pi-other-repo-");

		const info = tm.create("t1", elsewhere, 80, 24, workspace, "other repo");

		expect(info).not.toBeNull();
		expect((info as TerminalInfo).cwd).toBe(realish(elsewhere));
		expect(spawnedCwds).toEqual([realish(elsewhere)]);
	});

	it("still resolves a relative cwd against the workspace root", () => {
		const { tm, spawnedCwds, workspace } = fixture();
		const nested = join(workspace, "sub");
		mkdirSync(nested, { recursive: true });

		const info = tm.create("t2", "sub", 80, 24, workspace, "nested");

		expect(info).not.toBeNull();
		expect(spawnedCwds).toEqual([realish(nested)]);
	});

	it("rejects a directory that does not exist, naming the path", () => {
		const { tm, events, workspace } = fixture();
		const missing = join(workspace, "no-such-dir");

		const info = tm.create("t3", missing, 80, 24, workspace, "missing");

		expect(info).toBeNull();
		const texts = errorTexts(events).join("\n");
		expect(texts).toContain("not an existing directory");
		expect(texts).toContain(missing);
		// 不再谎称是工作区边界问题。
		expect(texts).not.toContain("inside the current workspace");
	});

	it("rejects a path that is a file rather than a directory", () => {
		const { tm, events, workspace } = fixture();
		const file = join(workspace, "a-file.txt");
		writeFileSync(file, "x");

		const info = tm.create("t4", file, 80, 24, workspace, "file");

		expect(info).toBeNull();
		expect(errorTexts(events).join("\n")).toContain("not an existing directory");
	});

	it("runCommand also accepts a cwd outside the workspace", () => {
		const { tm, spawnedCwds, workspace } = fixture();
		const elsewhere = tmpDir("pi-cmd-cwd-");

		tm.runCommand("c1", { name: "ls", command: "ls", cwd: elsewhere }, 80, 24, workspace);

		expect(spawnedCwds).toEqual([realish(elsewhere)]);
	});
});

/** macOS 的 /tmp 是 /private/tmp 的符号链接——比较时统一走 realpath。 */
function realish(p: string): string {
	return realpathSync(p);
}
