# PATCHES.md — 这个 fork 相对上游的改动

Fork of [`xing-shuyin/pi-web-ui`](https://github.com/xing-shuyin/pi-web-ui) (MIT).

- `main` = 上游镜像，**不要**在上面改东西（`git fetch upstream && git merge --ff-only upstream/main`）。
- `mine` = 上游某个 tag + 下面这些补丁，一个补丁一个 commit，commit 标题 = 这里的小节标题。
- 每次上游发版：`scripts/sync-upstream.sh <tag>`（rebase `mine`）→ 跑 `scripts/check.sh` → 更新本文件的「状态」。
- 状态生命周期：`local` →（提了 PR）`PR #N` →（上游合了）`merged vX.Y.Z` → 下次 rebase 时**删掉该 commit**。

上游节奏很快（一天两三个版本），不必追每个 tag：按需（想要某个修复/功能时）或每周同步一次即可。

| 补丁                    | 状态    | 主要文件                                                   |
| ----------------------- | ------- | ---------------------------------------------------------- |
| terminal-bash-script    | `local` | `server/terminals.ts`                                      |
| terminal-view-lifecycle | `local` | `server/terminals.ts`, `server/index.ts`                   |
| global-history          | `local` | `server/agent-service.ts`, `server/protocol.ts`, `web/src/` |

---

## terminal-bash-script

**状态**：`local`（上游未提 issue/PR；bug 对所有 macOS 用户都成立，值得上游）
**基线**：v0.85.0

### 问题

开「终端接管 bash」后，工具 spawn `bash -i` 并**立刻**把整条命令行写进 PTY。此时 shell
还没接管 readline，tty 处于规范化（canonical）模式，整行由**内核**缓冲，上限
`MAX_CANON` = **macOS 1024** / Linux 4095 字节。超出部分被静默丢弃 —— 连收尾引号、
哨兵、换行一起没了，shell 一直等这行剩下的部分，工具只能等到超时才返回
（"Command timed out after 30s"）。多行命令先被折成一行 `eval $'…'`，只会更长。
实测：1136 字节的输入行在第 1024 字节被切断。

另一个独立挂死：`git log/show/diff` 在 PTY 里开 `less` 等按键，模型按不了。

### 改法（都在 `server/terminals.ts`）

1. **命令写进脚本文件，只输入一行短的**。命令原样写进私有脚本
   （`/tmp/pi-web-ui-<uid>/<pid>-<n>.sh`，目录 0700、文件 0600），PTY 里只收到
   `: pi-bash-N; . '<file>' || printf '\n[pi-exit:%s]\n' "$?"`（约 80 字节，远低于上限，
   也不到一行 120 列，回显不会折行）。**source 而不是 `bash <file>`**：cd/export/venv
   仍留在持久 `ai-bash` 终端里，与「输入命令」时完全一致。退出码护栏（`PIPESTATUS[0]`，
   141→0）与哨兵都在文件里；`||` 兜底保证文件 source 不了也有哨兵。命令跑完即删文件
   （后台仍在跑的保留，24 小时后清扫，进程退出时清）。写不了文件则回落老的输入形式。
2. **回显剥离锚定 `: pi-bash-N;`**（每次调用唯一），不再锚 `[pi-exit:%s]` —— 输出里
   正好包含该字面量的命令不会再被整段吞掉。
3. **命令横幅**（`$ <command>`，灰色）写进可见终端，因为命令本身不再被输入到那里。
4. **`PAGER=cat GIT_PAGER=cat`** 只给 AI shell（用户终端保留自己的分页器）。
5. **shell 提前退出的检测**：交互 shell 在打印哨兵前就死了（`exit N`，或 `set -e` 遇错
   —— 它确实会杀掉 `bash -i`）时，按 PTY 退出码带着已捕获的输出返回，不再空转到超时
   （无超时的调用则是永远挂着）。

新增导出：`buildTerminalBashScript` / `buildTerminalBashSourceLine` /
`writeTerminalBashScript` / `removeTerminalBashScript` / `cleanBashOutput(raw, anchor)`；
新增方法 `TerminalManager.note(id, text)`；`shellEnv(agentBash)`。

### 回归

- `tests/terminal-bash-script-test.mjs`（真 PTY，19 项；已进 `npm run test:smoke`）
- `tests/unit/terminal-bash-limiter.test.ts`：桩改为读**真正执行的脚本**，另加一条
  「输入行 < 200 字节且不含命令正文」的 MAX_CANON 断言
- 上游 `tests/terminal-bash-test.mjs`（真 PTY，63 项）保持全绿

---

## terminal-view-lifecycle

**状态**：`local`（上游 [issue #147](https://github.com/xing-shuyin/pi-web-ui/issues/147)
已确认并在 2026-09-14 标记「已修复、待发布」，但 v0.85.0 / `main` 里都还没有承载点。
**上游发版后先跑本仓 `tests/unit/terminal-view.test.ts`：过了就删掉这个 commit。**）
**基线**：v0.85.0

### 问题

前端 `TermXterm` 每次挂载都会发 `terminal_create` —— 包括已经跑完的 AI bash 终端。
老路由直接调 `create()`：已退出的终端被**重启**，历史输出丢掉；而视图请求不带
`agentBash: true`，重建出来的是普通用户 shell。刷新/切对话/重连几次就攒出十几个空闲
shell 占满「16 个活跃用户终端」上限，长任务里反复弹「终端数量已达上限（16）」。

### 改法

`TerminalManager.openView()`（`server/terminals.ts`）+ WebSocket 路由改调它
（`server/index.ts` 的 `case "terminal_create"`）：

- 活着的终端直接贴回（顺带 resize），不换实例、不改 AI/用户归属；
- 已结束的只做展示，保留输出、退出码与归属，不 spawn；
- 缺失/被淘汰的 `ai-bash` / `ai-bash-<n>` 只回一条 `terminal_exit`（这些 id 只能由
  bash 工具创建，过期标签页不许借它开用户 shell）；
- 未知的用户标签 id 照旧建 shell（浏览器新标签协议依赖这个）；
- 显式 `create()` / `runCommand()` 保持原来的重启语义与准入检查；
- 16 个活跃用户终端的上限不变，历史不计入，AI bash 仍豁免。

### 回归

`tests/unit/terminal-view.test.ts`（12 项：反复挂载、32 个已完成标签、历史淘汰、上限、
AI 豁免、显式重开、校验、WS 路由、真 PTY）

---

## global-history

**状态**：`local`（打算上游成一个设置项：History 范围 = 全部项目 / 当前项目）
**基线**：v0.85.0

### 问题

左栏 **History** 只列当前工作目录的转录（`SessionManager.list(this.cwd)` →
`~/.pi/agent/sessions/--<cwd>--/`），所以切项目（最近项目 / `set_cwd`）会把整列历史
换掉。想找别的文件夹里的旧对话，得先猜它属于哪个项目 —— 而「运行的对话」本来就是
跨项目显示的，两者口径不一致。

### 改法

- **服务端**（`server/agent-service.ts`）：新增 `historyScope()`，默认 `"all"` →
  `loadSessionInfos()` 走 `SessionManager.listAll()`（`pushProjects()` 本来就用它汇总
  最近项目），一次列出所有文件夹的对话，按时间倒序。3 秒列表缓存改成**按范围**做键，
  切工作目录不再重新解析全部转录。`pushSessions()` 与 `searchSessions()`（全局搜索）
  每条带上自己的 `cwd`。**`PI_WEB_UI_HISTORY_SCOPE=project` 切回原来的按文件夹**。
  删除**当前**对话时的回退目标仍然只看当前文件夹（删对话不该把人踢到别的项目）。
- **协议**（`server/protocol.ts`）：`SessionSummary.cwd?: string`。
- **前端**（`web/src/components/LeftPanel.tsx` + `styles.css`）：`cwd` 与当前工作目录
  不同的行加一个文件夹徽章（复用 `.session-src` 外观，`.session-cwd` 关掉大写化并限宽
  省略），`title` 是完整路径。服务端没发 `cwd` 时不渲染徽章（对老服务端无害）。

行为：列表不再随文件夹切换而变；点开别的文件夹的对话仍会跟着切到**该对话自己的 cwd**
（上游 `switchSession()` 的既有行为 —— 对话的 cwd 就是它工具运行的地方）。打开文件夹
仍会恢复该文件夹最近的对话（上游 `setCwd()`），但有了全局列表，除了「去别的目录新开
对话」基本用不到文件夹选择器了。每项目的并发对话上限不变。

代价：列表成本随**全部**转录的总大小增长（SDK 逐个流式解析），用 3 秒缓存兜着。

### 回归

- `tests/unit/global-history.test.ts`（7 项：范围开关、跨文件夹列表、缓存键、
  `scope=project` 回落、推送形状与排序、未请求不推、全局搜索带 cwd）
- `tests/unit/history-cwd-badge.test.ts`（5 项：真 jsdom + 真 React 渲染徽章规则）
