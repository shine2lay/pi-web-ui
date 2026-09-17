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
| chat-cwd-pin            | `local` | `server/agent-service.ts`                                        |
| client-per-load         | `local` | `web/src/use-chat.ts`                                            |
| server-owned-chats      | `local` | `server/agent-service.ts`, `index.ts`, `protocol.ts`, `web/src/` |
| topbar-crowding         | `local` | `web/src/ui-slots.ts`, `App.tsx`, `TopBar.tsx`                   |
| quiet-duplicate-open    | `local` | `server/agent-service.ts`, `dsh/dsh-agent-service.ts`            |
| no-cwd-restore          | `local` | `server/agent-service.ts`, `dsh/dsh-agent-service.ts`, `use-chat.ts` |

---

## terminal-bash-script

**状态**：`local`（上游未提 issue/PR；bug 对所有 macOS 用户都成立，值得上游）
**基线**：v0.86.2

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
在 v0.86.x 只修了**一半**：`create()` 现在从 history 继承 `agentBash`，已退出的 AI 终端
不再被降级成用户终端去占那 16 个名额；但视图挂载仍然走 `create()` —— 已退出的终端会被
**重新起进程**、历史输出一并丢掉。只是看一眼不该重启它，所以这个补丁继续保留。
每次同步后先跑 `tests/unit/terminal-view.test.ts`：哪天它对着纯上游代码也全绿，就删掉这个 commit。）
**基线**：v0.86.2

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
**基线**：v0.86.2

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
**基线**：v0.86.2

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
- `FooterBar.tsx`：只渲染钉住的几条（v0.86 起上游把底栏改成 `host:*` slot map，本补丁
  改写其中的 `host:plugin-status` 条目，而不是再往 JSX 里插一段）（各自一个 chip，单行省略、title 看全文，
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
**基线**：v0.86.2

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

---

## chat-cwd-pin

**状态**：`local`（想上游成设置项：切对话时工作区跟随 / 钉住）
**基线**：v0.86.2

### 问题

`switchConversation()` / `switchSession()` 一旦发现目标对话的 cwd 与当前工作区不同，就顺手把
**整个工作区**搬过去：文件树、最近项目排序、项目模型与密钥、新建对话的落点全跟着换。左栏
「最近对话」本来就是跨文件夹的一列（见 global-history / recent-chats），来回点几条 = 来回搬家，
而用户只是想看/继续那条对话。

### 改法

- `chatFollowsWorkspace()`（默认 `false`）：`switchConversation()` 的 `cwdChanged` 与
  `switchSession()` 里的 `this.cwd = targetCwd` + 项目模型/密钥恢复，一并放进这个守卫里。
- 工作区此后只由**显式**动作改变：选最近项目、`set_cwd`。
- `PI_WEB_UI_CHAT_FOLLOWS_CWD=1` 恢复上游的「切对话就切工作区」。

**对话自己的 cwd 不受影响**：`conv.cwd` 绑在运行时上（`switchSession()` 也是用 `targetCwd`
建的运行时），工具照样在**该对话自己的目录**里跑。左栏跨文件夹的行有文件夹分组标题可认，
所以「在哪个文件夹」这个信息并没有丢 —— 丢掉的只是被强制搬家这件事。

代价：工作区与当前对话的 cwd 可以不一致（文件树是 A、对话跑在 B）。这正是要的效果，
但要知道新建对话会落在**工作区**而不是刚看的那条对话的目录。


### 配套：列表位置也不许跳

工作区钉住之后，位置还是会动 —— 两个来源都在这个补丁里一并修掉：

- `web/src/conv-groups.ts`：分组置顶原来看的是**含当前对话的那组**（#140 的做法，当时切
  对话必定伴随切工作区）。现在切对话不再搬家，「当前对话在别的文件夹」成了稳定状态，
  再按 activeId 置顶就等于每点一条跨文件夹的对话就把整列重排。改成只看**工作区**；
  工作区在列表里没有对应分组时（空白新对话 / 刚切完工作区那一帧）才回落到 activeId 所在组，
  #140 的「顶上闪一下项目名」仍然不会回来。
- 行内顺序：新增 wire 字段 `ConversationSummary.sortAt`（转录最后活动时间，缺省用对话
  `createdAt`——**不是** `lastActiveAt`，那个一点开就变），左栏按它给根行排序。于是点开一条
  常驻行（它从「历史行」变成「活行」）位置不动，只有真的聊了才重排。

### 回归

- `tests/unit/chat-cwd-pin.test.ts`（6 项：开关解析、默认不搬家且无副作用、对话自身 cwd 不变、
  同目录切换、`=1` 时整套副作用回归；另加一条静态体检确保 `switchSession()` 那条入口同样被守住）

---

## client-per-load

**状态**：`local`（可上游：现有 sessionStorage 方案挡不住复制标签页）
**基线**：v0.86.2

### 问题

两个窗口会互为镜像：一边切对话，另一边跟着变。根因是 clientId 相同 —— 后端按
clientId 建 ClientSession，同 id = 同一个会话。上游把 clientId 从 localStorage
（所有标签页共用，issue #10 的镜像之痛）改成 sessionStorage 已经好很多，但
**复制标签页 / Ctrl-点链接 / 恢复上次会话**都会把 sessionStorage 一起克隆，
两个窗口照样拿到同一个 id，镜像原样复现。

### 改法

`getClientId()` 每次页面加载现生一个 uuid，**不落任何存储**（原来的
`pi-web-client-id` 键整个去掉）。撞车在构造上不可能发生，不需要认领/心跳那套
跨标签页协调。

代价（用户明确接受）：刷新后不再自动回到上次那条对话。对话本身在服务端好好跑着，
左栏「最近对话」点回去即可；工作目录另有 localStorage 记忆，不依赖 clientId。

### 回归

- `tests/unit/client-id.test.ts`（4 项：同一次加载内稳定、两次加载必不同、
  不写任何 client 相关存储键、隐私模式下不抛错）

---

## server-owned-chats

**状态**：`local`（上游 #145 在往「所有权 + 感知」方向走，这里是相反的选择：取消所有权）
**基线**：v0.86.2

### 问题

对话原本属于**某个客户端**：`ClientSession` 各自持有一张 `convs` 表。于是同一条转录
在第二个窗口打开就意味着第二个 writer（两个 runtime 往同一份 JSONL 追加，历史分叉），
只能靠一整套防护兜着——正在跑就拒绝打开、发送前再拦一次、左栏用「另一处」只读行
表示「那边有一条你碰不到的对话」。用户的实际诉求恰恰相反：两个窗口就是要看同一条
对话、都能说话，或者各看各的。

### 改法

**对话归服务端，客户端只是订阅者。**

- `ClientSession.convs` 改为进程级共享（`ClientSession.sharedConvs`）；`activeId` 退化为
  纯视图状态「这个窗口在看哪条」。同一条对话在整个服务端只有**一个** runtime，
  第二个 writer 在结构上不可能出现。
- 实时扇出：带 `conversationId` 的增量（`message_delta` / `tool_delta`）投递给**所有
  正在看这条对话**的客户端。快照**不转发**——它带着每个客户端自己的 rev 链，跨客户端
  转发会把链弄断；改为 nudge 对方的快照调度器，让它从共享对话自己生成一份来对账。
- 删掉所有权那套：打开正在跑的对话不再拒绝（直接订阅同一条）、发送不再拦截
  （两边的输入按到达顺序排队，本来就是 steer/queue 语义）、`listExternalRunning()`
  恒返回空（共享之后「别处在跑的对话」本来就在每个客户端的列表里，再补一份只会重复）。
- 共享带来的三个连坐点必须堵死：`dispose()` 不再杀别人的对话（只收自己的定时器/监听，
  最后一个离开的才做整体清理）；`removeConversation()` / `displaceActive()` 遇到
  **别的窗口正在看**的对话不回收——否则那边会当场失去正在读的对话。
- 上游 v0.94 的 `AgentService.findConversationHome()`（桥接工具 ask_user_question / browser_page
  的投递目标）默认「第一个持有这条对话的客户端」就是归属方。共享之后**每个**客户端
  都持有每条对话，那就成了按接入顺序随便挑：插件/调度伪客户端（sink 是空函数，
  browser_page 干等到超时），或早已刷新掉的旧标签页（没有 socket，当场报「没有已连接的
  页面」）。改为：正开着这条对话的在线浏览器 → 任一在线浏览器（都取最新接入的）→
  任一浏览器 → 上游口径（新增 `ClientSession.isViewing()`）。问卷本来就是广播 + 进程
  共享登记表，挑谁都一样。回归：`tests/unit/conversation-home.test.ts`。
- 上游 v0.94 的手动过户 `takeOverConversation()` 把 runtime 从 owner 摘下来（detach）再塞进
  目标（insert）。共享表上那会把对话从**所有**窗口摘掉再塞回来（可能还换 id），源窗口还收到
  「已过户到另一处」的假通知。改为：目标已持有这条对话 → 一律退化为普通切换（单 owner
  口径下目标不会持有别人的对话，行为不变）。入口本来就不会出现（`listExternalRunning()`
  恒为空），这是防御。回归：`tests/unit/takeover-shared-table.test.ts`。

### 回归

- `tests/server-owned-chats-test.mjs`（已进 smoke）：两窗口打开同一转录 = 同一个
  conversation（无拒绝、无第二 writer）、轮流发言都进同一条且彼此可见、流式中两个
  订阅者同时拿到增量、一个窗口切走另一个不受影响、订阅者断线不影响对话本身
- `tests/cross-client-session-test.mjs` 按新口径改写：原来断言「必须拒绝」的两处
  改为「必须能订阅同一条」，并发发送改为断言「排队而非拦截」
---

## quiet-duplicate-open

**状态**：`local`（上游大概率不接受：这是把它刻意加的提醒关掉）
**基线**：v0.86.2

### 问题

在第二个窗口打开一条**空闲**对话时，每次都弹「该对话在另一处也开着……请只留一处
发送消息」。它说的风险是真的（两个 runtime 各自往同一份 JSONL 追加，轮流发送会让
历史分叉），但多窗口看同一条对话本来就是日常操作，于是这条提醒在正常使用中反复出现。

### 改法

去掉**空闲持有者**那条 info 提醒（pi 引擎与 DSH 引擎同口径）。真正有害的一刻没有放松：

- 对方**正在跑**时打开 → 仍然硬拦（原样保留）；
- 发消息前的 `prompt()` 守卫仍会再查一次（开时空闲、发时在跑的竞态照样拦）。

要两处一起开同一条对话，正确做法是 co-drive 的 `join_client`：那条路径只有**一个**
writer（持有者的 runtime），从根上分叉不了。

### 回归

- `tests/cross-client-session-test.mjs` 原有断言全绿（含「幽灵持有者不打扰」这条
  「不该出现提醒」的负向断言）；正在跑时的硬拦与并行提醒均未受影响

---

## no-cwd-restore

**状态**：`local`（可上游成设置项：启动目录 = 服务端默认 / 上次用过的）
**基线**：v0.86.2

### 问题

隔三差五弹「Restored the last working directory: /home/me/rollcall」，然后人就在一个没打算去的
项目里了。上游有**两套**自动恢复叠在一起：

1. 服务端按 clientId 记 `lastCwd`，新连接时直接在那个目录里建会话；
2. 浏览器用 localStorage（`pi-web-last-cwd`）再记一份，首帧快照上发现服务端不在那里就补发
   `set_cwd` 切过去 —— 这一套每次页面加载都跑，于是一个只去过一次的目录从此粘住。

“上次碰过的”和“现在想要的”不是一回事；而 client-per-load 之后每次加载都是新 clientId，第 1 套
已经不怎么命中，第 2 套才是真正在拽人的那只手。

### 改法

两套一起删（pi 引擎、DSH 引擎、浏览器）：新连接一律用服务端启动目录，切目录只由用户
显式操作触发（左栏项目 / 底栏路径 / 文件树「以项目打开」/ 全局搜索）或插件显式请求
（`startChat({cwd})` 等，陆生路径仍要确认）。`stateStore.remember` 保留 —— 那是左栏项目列表的数据源，
不是恢复。浏览器边的 localStorage key 连同读写函数、ref、effect 整套删掉：只写不读的 key
只会让下一个读代码的人以为恢复还在。

其他会动工作目录的地方（盘点过一遍）都是用户点出来的，不动；chat-cwd-pin 继续保证切对话
不搬工作区。

### 回归

- `npm run typecheck` 五个工程全过；`scripts/check.sh` 全绿
- 部署后验证：构建产物里 `Restored the last working directory` 出现 0 次

---

## topbar-crowding

**状态**：`local`（上游大概率乐见其成，可提 PR）
**基线**：v0.94.1（v0.86.2 上的 7 个提交在同步 v0.94.1 时按上游的新顶栏重做成 1 个）

### 问题

装的东西越多顶栏越挤：内置入口十来个，每个界面插件还要再占一个，窄一点的窗口
直接把右侧的模型选择器挤没。而 GitHub 仓库外链每天都在占一个固定位置 —— 它一年
也点不了一次。

### 上游 v0.94 的顶栏（我们在它之上改）

完全扁平的 `.topbar-flow`：条目按 `align`（start/center/end）由两个 spacer 分三段；
放不下的由 `web/src/topbar-fit.ts` 实测宽度、从视觉尾部收进「⋯」；`hidden` 的条目常驻「⋯」。
上游自己已把浏览器/声音/语言/主题/版本缺省收起，并把它们的**整块面板**搬进「⋯」菜单
（`OVERFLOW_AS_NODE_IDS`）；设置被 `REQUIRED_TOPBAR_ITEM_IDS` 强制常驻栏上；GitHub 外链缺省收起、
order 200。v0.86.2 上的旧做法（`capTopbarPrimary()` 限额 → 按角色分位置、`.topbar-right`
包右侧、删插件 tab 旁重复的「⋯」）被这套整体取代，不再移植；`App.tsx` 不再改动。

### 改法

**按角色分位置，而不是按数量截断**（数量不是用户的心智模型，**用途**才是），全部用上游的
数据模型表达（`web/src/ui-slots.ts` 的 `BUILTIN_UI_ITEMS` 缺省值）：

- **左边 = 去哪儿**：视图三连（chat/terminal/git）+ 🧩 插件面板改成 `align: "start"`（上游是 end）。
- **右边 = 最常用的动作**：搜索、新建对话（上游本来就是 end），再往右是「⋯」。
- **其余缺省进「⋯」**：除上游已收起的 5 条，**后台任务与设置**也 `hidden: true`。
- **移除 `host:github`**：内置表条目、TopBar 节点工厂、「⋯」里的外链行、`.chip.github` 样式
  一并删掉——纯外链、零上下文价值，连「⋯」里的一行也不该占。
- **设置可以收进「⋯」**：`REQUIRED_TOPBAR_ITEM_IDS` 只钉 slot（插件 `arrange` 不能把它挪出
  `topbar.primary`），不再强制 `hidden=false` —— 被隐藏的条目一定出现在「⋯」里，所以设置
  仍是找回其它入口的通道。布局页（`SettingsModal.tsx`）随之去掉设置那行的禁用勾选，
  否则缺省收起的设置永远勾不回栏上。它仍传给 fitTopbar：勾回栏上之后不会被实测溢出收走。
- **「⋯」= 入口列表 + 右侧抽屉**（`TopBar.tsx`）：上游把声音/语言/主题/版本的整块面板
  塞进菜单，菜单又长、还得在里面二次翻找。改成菜单里一行入口（图标 + 名称；版本带版本号
  与更新红点/角标），点开从右侧滑出抽屉（`.topbar-drawer`，portal 到 body）展开该面板。
  面板内容只有一份（`renderSoundBody` / `renderLanguageBody` / `renderThemeBody` / 上游的
  `renderUpdateBody` + `renderAllUpdatesBody`），顶栏下拉与抽屉共用。抽屉里选主题/语言后
  抽屉留着（方便连着试）；打开版本抽屉时与顶栏下拉一样拉一次 `check_update` /
  `check_updates_all`。浏览器操作仍整块搬进菜单（自带面板）；设置/搜索/后台任务打开
  各自已有的面板，不套抽屉；受管实例的版本只是展示 chip，照旧原样画。
- **被实测挤出去的条目排在菜单最上面**，缺省收起的在后（点开「⋯」最想找的就是它们）。
  **刻意偏离上游**：`sortOverflowMenuItems` 的注释要求两个来源合并后统一按视觉顺序排。
  按那个口径，窄窗口里被挤出去的新建对话（end 段、order 96）会排在一长串配置项后面。
  两段各自仍用 `sortOverflowMenuItems` 排序。

窄窗口下谁先进「⋯」仍由上游的实测溢出决定（从视觉尾部收，右先于左）。用户仍可在设置
「界面布局」里把任何一条拉回顶栏、藏起或调序——这里改的只是**默认位置**。

### 回归

- `tests/unit/ui-slots.test.ts`：缺省收起 7 条 / 常驻 10 条；按角色分位置（align）；GitHub 不在
  内置表；设置不能被插件挪出顶栏、但可以收起且用户能勾回；order 偏好里残留的
  `host:github` 被忽略。
- `tests/unit/topbar-panel-toggle.test.ts`：「⋯」里只列入口行（面板不进菜单）；主题抽屉
  portal 到 body、选中后留着、点遮罩关；版本抽屉打开时发 `check_update` + `check_updates_all`、
  ✕ 关。上游的「溢出菜单里的 GitHub 行」测试随 GitHub 一起删掉。
