/* 终端接管 bash「脚本文件执行」回归（真实 PTY，不起 server、零 token）。
 *
 * 缺陷：工具 spawn `bash -i` 后**立刻**把整条命令行写进 PTY。此时 shell 还没
 * 接管 readline，tty 处在规范化（canonical）模式，整行由**内核**缓冲，上限
 * MAX_CANON = macOS 1024 / Linux 4095 字节。超出部分被**静默丢弃** —— 连收尾的
 * 引号、哨兵和换行一起没了，于是 shell 一直等这行的剩余部分，工具只能等到超时
 * 才返回（实测 1136 字节的输入行在第 1024 字节被截断）。多行脚本先被折成一行
 * `eval $'…'`，只会更长。另一个独立的挂死：`git log/show/diff` 在 PTY 里开
 * `less` 等按键，模型按不了。
 *
 * 修复：命令原样写进私有脚本（`/tmp/pi-web-ui-<uid>/<pid>-<n>.sh`，目录 0700、
 * 文件 0600），PTY 里只输入一行短的 `: pi-bash-N; . '<file>' || …`（约 80 字节，
 * 远低于上限、也不到一行 120 列，回显不会折行）。**source 而非 `bash <file>`**：
 * cd/export/venv 仍留在持久 ai-bash 终端里。另加 PAGER=cat/GIT_PAGER=cat（仅
 * AI shell）、shell 提前退出时按 PTY 退出码收尾、回显剥离锚定 `: pi-bash-N;`。
 *
 * Run:  npm run build:server && node tests/terminal-bash-script-test.mjs */
import { readdirSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new globalThis.URL("../", import.meta.url));
const { TerminalManager, makeTerminalBashTool, buildTerminalBashScript, buildTerminalBashSourceLine, cleanBashOutput } =
	await import(pathToFileURL(join(REPO, "dist", "server", "terminals.js")).href);

const cwd = mkdtempSync(join(tmpdir(), "piweb-tbash-script-"));
const emitted = [];
const tm = new TerminalManager(
	(msg) => emitted.push(msg),
	cwd,
	() => "en",
);
const tool = makeTerminalBashTool(tm, {
	cwd,
	kills: new Set(),
	idleMs: () => 15_000,
	defaultPersist: () => false,
	lang: () => "en",
	notifyBackgroundDone: () => {},
});

let failures = 0;
function check(name, cond, extra = "") {
	console.log(`  ${cond ? "✓" : "✗ FAIL:"} ${name}${extra ? "  -- " + extra : ""}`);
	if (!cond) failures++;
}
async function run(params, timeoutMs = 20_000) {
	const started = Date.now();
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(), timeoutMs);
	try {
		const r = await tool.execute("call", { timeout: Math.ceil(timeoutMs / 1000), ...params }, ac.signal);
		return { ok: true, text: r.content[0].text, exit: r.details.exitCode, ms: Date.now() - started };
	} catch (e) {
		return { ok: false, text: String(e?.message ?? e), exit: null, ms: Date.now() - started };
	} finally {
		clearTimeout(t);
	}
}
const oneLine = (s) => s.replace(/\s+/g, " ").slice(0, 160);

console.log("脚本与输入行形状（纯函数）");
{
	const script = buildTerminalBashScript("echo hi | cat\n", { file: "/tmp/x.log", lines: 3 });
	check(
		"脚本：命令在前，随后退出码护栏、tail、哨兵",
		/^echo hi \| cat\n__pi_rc=\$\{PIPESTATUS:-\$\?\}.*\ntail -n 3 -- '\/tmp\/x\.log'\nprintf '\\n\[pi-exit:%s\]\\n' "\$__pi_rc"\n$/s.test(
			script,
		),
		JSON.stringify(script),
	);
	const { line, anchor } = buildTerminalBashSourceLine("/tmp/pi-web-ui-501/37101-12.sh", 12);
	check("输入行很短（120 列下不会折行）", line.length < 100, `${line.length} bytes: ${line}`);
	check("锚点就是行首的 no-op", anchor === ": pi-bash-12;" && line.startsWith(anchor));
	const cleaned = cleanBashOutput(
		`banner noise\r\nbash-3.2$ : pi-bash-12; . '/tmp/x.sh' || printf '\\n[pi-exit:%s]\\n' "$?"\r\nreal output\r\n[pi-exit:0]\r\nbash-3.2$ `,
		anchor,
	);
	check("cleanBashOutput 按锚点剥回显、保留真实输出", cleaned === "real output", JSON.stringify(cleaned));
}

console.log("真实 PTY");
// 1. 超过 MAX_CANON（macOS 1024 字节）的单行：老的「直接输入」被 tty 截断并挂到超时。
const long = `echo start; : ${"x".repeat(1100)}; echo 'physical=24 GB'`;
check("夹具确实长于 MAX_CANON", Buffer.byteLength(long) > 1024, `${Buffer.byteLength(long)} bytes`);
let r = await run({ command: long });
check(
	"1. >1024 字节的单行命令正常跑完",
	r.ok && r.exit === 0 && /physical=\d+ GB/.test(r.text),
	`${r.ms}ms ${oneLine(r.text)}`,
);
check("1b. 回显的 source 行不会混进输出", !/pi-bash-/.test(r.text));

// 2. 多行 heredoc（老路径会被折成 eval $'…'）。
r = await run({
	command: "python3 - <<'EOF'\nimport sys\nprint('hello from heredoc', sys.version_info[0])\nEOF",
});
check(
	"2. heredoc 原样执行",
	r.ok && r.exit === 0 && /hello from heredoc 3/.test(r.text),
	`${r.ms}ms ${oneLine(r.text)}`,
);

// 3/4. 退出码语义不变（真实退出码 + PIPESTATUS[0]）。
r = await run({ command: "cd /tmp/definitely-missing-dir-xyz" });
check(
	"3. 失败命令报 exit 1 且带错误文本",
	r.ok && r.exit === 1 && /No such file|not found/i.test(r.text),
	oneLine(r.text),
);
r = await run({ command: "false | cat" });
check("4. `false | cat` 报 exit 1（PIPESTATUS）", r.ok && r.exit === 1, `exit=${r.exit}`);

// 5. git 不带 --no-pager 也不再挂（AI shell 的 GIT_PAGER=cat）。
r = await run({ command: `cd ${REPO} && git log -1 --format=%h` }, 15_000);
check(
	"5. git 不带 --no-pager 能返回（GIT_PAGER=cat）",
	r.ok && r.exit === 0 && /^[0-9a-f]{7,}$/m.test(r.text),
	`${r.ms}ms ${oneLine(r.text)}`,
);

// 6. 输出里出现老的格式串字面量不再被整段吞掉（回显剥离改锚 `: pi-bash-N;`）。
r = await run({ command: "echo 'literal [pi-exit:%s] in output'; echo '__pi_rc text too'" });
check(
	"6. 输出里像哨兵的文本不再被吞",
	r.ok && r.exit === 0 && r.text.includes("literal [pi-exit:%s] in output") && r.text.includes("__pi_rc text too"),
	oneLine(r.text),
);

// 7. 持久终端仍保留 shell 状态（source 而不是子 shell）。
r = await run({ command: "cd /tmp && export PI_TEST_STATE=kept", persist: true });
check("7a. persist：首次调用成功", r.ok && r.exit === 0, oneLine(r.text));
r = await run({ command: "pwd; echo state=$PI_TEST_STATE", persist: true });
check(
	"7b. persist：cd/export 跨调用保留",
	r.ok && r.exit === 0 && /\/tmp$/m.test(r.text) && /state=kept/.test(r.text),
	oneLine(r.text),
);

// 8. 尾部限输出管道（拆掉 tail 直跑 + 只返回末 N 行）在脚本模式下不变。
r = await run({ command: "printf 'a\\nb\\nc\\nd\\n' | tail -2" });
check(
	"8. 限输出管道路径仍返回末 2 行",
	r.ok && r.exit === 0 && /lines omitted above\]…\nc\nd\n/.test(r.text) && /detected a trailing/.test(r.text),
	oneLine(r.text),
);

// 9. shell 自己先退出（`exit`/`set -e`）时按 PTY 退出码立刻收尾，不再空转到超时。
r = await run({ command: "echo before; exit 3" }, 15_000);
check(
	"9. `exit 3` 立刻返回且退出码为 3",
	r.ok && r.exit === 3 && /before/.test(r.text) && r.ms < 10_000,
	`${r.ms}ms exit=${r.exit} ${oneLine(r.text)}`,
);

// 10. 引号与 Unicode 原样往返（不再过 eval $'…' 转义）。
r = await run({ command: `printf '%s\\n' "it's \\"quoted\\" — 员工 ✓"` });
check("10. 引号/Unicode 原样返回", r.ok && r.exit === 0 && r.text.includes(`it's "quoted" — 员工 ✓`), oneLine(r.text));

// 11. 脚本文件用完即删（持久终端的命令也跑完了）。
const scriptDir =
	process.platform === "win32" ? join(tmpdir(), "pi-web-ui-bash") : `/tmp/pi-web-ui-${process.getuid()}`;
let leftovers = [];
try {
	leftovers = readdirSync(scriptDir).filter((n) => n.startsWith(`${process.pid}-`));
} catch {
	// 目录不存在 = 没留下任何东西
}
check("11. 本进程没有残留脚本文件", leftovers.length === 0, `${scriptDir}: ${leftovers.join(",") || "clean"}`);

// 12. 命令改成在可见终端里打横幅（因为它不再被「输入」进去）。
const bannerSeen = emitted.some(
	(m) => m.type === "terminal_output" && typeof m.data === "string" && m.data.includes("\u001b[90m$ false\u001b[0m"),
);
check("12. 可见终端里有命令横幅", bannerSeen);

tm.killAll();
rmSync(cwd, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
