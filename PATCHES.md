# PATCHES.md — 这个 fork 相对上游的改动

Fork of [`xing-shuyin/pi-web-ui`](https://github.com/xing-shuyin/pi-web-ui) (MIT).

- `main` = 上游镜像，**不要**在上面改东西（`git fetch upstream && git merge --ff-only upstream/main`）。
- `mine` = 上游某个 tag + 下面这些补丁，一个补丁一个 commit，commit 标题 = 这里的小节标题。
- 每次上游发版：`scripts/sync-upstream.sh <tag>`（rebase `mine`）→ 跑 `scripts/check.sh` → 更新本文件的「状态」。
- 状态生命周期：`local` →（提了 PR）`PR #N` →（上游合了）`merged vX.Y.Z` → 下次 rebase 时**删掉该 commit**。

上游节奏很快（一天两三个版本），不必追每个 tag：按需（想要某个修复/功能时）或每周同步一次即可。

| 补丁                    | 状态    | 主要文件                                                         |
| ----------------------- | ------- | ---------------------------------------------------------------- |
| terminal-bash-script    | `local` | `server/terminals.ts`                                            |
| terminal-view-lifecycle | `local` | `server/terminals.ts`, `server/index.ts`                         |
| global-history          | `local` | `server/agent-service.ts`, `server/protocol.ts`, `web/src/`      |
| status-placement        | `local` | `web/src/status-placement.ts`, `FooterBar.tsx`, `RightPanel.tsx` |
| recent-chats            | `local` | `server/agent-service.ts`, `client-state.ts`, `web/src/`          |

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

---

## status-placement

**状态**：`local`（可上游：纯前端偏好，不动协议与服务端）
**基线**：v0.85.0

### 问题

底栏（`.statusbar`）把**所有**扩展状态拼成一行：
`chat.statuses.map(s => s.text).join(" · ")`。装几个扩展之后这行就爆了
（`mcp`「1 server enabled」、`pi-control-chrome`「ready」、`multi-pass` 的模型链、
`subagent-slash`…），连带着上下文条/累计费用/缓存命中/消息数/工作目录，
窄屏下直接溢出——真正要盯的那条（配额余量）反而被挤到看不见。

### 改法

按 key 给每条状态选位置，**钉住的进底栏，其余进右栏底部**（与 widgets 同一块区域，
沿用已有的分隔条/权重）：

- `web/src/status-placement.ts`：钉住列表（localStorage `pi-web-ui:statusbar-pinned`）
  - 纯函数 `splitStatuses()`。与 `title-settings.ts` 同构（纯浏览器偏好，不进
    server 快照）。默认只钉 `multi-pass-limits`（唯一一条「不看会踩坑」的状态）；
    存过空列表就尊重用户的「一条都不钉」，不再回落默认值。
- `FooterBar.tsx`：只渲染钉住的几条（各自一个 chip，单行省略、title 看全文，
  点一下收进右栏）。
- `RightPanel.tsx`：未钉住的渲染成 widget 同款卡片（标题 = 状态 key，点一下钉回底栏），
  底部区域的显示条件扩展为「widgets 或状态非空」。

语义：右栏收起时未钉住的状态就是不显示（用户选定的行为：要看就拉开右栏），
所以钉住的那几条 = 「无论如何都要看得见」。新增 i18n：`statusToPanel` / `statusToBar`
（zh/en + 8 个语言包同位置插入，`tests/unit/locales.test.ts` 锁顺序）。

### 回归

- `tests/unit/status-placement.test.ts`（14 项：规整/默认值/空列表语义/坏 JSON/
  分流顺序/撤销的状态两边都不显/toggle 落盘/隐私模式写不进去仍生效）
- `tests/unit/status-placement-ui.test.ts`（5 项：真 jsdom + 真 React，同一批状态在
  两处不重不漏，两个方向的点击换边）

---

## recent-chats

**状态**：`local`（想上游成设置项：左栏第一列 = 只列运行中 / 最近对话）
**基线**：v0.85.0

### 问题

左栏第一列叫「运行的对话」，只装**活着的运行时**：一条对话空闲后被换到后台
（`displaceActive()`）就从列表里消失了，想接着聊只能去下面的 History 里翻。
而且列表只有一种指示灯 —— 绿点闪 = 正在跑；**跑完灯就没了**，于是「哪几条在等我看」
这个最该一眼看见的信息，恰恰是列表唯一不显示的状态。

### 改法

- **列表常驻**（`server/agent-service.ts`）：`emitConversations()` 在活着的对话之后
  补上磁盘上最近 `recentChatLimit()`（默认 15，`PI_WEB_UI_RECENT_LIMIT=0` 关掉）条
  转录，作为 `live: false` 的行。数据直接复用 `pushSessions()` 已经解析好的那份列表
  （`recentSessions`，3 秒缓存），**不额外扫盘**；同一条对话既活着又在磁盘列表里时
  只保留活的那份（按转录路径去重）。运行时释放/回收的既有规则一个字没动，
  纯展示口径 —— 与 `shownInRunningList()` 的处理方式一致。
- **✕ = 只从这一列移出**：新增 `remove_recent_chat`（wire）→ `removeRecentChat()`，
  在 `client-state.json` 的**全局键**下记 `recentRemoved` 墓碑（列表每次都从磁盘重建，
  没有墓碑会立刻原地复活；全局键 = 换标签页/重启仍然有效）。**转录一个字都不动**，
  History 里照样能找到并重新打开；重新打开/继续聊（`markRecentSeen()`）自动撤销墓碑。
  原来的 `dismiss_conversation`（含强行关闭）现在顺手打同一个墓碑，否则「移出运行列表」
  会变成「原地换成一条常驻历史行」，看起来像没删掉。
- **两种灯**（`web/src/styles.css` + `LeftPanel.tsx`）：
  - `.conv-dot.conv-running` —— **黄灯闪**：本轮正在跑（原来是绿灯闪）。
  - `.conv-dot.conv-waiting` —— **绿灯常亮**：本轮跑完了但用户还没看（「轮到你了」）。
    静态事实不该跟着闪；`prefers-reduced-motion` 下黄灯也不闪，只靠颜色区分。

  两种状态互斥，一行永远只有一盏灯。`waiting` 由服务端给：`agent_end`（且不是自动重试
  的中间态）时 `markRecentWaiting()` 点亮，**当前正看着的那条不点**（人就在那儿）；
  `recentWaiting` 同样落在 client-state 的全局键下，所以运行时被释放、变成常驻历史行
  之后绿灯依然记得。灭灯只在三处：切到该对话、从历史/最近打开它、往它里面发消息。
- **常驻行的点击**：`live === false` 的行点开走 `switch_session`（带 `sessionPath`），
  活着的行仍走 `switch_conversation`；重命名两种行都仍可用。

新增 wire 字段：`ConversationSummary.sessionPath / live / waiting`；新增 i18n：
`recentChats` / `waitingForYou` / `removeFromRecent` / `removeFromRecentConfirm`
（zh/en + 8 个语言包同位置插入，`tests/unit/locales.test.ts` 锁顺序）。
DSH 引擎的左栏只有活着的行，`removeRecentChat()` 在那边是空操作（保持同一套 wire）。

### 回归

- `tests/unit/recent-chats.test.ts`（10 项，服务端：活着 + 磁盘常驻行的合并与去重、
  上限只管常驻行、墓碑生效与撤销、跑完点绿灯、当前对话不点灯、跑着不叠绿灯、
  运行时释放后绿灯不丢、移出后不再持有绿灯）
- `tests/unit/recent-chats-ui.test.ts`（8 项，真 jsdom + 真 React：黄/绿/不点灯三态、
  一行一盏、常驻行点开走 `switch_session`、✕ 两段确认发 `remove_recent_chat`、
  活着的行仍走 `switch_conversation` / `dismiss_conversation`）
- `tests/unit/global-history.test.ts` 的假会话补了 `recentSessions` / `emitConversations`
  承载点（`pushSessions()` 现在会把列表交给「最近对话」并重推左栏）
