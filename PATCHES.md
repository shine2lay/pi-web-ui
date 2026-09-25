# PATCHES.md — 这个 fork 相对上游的改动

Fork of [`xing-shuyin/pi-web-ui`](https://github.com/xing-shuyin/pi-web-ui) (MIT).

- `main` = 上游镜像，**不要**在上面改东西（`git fetch upstream && git merge --ff-only upstream/main`）。
- `mine` = 上游某个 tag + 下面这些补丁，一个补丁一个 commit，commit 标题 = 这里的小节标题。
- 每次上游发版：`scripts/sync-upstream.sh <tag>`（rebase `mine`）→ 跑 `scripts/check.sh` → 更新本文件的「状态」。
- 状态生命周期：`local` →（提了 PR）`PR #N` →（上游合了）`merged vX.Y.Z` → 下次 rebase 时**删掉该 commit**。
  被上游（或本 fork 后面的补丁）取代的同样在同步时删掉，并在文末「已退役的补丁」记一笔。

上游节奏很快（一天两三个版本），不必追每个 tag：按需（想要某个修复/功能时）或每周同步一次即可。

| 补丁                         | 状态           | 主要文件                                                                                                                                       |
| ---------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| terminal-bash-script         | `local`        | `server/terminals.ts`                                                                                                                          |
| terminal-view-lifecycle      | `local`        | `server/terminals.ts`, `server/index.ts`                                                                                                       |
| global-history               | `local`        | `server/agent-service.ts`, `server/protocol.ts`, `web/src/`                                                                                    |
| status-placement             | `local`        | `web/src/status-placement.ts`, `FooterBar.tsx`, `RightPanel.tsx`                                                                               |
| recent-chats                 | `local`        | `server/agent-service.ts`, `client-state.ts`, `web/src/`                                                                                       |
| chat-cwd-pin                 | `local`        | `server/agent-service.ts`                                                                                                                      |
| client-per-load              | `local`        | `web/src/use-chat.ts`                                                                                                                          |
| server-owned-chats           | `local`        | `server/agent-service.ts`, `index.ts`, `protocol.ts`, `web/src/`                                                                               |
| topbar-crowding              | `local`        | `web/src/ui-slots.ts`, `App.tsx`, `TopBar.tsx`                                                                                                 |
| quiet-duplicate-open         | `local` → 退役 | `server/agent-service.ts`                                                                                                                      |
| no-cwd-restore               | `local`        | `server/agent-service.ts`, `dsh/dsh-agent-service.ts`, `use-chat.ts`                                                                           |
| flat-recent-chats            | `local`        | `web/src/conv-groups.ts`, `LeftPanel.tsx`, `server/agent-service.ts`, `protocol.ts`                                                            |
| no-mcp-restart-nag           | `local`        | `server/webui-context.ts`, `tests/unit/mute-mcp-restart-nag.test.ts`                                                                           |
| ask-question-delivery        | `local`        | `server/ask-delivery.ts`, `agent-service.ts`                                                                                                   |
| reload-adopt                 | `local`        | `server/attach-adopt.ts`, `agent-service.ts`                                                                                                   |
| switch-loading               | `local`        | `web/src/switch-pending.ts`, `SwitchOverlay.tsx`, `use-chat.ts`, `server/agent-service.ts`, `dsh/dsh-agent-service.ts`, `protocol.ts`          |
| qn-rail-window               | `local`        | `web/src/qn-window.ts`, `components/MessageList.tsx`, `styles.css`, `i18n.tsx`                                                                 |
| terminal-cwd-anywhere        | `local`        | `server/terminals.ts`, `tests/unit/terminal-cwd.test.ts`                                                                                       |
| chat-window-pagination       | `local`        | `server/question-index.ts`, `agent-service.ts`, `protocol.ts`, `index.ts`, `web/src/message-window.ts`, `MessageList.tsx`, `use-chat.ts`       |
| bg-tasks-push-dedupe         | `local`        | `server/bg-servers.ts`, `agent-service.ts`, `tests/unit/bg-servers-dedupe.test.ts`                                                             |
| load-older-survives-snapshot | `local`        | `web/src/message-window.ts`, `use-chat.ts`, `tests/chat-pagination-test.mjs`                                                                   |
| exchange-fold                | `local`        | `web/src/exchange-fold.ts`, `components/ExchangeFoldRow.tsx`, `MessageList.tsx`, `exchange-fold.css`, `i18n.tsx`, `locales/*.json`             |
| exchange-digest              | `local`        | `server/exchange-digest.ts`, `agent-service.ts`, `protocol.ts`, `index.ts`, `web/src/message-window.ts`, `exchange-fold.ts`, `MessageList.tsx` |
| done-any-chat                | `local`        | `web/src/done-cues.ts`, `App.tsx`, `server/agent-service.ts`, `i18n.tsx`, `locales/*.json`                                                     |
| todo-list-owner              | `local`        | `server/agent-service.ts`                                                                                                                      |
| markers-skip-code            | `local`        | `server/markers/marker.ts`                                                                                                                     |
| single-load                  | `local`        | `web/src/use-chat.ts`, `server/index.ts`, `server/protocol.ts`                                                                                 |
| tldr-panel                   | `local`        | `server/tldr-lines.ts`, `agent-service.ts`, `protocol.ts`, `web/src/components/TldrPanel.tsx`, `RightPanel.tsx`, `ui-slots.ts`, i18n           |

---

## qn-rail-window

**状态**：`local`（纯前端，可以直接提上游；窗口大小和对齐策略是口味选择，提之前先对口径）
**基线**：v0.94.1

### 问题

提问导航条（消息区右侧那一排刻度）把会话里**每一个**用户问题都画成一个刻度，
再用 `--rail-gap` 把行距压到全部塞下为止。长会话动辄 40+ 问：600px 的条上行距
压到 ~11px，80 问就是 4px —— 一团密集的线，逐刻度的文字气泡也因为挤不下被换成
列表面板（`many` 模式）。用户原话：“40+ messages, a bit too much”。

这**不是拉取问题**：消息全部已经在客户端（`snapshot` 整份 `messages`，之后 `snapshot_delta`
只追加），导航条只是 `state.messages` 的一个视图。不动协议。

### 改法

**滑动窗口**（用户在三个方案里选的：滑窗 / 无限滚动式累加 / 固定最后 10 个点开展开）：

- `web/src/qn-window.ts`：`planQnWindow(total, active, size = QN_WINDOW /* 10 */) → {start, end}`。
  纯函数，和 `lazy-window.ts` 一个路数。以当前阅读中的问题（`activeIdx`）为中心，
  奇数余量偏向更早一侧（上 5 / 当前 / 下 4）；贴边时不缩窗；`active = -1`（尚未定位）
  按末尾处理 —— 初始加载铉在底部，首帧就是最终形态，不会先画开头再跳到结尾。
- `MessageList.tsx`：只渲染 `questions.slice(start, end)`；**编号保持全局序号**（第 35 问永远
  是「35.」，和消息上的 `qnIndex` 标签一致）。两端各一个 `+N` 计数（`.qn-more`），点击
  `jumpTo` 到最近的一个被折叠问题，窗口随之重新居中。计数始终占位（`visibility` 而非
  `display`），刻度簇不因一侧变空而跳动。`railGap` 改按实际渲染行数算（≤ 12 行），所以
  桌面上行距回到 27px、逐刻度气泡回来了；`many` 列表面板仍列全部问题（矮视口才触发）。
- 滚动消息区（或在导航条上滚轮）→ `activeIdx` 单步变化 → 窗口两端各换一个刻度。
  没有阶跃，也永远不会回到一团。

### 回归

- `tests/unit/qn-window.test.ts` 7 项：不超窗全显 / 末尾与 -1 / 居中偏早 / 贴边不缩窗 /
  total>size 时宽度恒等于 size 且 active 必在窗内（扫 -1..60）/ 单步下滑 / size≤0 不限。
- i18n：`questionNavEarlier` / `questionNavLater`（`{n}`），`i18n.tsx` zh+en + 8 个 locale。
- 纯前端，`express.static` 直接从 `web/dist` 读 —— 刷新页面即生效，不用重启服务。

---

## switch-loading

**状态**：`local`（上游同样有这个问题，但修法改了协议，得先跟上游对过口径才好提 PR）
**基线**：v0.94.1（依赖 `server-owned-chats`：对话归服务端，切换才是一次有明确回执的请求）

### 问题

点左栏一条对话，**界面纹丝不动** —— 直到服务端把整份转录序列化完推来新快照。
大会话要好几秒，用户看到的就是「点了没反应」，于是再点一次、或者改点别的。
切失败更难受：目录打不开、对话 id 不存在，以前是**静默**的 —— 界面停在原地，
既没告诉你失败了，也没告诉你为什么。

### 改法

**协议（v19 → v20）**：切换从「发出去就不管了」变成有回执的请求。

```ts
export type SwitchTarget = { kind: "session"; path: string } | { kind: "conversation"; id: string };
| { type: "switch_done"; target: SwitchTarget }
| { type: "switch_failed"; target: SwitchTarget; error: string; errorEn?: string }
```

- **`target` 原样回传**。客户端据此判断回执是不是自己还在等的那次切换 ——
  内部触发的切换、连点两条时早先那次的回执，都对不上，直接忽略。
  不用 `notice`：那只是一条 toast，**对不到目标上**。
- **成功回执一定在新快照之后发**（`flushSnapshot()` 是同步的），所以客户端收到
  `switch_done` 时内容已经到位，不会出现「遮罩没了但还是旧内容」的中间帧。
- 两个引擎同一份契约：`server/agent-service.ts` 和 `server/dsh/dsh-agent-service.ts`
  各自 `emitSwitchDone()` / `emitSwitchFailed()`。

**客户端**：`web/src/switch-pending.ts`（101 行，纯函数、不碰 React）记下 `pendingSwitch`；
发出 `switch_*` 的**那一刻**聊天区盖一层「正在打开…」（`SwitchOverlay.tsx`，带「已等待 N 秒」
和「隐藏」），左栏高亮立即挪到目标行。失败就留在原地，把原因（中/英）显出来并给一个「重试」。

**为什么同时认两种结束信号**（回执 + 快照对得上）：回执是主信号，引擎无关；
但 DSH 的快照没有 `sessionFile`，按路径根本对不上，所以再加一道保险：只要要的那条
对话已经显示出来了，就没理由还盖着「正在打开」。

### 回归

- `tests/switch-ack-test.mjs`（e2e，已登记进 `tests/run-smoke.mjs`）：成功路径「先快照后
  `switch_done`、target 原样回传」；三条失败路径（目录打不开、对话 id 不存在、切到已经
  是当前的转录）都不再静默；失败时**当前对话纹丝不动**。
- `tests/unit/switch-pending.test.ts` + `tests/unit/switch-loading-ui.test.ts`（共 354 行）。
- `node scripts/check-protocol-sync.mjs`：双端 `PROTOCOL_VERSION` 一致 (v20)、
  `protocol.ts` 保持纯类型导出。
- i18n 跑满：8 个 locale + `web/src/i18n.tsx`。

---

## reload-adopt

**状态**：`local`（上游不适用：它的对话有归属，这里没有）
**基线**：v0.94.1（依赖 `server-owned-chats` + `client-per-load`；同步时的改动见「与上游 v0.94 的关系」）

### 问题

刷新一下，自己的对话就被自己挡在外面：落在空白新对话上，并被告知
「该项目最近的对话…正在另一处运行，直接打开会造出第二个写者」。那个「另一处」
就是你刷新前的窗口。

三个补丁叠在一起才有这个效果：

1. 上游 issue #145 的保护：`attach()` 发现「最近那条正在别处跑」就停在空白对话；
2. `client-per-load`：每次页面加载都是**新 clientId**，所以刷新后的你对服务端
   而言就是「别人」；而旧 `ClientSession` 不随 socket 断开而销毁（PTY 要活下来），
   于是它以「正在跑的另一处」的身份留在进程里；
3. `server-owned-chats`：对话已经是进程共享的，**第二个 writer 在结构上已经
   不可能** —— 也就是说第 1 条那个保护的前提在本 fork 里已经不成立了。

真正的漏洞在 `ClientSession.create()`：它永远 `SessionManager.continueRecent(cwd)`，
也就是**从磁盘再恢复一份**，从不看一眼共享表里是不是已经开着这条。上游用
「停在空白」来绕开它；切项目那条路径却早已是对的写法（`Prefer the target project's
own most recently active conversation`）—— 两处口径不一致。

### 改法

接入时**接管已经开着的那条**，而不是再恢复一份（与切项目路径同口径）：

- `server/attach-adopt.ts`：`pickAdoptTarget(cwd, candidates)` —— 同 cwd 里 `lastActiveAt`
  最大的一条；没有候选返回 `null`（照旧从磁盘恢复）。纯函数，可单测。
- `attach()` 删掉 issue #145 那整块（含 `SessionManager.list()` 扫目录），改成纯内存
  判断；命中候选时以 `blank: true` 建会话（不碰磁盘），再 `adoptConversation()`。
- `adoptConversation()` 不走 `switchConversation()`：后者会 emit 一堆东西（含客户端从没
  请求过的 `switch_done`），而此刻 sink 还没挂上 —— 首帧快照自然带着 activeId。
  刚建的空白对话随即回收（`displaceActive` → `removeConversation`，即切项目那套），
  否则每次刷新都多一条空对话。
- 「停在了新对话」那条提示从 `create()` 里删除（切项目首访那条路径的同文案保留，
  那里按定义没有同 cwd 的候选）。

### 顺手修掉的真 bug：对话 id 撞键

`convSeq` 是 **per-ClientSession** 的，`convs` 却是**进程共享**的 —— 两个窗口各自
生成 `c1`，后来那个 `convs.set("c1", …)` 会把前一个窗口的对话从共享表里**静静
换掉**，也就是 `server-owned-chats` 声称不可能出现的那个第二个 writer。之前没被发现，
是因为两个窗口的 `c1` 恰好恢复自同一份转录，`server-owned-chats-test` 的断言
「同一个 conversation」就这么阴差阳错地绿了。接管之后候选不再来自磁盘，撞键当场
暴露（接管目标被自己的空白对话顶掉）。`convSeq` 改为 `static` —— 共享注册表 +
私有序号就是撞键，跟 `questionSeq`（见 ask-question-delivery）同一个错。

### 与上游 v0.94 的关系（2026-09-23 同步到 v0.94.1）

- 上游 v0.94 在 `attach()` 里加了「浏览器重启认领」（`findAdoptableOrphan` →
  `pickAdoptableOrphan`）：没有别的在线浏览器时，把最近断开的残留 `ClientSession` 整个
  过户给新 clientId，并提示「已恢复你关闭浏览器前的工作会话」。**本 fork 不调用它**：
  - 它按「clientId 存 sessionStorage、刷新不换 id」设计，只在关掉浏览器重开时触发；
    `client-per-load` 下每次单标签刷新都会触发。
  - `server-owned-chats` 之后 `convs` 是进程共享的，每个残留会话的「有内容 / 在跑 /
    最近活跃」算的都是同一张表、完全相同（残留会话又只在停服时才清）—— 于是总挑到
    **最早**的那个残留，落到它很久以前打开的对话上，还每次刷新都弹那条提示。

  刷新/新标签落到哪条，统一由 `pickAdoptTarget` 决定。上游的函数原样保留（只是不调），
  下次同步少一处冲突。上游的冒烟 `orphan-adopt-test` 测的正是这条被跳过的路径。

- 上游 issue #235 的坏转录修复（`openManagerAndRuntime` + `transcriptRepairNotices`）保留，
  只改了 `opts.blank` 的注释。上游新增的 `blankTitle` / `idleHeld` 两种「停在空白」提示
  随 issue #145 那块一起删掉。
- 接线用上游的 `wireClient()`，它比原来手写的 6 行多了 `getClaimStore`、
  `findConversationHome`、`steerConversationElsewhere` 和 `schedulerStore`。

### 回归

- `tests/unit/attach-adopt.test.ts`（7 项）：无候选 → null、开着就接管、同项目多条取
  最后活跃、跨项目不抢、并列先到先得、cwd 字面比较（尾斜杠/子目录不算同项目）、
  `lastActiveAt: 0` 不被当假值跳过
- `tests/cross-client-session-test.mjs` 0a 改口径：原来断言「首帧空白 + 出现停在新对话
  提示」，现在断言「直接接管那条（sessionFile 一致、能看到历史）且无提示」
- 全量冒烟 52 中 49 过；3 个失败与本补丁无关，已逐一定位：
  - `conv-cross-project-test`：断言上游的「切对话跟着切工作区」，而 `chat-cwd-pin`
    故意关掉了它 —— `PI_WEB_UI_CHAT_FOLLOWS_CWD=1` 下该测试 ALL PASS（已验）；
  - `settings-test`：`EADDRINUSE :8931`（本机端口被占）；
  - `terminal-smoke-test`：49 checks 全过，收尾退出码噪声。
- 单测全量 1451 passed / 116 files

### 子代理必须排除（及其测试缺口）

`sa-*` 子代理对话也在共享表里，**跟父对话同一个 cwd**，且 `makeConversation()` 给它
`lastActiveAt = Date.now()` —— 刚派出一个子代理，它就是这个 cwd 里最「新」的那条。
不过滤就会把刷新的用户直接丢进子代理会话。共享表里按 cwd 挑对话的地方全都过滤它
（`conv.cwd !== cwd || conv.isSubagent` 等 4 处），这里跟着一致。

**测试缺口（已知，别高估）**：`tests/subagent-ui-context-test.mjs` 末尾新增的三条断言
（接管到主对话、子代理仍在列表里、接管的不是 `sa-*`）**杀不掉变异**：把
`|| c.isSubagent` 拿掉重新 build，该测试照样 ALL PASS（已实跑变异探针确认）。
原因：它在子代理**跑完之后**才刷新，此时主对话又成了最新的那条（到底哪条路径
重新抬了父对话的 `lastActiveAt` 没查到 —— 6 处赋值点里没一个明显对得上）。
真正危险的窗口是「子代理**正在跑**时刷新」，要确定性复现得让假模型把子代理
那一回卡住。所以：**这条规则的回归保障是单测，不是那个 e2e**；e2e 那三条只算
便宜的烟雾（它们确实钉住了「刷新接管到带历史的主对话」这个正向行为）。

### 切项目（`setCwd`）复用同一条规则

`setCwd()` 里原本是一份手写的「同 cwd 取 lastActiveAt 最大」循环，漏了 `isSubagent`。
这个漏洞比 reload 那个**更好触发**：离开项目 X 时 `displaceActive()` 会把主对话拿掉，
等再切回 X，`cwd === X` 的候选里就只剩子代理那条 —— 不是「比时间戳输了」，是
「只剩它」。现在直接调 `pickAdoptTarget()`：规则只剩一处，行为完全一致（同样的
严格 `>` 并列先到先得、同样的迭代顺序），只多了排除子代理。

这次的测试是**真能杀变异的**（上一轮的教训）：纯函数单测只能证明
`pickAdoptTarget` 自己对，证不了 `setCwd` 真的去调了它（这正是典型的「存活变异」
类型：逻辑有测试，**调用点没有**）。所以按 `chat-cwd-pin.test.ts` 的做法加了一条
调用点测试：拿 `ClientSession.prototype.setCwd` 配桩 this 直接跑（零 token、零端口，
两条对话都在目标目录下所以不会走到 SessionManager）。变异探针：把老循环原样探回去，
该测试 `AssertionError: expected 'sa-1234abcd' to be 'main-there'` —— 变异被杀。

### 没做（留给后续）

- `create()` 仍会先建一个马上要回收的空白 runtime（它顺手播下 `sharedModelRuntime`
  的种）。浪费一次创建，但改掉要拆 `create()` 的结构，收益不抵风险。
- 切项目首访那条路径里的 `resumeSkipped` 提示现在几乎不可能触发（持有该文件的
  对话通常就是同 cwd 的 `target`，上一步就被选走了），留着不动。
- ~~切项目那条路径有同样的子代理漏洞~~ → 已修，见下。

---

## ask-question-delivery

**状态**：`local`（bug 对上游同样成立，值得提 PR）
**基线**：v0.94.1（2026-09-23 同步时按上游的新问卷模型重做，见「与上游 v0.94 的关系」）

### 问题

`ask_user_question` 的对话框时不时不弹，而且一旦不弹，**那轮对话就永远卡在那里**。

两条独立的根因叠在一起：

1. **永久挂死**。`askUser`（`server/agent-service.ts`）故意不设超时——注释写得很清楚：
   「不设超时：等的是人类回答，不是挂死的工具」。而 `emit()` 在 `this.sinks` 为空
   （没有任何页面连着）时是**静默丢弃**的：

   ```ts
   for (const sink of [...this.sinks]) sink(msg); // sinks 为空 = 什么也没发生
   ```

   于是：没人在线时提问 → `question_pending` 丢掉 → 对话框不出现 → promise 永远不
   resolve。同一个文件里的 `pageCall`（`browser_page`）早就有 `sinks.size === 0` 的
   守卫并立即报错，`askUser` 漏了——同一类「需要活着的浏览器」的工具，一个有一个没有。

   触发场景比想象中多：关标签页 / 笔记本休眠 / WS 重连的空窗 / 后台对话或子代理
   在问而你在看别的对话。服务是长命的（systemd，往往跑好几天），浏览器却来来去去。

2. **忭照救不回来**。本来有一条恢复通道（`UiState.pendingQuestion`），但它按当前对话过滤：

   ```ts
   if (p.conversationId !== undefined && p.conversationId !== this.activeId) continue;
   ```

   于是只有用户**恰好回到发问的那条对话**时问卷才复活；打开别的对话 → 快照里是
   null → 对话框永远不回来。而对话框是问卷的**唯一入口**（代码注释自己也说了
   「DshQuestionDialog 无入口」），侧栏没有任何「这条对话在等你回答」的提示，
   丢了就是真丢了。

日志侧面印证：37 次调用里 35 答、2 取消、0 报错——但这是幸存者偏差，**没弹出来的
那些压根不会写下结果行**，在会话日志里天然隐形。

### 改法

新增纯函数模块 `server/ask-delivery.ts`（同 `pending-question.ts` 的套路：判定逻辑抽
出来、单测钉住）：

- `askDeliveryOnAsk(clientCount)` —— 有页面就即时推（原行为不变），没有则不 emit。
- **不是一看见没页面就报错**：刷新/重连有几秒空窗，那种情况下用户马上就回来了。
  给 `ASK_USER_NO_CLIENT_GRACE_MS` = 30s 宽限期：期间页面接上 → 快照把对话框补出来；
  到点依旧没人 → `askDeliveryOnGraceExpiry` 判 `reject`，让模型改用正文提问而不是干等。
  计时器 `unref()`，不拖住进程退出；答完/取消/dispose 都会 `clearTimeout`。
- `pickPendingQuestionForSnapshot(entries)` —— 去掉 activeId 过滤，**不分对话一律带进快照**。

协议：首版给 `UiPendingQuestion` 和 `question_pending` 各加了一个可选 `conversationId`。上游 v0.94
自己加了同样的字段（外加 `conversationTitle`），同步后本补丁**不再改协议字段**，只改
`UiState.pendingQuestion` 的注释（不分对话一律携带）。`PROTOCOL_VERSION` 一直没动。

### 第二轮：multi-device（一张问卷，所有设备都能看、都能答）

用户在多台设备间走动（笔记本 ↔ 台式机），问卷却只在**发起提问的那一台**弹。
三个结构性原因：

1. `pendingQuestions` 是 **per-ClientSession** 的私有 Map；另一台设备 = 另一个 ClientSession。
2. `fanOutToViewers` 只转发 `message_delta` / `tool_delta` 两种消息，`question_pending`
   根本不跨客户端。
3. `answerQuestion` 只查 `this.pendingQuestions` —— 只有发问的那台能回答。

改法与 `server-owned-chats` 同构：**问卷属于对话，不属于客户端**。

- `sharedQuestions` 改为 `static`（连同 `questionSeq` —— 否则两个客户端各自生成 `q-1` 撞键）。
- `broadcastToAllClients()` 把 `question_pending` 广播给**所有在线客户端**，不走
  `fanOutToViewers` 那套 `activeId` 过滤：问卷阻塞整个 agent 循环，漏给一台就可能永远等下去。
- 收场用上游的 `question_retracted`（v0.94 为手动过户引入：前端只收「正好是这个 id」的
  那张并记入 answered，迟到的旧快照不会把它复活），但改为**广播给所有在线客户端**：
  第一个答的生效，其余设备的对话框自动收场。首版自己加过一个语义相同的
  `question_closed`，同步时删掉了。
  为什么不能指望快照：`resolvePendingQuestion` 的收起分支只对
  `source === "snapshot"` 的面板生效，而另一台设备的面板是广播（live）弹出来的。
  只关「正好是这个 id」的那张，不能盲清：收场消息与下一次 `question_pending`
  可能背靠背到达，盲清会把新弹出的那张误关。
- `cancelPendingQuestions()` 不再跟着客户端 dispose 走：只有「除我之外一台都不剩」
  时才取消（`shouldCancelOnClientDispose`）。client-per-load 之后每次刷新都会 dispose
  一个旧会话 —— 不改的话等于每次刷新都把自己的问卷打掉。
- 在线数一律改用 `connectedClientCount()`（看 `sinkCount() > 0`，不是会话是否存在）——
  `ClientSession` 比它的 socket 活得久，这是 `viewedElsewhere` 早就踩过的坑。
- 对话名标注直接用上游 v0.94 的对话框：`question.conversationTitle`（缺省时 App.tsx 按
  `conversationId` 从对话列表里查）有值就显示（`.question-conv-title`），不管是不是本设备
  当前在看的对话。首版自己做过一版「只在来源不是当前对话时标出」，同步时改用上游的，
  `DshQuestionDialog.tsx` / `App.tsx` / `use-chat.ts` 都不再改。

### 与上游 v0.94 的关系（2026-09-23 同步到 v0.94.1）

上游在 v0.94 自己补上了一半：问卷带 `conversationId` / `conversationTitle`、侧栏「?」角标
（`hasQuestion`）、`question_retracted`、跨页作答（`peek_elsewhere_question` →
`elsewhere_question`）。分歧在**弹在哪里**：

- 上游用 `shouldPopQuestion` 只推给**正开着该对话**的页面，别处只给「?」角标。我们保留
  「所有在线设备都弹，并标出对话名」（用户 2026-09-23 的选择）：问卷阻塞整个 agent 循环，
  角标太容易漏看。所以 `askUser` 不调 `shouldPopQuestion`（函数仍导出，上游的
  `ask-user-question-tool.test.ts` 继续覆盖它）。
- 快照：上游的 `pendingQuestionForSnapshot` 只带当前对话的问卷，我们仍然不分对话一律带。
  前端 `resolvePendingQuestion` 的规则 2（快照为空时收掉别的对话的框）因此不会误伤：
  快照有值时规则 1 先返回，前端不用改。
- 角标：问卷是进程共享的，所以登记、解决、宽限期到点都用 `emitConversationsToAll()`
  刷新**所有**在线客户端的对话列表；只刷本客户端的话，在台式机上答完，笔记本上的
  「?」还挂着。
- 快照里的对话名按对话现名取（改过名也跟上）；取不到时用提问时记下的，**不**回落到
  「本客户端当前对话」（问卷共享，那会给别的设备标错来源）。
- 在 `server-owned-chats` 下 `listExternalRunning()` 恒为 `[]`，上游跨页作答的入口不会出现；
  代码原样保留，没改。

### 没做（留给后续）

- `DshQuestionDialog` 的 **全局 Esc**（`document.addEventListener("keydown")`，无任何限制，v0.94.1
  仍然如此）：
  在任何地方因任何原因按 Esc 都会直接取消提问，没有二次确认。
- 同文件的倒计时：`question.deadline` 若为过去时间（时钟偏移 / DSH 传了个旧值），
  对话框会在挂载后 1 秒内自己取消——看起来也是「根本没弹」。标准引擎不传
  `deadline`，所以只影响 DSH 路径。

### 回归

`tests/unit/ask-delivery.test.ts` 11 项：有/无页面的投递分支；宽限期到点的三种结局
（没人→reject / 页面回来→keep / 已答过→keep，最后一条防的是去动已 settle 的 promise）；
宽限期取值区间；错误文案必须告诉模型改用正文提问（否则它会原地重试）；
快照提取的四种情形——**非当前对话的问卷也要带上**（就是以前丢问卷的那条路径）、
旧条目无 conversationId 不加空字段、空表返回 null、多张并存取第一张。

multi-device 追加 3 项：`shouldCancelOnClientDispose` 两分支（还有设备连着 → keep，
一台不剩 → cancel）、快照带 `conversationTitle`。首版给对话框加的 3 项测试随对话框改动一起
删了，对话名标注由上游自己的 `tests/unit/dsh-question-dialog.test.ts` 覆盖。

同步 v0.94.1 后：ask-delivery、ask-user-question-tool、pending-question、dsh-question-dialog、
question-attachments 共 63 项全过。

---

## terminal-bash-script

**状态**：`local`（上游未提 issue/PR；bug 对所有 macOS 用户都成立，值得上游）
**基线**：v0.94.1

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
**基线**：v0.94.1

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
**基线**：v0.94.1

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
**基线**：v0.94.1

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
**基线**：v0.94.1

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
**基线**：v0.94.1

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

> **已被 flat-recent-chats 取代**：下面这套「分组 + 按活动时间排」仍然会在收消息时重排。
> 分组与 `sortAt` 排序已删，左栏改为扁平列表按创建时间倒序；`sortAt` 字段本身保留。
> 下次 rebase 时这一小节对应的改动已在 flat-recent-chats 那个 commit 里被覆盖，不必单独保留。

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
**基线**：v0.94.1

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
**基线**：v0.94.1

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
- **看客也要实时**（2026-09-24 修）：SDK 事件只订阅在「开这条对话的那个窗口」（订阅方）上。
  `onEvent` 原先只在订阅方**自己**正看着这条对话时才发增量、安排快照。订阅方一切走
  （或那次页面加载早就刷新没了，client-per-load 之后很常见），这条对话的增量就谁都不发了：
  正看着它的别的窗口（看客）只剩 `noteForeignDelta` 的慢节奏，连自己刚发的问题都要等好几秒，
  流式过程完全看不到，回答最后整段出现。改为「激活」按**每个窗口**算：
  - `message_update`：订阅方自己在看 → `emit`（顺带扇出）；自己没在看但别人在看 → 只扇出。
  - 每个事件末尾 `checkpointViewers()`：替正看着这条对话的窗口按同样的口径安排或立即对账。
    快照仍由各窗口自己生成（各自的 rev 链）。没 socket 的会话（旧标签页留下的）跳过。
  - 用户的问题落进转录（`role=user` 的 `message_end`）也算检查点边界，立即对账：问题和
    `isStreaming=true` 一起到（以前等定时器，最长 2 秒）。exchange-fold 的折叠行靠它从第一帧就在。
  - `getSessionStats()` 的缓存从单槽改为按会话各存一份（`WeakMap`）：订阅方现在会替别的
    窗口流式它自己没在看的对话，两条对话同时在跑时单槽会被每一帧互相挤掉。

### 回归

- `tests/server-owned-chats-test.mjs`（已进 smoke）：两窗口打开同一转录 = 同一个
  conversation（无拒绝、无第二 writer）、轮流发言都进同一条且彼此可见、流式中两个
  订阅者同时拿到增量、一个窗口切走另一个不受影响、订阅者断线不影响对话本身、
  **订阅方切走后看客照样实时**（第 7 段：看客自己发的问题 1 秒内出现、流式中收到增量、
  切走的订阅方收不到别的对话的增量）。**旧构建（add06a7）实测：问题 4226ms 才出现、12 秒内
  0 条增量、回答最后整段到（失败）；新构建：问题 51ms、增量 9 条、切走的 0 条**。
- `tests/cross-client-session-test.mjs` 按新口径改写：原来断言「必须拒绝」的两处
  改为「必须能订阅同一条」，并发发送改为断言「排队而非拦截」

---

## quiet-duplicate-open

**状态**：`local`，**下次同步退役**（代码上已无效果，见下面「现状」）
**基线**：v0.94.1

### 问题

在第二个窗口打开一条**空闲**对话时，每次都弹「该对话在另一处也开着……请只留一处
发送消息」。它说的风险是真的（两个 runtime 各自往同一份 JSONL 追加，轮流发送会让
历史分叉），但多窗口看同一条对话本来就是日常操作，于是这条提醒在正常使用中反复出现。

### 改法

去掉**空闲持有者**那条 info 提醒。只改了 pi 引擎（`server/agent-service.ts`）；DSH 引擎
`server/dsh/dsh-agent-service.ts` 的同一条提醒一直都在（这里原先写「两个引擎同口径」，
不对：这个提交从来没动过 DSH）。真正有害的一刻没有放松：

- 对方**正在跑**时打开 → 仍然硬拦（原样保留）；
- 发消息前的 `prompt()` 守卫仍会再查一次（开时空闲、发时在跑的竞态照样拦）。

### 现状（2026-09-23 同步 v0.94.1 时查明）

栈里排在后面的 `server-owned-chats` 把对话归给了服务端：两处打开同一条就是订阅同一个
runtime，只有**一个** writer，从根上分叉不了。它把 pi 引擎的持有者检查整段删掉了（连同
上面两条硬拦：打开正在跑的对话不再拒绝、发送不再拦截），所以到栈顶这个补丁在代码上
**已经没有任何效果**：它加的行一行都不剩，它删的那段提醒也不在（逐行核对过）。

**下次同步时退役**：在它那一步 `git rebase --skip`；到 `server-owned-chats` 那一步，
`server/agent-service.ts` 里这段取 `server-owned-chats` 自己的版本（整段删掉）；PATCHES.md
删掉本节和索引行，在文末「已退役的补丁」记一笔。这次没删：删它要把后面每个碰索引表的
提交都重解一遍冲突，换来的只是栈里少一个空转的提交，不如放到下次同步顺手做。

（这里原先指向 co-drive 的 `join_client`，该补丁这次同步已退役，见「已退役的补丁」。）

### 回归

- `tests/cross-client-session-test.mjs` 原有断言全绿（含「幽灵持有者不打扰」这条
  「不该出现提醒」的负向断言）；正在跑时的硬拦与并行提醒均未受影响

---

## no-cwd-restore

**状态**：`local`（可上游成设置项：启动目录 = 服务端默认 / 上次用过的）
**基线**：v0.94.1

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

## flat-recent-chats

**状态**：`local`（可上游成设置项：左栏排序 = 最近活动 / 创建时间；分组 = 按项目 / 不分）
**基线**：v0.94.1

### 问题

左栏「最近对话」的行一直在动。前两轮（#140、chat-cwd-pin）都在修这个症状的不同表现，
但只要还是「按项目分组 + 按最后活动时间排」，就总有下一种跳法：

- 一条对话收到消息（定时注入的 `continue`、子代理回报）就窜到顶上；
- 切工作区，分组重排，组标题出现/消失，整列高度变；
- 同名对话（几个「temper」）分在不同组里，找的时候要先想它在哪个文件夹。

用户的要求很直接：一条列表，不要文件夹，不要动。

### 改法

**顺序改成一个不变量的纯函数**：按对话**创建时间**倒序，无分组。创建时间不会因为收消息、
点开、切项目、流式、刷页而变，所以行结构上不可能跳 —— 不是「少跳了」，是没有任何输入能让它跳。
代价是「最近聊过的」不一定在最上面 —— 找它用搜索，列表的价值在于位置可预测。

- 新 wire 字段 `ConversationSummary.createdAt`。**必须是转录的创建时间，不是运行时的**：
  第一版用了 `conv.createdAt`，而运行时是点开对话那一刻才建的，于是一条上周的对话一选中就
  变成「最新」窜到顶上（选中和新建分不开）。现在从转录文件名的时间戳前缀解
  （`2026-09-14T01-39-55-678Z_<id>.jsonl`，`sessionCreatedAt()`），写完就不再变；只有还没落盘的
  全新对话才退回运行时创建时间。磁盘行同样从文件名解，解不出才退回 mtime（mtime 是「最后
  活动」，恰好是不能用的那个）。DSH 对话没有带时间戳的文件名，用运行时的。
- `web/src/conv-groups.ts`：`groupConversations()` 换成 `orderConversations()` —— 扁平行列表，
  根行按 `createdAt` 倒序，子代理缩进跟在父行下（那是父子关系，不是文件夹），父行不在列表里的
  孤儿作为根行出现。缺 `createdAt` 的行（老服务端）排最后且保持相对顺序（稳定排序）。
- `LeftPanel.tsx`：删掉分组容器、组标题、「另一处」行的项目副标题；列表里只显标题，文件夹只在
  悬停里给（`title="<标题> — <cwd>"`）。`.panel-conv-group-title` 样式删。
- `sortAt` 字段保留（其他调用方可能要），只是左栏不再看它。

### 回归

- `tests/unit/conv-groups.test.ts` 重写（7 项）：核心一条是**同一组输入换上 `sortAt` / `messageCount` /
  `isStreaming` / `live` / `waiting` / 输入顺序打乱，输出顺序字面相同**；另有跨文件夹混排、
  子代理缩进、孤儿不丢、缺字段排最后、同时刻稳定。
- `tests/unit/recent-chats.test.ts` 新增 5 项：文件名解析（含 Windows 路径、解不出返回 undefined）；
  磁盘行的 `createdAt` 来自文件名而 mtime 变了它不变；无时间戳文件名退回 mtime；**点开一条上周的
  磁盘行后 `createdAt` 不变**（就是上面那个「选中就窜顶」的复现）；活行不随转录活动变。
- `scripts/check.sh` 全绿（111 文件 / 1401 单测 + 63 PTY）

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

---

## no-mcp-restart-nag

**状态**：`local`（上游修了就删；真正的修法在 pi-mcp-adapter 那边）
**基线**：v0.94.1

### 问题

每次启动都弹「MCP: direct tools for github, github-read will be available after restart」。
但工具当时就已经注册好了——同一个会话里 `github_*` 直接能调，“重启后才能用”是假的。

根因在 pi-mcp-adapter：那条通知只在服务器的缓存元数据判定为“缺失”时才弹
（`init.ts` 里的 `getMissingConfiguredDirectToolServers`），而是否有效看 `configHash`；
`metadata-cache.ts` 的 `computeServerHash` 把 `headers` / `bearerToken` 做完环境变量
插值后也算进 hash。GitHub 令牌一轮换，hash 就变 → 缓存判定失效 → 重新 bootstrap
→ 再弹一次。缓存里其实是有的（`~/.pi/agent/mcp-cache.json`：github 90 个工具、
github-read 56 个）。

上游这行是整个启动流程里**唯一一条没带开关的通知**：相邻的「N servers connected」
受 `settings.notifyOnStartupConnect` 控制，它不受。看着像漏了，不像有意为之。

### 改法

`server/webui-context.ts` 的 `notify` 入口加一张 `MUTED_INFO_NOTICES` 正则表，
**只对 `info`** 生效，且整条匹配（`^…$`）。warning / error —— 连不上、工具被跳过、
需要授权 —— 照常弹；其他 MCP info（如「N servers connected」）也不受影响。

注意这只是撑掉提示：那两个 server 仍然每次启动重做一遍 bootstrap（多几次连接 +
list 往返）。想真修就得让令牌不再每次变（固定 `bearerToken`，或 `requestHeadersCommand`
只解一次），让 hash 稳下来、缓存真的被用上。

### 回归

- `tests/unit/mute-mcp-restart-nag.test.ts` 6 项：单 server / 多 server 逗号分隔 / level 省略时
  按 info 处理 / **warning 与 error 照常弹** / 其他 MCP info 不受影响 / 把这句话当正文的
  消息不误伤

---

## terminal-cwd-anywhere

**状态**：`local`
**基线**：v0.94.1

### 问题

上游把 PTY 的**启动目录**限在工作区内（`TerminalManager.safeCwd` 用
`relative()` 做包含检查），越界就报「Terminal cwd must be inside the current
workspace」。两个入口都受影响：`create()`（前端新开标签 / agent 的
`terminal_create` 工具）和 `runCommand()`（`.pi/commands.json` 里带 `cwd` 的命令）。

这个限制拦不住任何东西：终端就是个交互式 shell，开出来第一件事就可以
`cd /anywhere`，跟在哪个目录**启动**没关系。它只挡了日常多仓库用法：在另
一个 checkout 开个终端、让 agent 去别的仓库跑条命令。真正的边界是访问控制：
服务端默认只听 `127.0.0.1`，每条连接都要 token。

### 改法（`server/terminals.ts`）

- `safeCwd()` 去掉包含检查：相对路径仍然按工作区根解析（agent 工具的 `cwd`
  参数就是这么写的），绝对路径原样接受。保留的唯一约束：目录必须存在且是
  目录（`realpathSync` + `statSync().isDirectory()`）—— 否则 PTY 根本起不来。
- 两处报错改成实话：`Terminal cwd is not an existing directory: <path>`
  （i18n key `terminals.cwd.missing`，带上到底是哪个路径），不再谎称是工作区边界。
- agent 的 `terminal_create` 工具描述/参数说明同步改口（从「工作区相对目录」改为
  「绝对路径（任意位置）或工作区相对路径」），否则模型不知道可以传绝对路径。

### 回归

- `tests/unit/terminal-cwd.test.ts` 5 项：工作区外目录能开 / 相对路径仍按工作区根解析 /
  不存在的目录被拒且报错带路径 / 指向文件被拒 / `runCommand` 同样放行。
  （对着未打补丁的 `server/terminals.ts` 跑：5 项中 4 项失败——确实是回归测试。）
- `tests/unit/terminal-view.test.ts` 里那条「非法 id/越界 cwd 仍被拒」同步改成：非法 id
  仍拒、工作区外放行、不存在的目录仍拒。

---

## chat-window-pagination

**状态**：`local`
**基线**：v0.94.1（协议 v20 → **v21**）

### 问题

上游的快照把对话的**全部**消息一次性发给浏览器。实测一个 8615 条消息的
会话（`~/.pi/agent/sessions/--home-shinelay--/2026-09-14T01-39-55-678Z_*.jsonl`，
37.2MB）：

|                        |                        |
| ---------------------- | ---------------------- |
| 磁盘读 + JSON.parse    | **226 ms**（不是瓶颈） |
| 快照发给浏览器的字节   | **35.88 MB**           |
| 尾部 100 条            | **0.54 MB，只占 1.5%** |
| 全量提问索引（220 条） | **15 KB**              |

所以「老对话打开慢」花的不是磁盘，是 35.88MB 过 socket + 浏览器解析/协调。
顺带的第二个毛病：滚条无限长，往回找东西只能一直往上拉。

### 改法

服务端分页（不是前端少渲染），因为要省的就是传输和解析：

- `server/agent-service.ts`：全量快照只带最新 `MESSAGE_WINDOW` 条（默认 100，
  `PI_WEB_MESSAGE_WINDOW` 可调，`<=0` = 不分页），带上 `messagesStart`；新增
  `loadOlder(beforeIndex, count)` 发 `older_messages`。
- `server/question-index.ts`（新）：`buildQuestionIndex` / `questionPreview`——每条 user
  消息一项，带**全局下标**和 160 字预览，技能调用显示 args 而不是 SKILL.md 正文。
- `server/protocol.ts`：`UiState.messagesStart` / `UiState.questionIndex`（均可选，
  不分页的 DSH 引擎不发）、`UiQuestionRef`、`load_older` / `older_messages`。
- `web/src/message-window.ts`（新）：`prependOlderMessages`（切对话/接不上/重复
  一律作废）、`paginationAfterDelta`（delta 只长末尾，窗口起点不变，提问索引
  缺省沿用）。抽成纯函数是为了可测，也跟 `message-delta.ts` 的既有做法一致。
- `components/MessageList.tsx`：导轨改用全量 `questionIndex`（编号不再随窗口
  漂）；顶部「↑ 载入更早的消息（还有 N 条）」按钮；点一条**还没加载**的提问
  会先把那段取回来再跳（`pendingJumpRef`）。

设计取舍：**窗口恒贴末尾、永远连续**——所以完整长度恒等于
`messagesStart + messages.length`，服务端不发 total（两处就不会不一致）。代价：
点导轨上很老的提问会把中间那段一起拉回来；最坏也就是老行为（整段都在），
不会更差，且是用户明确点击才发生。

协议号从 16 升到 **17**：老页面配新服务端会静默只看到 100 条历史且没有入口，
正是版本号要拦的那类不兼容。

### 回归

- `tests/unit/question-index.test.ts` 9 项：全局下标不是提问序号 / 只收 user /
  技能调用显示 args / 无 args 退回技能名 / **跟前端 `parseSkillBlock` 对同一样本
  结果一致**（两处正则不许漂）/ 空提问不进导轨 / 预览截断 / 多文本块拼接 /
  8600 条的索引 < 30KB。
- `tests/unit/message-window.test.ts` 11 项：拼接与起点前移 / 原状态不被改 /
  切对话的迟到回执作废 / 接不上的作废（宁可不合并也不留空洞）/ 重复作废 /
  空回执作废 / 一路拼到顶 / delta 不冲掉分页状态。
- `tests/chat-pagination-test.mjs` 16 项线上协议冒烟（零 token，已入
  `tests/run-smoke.mjs`）：预先写好一份 24 条 / 6 提问的会话 jsonl，用
  `PI_WEB_MESSAGE_WINDOW=8` 跑真服务端，验证快照只带 8 条且 `messagesStart=16`、
  `questionIndex` 盖全 6 个提问且下标是 0/4/8/12/16/20、`load_older` 回的段正好
  接在窗口前面、一路取到 start=0、到顶后再要就不发了。

## bg-tasks-push-dedupe

**状态**：`local`
**基线**：v0.94.1

**症状**（用户 2026-09-22 报）：“pi-web-ui 不再把事件推到 UI，不刷新就看不到
任何对话的更新。”

**实测**：服务端推送本身没坏。用真实浏览器（`pi.wai2shine.com`，过 Cloudflare
隧道）量了一个没刷新过的页面：`messagesStart=1854`、页脚 `messages 2446 → 2463`、
`Context 165.1K → 177.4K`、287 行已挂载、滚动容器 `fromBottom=0`——快链路上一切正常。
真正的问题在流量：60 秒内数到 **101 条 `bg_servers`**，每条都带完整任务列表
（~16KB）≈ **1.6MB/分钟的纯噪音**，而内容一字未变。

**链路**：`插件 task.update()` → `plugins.ts` 的 `fire()` → `onBgTasksChanged` →
`AgentService.refreshBackgroundServers()` → **每个** ClientSession 的 `refreshBgTasks()`
→ `BgServerTracker.push()` → 广播给所有 sink。源头是 `~/.pi-web-ui/plugins/temper/
index.mjs` 的轮询：对每条盯梢的运行无条件 `update()`，20 条 × 10s = 120 次/分。

**为何会表现为“不刷新就停更”**：快照推送有背压保护（`ws.bufferedAmount` 超阈就
丢弃这次 snapshot / snapshot_delta）。慢链路（手机、移动网）上，1.6MB/分的噪音
足以把缓冲长期顶在阈值之上，于是消息列表停更，而重新刷新（新 socket + 新快照）
立刻正常——正是用户描述的现象。快链路的笔记本看不出来（bufferedAmount ≈ 0）。

### 改动

- `server/bg-servers.ts`：`push()` 收 `{ skipIfUnchanged }`，序列化后跟 `lastPushedJson`
  比对，一样就不推。**默认仍然无条件推**（新 socket 接入必须拿到一份），且无条件
  推送也刷新基线，避免拿陈旧基线比对。
- `server/agent-service.ts`：`refreshBgTasks()` 改调 `push({ skipIfUnchanged: true })`——
  只有“插件任务变化”这条高频路径去重，其余调用方不受影响。
- （仓外）`~/.pi-web-ui/plugins/temper/index.mjs`：源头也加了去重，状态字符串没变就
  不调 `update()`（`lastTaskStatus`；`persist()` 只写 id/workflow/lastStatus，不会落盘）。

两层都改是故意的：插件层治这一个插件，宿主层治所有将来的嗦叭插件。

### 回归

- `tests/unit/bg-servers-dedupe.test.ts` 4 项：重复推只发一次 / 状态真变了必须发 /
  默认路径永远发（新 socket）/ 无条件推送会刷新去重基线。

## load-older-survives-snapshot

**状态**：`local`
**基线**：v0.94.1

**症状**（用户 2026-09-22 报）：点了「加载更早消息」，一来新消息就退回点击之前的样子，
已加载的历史没了。

**复现**（headless，两个方向的 WS 帧都记）：点击 → `older_messages start=4053` → 标签
4153→4053 → 没有任何 `get_state`，服务端自己连发 `snapshot rev=4 start=4153`、
`rev=5 start=4155` → 标签退回 4153。整段日志里**一条 snapshot_delta 都没有**。

**根因（上游的问题，被分页暴露出来）**：`serializeCachedFor` 的缓存上限固定
`UI_MESSAGE_CACHE_CAP = 4096`、按插入顺序淘汰，而 `messagesOf()` 每次从最老到最新顺序
扫整段对话。超过 4096 条的对话里，这一遍扫描会先淘汰掉自己马上要用的项（顺序
扫描抖动），**每条消息每次都重新序列化成新对象**：

- `emitSnapshotNow()` 靠对象引用判断「只是追加」，下标 0 就对不上 → 每个检查点（流式期间
  每 60ms）都发整份快照（100 条，~0.5MB）而不是几百字节的 delta；整份快照把客户端
  窗口重置成最新 100 条——这就是用户看到的「退回」。
- 用户消息的 `seq` 在每次未命中时 +1，id（`u-<ts>-<seq>`）每次都漂移。
- 2463 条的 rollcall 对话没超上限，所以那边一直是 delta——只有超长对话中招。

分页之前整份快照带全部消息，所以这个抖动只是慢（而且是很慢），看不出错。

**服务端那一半已退役（v0.94.1 同步，2026-09-23）**：原补丁还有一半叫 ui-cache-no-thrash——
`server/ui-message-cache.ts` 把缓存上限抬到 `max(4096, 2×活跃条数)`，仍按 FIFO 淘汰。
上游 4dfd95d（issue #259）修了同一个根因，而且修得更好：`pruneMessageCache()` 只回收
「已不在转写里」的死条目，绝不淘汰仍在转写里的项。于是这一半连同它的单测
（`tests/unit/ui-message-cache.test.ts`）一起删掉，`server/agent-service.ts` 与上游一字不差。
上游没给 #259 写测试——下面冒烟第 5 段现在就是它的回归保护。

### 改动

- `web/src/message-window.ts` `keepLoadedHistory()` + `use-chat.ts` 的 `snapshot` reducer：
  整份快照到达时，同一对话 + 同一 `sessionId` + 客户端消息一直连到快照窗口第一条
  - 那一条 id 对得上，就把已加载的更早历史拼在前面。任何一条不满足就原样采用快照
    （压缩/分叉/换会话/中间有洞）。整份快照在修好抖动之后仍会正常出现（重连、
    rev/seq 缺口后的 get_state、同一客户端另一个标签页重连），所以这一层不是多余的。

### 回归

- `tests/unit/message-window.test.ts` 新增 10 项（`keepLoadedHistory`）：接得上就保留且起点
  不回退 / 拼好后 `messagesStart + 条数` 不变量成立 / 重叠部分和轻量字段用快照的 /
  换对话、换会话、历史被改写、中间有洞、没加载过、首次连接、空窗口都原样采用快照。
- `tests/chat-pagination-test.mjs` 第 5 段（真服务端，零 token）：4300 条的种子会话上发两次
  `set_thinking`（每次都 flush 一个检查点），要求全是 `appended=[]` 的 snapshot_delta、零整份快照。
  **旧构建上实测 0 delta / 2 整份快照（失败），新构建 2 delta / 0 整份快照**。同步到
  v0.94.1 后，去掉我们的服务端改动、只靠上游的 `pruneMessageCache()`，同样 2 delta / 0 整份快照。

---

## exchange-fold

**状态**：`local`
**基线**：v0.94.1

**诉求**（用户 2026-09-23）：agent 一跑就是几十轮思考 + 工具调用，每轮一个块，读不过来。把一轮对话的
中间步骤折成一行，显示一共几轮、几次思考、几次工具调用；最终只看「我的问题 + 它的回答」。
用户选定：折叠时只留下回答；agent 还在跑时是一行折叠的直播行。

### 改法

- `web/src/exchange-fold.ts`（纯逻辑，不碰 React）：`planExchangeFolds(messages, opts)` 把消息切成一轮一轮。
  一轮 = 一条用户提问（或用户自己跑的 `!` 命令）到下一条之间的所有消息；运行中 steer 切成两轮。
  每轮算出：隐藏的成员（思考、工具调用及结果、步骤之间顺手写的话、运行中插进来的提醒/压缩摘要）、
  回答（最后一条有文字的助手消息，只显示文字；以错误收尾时最后一条也在，错误信息和重试按钮挂在它上面）、
  计数、时长、状态（done / working / error / aborted），以及折叠行画在哪条消息之前。分页窗口从一轮
  中间开始时从第一条已载入的消息算起。
- `web/src/components/ExchangeFoldRow.tsx` + `exchange-fold.css`：折叠行
  `▸ 23 turns · 11 thinking · 31 tool calls · 4m 10s`。agent 还在跑时是直播行：转圈、计数实时增长，
  下面一行显示当前步骤（`liveStep()`：思考中… / 写回答… / `bash: <命令>`）；回答照常在行下方流式出现。
  点这一行展开 = 和以前一样的完整视图，再点收起。
- `MessageList.tsx`：按 plan 决定每条消息画不画、怎么画（隐藏成员不画，回答走 `textOnly()`）。
- 提问和回答不吃上游的摘要行：上游把最近 `KEEP_RECENT` 条以外的旧消息画成一行摘要，点了才展开；
  而折叠起来的步骤也算在这 N 条里，所以除了最后一轮，每一轮的回答都会被收成摘要行。
  `oldRow()` 把用户消息和回答（不是折起来的步骤的助手消息）排除在外。其它消息（展开那一轮里的步骤、
  附件、收尾后的提醒/压缩摘要、`!` 命令）照旧。用户 2026-09-24：“don't fold the final output, it will
  be annoying to un-collapse jus to see the output”。
- 文案：`web/src/i18n.tsx`（en/zh）+ `locales/*.json`（de es fr it ja ko pt ru）各 12 条。
- 依赖 server-owned-chats 的「用户问题落盘即对账」（c094fe9）：问题和 `isStreaming=true` 一起到，
  折叠行从第一帧就在。没有它，第一轮的思考会先在行外裸露渲染一两秒。

### 回归

- `tests/unit/exchange-fold.test.ts`：22 项。已结束的一轮（切分与计数、取哪条当回答、单条回答不折、
  错误与中止、附件和回答之后的消息照常显示、压缩摘要/提醒随步骤隐藏、`!` 命令是边界、分页窗口切开的一轮、
  steer 切成两轮），直播中的一轮（整段隐藏、正文还空时行画在末尾、工具结果后等模型时不露回答、
  回答写完不再闪「working」、新问题在路上时上一轮保持已完成、扩展触发的一轮），以及 `textOnly` /
  `liveStep` / `formatSpan`。
- `tests/exchange-fold-test.mjs`（真服务端 + 真浏览器，mock 模型，零 token）：思考 → 两次工具调用 → 回答
  的三轮运行：直播行与当前步骤、计数递增、折叠期间从不出现工具卡/思考块、回答照常流式、
  结束后一行 `3 turns · 1 thinking · 2 tool calls · 5s`、点开/收起、刷新后不变。再加一段长对话
  （6 轮、36 条，超出 `KEEP_RECENT`）：6 行折叠、没有提问或回答被截成摘要行、每条回答（最早的也算）完整
  显示；展开最早一轮时它的步骤照旧是摘要行，回答仍完整。共 31 项。`XFOLD_DEBUG=1` 打印时间线和 WS 帧。
  **c094fe9 之前实测两项失败（第一轮的思考出现时还没有折叠行）；`oldRow()` 排除回答之前实测两项失败
  （7 个摘要行，最早三轮的回答被截）；之后全过。**
- `tests/collapse-test.mjs`（上游的冒烟）：种对话的脚本跟上协议 v2（先完整 `snapshot`，之后只有
  `snapshot_delta`），页面固定为中文（检查读「展开/收起」）。按 exchange-fold 改：提问从不是摘要行、
  滚到它时完整显示；最早的摘要行是第一个附件。共 12 项。

---

## exchange-digest

**状态**：`local`
**基线**：v0.94.1（接 chat-window-pagination 与 exchange-fold）

**诉求**（用户 2026-09-24）：分页之后快照只带最新 `MESSAGE_WINDOW`（100）条消息。agent 一轮动辄几百步，
这 100 条常常全落在最后一轮里；exchange-fold 把步骤折起来以后，页面上只剩一行，前面几轮问了什么、
答了什么都看不到，得一截一截地「载入更早」。要求：打开对话至少看得到最近 5 轮的提问和回答。
原样发最近 5 轮太重（实测长会话 11–12MB，现在的快照 0.2–1.8MB），所以只发摘要。

### 改法

- `server/exchange-digest.ts`（纯函数）：窗口之前的每一轮只发前端折叠时会显示的东西——提问（连同附件）、
  回答（只留文字）、回答之后照常显示的消息、折叠行的计数/时长/状态（`UiExchangeDigest`），一轮几 KB。
  `digestExchange` / `digestsBefore`（按轮数或按区间取，最多 `MAX_DIGESTS` = 1000）/
  `snapshotDigests`（窗口里开头的轮数不够 k 就补；窗口从一轮中间开始时总带上这一轮开头那一截，
  `partial`）/ `straddleDigest`。规则与 `web/src/exchange-fold.ts` 一致（一个在服务端、一个在前端，没法共用），
  单测拿同一批样本钉住两边算出来的一样。
- 协议（`server/protocol.ts`）：`UiState.exchanges`（整份快照带，delta 不带）；
  `load_exchanges { beforeIndex, count?, fromIndex? }` → `older_exchanges { conversationId, beforeIndex, exchanges }`
  （空结果也回，客户端靠它知道到顶了）；`older_messages` 多一个 `straddle`（新起点落在一轮中间时，
  这一轮开头那一截的摘要）。
- `server/agent-service.ts`：快照带 `snapshotDigests(cur, windowStart, EXCHANGE_DIGESTS)`；`loadExchanges()`；
  `loadOlder()` 附 `straddle`。`PI_WEB_EXCHANGE_DIGESTS`（默认 5；<=0 = 不发摘要，前端退回按条载入）。
  `server/index.ts` 路由 `load_exchanges`（`loadExchanges?` 可选：DSH 引擎不实现，快照里没有 exchanges，
  前端也就不请求）。
- `web/src/message-window.ts`：`chainDigests`（只留窗口之前、首尾相接、最新一份正好接到窗口起点的一串；
  接不上的地方往前丢掉——宁可让用户再点一次，也不拼出有洞的历史）、`prependOlderExchanges`、
  `prependOlderMessages`（载入的消息替掉它覆盖的摘要，`straddle` 替换跨窗口那一轮的 partial），
  整份快照到达时保留用户多取的摘要（接缝处那条的 id 对得上才接，同 `keepLoadedHistory`）。
- `web/src/exchange-fold.ts`：`PlanOptions.lead`（`FoldLead`）——窗口从一轮中间开始时，开头那段接上 partial
  摘要：键（提问 id）和起始时间用它的，计数加上它的。载入以后真正的折叠也是这个键，展开状态接得上。
- `MessageList.tsx`：摘要画在窗口消息之前（提问、回答、折叠行，和真消息一个样）。
  「显示更早的对话（还有 N 个提问）」往前取几轮摘要；点导轨上还没显示的提问 → `load_exchanges`
  带 `fromIndex` 一路取到它再跳；点开摘要里的一轮或跨窗口的那一轮 → `load_older` 取回从这一轮开头起的
  消息（窗口要连续，中间几轮也一起载入，照样折着）。
- `use-chat.ts` 处理 `older_exchanges`；`App.tsx` 接 `onLoadExchanges`；文案 `loadOlderExchanges`
  （`i18n.tsx` en/zh + `locales/*.json` 8 种）。

### 回归

- `tests/unit/exchange-digest.test.ts`：16 项。一轮的摘要（提问 + 附件、回答只留文字、回答之后的消息、
  计数、状态、折不折）、`!` 命令、以错误收尾、partial；按轮数/区间取、上限；快照带几份、跨窗口那一轮；
  与 `planExchangeFolds` 对拍。`tests/unit/message-window.test.ts` +15 项（`chainDigests` /
  `prependOlderExchanges` / 载入替掉摘要 / 快照保留），`tests/unit/exchange-fold.test.ts` +4 项（`lead`）。
- `tests/exchange-digest-test.mjs`（真服务端 + 真浏览器，零 token，预先写好的会话：7 轮，最后一轮
  30 步；窗口 20、摘要 2）：打开时看得到最近两轮的提问和回答，最后一行的计数是整轮的
  （`31 turns · 1 thinking · 30 tool calls`），没有步骤被画出来；「显示更早的对话」；导轨跳到第 1 个提问；
  点开跨窗口那一轮取回 30 步；点开摘要里的一轮取回它的步骤、其它轮照旧折着。共 21 项。
  `DIGEST_DEBUG=1` 打印每一步的页面状态和发给服务端的 `load_*` 请求。数的是消息节点（`[data-msg-id]`），
  不是 `.toolcall`：较老的消息画成一行摘要行（`oldRow`），不是工具卡。

---

## done-any-chat

**状态**：`local`
**基线**：v0.94.1（接 server-owned-chats）

**诉求**（用户 2026-09-24）：任何一条对话跑完都要听到提示，不只是正开着的那条。

### 改法

- `web/src/done-cues.ts`（纯函数）：
  - `runEdge(prev, next)`：正开着的那条对话的开始/结束，只认**同一条对话自己的**变化。上游的 effect 只看
    `state.isStreaming`，从一条在跑的对话切到一条闲着的，会误响一次「完成」。
  - `runningSeen` / `finishedChats(prev, list, activeId)`：其余对话看左栏列表每行的 `isStreaming`，上一份
    里在跑、这一份里不跑了就是跑完了。正开着的那条归 `runEdge`（不重复响）；子代理不算（父对话还在跑，
    跑完自己会响；不然并行派几个子代理就响几次）；历史行、上一份里没有的对话不算；刚加载/刚重连
    （`prev` 为 null）不算。
- `App.tsx`：原来的开始/结束 effect 改用 `runEdge`（依赖加上 `conversationId`）。新 effect 看
  `chat.conversations`：有对话跑完就响一次「完成」，每条（最多 3 条）发一条系统通知，正文带对话标题
  （`notifyDoneBodyChat`）。断线（`chat.ready` 变 false）清空记录：服务端重启会结束所有 run，不能当成跑完了。
- `server/agent-service.ts`（`ClientSession.onEvent`）：
  - `agent_start`：`emitConversations()` → `ClientSession.emitConversationsToAll()`。server-owned-chats 之后对话表
    是共享的，每个窗口都列着所有对话，但列表只推给订阅这条对话的那个会话（`emit()` 只把
    `message_delta`/`tool_delta` 扩出去）。别的窗口（另开的窗口、另一台设备、上游刷新两次后留下的那一个）
    看不到它开跑，也就看不出它跑完。
  - 新增 `agent_settled`：同样推给所有窗口。`session.isStreaming`（SDK 的 `_isAgentRunActive`）要到这时才变回
    false，agent_end 之后还有排队的追问、自动压缩。以前没人在这时推列表，「在跑」要等 agent_end 之后
    800ms 那次刷新碰运气（收尾慢就还显示在跑）。
- 文案：`notifyDoneBodyChat`（`i18n.tsx` en/zh + `locales/*.json` 8 种）；`sound.done.desc` 改成「任何一条对话里…」。

### 回归

- `tests/unit/done-cues.test.ts`：14 项。`runEdge`：同一条、换一条、没有快照。`finishedChats`：后台跑完、
  正开着的那条、首份列表、新出现的、仍在跑/刚开跑/一直闲着、离开列表、子代理、历史行、一次跑完几条。
- `tests/done-any-chat-test.mjs`（真服务端 + 两个浏览器上下文，零 token，AudioContext 换成记录器，按音符认
  提示音）：窗口 A 在慢对话跑着时新开对话——不响；新对话答完响一次；窗口 B 后打开、从没订阅过慢对话；
  慢对话跑完 A、B 各响一次（答完后约 10ms），不多响。共 14 项。修复前（29c8f29）失败 5 项：切走误响，
  A 和 B 都没为后台对话响。`DONEANY_DEBUG=1` 打印列表推送、mock 请求和提示音时间线。
  - 测试的数据目录是新的，上游的「同项目并行提醒」（`parallelReminderEnabled`，默认开）会在快对话的首条提问
    后附一条「(System reminder …」，列出在跑的慢对话连同它的提问。mock 按对话自己的提问认对话时要跳过它。
  - 快对话的回答分几段流式发（约 1.5 秒）。几毫秒就跑完的 run，页面快照来不及显示它在跑，正开着的那条
    就不响（上游原来就这样，真实的 run 至少几秒）。

---

## todo-list-owner

**状态**：`local`（上游同样有这个问题，可以提 PR）
**基线**：v0.94.1

**问题**（2026-09-24 实际遇到）：`todo_list` 读的是建这个 runtime 的窗口**此刻正开着的**对话（`this.activeId`），
不是调用它的对话。对话在后台跑时，它拿到的是前台对话的任务列表。写操作（内联 `[[todo:...]]`）不受影响：
标记按产出它的对话（`conv.id`）写。

**改法**：`makeRuntimeFactory` 里 `makeMarkersListTool(() => ownerId ?? this.activeId, …)`。`ownerId` 就是这个
runtime 所属的对话（每个调用点都传了 `conversationId`），跟标记写入用的是同一个 id；边上的
`ask_user_question`、`browser_page`、`claim_files`、子代理工具早就这么用。

**回归**：`tests/todo-list-owner-test.mjs`（真服务端 + 浏览器，零 token）。先在页面自带的第一条对话里说一句、
再新开对话 A：A 记一条任务，下一次模型调用被 mock 扣住；窗口新开对话 B，B 记自己的任务；放开 A，A 在后台
调 `todo_list`。共 11 项，修复前失败 2 项（拿到的是 `bravo task`）。

- 坑：页面自带的第一条对话不能当 A。上游页面会加载两次，第一条对话的 runtime 可能是被丢掉的那个连接建的，
  它的「正开着的对话」永远停在 A 上，修复前也碰巧读对（第一版测试就是这样在修复前通过的）。

---

## markers-skip-code

**状态**：`local`（上游同样有这个问题，可以提 PR）
**基线**：v0.94.1

**问题**（2026-09-24 实际遇到）：内联标记是在整段助手正文里找，代码块、行内代码也照样执行。AI 把系统
提示词贴进回答（放在代码块里），里面的标记示例就执行了：对话被改名成「…」，还多了一条空任务。

**改法**（`server/markers/marker.ts`）：

- 新 `codeRanges(text)`：围栏代码块（``` / ~~~，最多 3 格缩进；同种字符、不短于开头、独占一行才算闭合；
  没闭合就到结尾）和行内代码（N 个反引号到下一段恰好 N 个；不跨空行；配不上的反引号是普通字符）。
- `parseMarkers`：开头落在代码区间里的标记跳过。正文里没有 `` ` `` 也没有 `~~~` 就不算区间。
- `stripMarkers`：同样留下代码里的标记（目前没有调用方，保持一致）。
- 页面不处理标记：`web/src` 里没有标记解析，标记原样显示。

**回归**：`tests/unit/markers-skip-code.test.ts` 15 项：正文照样执行、``` / ~~~ 块、没闭合的块、缩进、
闭合规则、行内代码、反引号个数、落单的反引号、不跨空行、标记自己的文字里带行内代码、当天贴系统提示词的原样。

---

## single-load

**状态**：`local`（上游的 bug，来自 1f31bde；到 upstream/main 7f641d7 还在。拟提 issue，上游修了就退役）
**基线**：v0.94.1

**问题**（2026-09-24 实测）：每个新标签页都把整页加载两遍。上游 1f31bde「self-reload page when server
rebuilds underneath it」比的是两个永远对不上的 id：页面用 Vite 编进 bundle 的 `__BUILD_ID__`（构建时间戳，
如 `20260925T02154`），服务端 ready 帧发的是 index.html 里入口 chunk 的 hash（如 `hBSAltKa`）。于是页面一收到
ready 就刷新（sessionStorage 标记挡住第二次），多开一条 WS、多留一个被丢掉的会话。线上实测新标签页要
~2.0 秒才可用，只加载一次是 ~1.1 秒。服务端还把 id 缓存到进程退出：重建了前端、还没重启服务端时
（本 fork 常有的状态：前端刷新即生效，服务端等空闲再重启），它报的是启动时那份的 hash。

**改法**：两边都认 index.html 里入口 chunk 的 hash。

- `web/src/use-chat.ts`（`ready`）：页面自己的 id 取它被服务时那份 index.html 的入口 `<script>`
  （`script[src*="/assets/index-"]`，正则和服务端同一个）。Vite 开发服务器服务的是 `/src/main.tsx`，没有
  hash，照旧不刷新。
- `server/index.ts` `buildId()`：每次 ready 现读 index.html（~1KB），不再缓存。
- `server/protocol.ts`：`buildId` 的注释改对（原来写的是「Vite `__BUILD_ID__`」）。
- `__BUILD_ID__` 的 `define`（`web/vite.config.ts`）和 `web/src/build-id.d.ts` 没人用了，为补丁小留着没删。
  副作用是好事：bundle 里不再有时间戳，源码没变就重建出同一个 hash（实测），重启后开着的标签页不白刷。

**回归**：`tests/single-load-test.mjs`（真服务端 + 浏览器，零 token）。① 新上下文打开：只导航 1 次、
1 条 WS、没有刷新标记；② 把页面入口 `<script>` 改成别的 hash 再重启服务端：恰好刷新一次、落在服务端
那份构建（自刷新没被修坏）；③ `SINGLELOAD_MUTATE_DIST=1` 才跑：服务端在跑时 index.html 变了，之后的
连接拿到新 id（它改 `web/dist/index.html`，只在临时副本里开）。共 10 项，修复前失败 6 项。

---

## tldr-panel

**状态**：`local`
**基线**：v0.94.1

**诉求**（用户 2026-09-24）：agent 长任务动辄几百步，读不过来；要一份边做边写的大白话 TL;DR，只记大事。
三步：① exchange-fold（折叠步骤）；② pi-tldr 扩展（`~/projects/pi-tldr`，独立仓库，不进本 fork）给 agent 一个
`tldr` 工具和轻提醒，每一行存成会话自定义条目；③ 本补丁：右栏的 TL;DR tab。用户的选择：只放右栏，最新的在上，
可展开到全部，「需要你」的行高亮；不进折叠行、不进左栏。

### 改法

- 条目格式（和 pi-tldr 的约定）：`{ type: "custom", customType: "tldr", data: { v: 1, text, needsYou, ts } }`。
- `server/tldr-lines.ts`（纯函数）：`tldrLinesFromEntries(entries)` 把**当前分支**的条目变成行，按时间升序；
  坏数据跳过不抛；只留最新 500 行，一行最多 400 字。读分支（`getBranch()`）而不是消息：压缩只加一条
  compaction 条目，老行还在；改写分叉后被丢下的分支上的行不再显示（和消息列表一致）。
- `server/protocol.ts`：`UiTldrLine { id, text, needsYou, ts }`，`UiState.tldr?`。
- `server/agent-service.ts`：
  - `tldrOf(conv)`：缓存挂在 `Conversation.tldrCache`（同一条对话的所有窗口共用），key = 会话 id + 叶子 id：
    流式期间 60ms 一条的快照不重扫分支，树动了才扫；行 id 串没变就沿用同一个数组。出错（DSH 之类没有
    sessionManager）返回缓存或 `[]`。
  - `emitSnapshotNow`：整份快照总带 `tldr`（切对话要把上一条的行换掉）；delta 只在数组引用变了时带
    （`ClientSession.emittedTldr`，每个窗口各记各的）。客户端 delta 合并是 `{...ui, ...d.state}`，缺省就沿用。
- `web/src/components/TldrPanel.tsx`：倒序列出；默认只显示最新 5 行，「显示全部（N 行）」展开；「需要你」的行
  琥珀色底 + 徽标；行尾时间（今天只写时分）。空态说明要装 pi-tldr。
- `web/src/components/RightPanel.tsx`：内置 tab `tldr`（槽位条目 `host:right-tldr`，`ui-slots.ts`，order 20，
  排在文件后面）；排序/隐藏和文件 tab 一样走槽位（`HOST_TAB_SLOT_ID`），设置里「界面布局」能藏。
  `App.tsx` 传 `tldr={chat.state?.tldr}`。
- 文案：`tldrTab` / `tldrEmpty` / `tldrShowAll` / `tldrShowFewer` / `tldrNeedsYou`（`i18n.tsx` + `locales/*.json`
  8 种）；样式 `.tldr-*`（`styles.css`）。

### 回归

- `tests/unit/tldr-lines.test.ts`（4 项）：只认 tldr 条目、坏数据、时间戳回退、上限和截断。
- `tests/unit/tldr-panel.test.ts`（4 项，renderToStaticMarkup）：空态、倒序 + 收起/展开、放得下就没按钮、高亮。
- `tests/unit/ui-slots.test.ts`：右栏槽位多了 `host:right-tldr`。
- `tests/tldr-panel-test.mjs`（真服务端 + 两个浏览器窗口 + **真的 pi-tldr**，零 token）：mock 模型分三次调 `tldr`
  再回答。`tldr` 工具出现在模型请求里（扩展在 pi-web-ui 里加载、hasUI）；窗口 A 逐行实时看到、最新的在上；
  窗口 B 中途打开同一条对话，第 3 行也实时到；「需要你」高亮加徽标；刷新后行还在；新对话是空态、切回来行
  又回来。共 21 项。pi-tldr 位置默认 `~/projects/pi-tldr`，`PI_TLDR_PKG` 可改；`TLDR_SHOT=/tmp/x.png` 存截图。
  - 反向验证：delta 不带 `tldr` 时失败 5 项（跑的过程中一行都不出来，跑完靠整份快照一次出三行）。

---

## 已退役的补丁

同步时删掉的补丁在这里留一笔，下次同步不用再查它们为什么没了。

- **co-drive**（旧 `530d593`，同步 v0.94.1 时退役）：`join_client` / `leave_client` 让一个 socket
  加入另一个客户端的会话、一起驾驶。被 `server-owned-chats` 取代：对话归服务端之后，所有
  窗口本来就在同一条对话上，`server-owned-chats` 也早就删了这两条消息。做法：先在旧基线上
  把 `quiet-duplicate-open`、`server-owned-chats` 不带 co-drive 重排一遍（树与原来逐字节相同），
  再整体 rebase。
- **no-parallel-noise**（旧 `27caeb9`，同步 v0.94.1 时退役）：删掉「同项目并行提醒」（同一 cwd
  下有别的对话在跑时，每轮都弹）。上游 v0.94 加了开关 `parallelReminderEnabled`（设置里的
  「同项目并行提醒」，默认**开**），关掉时两个引擎整段跳过，效果与本补丁相同。**保持
  关闭**：它存在 `~/.pi-web-ui/client-state.json` 的全局 `__settings__` 里，所有客户端/标签页
  共用，关一次就行。副作用（上游自己的设计）：关掉后那段里的认领心跳
  `getClaimStore().touch()` 也不跑。
- **ui-cache-no-thrash**（旧 `0ce96b5` 的服务端一半，同步 v0.94.1 时退役）：被上游 4dfd95d
  （issue #259）的 `pruneMessageCache()` 取代，见 `load-older-survives-snapshot`。
- **quiet-duplicate-open**：还在栈里，但代码上已无效果，**下次同步退役**，见该节「现状」。

---

## 同步时的已知失败（不是回归）

下次同步先对照这里：失败原因还是这里写的那个，就不是同步引入的。

- **`scripts/check.sh` 要在 UTC 下跑**（`TZ=UTC scripts/check.sh`）：上游的
  `tests/unit/notes-plugin.test.ts` 有两条用例把 UTC 的 ISO 字符串当本地时间读，非 UTC 时区必挂
  （v0.94.1 上实测）。本 fork 不碰那段代码。`check.sh` 是 `set -e`，挂在单测就不会跑到构建。
- 下面这些冒烟不在 `check.sh` 里，同步时手动跑、预期失败（v0.94.1 上逐个核对过）：
  - `tests/takeover-test.mjs`、`tests/idle-takeover-test.mjs`、`tests/remote-answer-test.mjs`：测上游 v0.94 的
    单 owner 功能（手动过户、空闲持有时新标签页空白落地、跨页作答），都靠左栏的 elsewhere 行。
    `server-owned-chats` 下 `listExternalRunning()` 恒为空（共享表上那条对话本来就在自己的列表里），
    `reload-adopt` 让新标签页直接打开已经开着的那条，`ask-question-delivery` 让问卷在所有在线窗口
    弹出（用户的选择）。
  - `tests/orphan-adopt-test.mjs`：`reload-adopt` 刻意不调用 `findAdoptableOrphan()`（见该节）。
  - `tests/conv-group-flash-test.mjs`：断言上游按项目分的左栏「全程只有一行」；`flat-recent-chats`
    把所有项目的对话排成一条扁平列表，切到 B 聊一句后就有两行。同步前的构建（0ce96b5）上失败得
    一模一样。
  - `tests/scroll-attr-collapse-test.mjs`：种对话就超时（`seed timeout`），纯上游 v0.94.1（9fa8905）上一样
    （2026-09-24 实测），不是本 fork 引入的。
  - `tests/lazy-window-test.mjs`：同样是种对话就超时。种对话的脚本每发一条 prompt 就等模型出错的那条
    助手消息（fastfail 模型连不上），现在每条 prompt 只追加用户消息，数到 37 就停了（要 38）。
    exchange-digest 之前的 28fab8f 上失败得一模一样（2026-09-24 实测）。
  - 本 fork 自己的冒烟全过：`server-owned-chats-test`、`cross-client-session-test`、`chat-pagination-test`、
    `exchange-fold-test`、`exchange-digest-test`、`done-any-chat-test`、`todo-list-owner-test`（后加）。
