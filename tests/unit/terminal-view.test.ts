import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { makeTerminalBashTool, TerminalManager } from "../../server/terminals.js";
import type { ServerMessage, TerminalInfo } from "../../server/protocol.js";

/**
 * 浏览器终端视图的挂载语义（`TerminalManager.openView`，issue #147）。
 *
 * 前端 `TermXterm` 每次挂载都会发 `terminal_create` —— 包括已经跑完的 AI bash
 * 终端。老路由直接调 `create()`：已退出的终端被**重启**，历史输出丢掉，而且视图
 * 请求不带 `agentBash: true`，重建出来的是普通用户 shell。刷新几次页面就能攒出
 * 十几个空闲 shell 占满「16 个用户终端」上限，于是长任务里反复弹
 * 「终端数量已达上限（16）」（实测 91 个子进程 = conhost 55 + bash 36）。
 *
 * `openView()` 的三条不变量：活着的终端直接贴回、已结束的只做展示、缺失的
 * `ai-bash*` 只回一条 exit 事件（这些 id 只能由 bash 工具创建）。显式的
 * `create()` / `runCommand()` 保持原来的重启语义。
 *
 * 零 token、零端口：只桩掉 PTY 分配（spawnShell），准入/历史/输出/退出/attach/
 * resize/kill/runCommand 全部走真实实现；末尾另有一条**真 PTY** 回归。
 */

const root = tmpdir();

interface Fixture {
	tm: TerminalManager;
	events: ServerMessage[];
	spawns: { id: string; agentBash: boolean; forceBash?: boolean; locale?: string }[];
	kills: string[];
	create: (id: string, agentBash?: boolean) => TerminalInfo | null;
	finish: (id: string, agentBash?: boolean) => unknown;
}

const managers: TerminalManager[] = [];
afterEach(() => {
	for (const tm of managers.splice(0)) tm.killAll();
});

/** openView 在未打补丁的树上不存在 —— 回落 create() 让同一批用例复现原缺陷。 */
function openView(tm: TerminalManager, id: string, opts?: { locale?: string }): TerminalInfo | null {
	const method = (tm as unknown as { openView?: TerminalManager["create"] }).openView ?? tm.create;
	return method.call(tm, id, root, 80, 24, root, id, opts) as TerminalInfo | null;
}

function fixture(): Fixture {
	const events: ServerMessage[] = [];
	const spawns: Fixture["spawns"] = [];
	const kills: string[] = [];
	const tm = new TerminalManager(
		(event) => events.push(event),
		root,
		() => "en",
	);
	managers.push(tm);
	// 只假装分配 PTY，其余全用真实现。
	(tm as unknown as { spawnShell: unknown }).spawnShell = function (
		this: TerminalManager,
		id: string,
		cwd: string,
		cols: number,
		rows: number,
		title: string | undefined,
		command: string | undefined,
		forceBash?: boolean,
		agentBash = false,
		locale?: string,
	): boolean {
		const entry = {
			id,
			cwd,
			cols,
			rows,
			title,
			command,
			agentBash,
			locale,
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
			pty: {
				kill() {
					kills.push(id);
				},
				resize() {},
				write() {},
				onData() {
					return { dispose() {} };
				},
			},
		};
		spawns.push({ id, agentBash, forceBash, locale });
		(this as unknown as { terms: Map<string, unknown> }).terms.set(id, entry);
		return true;
	};
	(tm as unknown as { writeWhenReady: unknown }).writeWhenReady = () => {};
	const create = (id: string, agentBash = false): TerminalInfo | null =>
		tm.create(id, root, 120, 40, root, id, { forceBash: true, agentBash });
	const finish = (id: string, agentBash = false): unknown => {
		expect(create(id, agentBash)).toBeTruthy();
		(tm as unknown as { note(id: string, text: string): void }).note(id, "saved output\r\n");
		(tm as unknown as { exit(id: string, code: number): void }).exit(id, 7);
		return (tm as unknown as { find(id: string): unknown }).find(id);
	};
	return { tm, events, spawns, kills, create, finish };
}

const find = (tm: TerminalManager, id: string): { id: string; output: string; exited: boolean } =>
	(tm as unknown as { find(id: string): { id: string; output: string; exited: boolean } }).find(id);

describe("终端视图挂载（openView，issue #147）", () => {
	it("已结束的 AI bash 反复被查看：输出/退出码/归属都在，且不再起进程", () => {
		const { tm, spawns, finish } = fixture();
		const entry = finish("ai-bash-1", true) as { id: string; output: string };
		const output = entry.output;
		for (let i = 0; i < 20; i++) {
			const info = openView(tm, entry.id)!;
			expect(info.running).toBe(false);
			expect(info.agentBash).toBe(true);
			expect(info.exitCode).toBe(7);
			expect(find(tm, entry.id)).toBe(entry);
			expect(entry.output).toBe(output);
		}
		expect(spawns).toHaveLength(1);
		expect(tm.countLive()).toBe(0);
	});

	it("32 个已完成的 AI 视图全部挂载也不吃用户终端名额", () => {
		const { tm, finish, spawns, events } = fixture();
		const ids = Array.from({ length: 32 }, (_, i) => `ai-bash-${i + 1}`);
		for (const id of ids) finish(id, true);
		for (const id of ids) expect(openView(tm, id)?.running).toBe(false);
		expect(tm.countLive()).toBe(0);
		expect(spawns).toHaveLength(32);
		expect(openView(tm, "user-new")).toBeTruthy();
		expect(tm.countLive()).toBe(1);
		expect(events.some((e) => e.type === "notice" && /limit reached/i.test(e.textEn ?? ""))).toBe(false);
	});

	it("已结束的用户终端同样只做展示，显式重开才重启", () => {
		const { tm, finish, spawns, create } = fixture();
		const old = finish("user-old") as { id: string };
		expect(openView(tm, old.id)!.running).toBe(false);
		expect(spawns).toHaveLength(1);
		expect(find(tm, old.id)).toBe(old);
		expect(create(old.id)!.running).toBe(true);
		expect(spawns).toHaveLength(2);
		expect(find(tm, old.id)).not.toBe(old);
	});

	it("贴回活着的终端：既不换实例也不改 AI/用户归属", () => {
		const { tm, create, spawns } = fixture();
		create("ai-bash", true);
		const live = find(tm, "ai-bash");
		for (let i = 0; i < 10; i++) expect(openView(tm, live.id)!.agentBash).toBe(true);
		expect(find(tm, live.id)).toBe(live);
		expect(spawns).toHaveLength(1);
		expect(tm.countLive()).toBe(1);
	});

	it("新用户标签照常开 shell，保留 locale，非法 id/越界 cwd 仍被拒", () => {
		const { tm, spawns, events } = fixture();
		expect(openView(tm, "user-new", { locale: "en" })!.agentBash).toBe(false);
		expect(spawns[0].locale).toBe("en");
		expect(openView(tm, "../invalid")).toBeNull();
		const method = (tm as unknown as { openView?: TerminalManager["create"] }).openView ?? tm.create;
		expect(method.call(tm, "outside", homedir(), 80, 24, root, "outside")).toBeNull();
		expect(spawns).toHaveLength(1);
		expect(events.some((e) => e.type === "notice")).toBe(true);
	});

	it("缺失/被淘汰的 AI 终端视图不会顶替出一个新 shell", () => {
		const { tm, spawns, events } = fixture();
		for (const id of ["ai-bash", "ai-bash-1", "ai-bash-999"]) {
			expect(openView(tm, id)).toBeNull();
			expect(events.some((e) => e.type === "terminal_exit" && e.terminalId === id)).toBe(true);
		}
		expect(spawns).toHaveLength(0);
		expect(tm.countLive()).toBe(0);
		expect(events.some((e) => e.type === "notice")).toBe(false);
	});

	it("历史淘汰掉的 AI 条目不会被过期标签页复活", () => {
		const { tm, finish, spawns } = fixture();
		for (let i = 0; i < 33; i++) finish(`ai-bash-${i + 1}`, true);
		expect((tm as unknown as { has(id: string): boolean }).has("ai-bash-1")).toBe(false);
		expect(openView(tm, "ai-bash-1")).toBeNull();
		expect(spawns).toHaveLength(33);
		expect(tm.countLive()).toBe(0);
	});

	it("16 个活跃用户终端的上限仍然生效，贴回活/历史终端不受限", () => {
		const { tm, create, finish, spawns } = fixture();
		const history = finish("user-history") as { id: string };
		for (let i = 0; i < 16; i++) create(`user-${i}`);
		expect(tm.countLive()).toBe(16);
		expect(openView(tm, history.id)?.running).toBe(false);
		expect(find(tm, history.id)).toBe(history);
		expect(openView(tm, "user-0")?.running).toBe(true);
		expect(openView(tm, "user-over-limit")).toBeNull();
		expect(spawns).toHaveLength(17);
		expect(create("ai-bash-100", true)?.running).toBe(true);
		expect(tm.countLive()).toBe(17);
	});

	it("显式重开/重跑仍需先过准入，不会白白丢掉保留的历史", () => {
		const { tm, create, finish } = fixture();
		const history = finish("user-history") as { id: string };
		for (let i = 0; i < 16; i++) create(`user-${i}`);
		expect(create(history.id)).toBeNull();
		tm.runCommand(history.id, { command: "echo rerun", name: "rerun" }, 80, 24, root);
		expect(find(tm, history.id)).toBe(history);
		expect(tm.countLive()).toBe(16);
	});

	it("显式 runCommand 可以重启已结束的终端，也能就地重启活着的", () => {
		const { tm, finish, spawns, kills } = fixture();
		const old = finish("command") as { id: string };
		// 上游 v0.94（issue #269）：进程一退出就释放 PTY 句柄，所以 finish 本身就记一次 kill。
		expect(kills).toEqual([old.id]);
		tm.runCommand(old.id, { command: "echo rerun", name: "rerun" }, 80, 24, root);
		expect(find(tm, old.id).exited).toBe(false);
		expect(spawns).toHaveLength(2);
		// 重启已结束的终端不再 kill 任何东西。
		expect(kills).toEqual([old.id]);
		tm.runCommand(old.id, { command: "echo again", name: "again" }, 80, 24, root);
		expect(spawns).toHaveLength(3);
		// 就地重启活着的终端：恰好再 kill 一次。
		expect(kills).toEqual([old.id, old.id]);
	});

	it("浏览器 WebSocket 路由真的走 openView，而不是显式 create", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const source = readFileSync(join(here, "../../server/index.ts"), "utf8");
		const route = source.slice(source.indexOf('case "terminal_create":'), source.indexOf('case "terminal_input":'));
		expect(route).toMatch(/tm\.openView\(/);
		expect(route).not.toMatch(/tm\.create\(/);
	});

	it("真 PTY：跑完的 bash 命令被反复挂载后仍是已结束状态", { timeout: 20000 }, async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-terminal-view-test-"));
		const bus = new EventEmitter();
		const tm = new TerminalManager(
			(e) => bus.emit("message", e),
			cwd,
			() => "en",
		);
		const tool = makeTerminalBashTool(tm, {
			cwd,
			kills: new Set(),
			idleMs: () => 15000,
			defaultPersist: () => false,
			lang: () => "en",
			notifyBackgroundDone: () => {},
		});
		try {
			const result = (await tool.execute(
				"test",
				{ command: 'printf "retained-history\\n"', timeout: 5 },
				new AbortController().signal,
				undefined,
				undefined as never,
			)) as { details: { exitCode: number } };
			expect(result.details.exitCode).toBe(0);
			const id = tm.list()[0].id;
			if (!find(tm, id).exited) {
				await new Promise<void>((resolve, reject) => {
					const onEvent = (e: ServerMessage): void => {
						if (e.type === "terminal_exit" && e.terminalId === id) {
							cleanup();
							resolve();
						}
					};
					const timer = setTimeout(() => {
						cleanup();
						reject(new Error("PTY did not exit"));
					}, 5000);
					const cleanup = (): void => {
						clearTimeout(timer);
						bus.off("message", onEvent);
					};
					bus.on("message", onEvent);
				});
			}
			const entry = find(tm, id);
			const output = entry.output;
			expect(output).toMatch(/retained-history/);
			for (let i = 0; i < 20; i++) {
				const view = openView(tm, id)!;
				expect(view.running).toBe(false);
				expect(view.agentBash).toBe(true);
				expect(find(tm, id)).toBe(entry);
			}
			expect(tm.countLive()).toBe(0);
			expect(entry.output).toBe(output);
		} finally {
			tm.killAll();
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
