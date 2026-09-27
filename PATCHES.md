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
| no-cwd-restore               | `local`        | `server/agent-service.ts`, `dsh/dsh-agent-service.ts`, `use-chat.ts`                                                                           |
| flat-recent-chats            | `local`        | `web/src/conv-groups.ts`, `LeftPanel.tsx`, `server/agent-service.ts`, `protocol.ts`                                                            |
| no-mcp-restart-nag           | `local`        | `server/webui-context.ts`, `tests/unit/mute-mcp-restart-nag.test.ts`                                                                           |
| ask-question-delivery        | `local`        | `server/ask-delivery.ts`, `agent-service.ts`                                                                                                   |
| reload-adopt                 | `local`        | `server/attach-adopt.ts`, `agent-service.ts`                                                                                                   |
| switch-loading               | `local`        | `web/src/switch-pending.ts`, `SwitchOverlay.tsx`, `use-chat.ts`, `server/agent-service.ts`, `index.ts`, `dsh/dsh-agent-service.ts`, `protocol.ts` |
| qn-rail-window               | `local`        | `web/src/qn-window.ts`, `components/MessageList.tsx`, `styles.css`, `i18n.tsx`                                                                 |
| terminal-cwd-anywhere        | `local`        | `server/terminals.ts`, `tests/unit/terminal-cwd.test.ts`                                                                                       |
| chat-window-pagination       | `local`        | `server/question-index.ts`, `agent-service.ts`, `protocol.ts`, `index.ts`, `web/src/message-window.ts`, `MessageList.tsx`, `use-chat.ts`       |
| bg-tasks-push-dedupe         | `local`        | `server/bg-servers.ts`, `agent-service.ts`, `tests/unit/bg-servers-dedupe.test.ts`                                                             |
| load-older-survives-snapshot | `local`        | `web/src/message-window.ts`, `use-chat.ts`, `tests/chat-pagination-test.mjs`                                                                   |
| exchange-fold                | `local`        | `web/src/exchange-fold.ts`, `components/ExchangeFoldRow.tsx`, `MessageList.tsx`, `exchange-fold.css`, `i18n.tsx`, `locales/*.json`             |
| exchange-digest              | `local`        | `server/exchange-digest.ts`, `agent-service.ts`, `protocol.ts`, `index.ts`, `web/src/message-window.ts`, `exchange-fold.ts`, `MessageList.tsx` |
| done-any-chat                | `local`        | `web/src/done-watch.ts`, `App.tsx`, `server/agent-service.ts`, `i18n.tsx`, `locales/*.json`                                                    |
| todo-list-owner              | `local`        | `server/agent-service.ts`                                                                                                                      |
| markers-skip-code            | `local`        | `server/markers/marker.ts`                                                                                                                     |
| single-load                  | `local`        | `web/src/use-chat.ts`, `server/index.ts`, `server/protocol.ts`                                                                                 |
| tldr-panel                   | `local`        | `server/tldr-lines.ts`, `agent-service.ts`, `protocol.ts`, `web/src/components/TldrPanel.tsx`, `RightPanel.tsx`, `ui-slots.ts`, i18n           |
| fast-reopen                  | `local`        | `server/compaction-markers.ts`                                                                                                                 |
| switch-cache                 | `local`        | `web/src/chat-cache.ts`, `server/window-hash.ts`, `agent-service.ts`, `protocol.ts`, `index.ts`, `use-chat.ts`, `App.tsx`, `SwitchOverlay.tsx` |
| tldr-collapse                | `local`        | `server/tldr-lines.ts`, `agent-service.ts`, `index.ts`, `protocol.ts`, `web/src/components/TldrPanel.tsx`, `RightPanel.tsx`, `App.tsx`, i18n   |
| queue-panel                  | `local`        | `server/task-queue.ts`, `agent-service.ts`, `protocol.ts`, `web/src/components/TaskQueuePanel.tsx`, `RightPanel.tsx`, `done-settle.ts`, i18n   |
| per-chat-dialogs             | `local`        | `server/chat-dialogs.ts`, `webui-context.ts`, `agent-service.ts`, `protocol.ts`, `web/src/App.tsx`, `LeftPanel.tsx`, i18n                      |
| image-aside-label            | `local`        | `server/attachments.ts`, `serialize.ts`                                                                                                        |
| tldr-sidebar                 | `local`        | `server/tldr-lines.ts`, `agent-service.ts`, `protocol.ts`, `web/src/components/LeftPanel.tsx`, `styles.css`                                    |
| tldr-answered                | `local`        | `server/tldr-lines.ts`, `agent-service.ts`, `protocol.ts`, `web/src/components/TldrPanel.tsx`                                                  |
| busy-endpoint                | `local`        | `server/agent-service.ts`, `index.ts`, `tests/busy-endpoint-test.mjs`                                                                          |
| rewind-to-here               | `local`        | `server/rewind.ts`, `agent-service.ts`, `protocol.ts`, `web/src/components/Message.tsx`, `MessageList.tsx`, `tests/rewind-to-here-test.mjs`   |
| crash-guard                  | `local`        | `server/crash-guard.ts`, `agent-service.ts`, `goal-service.ts`, `index.ts`, `tests/no-active-chat-crash-test.mjs`, `tests/unit/`              |
| dangling-tail-only           | `local`        | `server/dangling-tools.ts`, `agent-service.ts`, `tests/unit/dangling-tools.test.ts`, `tests/dangling-tail-test.mjs`                           |
| lazy-images                  | `local`        | `server/image-meta.ts`, `chat-image.ts`, `serialize.ts`, `agent-service.ts`, `index.ts`, `protocol.ts`, `web/src/components/ChatImage.tsx`, `chat-image.ts` |
| carry-on                     | `local`        | `server/running-chats.ts`, `agent-service.ts`, `client-state.ts`, `index.ts`, `scheduler-tasks.ts`, `tests/carry-on-restart-test.mjs`, `tests/unit/` |
| sealed-tests                 | `local`        | `scripts/sealed.sh`, `sealed-summary.mjs`, `check.sh`, `tests/lib/sealed-fence.cjs`, `tests/run-sealed.mjs`, `tests/lib/`, `vitest.config.ts`, `tests/*-test.mjs`, 6 处测试查出的 bug |
| wake-reopen                  | `local`        | `server/agent-service.ts`（`wakeClosedChat`、`wakeConversation` 的 id 相位）、`server/index.ts`（调度执行器）、`tests/wake-reopen-test.mjs`、`tests/unit/schedule-agent-tool.test.ts` |

---

## 同步到 v0.96.1 时要知道的（2026-09-26）

上游 v0.95.0 – v0.96.1 带进来几样会碰到本机部署的改动：

- **Host 白名单**（防 DNS rebinding，`server/host-guard.ts`）：没设 `PI_WEB_TOKEN` 也没设 `PI_WEB_ALLOW_HOSTS` 时，
  只放行回环和局域网地址；pi.wai2shine.com（Caddy 反代，Host 原样透传）和 spark.tailbb5055.ts.net（tailscale
  serve）会直接 403。所以 systemd unit（`~/.config/systemd/user/pi-web-ui.service`）加了
  `Environment=PI_WEB_ALLOW_HOSTS=pi.wai2shine.com,spark.tailbb5055.ts.net,127.0.0.1,localhost`。名单是严格的
  （写了就只认名单），所以回环的名字也要写上。WS 的 Origin 检查（Origin 的 host:port 要等于 Host）也用它。
- **SDK**：`package.json` 里 pi-coding-agent 改成 `>=0.85.1`，锁文件是 0.87.1。`resolve-global-sdk` 只在机器上的
  pi 更新时才跟过去，所以服务跑的是自带的 0.87.1（命令行 `pi` 2026-09-27 也升到了 0.87.1）。扩展都照常加载。
- **工具批准**（新功能，`server/tool-approval.ts` + `server/approval-rules.ts`）：删文件、force push、写工作区外的
  文件等要先点批准，上游默认**开**。本机的全局设置里关掉（`toolApprovalEnabled: false`），跟同步前一样：
  排队任务、定时唤醒这些没人看着的对话不会卡在批准框上。想要的话在设置里打开。
- **WS hello 防重放**（b116e13）：同一个 socket 重复 hello 只回一个 ready；clientId 只认字母数字和 `:_-`、
  1–128 位（`server/ws-client-id.ts`，不合格就换成随机 UUID）。本 fork 的页面和 /tmp 下的脚本的 id 都合格。
- **协议号**：上游 19 → 20（b116e13），本 fork 在上面 20 → 21（chat-window-pagination）→ 22（per-chat-dialogs），
  正好跟基于 v0.94.1 的上一版同号，开着的旧页面就不会出「请刷新」横幅，所以文末的 chore 提交再加 1 到 **23**。
- 上游新加的消息操作「派生分支」「回滚到此」和本 fork 的「倒回这里」并存，见 `rewind-to-here`。

---

## qn-rail-window

**状态**：`local`（纯前端，可以直接提上游；窗口大小和对齐策略是口味选择，提之前先对口径）
**基线**：v0.96.1

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
**基线**：v0.96.1（依赖 `server-owned-chats`：对话归服务端，切换才是一次有明确回执的请求）

**同步 v0.96.1（2026-09-26）**：本补丁原来把协议 19 → 20；上游 v0.96 自己也 19 → 20（b116e13，WS hello
防重放），同步时这一步被吸收，本补丁不再改协议号（现在的号见 chat-window-pagination、per-chat-dialogs 和
文末 chore 提交的 23）。代码上只是 import 挨着上游新加的批准类型。

同步后两处上游改动会把打开的那份快照挤掉，`switch_done` 跑到内容前面（chat-pagination-test 在本机报出来）。
原因都是发送背压：socket 缓冲超过下限（`SNAPSHOT_BACKPRESSURE_MIN_BYTES` = 256 KB）时快照直接丢，250ms 后
才补一份 delta，客户端还得靠 rev 缺口 `get_state` 自愈；而 `settings_state` 带着 `toolsSchema` 等预览，在
真实环境有 ~350 KB。

- 上游 v0.96 在新建对话、切对话、切会话、切工作目录、选预设时都推一份 `settings_state`，而且推在快照
  **前面**。现在这几处都改成先快照（切换时连同 `switch_done`）、后设置。
- v0.96 起 `ready` 先于 attach 的那批消息发出，连上就切的客户端（测试、WS 脚本）切换时缓冲正满。
  `server/index.ts` 的 `send` 现在记着最近发出的全量快照属于哪条对话（`lastSnapshotConvId`），
  **打开另一条对话的全量快照不丢**。切换是用户动作，频率低，慢客户端的内存保护不受影响。

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
- 同步 v0.94.1 带进来的一个漏洞（2026-09-24 补上）：上游 5ca2e70（confine switchSession to sessions root）
  对会话目录外的路径只发 `notice`、不回执，客户端的「正在打开…」会一直等。现在它和其它失败一样
  `flushSnapshot()` + `emitSwitchFailed()`（原因文字不变）。`switch-ack-test` 的「目录打不开」那条正好走这里
  （测试的工作目录在会话目录外），同步之后一直挂着。

**客户端**：`web/src/switch-pending.ts`（101 行，纯函数、不碰 React）记下 `pendingSwitch`；
发出 `switch_*` 的**那一刻**聊天区盖一层「正在打开…」（`SwitchOverlay.tsx`，带「已等待 N 秒」
和「隐藏」），左栏高亮立即挪到目标行。失败就留在原地，把原因（中/英）显出来并给一个「重试」。

**为什么同时认两种结束信号**（回执 + 快照对得上）：回执是主信号，引擎无关；
但 DSH 的快照没有 `sessionFile`，按路径根本对不上，所以再加一道保险：只要要的那条
对话已经显示出来了，就没理由还盖着「正在打开」。

### 回归

- `tests/switch-ack-test.mjs`（e2e，已登记进 `tests/run-smoke.mjs`）：成功路径「先快照后
  `switch_done`、target 原样回传」；三条失败路径（目录打不开、对话 id 不存在、切到已经
  是当前的转录）都不再静默；失败时**当前对话纹丝不动**。同步 v0.96.1 后还查新建对话、
  `switch_session`、`switch_conversation` 三处 `settings_state` 都在快照之后（改对前三处都报错）。
- `tests/switch-open-burst-test.mjs`（e2e，同步 v0.96.1 时加）：项目里放一份 ~400 KB 的 AGENTS.md，让连上时的
  `settings_state` 超过背压下限，连上就切到一份预先写好的会话：这条会话的全量快照要在 `switch_done`
  之前到、带着它的消息。去掉 `send` 里那条豁免就挂 3 项（快照被丢）。
- `tests/unit/switch-pending.test.ts` + `tests/unit/switch-loading-ui.test.ts`（共 354 行）。
- `node scripts/check-protocol-sync.mjs`：双端 `PROTOCOL_VERSION` 一致 (v20)、
  `protocol.ts` 保持纯类型导出。
- i18n 跑满：8 个 locale + `web/src/i18n.tsx`。

---

## reload-adopt

**状态**：`local`（上游不适用：它的对话有归属，这里没有）
**基线**：v0.96.1（依赖 `server-owned-chats` + `client-per-load`；v0.94.1 同步时的改动见「与上游 v0.94 的关系」）

**同步 v0.96.1（2026-09-26）**：上游 12a606b 让伪客户端（`scheduler:` / `plugin:` 开头的 clientId）不再认领
会话。本补丁照这个意思补上：伪客户端不 adopt、也不恢复上次的对话（在 `pickAdoptTarget` 里判断，
`isPseudoClientId` 改成 static 复用）。`pickAdoptTarget` 继续代替上游的 `findAdoptableOrphan`。

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
**基线**：v0.96.1（2026-09-23 同步 v0.94.1 时按上游的新问卷模型重做，见「与上游 v0.94 的关系」）

**同步 v0.96.1（2026-09-26）**：保留上游新加的工具批准（tool-approval）那段桥接，本补丁的投递（问卷在所有
在线窗口弹出）不变。

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
**基线**：v0.96.1

**同步 v0.96.1（2026-09-26）**：上游在同一处加了 `sentinelUnsafeReason`，两边都保留；`BASH_RC_GUARD` 前空一行。
回归用例 10b / 10c 照过。

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
**基线**：v0.96.1

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
**基线**：v0.96.1

**同步 v0.96.1（2026-09-26）**：保留上游新加的进程树清理（kill-tree）和 cwd 解析，本补丁的逻辑不变。

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
**基线**：v0.96.1

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
**基线**：v0.96.1

**同步 v0.96.1（2026-09-26）**：`ConversationSummary` 里上游新加的 `forkFrom` 与本补丁的 `sessionPath` / `waiting`
并存；WS 消息里上游的 `subagent_handoff` 与本补丁的 `remove_recent_chat` 并存。

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
**基线**：v0.96.1

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
- 同步 v0.96.1（2026-09-26）：这份单测的桩要跟着上游改。`switchConversationNow()` 现在每次都调
  `pushSettings()`（上游切对话推一份 settings_state），跨文件夹跟随时调上游新收成一处的
  `applyCwdSideEffects()`。桩里加了空的 `pushSettings`，`applyCwdSideEffects` 用生产那一份（它调的
  onCwdChanged / remember / pushProjects / listFiles …… 还是记录用的桩）。没加之前 4 项挂在
  `this.pushSettings is not a function`，补丁本身的行为没变。

---

## client-per-load

**状态**：`local`（可上游：现有 sessionStorage 方案挡不住复制标签页）
**基线**：v0.96.1

**同步 v0.96.1（2026-09-26）**：上游开始校验 clientId（`server/ws-client-id.ts`：字母数字和 `:_-`、1–128 位，
不合格就换成随机 UUID）。本补丁每次加载现生的 UUID 合格，不用改。

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
**基线**：v0.96.1

**同步 v0.96.1（2026-09-26）**：

- 上游的 `listExternalRunning()` 照旧恒为空（共享表上的对话本来就在自己的列表里）。
- 上游新加的工具批准：本补丁按视图 dispose 时也调 `cancelPendingApprovals()`。
- 上游在 `applyToolGating` 和切预设时写 `this.sessionStatsCache = null`；本补丁的缓存是按会话的 WeakMap，
  改成 `.delete(session)` / `.delete(conv.session)`。
- 上游 12a606b 的 `deleteSession` 会问别的客户端是否持有（`findSessionOwner`）。共享表下别的窗口开着这条就拦下，
  没人开着才删，跟本补丁的口径一致。
- `quiet-duplicate-open` 这次退役，它的提交并进了本补丁：它的代码本来就被本补丁整段删掉，最终的树逐字节不变
  （见文末「已退役的补丁」）。

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

## no-cwd-restore

**状态**：`local`（可上游成设置项：启动目录 = 服务端默认 / 上次用过的）
**基线**：v0.96.1

**同步 v0.96.1（2026-09-26）**：上游 #295 加了启动时按 stat 恢复上次的目录，#319 加了 `clearLastCwdIfMatches`，
都是「恢复上次目录」那条路；本补丁就是不恢复，所以两处都拿掉。

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
**基线**：v0.96.1

**同步 v0.96.1（2026-09-26）**：上游重写了左栏的按项目分组；本补丁照旧用 `orderConversations` 排成一条扁平
列表，替掉上游的分组渲染。

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
**基线**：v0.96.1（v0.86.2 上的 7 个提交在同步 v0.94.1 时按上游的新顶栏重做成 1 个）

**同步 v0.96.1（2026-09-26）**：上游把 settings、history、files 设成必需项（`REQUIRED`），又新加了
`ALWAYS_SHOWN_TOPBAR_ITEM_IDS = {history, files}`（总在顶栏上）；本补丁仍让 settings 能收进溢出菜单。
`tests/unit/ui-slots.test.ts` 的数目按新清单改成「7 + 11」。

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
**基线**：v0.96.1

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
**基线**：v0.96.1

**同步 v0.96.1（2026-09-26）**：上游把工具说明改成只有英文，本补丁的说明跟着只留英文。

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
**基线**：v0.96.1（协议 v20 → **v21**）

**同步 v0.96.1（2026-09-26）**：协议号：上游 v0.96 已是 20（旧基线上 20 是 switch-loading 加的），本补丁
20 → 21 不变。`App.tsx` 在上游改过的 `MessageList` 包装上接回 `onLoadOlder`。

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
**基线**：v0.96.1

**同步 v0.96.1（2026-09-26）**：上游在同一处加了 `listenBefore`，与本补丁的 `lastPushedJson` 并存。

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
**基线**：v0.96.1

**同步 v0.96.1（2026-09-26）**：上游新加的 `pendingApproval`（工具批准框）在 `keepLoadedHistory` 里一并保留，
免得载入更早的消息后批准框丢掉。

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
**基线**：v0.96.1

**同步 v0.96.1（2026-09-26）**：上游的消息列表里多了 system 消息；折叠时跳过它们，不算进一问一答。

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
**基线**：v0.96.1（接 chat-window-pagination 与 exchange-fold）

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
**基线**：v0.96.1（接 server-owned-chats）

**诉求**（用户 2026-09-24）：任何一条对话跑完都要听到提示，不只是正开着的那条。

### 改法

- 前端：上游 v0.95 起自己按对话 id 跟踪跑完（`web/src/streaming-cues.ts` 的 `diffStreamingCues`：每条对话各自
  比上一份和这一份的 `isStreaming`，切换对话不响，第一份列表只同步）。`App.tsx` 里上游的开始/结束 effect
  上补三处：
  - 传给 `diffStreamingCues` 的列表先过 `web/src/done-watch.ts` 的 `cueConversations`：子代理不算（父对话还在跑，
    跑完自己会响；不然并行派几个子代理就响几次），历史行（`live === false`）不算。正开着的那条另由
    `activeId` 传进去，打开的子代理照样有自己的开始/完成。
  - 断线（`chat.ready` 变 false）时 `prevStreamingMapRef` 清空：服务端重启会结束所有 run，重连后的第一份
    列表只同步，不能当成跑完了。上游没有这一步。
  - 后台对话的系统通知是带标题的整句（`notifyDoneBodyChat`），不再是「标题：通用句」拼接（英文里会出现
    全角冒号）。
- 同步 v0.96.1（2026-09-26）时改成这样：本补丁原来的 `web/src/done-cues.ts`（`runEdge` / `finishedChats`）和上游的
  `diffStreamingCues` 做的是同一件事，删掉改用上游的，只留上游没有的三处。原来每批最多 3 条系统通知，
  现在跟上游一样每条都发。
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

- `tests/unit/done-watch.test.ts`（4 项）：子代理和历史行被滤掉；后台对话跑完响、子代理跑完不响；打开的
  子代理照样响；重连后（清成 null）第一份列表不响。其余的边沿判定归上游的 `tests/unit/streaming-cues.test.ts`。
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
**基线**：v0.96.1

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
**基线**：v0.96.1

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

**状态**：`local`（上游的 bug，来自 1f31bde；到 v0.96.1 还在。上游修了就退役）
**基线**：v0.96.1

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
**基线**：v0.96.1

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

## fast-reopen

**状态**：`local`（上游同样有这个问题：来自上游 0070c88（#235），到 upstream/main 7f641d7 还在；可以提 PR）
**基线**：v0.96.1

**诉求**（用户 2026-09-24）：切走的对话再点回来要快（"cache the chat … so it loads faster"）。这是第一步：先修
「点回来」慢的真凶。只发差异是下一步（`switch-cache`）。

### 病因

- 切走的对话要是没在跑，服务端就把它关掉（`displaceActive`）。再点回来就是从历史重新打开：
  `switchSession` → `repairSessionFile` → `repairSessionTranscript`。
- `repairSessionTranscript` 第 3 步（截断残余的环）对每一行都从它自己走到根，每次新建一个 `seen` 集合。会话基本是
  一条长链，所以是 O(n²)：一个 1.8 万行的会话光这一步就是 17.7 秒（`--cpu-prof` self time），整个打开 19.5 秒。
  健康的文件也要付这个钱。

### 改法

- `server/compaction-markers.ts` 第 3 步改成线性：每一行记一个状态，1 = 在这一轮走过的路上，2 = 已结清（链最终到根、
  悬空或已截断）。走到已结清的行就停；走回这一轮的路上就是有环，截掉「指回去」的那条边。截的边和原来完全一样
  （按行序、同一个 `prev`）。

### 回归

- `tests/unit/repair-linear.test.ts`（3 项）：
  - 3000 张随机父子图（环、自环、悬空 parent、脏行都很多，一半以上有环）上和原算法（测试里留了一份）逐字节对比
    `text` / `cyclesBroken` / `changed`；
  - 6 万行长链 3 秒内修完，健康文件原样返回；
  - 长链头上接成环：只截一刀（截在 `m1` 上）。
  - 反向验证：换回原算法，这个文件 300 秒都跑不完（被 timeout 杀掉）。
- 实测（真服务端、零 token 的基准脚本）：从历史打开 1.8 万行的会话 19.5 s → 1.5 s；切回已被关掉的对话 0.85 s；
  两条都在跑的对话互切约 56 ms，不受影响。

---

## switch-cache

**状态**：`local`
**基线**：v0.96.1

**同步 v0.96.1（2026-09-26）**：上游在 `MessageList` 外面加了临时对话（ephemeral）横幅。预览缓存时不显示它
（`!chat.preview && chat.state?.isEphemeral`），因为横幅上的「保存」存的是服务端当前的对话，不是正在预览的那条。

**诉求**（用户 2026-09-24）："cache the chat, so if move away and come back, i shouldn't be fetching everything again,
only the differences" / "so it loads faster"。第一步是 `fast-reopen`（从历史重开慢的真凶），这是第二步：只取差异。

### 以前

- 切回一条对话，服务端每次整份重发最新一截（`MESSAGE_WINDOW` = 100 条，实测 300–410 KB），页面整份重新渲染。
- 切回一条已被关掉的对话，要等服务端从历史重开（约 1 秒）才看得到任何内容。

### 做法

- 浏览器：`web/src/chat-cache.ts` 的 `ChatCache` 按**转录路径**记住每条对话最后显示的那份 `UiState`（最多 8 条，
  LRU，只存引用）。不用对话 id：它是服务端进程内的序号，重启或从历史重开都会换。
- 切回去时 `switch_session` / `switch_conversation` 带上 `have`（`CachedWindow`：会话 id、窗口起点、条数、
  这一截消息 id 的指纹。指纹是 `server/window-hash.ts` 的 `messagesHash`，cyrb53，前后端共用一份）。
- 点下去的那一刻，消息列表先显示缓存的这份（预览，`chat.preview`；其余界面仍是服务端当前对话）。
  switch-loading 的遮罩这时是透明的，照样挡住点击和输入（服务端还在原对话上），顶上只留一张小卡片，快的
  切换连卡片都不出来；「隐藏」要等慢了才给（看着的是目标对话，隐藏却是回到原对话）。预览期间不做搜索跳转。
- 服务端 `ClientSession.resumeWindow`：切换期间记下 `switchHave`（`switchSession` / `switchConversation` 的
  finally 清掉），目标对话的第一份整份快照用它核对（用过即清）：会话 id 一样、区间在范围内、新增的不超过
  一个窗口、指纹一样 → 快照只带 `[start+count, 末尾)`，并在 `snapshot.reuse` 里回同一个窗口；`messagesStart`、
  exchange 摘要按客户端的起点算。任何一项不对 → 照常整份。
- 浏览器收到 `reuse`：`applyReuse` 把当时报上去的那份缓存（按 `windowKey` 记着，连点几条不串）接在前面。
  缓存那截的消息对象原样沿用，已经渲染的行不重画：`nextListKey` 让对话 id 或会话 id 有一个没变就不重建
  `MessageList`（预览换成从历史重开后的真快照时，对话 id 变了、会话 id 没变）。对不上 → 发 `get_state` 要整份。
- 为什么只比 id：消息 id 带时间戳（`u-<ts>-<seq>` / `a-<ts>-<n>` / `t-<toolCallId>`），服务端的序列化缓存键里
  还带内容指纹，内容一变就换新的 `n`、换 id → 指纹不一致 → 整份。和服务端自己的 delta 是同一个前提
  （持久化的消息不再变）。从历史重开后助手消息的 `n` 可能换号（压缩过就会），那样也只是退回整份。
- DSH 引擎不认 `have`，照常整份。

### 回归

- `tests/unit/chat-cache.test.ts`（18 项）：LRU、按路径 / 按左栏行找缓存、`cachedWindow` / `applyReuse` 的各种
  对不上、`nextListKey`。`tests/unit/switch-loading-ui.test.ts` 加了两条预览遮罩的用例。
- `tests/switch-cache-test.mjs`（零 token，35 项）：
  - 协议：对得上且没新消息 → `reuse`、0 条；旧窗口 → 只发新增的 2 条；指纹 / 会话 / 条数 / 垃圾字段不对 →
    整份、不崩；切回还在跑的对话（`switch_conversation`）同样只补差异。
  - 页面：点回看过的对话，发出去的 switch 带 `have`、收到的快照带 `reuse`；在页面里模拟 400ms 网络延迟，
    缓存那份在快照交到应用之前就显示了；两轮回答都在；接着聊照常。（不加延迟时小对话的快照几十毫秒就到，
    和预览只差 5–11ms，会抢跑。）
  - 反向验证：`switch_started` 不带 `preview` 时预览那一项必挂（文字 +462ms 才出现，快照最早 +438ms 交到
    应用），其余全过。
- 实测（真服务端、零 token 的基准脚本，三条真会话）：
  - 两条都在跑的对话互切：快照 300–393 KB → 18–38 KB（剩下的是问题索引、摘要、TL;DR 这些整份快照总带的
    东西），服务端耗时不变（约 100 ms）。
  - 切回已被关掉的对话：快照 409 KB → 16 KB，1.46 s → 1.06 s（剩下的是服务端从历史重开）；页面在点下去的
    那一刻就先显示缓存的那份。

---

## tldr-collapse

**状态**：`local`
**基线**：v0.96.1

**诉求**（用户 2026-09-24）：TL;DR 里看过的行要能手动折叠起来。用户的选择：连着的折叠行并成一行「N 行已读」
（不是原地变淡的一行）；要「全部折叠」；折叠状态存在服务端（所有窗口、所有设备一致），不是只存本浏览器。

### 改法

- 折叠状态是 pi-web-ui 自己写进会话的自定义条目：`{ type: "custom", customType: "pi-web-ui/tldr-collapse",
data: { v: 1, ids, collapsed } }`。跟行本身一样随会话走：刷新、重启、别的窗口和设备看到的都一样；
  改写分叉后被丢下的分支上的折叠也跟着不算。pi-tldr 不用改。
- `server/tldr-lines.ts`：`tldrLinesFromEntries` 沿分支按顺序重放折叠条目，最后折叠着的行带 `collapsed: true`
  （没折叠的不带这个字段）。`tldrCollapseData(ids, collapsed)` 规整 data：去重，去掉非字符串和超过 64 字符的
  id，最多 500 个；一个都不剩或 `collapsed` 不是布尔就返回 null。写之前和读的时候都过一遍。
- `server/protocol.ts`：`UiTldrLine.collapsed?`；客户端消息 `tldr_collapse { ids, collapsed, conversationId? }`。
- `server/index.ts`：分派 `tldr_collapse` → `DispatchSession.setTldrCollapsed?`（可选，DSH 不实现）。
- `server/agent-service.ts`：
  - `setTldrCollapsed`：`conversationId` 对不上当前对话就不记；只记状态真的变了的行（重复点击不写文件）；
    `appendCustomEntry` 之后自己 `flushSnapshot()` + `checkpointViewers(conv.id, true)`：写条目不发会话事件，
    正看着这条对话的别的窗口也马上对上。
  - `tldrOf` 的签名把折叠状态也算进去：只折叠了一行时行 id 串没变，数组也得换，delta 才会带上 `tldr`。
- `web/src/components/TldrPanel.tsx`：
  - 每行行尾一个 ▾（`.tldr-fold`）；顶上「全部折叠」（`.tldr-collapse-all`），还有没折叠的行时才出。
  - `tldrRows()`：连着的折叠行并成一行「N 行已读」（`.tldr-unfold`），点它重新展开那一串。收起时显示的
    5 行里，这样一行只算一行。
  - 点下去先在本地生效（`pending`），等服务端的行对上；5 秒还对不上（服务端没收）就回到服务端的状态。
  - 不给 `onCollapse` 就是只读：不出 ▾ 和「全部折叠」，「N 行已读」点不了。
- `web/src/components/RightPanel.tsx`：`onTldrCollapse` 用 `panelSend` 发 `tldr_collapse`，带上当前对话 id；
  `TldrPanel` 的 `key` 是对话 id（换对话时本地的待定状态和「显示全部」都清掉）。`App.tsx` 传
  `tldrConversationId={chat.state?.conversationId}`。
- 文案：`tldrCollapseAll` / `tldrFoldLine` / `tldrFolded` / `tldrFoldedOne` / `tldrUnfold`（`i18n.tsx` +
  `locales/*.json` 8 种）；样式 `.tldr-toolbar` / `.tldr-fold` / `.tldr-folded` / `.tldr-unfold`（`styles.css`）。

### 回归

- `tests/unit/tldr-lines.test.ts`（+4 项，共 8）：按分支顺序重放；坏数据和不认识的 id 跳过；被丢下的分支上的
  折叠不算；`tldrCollapseData` 的规整。
- `tests/unit/tldr-panel.test.ts`（+4 项，共 8）：`tldrRows` 并串；「N 行已读」在 5 行里只算一行；中间有没折叠的
  行就分成两串；只在能发的时候出按钮（▾ 加在行尾，徽章和文字位置不变）。
- `tests/tldr-panel-test.mjs`（+10 项，共 31）：窗口 A 折叠最上面一行 → A、B 都变成「1 行已读」；B 点
  「全部折叠」→ 两边都是「3 行已读」，按钮消失；A 刷新后还是折叠的；会话文件里正好两条折叠条目（第二条
  只有另外两行）；A 点「3 行已读」→ 两边三行都回来，第三条条目展开三行。`TLDR_SHOT` 另存一张折叠后的
  截图（`-folded.png`）。

---

## queue-panel

**状态**：`local`（队列本身在 pi-queue 扩展里：~/projects/pi-queue，私有仓库 github.com/shine2lay/pi-queue；
`~/.pi/agent/settings.json` 的 `packages` 里装上才有队列）
**基线**：v0.96.1

**同步 v0.96.1（2026-09-26）**：done-any-chat 改用上游的 `streaming-cues.ts` 后 `done-cues.ts` 没了，`DoneCues` 搬到
新文件 `web/src/done-settle.ts`（单测 `tests/unit/done-settle.test.ts`，还是原来那 8 项）。`App.tsx`：上游的 cue effect
喂给 `DoneCues`：`startCue` 时由 `doneCues().started(activeId)` 决定响不响开始；`nextMap` 里每条在跑的对话
取消它还在等的完成；`finishedConvs` → `finished({ open: isActive })`。完成的提示音、系统通知和 TTS 挪进
`DoneCues` 的回调（`cueEnv` ref），TTS 只在那条对话还开着时读回复。

**诉求**（用户 2026-09-24）：每条对话一个任务队列，「跟 TL;DR 类似，但是任务队列」，放这个 agent 接下来要做的事；
每个任务先和用户把计划定透、agent 能一路做完，才进队列。用户的选择：不留没计划的想法清单；在对话框里批准整份
计划；做完一个自己接着做下一个；卡住的任务停下整条队列等用户。

### 改法

- pi-queue 给 agent 四个工具（`queue_add` / `queue_update` / `queue_done` / `queue_stuck`）和 `/queue` 命令，
  把队列的每次变化写成会话里的一条自定义条目 `{ type: "custom", customType: "queue", data: { v: 1, op, … } }`。
  pi-web-ui 只读这些条目，按钮一律转成 `/queue …` 命令，自己从不写队列条目。
- `server/task-queue.ts`：
  - `taskQueueFromEntries(entries, available)` 沿当前分支按顺序重放，规则和 pi-queue `queue.ts` 的 `applyOp`
    一致：面板显示的必须就是 pi-queue 接下来会做的。
  - 删掉的不发；做完的只留最近 `TASK_QUEUE_MAX_DONE`（20）个，排着的和正在做的一个不少。计划每部分截在 4000 字，
    问题和总结截在 2000 字。坏数据跳过，不抛。
  - 镜像 pi-queue 的 `clear` op：做完的全部变成删掉，排着的和正在做的不动。
  - `taskQueueCommandLine(action, id)`：`/queue start|stop|clear`、`/queue up|down|remove <id>`；参数不对返回 null，不发。
- `server/protocol.ts`：`UiTaskQueuePlan`（标题 + 六部分）、`UiTaskQueueTask`（`ready | working | stuck | done`）、
  `UiTaskQueue`（`running`、`pausedReason`、`available`、`tasks`）；`UiState.taskQueue?`；客户端消息
  `task_queue_command { action, id?, conversationId? }`。跟 `UiState.queue`（输入框里排队的提问）不是一回事，
  所以这边一律叫 task queue。
- `server/index.ts`：分派 `task_queue_command` → `DispatchSession.taskQueueCommand?`（可选，DSH 不实现）。
- `server/agent-service.ts`：
  - `taskQueueOf(conv)`：缓存同 `tldrOf`，key 是会话 id + 叶 id + 装没装 pi-queue；队列没变就返回同一个对象。
    `available` = 这条对话有 `/queue` 命令。
  - 整份快照总带 `taskQueue`；delta 只在对象换了时带。
  - pi-queue 写 `queue` 条目的 `entry_appended` 算边界，立即对账：按钮和 agent 跑完后 pi-queue 的推进只写条目、
    不产生消息，不这样要等 2 秒的定时器。
  - `taskQueueCommand`：`conversationId` 对不上当前对话、参数不对、这条对话没装 pi-queue，就不做（没有 `/queue`
    命令时 `prompt` 会把这行字当普通提问发给模型）。否则 `session.prompt("/queue …")`：扩展命令即时执行，
    agent 在跑也行，不进消息列表。
- `web/src/components/TaskQueuePanel.tsx`：右栏的「队列」tab。
  - 顶上一行状态（`taskQueueStatusKey`：在跑 / 正在做 #n / 等你回答 #n / 停下的原因 / 都做完了）和「开始」/
    「停下」；没东西可做时「开始」禁用。
  - 正在做的任务在最上面；卡住时琥珀色，带 agent 的问题和「在对话里回答」的提示。
  - 排着的按要做的顺序，带 ↑ ↓ ✕（✕ 先在行内确认；两头的箭头禁用）。
  - 做完的变灰，带 agent 的总结，最近做完的在上，默认显示 `TASK_QUEUE_DONE_SHOWN`（5）个。标题右边「清除」
    （`.task-queue-clear`）发 `/queue clear`，一次清掉所有做完的（只是历史，不再确认）。
  - 点标题展开整份计划，六部分的顺序和叫法跟 pi-queue 批准对话框里的一样（`TASK_QUEUE_PLAN_PARTS`）。
  - 点了按钮先禁用，等服务端发来新的队列（最多 5 秒）再放开，防连点；面板自己不改队列。
  - 没装 pi-queue（`available: false`）时不给按钮，只说怎么装（`.task-queue-note`）。
- `web/src/components/RightPanel.tsx` + `web/src/ui-slots.ts`：新 tab `host:right-queue`（order 30，排在 TL;DR
  后面），能在设置里隐藏。`TaskQueuePanel` 的 `key` 是对话 id；按钮用 `panelSend` 发 `task_queue_command`，带上
  当前对话 id。`App.tsx` 传 `taskQueue={chat.state?.taskQueue}`；`TldrPanel.tsx` 导出 `lineTime` 给队列 tab 用。
- 计划里的两处小改：
  - `web/src/components/Dialog.tsx` + `styles.css`：确认对话框的正文包进 `.dialog-message` 单独滚动，确定 / 取消
    一直看得见。pi-queue 要批准的整份计划很长。
  - done-settle（`web/src/done-settle.ts` 的 `DoneCues`，`App.tsx` 里打开的对话和后台对话都走它）：「跑完」先等
    `DONE_SETTLE_MS`（1.5 秒）再响。这期间又开跑了（队列的下一个任务、pi-queue 的提醒），就当没停过，完成和
    开始都不响；等满了还没开跑的一起响一次。断线、卸载时没响的清掉。原因：pi-queue 做完一个任务接着开始下一个时，
    SDK 先在 `agent_settled` 里跑扩展，服务端就先推出一份「没在跑」；不等的话每个任务都响一次完成、一次开始。
- 文案：`taskQueue*`（`i18n.tsx` + `locales/*.json` 8 种）；样式 `.task-queue-*`（`styles.css`）。

### 第二轮：搁着等（queue-wait，2026-09-27）

**诉求**：Notion 那个任务等 temper 重启等了两个多小时，队列一直提醒、一直标「需要你」，其实用户什么都不用做。
用户选：任务在等外面的事时，队列先做下一个；等到了，手上那个做完就接着做它，排在新任务前面。

- pi-queue（~/projects/pi-queue，分支 main）加了工具 `queue_wait`：等什么（大白话）、一个只读的检查命令
  （退出码 0 = 等到了）、多久查一次（默认 2 分钟）、几点放弃（默认 24 小时）。扩展在后台跑检查；超时放弃或检查
  一直出错，任务就变成「需要你」并带上原因。新条目 `wait`（`what`/`check`/`everyMs`/`until`）和 `wait_over`
  （`failed?`）。
- `server/task-queue.ts` 跟着镜像：新状态 `waiting`，带 `wait`。「当前任务」只算 working / stuck，搁着的不算，
  所以下一个能开始；`start` / `resume` 一个搁着的任务只在没有当前任务时生效；`wait` 只对正在做或已经搁着的任务
  生效（新的等待替换旧的）；`wait_over` 只记一次，`failed` 截在 2000 字；缺的数字用 pi-queue 的默认值；`done` /
  `stuck` / `resume` 清掉 `wait`。
- `server/protocol.ts`：`UiTaskQueueWait`（`what`、`check`、`everyMs`、`since`、`until`、`overAt?`、`failed?`），
  `UiTaskQueueTask.status` 加 `waiting`、加 `wait?`。
- `TaskQueuePanel.tsx`：「正在做」和「接下来」之间多一段「在等」：等什么、从几点起、几点放弃、检查命令（代码样式）；
  等到了说一声「手上这个做完就接着做」；没等到（放弃或检查一直出错）琥珀色边、带原因。虚线左边框。搁着的任务不给
  ↑ ↓ ✕（聊天里 `/queue remove` 照样能删）。只剩搁着的任务时「开始」照样能按，队列在跑时顶上说「在跑 · #n 在等」
  （`taskQueueStatusOnHold`），不算「都做完了」。
- 文案 7 个新 key（`taskQueueOnHold`、`taskQueueStatusOnHold`、`taskQueueWaitingOn`、`taskQueueWaitCheck`、
  `taskQueueWaitGivesUp`、`taskQueueWaitOver`、`taskQueueWaitFailed`），中英 + 8 种语言包。

### 回归

- 第二轮：`tests/unit/task-queue.test.ts` 加 5 项（照搬 pi-queue 的等待重放用例：搁着后下一个能开始、只有在做的
  能搁着、等到了也要等手上的做完、`wait_over` 只记一次和没等到的原因、删掉搁着的和默认值），
  `tests/unit/task-queue-panel.test.ts` 加 3 项（「在等」一段带检查命令且转义、不给 ↑ ↓ ✕；等到了 / 没等到；
  只剩搁着的时「开始」可按），状态那项加了「在跑 · #n 在等」。
- `tests/unit/task-queue.test.ts`（13 项）：重放（add 保序、start 定当前任务、第二个 start 不理、stuck → 恢复 →
  done 且 done 是终态、move 只在排着的任务里数、remove 和计划更新、run / pause 和原因）；只留最近做完的；坏 id
  跳过、坏的计划部分给空串、超长截断；别的条目类型、不认识的 op 和版本跳过；`available`；按钮 → `/queue` 命令，
  别的一律拒。
- `tests/unit/task-queue-panel.test.ts`（9 项）：空状态和「没装 pi-queue」；分成正在做 / 接下来（按顺序）/ 做完
  （最新在上）；卡住的高亮、带问题；↑ ↓ ✕ 和两头禁用；没装 pi-queue 或没有发送方时不出按钮；能跑时给「开始」、
  在跑时给「停下」；展开的计划按 pi-queue 的顺序；做完的只显示最近几个、能展开；顶上那行说对队列在干什么。
- `tests/unit/done-settle.test.ts`（8 项）：`DONE_SETTLE_MS` 够接住下一个任务又不太长；跑完等满了只响一次；等的
  时候又开跑 = 没停过；没东西在等时的开始是真开始；几条对话前后脚跑完一起响一次；其中一条又开跑，别的照样响；
  同一条跑完两次算一次；`clear` 全清。
- `tests/unit/ui-slots.test.ts`：tab 列表加上 `host:right-queue`。
- `tests/queue-panel-test.mjs`（37 项，不花 token）：真 pi-queue（`PI_QUEUE_PKG`，默认 ~/projects/pi-queue，
  从 settings.json 的 `packages` 装）+ 模拟模型，两个窗口：
  - 规划那一轮调三次 `queue_add`，用户在对话框里逐个批准；长计划在对话框里滚动，确定 / 取消看得见；每批准一个，
    A 的队列 tab 立刻多一个。
  - B 打开同一条对话能看到；A 里 ↓、B 里 ✕（行内确认）两边都立刻跟上；点标题展开计划。
  - 「开始」：#2 在做 → 做完、带总结；#1 卡住，两个窗口都高亮、带问题；整条队列在每个窗口听起来是一次运行
    （一次开始、一次完成）。
  - 在对话里回答 → #1 做完，「都做完了」，「开始」禁用；刷新后队列还在；新对话是空状态，切回来队列回来。
  - 模拟模型没收到脚本外的消息（没有提醒、没有「继续」）；页面没报错。
  - `QUEUE_DEBUG=1` 打印模拟模型收到的请求；`QUEUE_SHOT=/tmp/x.png` 另存四张截图（`-dialog` / `-plan` /
    `-stuck` / `-done`）。
- 反证（2026-09-25）：去掉 `.dialog-message` 的滚动样式、`DONE_SETTLE_MS` 设成 0，E2E 正好挂两项：长计划那项
  （正文 2250/2250px 不滚，按钮不在视野里）和窗口 A 的「一次运行」（开始 +2、完成 +2）。窗口 B 那项照样过，
  看来 B 没收到任务之间那一下「没在跑」。

---

## per-chat-dialogs

**状态**：`local`
**基线**：v0.96.1

**同步 v0.96.1（2026-09-26）**：上游没有按对话的弹窗，照原样重做。`agent-service.ts`：上游新加的
`transcriptBlocked` / `workspaceSnapshots` / `activePromptAc` / `lastTurnBaseTokens` 与本补丁的弹窗并存；`bindSession`
里 `uiContext` 用本补丁的 `chatUiContext(...)`，`onError` 用上游的 `makeExtensionErrorReporter`。`protocol.ts` 的
`ConversationSummary`：上游的 `isEphemeral` / `forkFrom` 加本补丁的 `dialogId`。`App.tsx`：本补丁的 `cuedDialogs` /
`listAtConnect` 代替上游的 `notifiedDialogIds`（上游那个只看得到本窗口自己的弹窗），两处都保留上游的 TTS
播报问题。

**诉求**（用户 2026-09-25）：「Make sure tasks are per agent not shared」。核对结果：队列本身早就是每条对话一份（pi-queue 的
`queue` 条目写在各自的会话里，只有这条对话的 agent 会去做，队列 tab 只显示当前对话的）。不是每条对话一份的
是扩展弹窗（`ctx.ui.select / confirm / input`，pi-queue 批准计划就用它）：弹窗挂在浏览器窗口上，不挂在对话上——

- 对话 A 在后台问，弹窗出现在正看着的对话 B 里，也不说是 A 的；
- 两条对话同时问，后一个顶掉前一个，前一个的 agent 永远等下去；
- 刷新页面，等着的弹窗就没了。

用户的选择：「只在自己的对话里」——弹窗只在看着那条对话时出现，切回来、刷新都还在；这期间左栏那一行挂「?」；
agent 一直等到你回答。

### 改法

- `server/chat-dialogs.ts`：
  - `ChatDialogs`：一条对话在等回答的弹窗，最早的在前；`current` 是最早那个（没变时是同一个对象，delta 按引用比）。
    `open(kind, title, args, owner, opts)` 返回 Promise；`answer(id, value)` 按 id 回答（不是这条对话的 id 返回
    false）；pi 的 `timeout` / `signal` 到了以「取消」（null）结束；`cancelExcept(owner)`（换了会话：旧会话问的作废）、
    `cancelAll()`（关对话、强制重建、释放）。多了少了调 `onChange`（抛错不影响扩展）。
  - `chatUiContext(base, dialogs, owner)`：给扩展的 `ctx.ui`。select / confirm / input 走这条对话的 `ChatDialogs`，
    返回值照 pi 声明的收窄（select 只返回选项之一，confirm 只有 `true` 算是，取消 = `undefined` / `false`）；
    其余（notify、widget、status……）照旧交给窗口的 `WebUIContext`（绑定 this）。
- `server/webui-context.ts`：`nextDialogId()`。窗口自己的弹窗（目标向导）和各对话的弹窗共用一个计数器：页面只按
  id 回答，等着的弹窗 id 不能撞。
- `server/agent-service.ts`：
  - `Conversation.dialogs`：`makeConversation` 里建，`onChange` → `ClientSession.chatDialogsChanged(conv)`：看着这条
    对话的窗口立即补快照，所有窗口重推左栏。
  - `bindExtensions` 的 `uiContext` 换成 `chatUiContext(this.webUi, conv.dialogs, conv.session)`；绑之前先
    `conv.dialogs.cancelExcept(conv.session)`。
  - 快照 `UiState.dialog`：整份快照总带（没有就是 null，切回来、刷新都靠它），delta 只在对象换了时带。
  - `resolveDialog(id, value)`：先在所有对话的弹窗里找（哪个窗口看着那条对话都能答），找不到才给窗口自己的。
  - 左栏：`ConversationSummary.dialogId`（有弹窗在等，是最早那个的 id）。
  - 关对话、`forceResetConversation`、释放时 `cancelAll()`。
  - 目标向导（`goal-service.ts`）不变：它用窗口自己的 `webUi`，弹窗还是 `dialog` 消息。
- `server/protocol.ts`：`UiDialog`（`id`、`kind`、`title`、`args`）；`UiState.dialog?`；`ConversationSummary.dialogId?`。
  协议版本 21 → 22（`server/protocol-version.ts` 和 `web/src/protocol-version.ts`）：老页面配新服务端看不到这些
  弹窗，对话就一直等，所以要横幅提醒刷新。
- `web/src/App.tsx`：
  - 显示的弹窗 = `chat.dialog`（窗口自己的：目标向导）?? `chat.state?.dialog`（打开的对话最早的那个）。
  - 提示音：一个弹窗只响一次，在它先出现的地方（左栏的 `dialogId`：后台对话问的；或打开的对话的快照）。
    连上时已经在等的不响：`cuedDialogs` 在连上后的第一份新列表里先记下它们；连上那一刻手里的旧列表
    （`listAtConnect`）不算。
- `web/src/components/LeftPanel.tsx`：`dialogId` 也挂「?」（提示 `waitingDialogBadge`：打开这条对话就能看到）。
  「?」从标题后面挪到前面：`.session-title` 是单行省略号，标题一长（还没起标题时就是第一句话）「?」
  就被吃掉。上游问卷的「?」一直就是这样，一起挪了（`.question-badge` 的 `margin-right` 本来就是给前置用的）。
- 文案：`waitingDialogBadge`（`i18n.tsx` + `locales/*.json` 8 种）。

### 回归

- `tests/unit/chat-dialogs.test.ts`（10 项）：最早的在前、显示最早的、没变时是同一个对象；按 id 答（后问的可以先答，
  别的 id 不动）；id 跨对话不重；超时、abort（已经 abort 的不开）；换会话作废旧的、关对话全清，没东西可清时
  不推；`onChange` 抛错不影响扩展；`chatUiContext` 分流（select / confirm / input 给对话，其余给窗口）、按 pi
  声明收窄返回值、透传 timeout / signal。
- `tests/unit/recent-chats.test.ts`：假对话加上 `dialogs`。
- `tests/per-chat-dialogs-test.mjs`（35 项，不花 token）：真 pi-queue（`PI_QUEUE_PKG`）+ 模拟模型，两个窗口：
  - 窗口 1 在对话 B（新对话）时，A 调 `queue_add`：B 里不出弹窗，A 那行挂「?」且在标题框里看得见（没被
    省略号吃掉），提示音响一次。
  - B 也调：B 里是 B 的弹窗（不是 A 的），再响一次，B 那行也挂「?」。
  - 窗口 2 打开 A，看到 A 的弹窗（只有一个）；窗口 1 切到 A：A 的弹窗，不再响；刷新后还在，也不响。
  - 窗口 2 批准 A：两个窗口里都关掉，A 接着跑完；A 的「?」没了、B 的还在；A 的队列只有 A 的任务。
  - 回到 B：B 的弹窗还在、B 的队列还空；批准后 B 跑完，B 的队列只有 B 的任务，A 的队列不变；左栏没有
    「?」了；窗口 2 一次没响（两个弹窗都是它连上之前就在等的）。
  - 模拟模型认提问时跳过服务端的「同项目并行提醒」：A 在跑时，B 的提问后面跟着一条
    `(System reminder: 1 other run(s) […DIALOG-A…]`。
  - `DIALOGS_DEBUG=1` 打印模拟模型收到的请求；`DIALOGS_SHOT=/tmp/x.png` 另存 `-waiting` / `-own` 两张截图。
- 反证（2026-09-25）：同一个 E2E 在改动前的构建（3869592）上挂 10 项：A 的弹窗出现在 B 里、左栏没有「?」；
  B 的弹窗顶掉 A 的；窗口 2 看不到 A 的弹窗；刷新后 A 的弹窗没了；批准 A 时找不到按钮（A 永远在等）。
  「?」还在标题后面的构建上，只挂「长标题不挡住它」那一项。

---

## image-aside-label

**状态**：`local`
**基线**：v0.96.1

**同步 v0.96.1（2026-09-26）**：`server/attachments.ts`：上游给粘贴的图片块加了 `source: { type: "url", url }`，
保留；本补丁的 `imageLabel({ name })` 文字块照旧排在前面。`server/serialize.ts` 的 `case "custom"`：上游改成先建
`const msg: UiMessage` 再截断 details（`TOOL_DETAILS_CAP`）；本补丁「customType 为 file、details.mode 为 image 时
去掉文字块」放在它前面。

**诉求**（用户 2026-09-25）：贴进对话的截图，模型说没收到图。查明：会话文件里图是在的，只是没发给模型。
billion-context-pi（ACP）每轮用自己的「核心」重建发给模型的消息列表；自定义消息只有 `extractText(content)`
非空才建核心，没有核心就不进上下文。附件的图片卡片（`customType: "file"`、`details.mode: "image"`）只有一个
图片块、没有文字，于是整条被丢，图跟着没了。装了 billion-context-pi 以后（约 9 月 18 日起）一直这样。
根上该在 billion-context-pi 修（没有文字的消息也该留）；用户选了先在本 fork 修（方案 1），上游先不提。

### 改法

- `server/attachments.ts`：
  - `imageLabel(where)`：图片卡片带的那一行文字。贴的图是 `<image name="…" />`，按路径附的是
    `<image path="…" />`（属性照 `attr()` 转义）。有了文字 billion-context-pi 就给它建核心，图片块原样跟着
    （`patchRefTag` 只给文字块加 ref 标签，别的块不动）；模型也多知道一个文件名。
  - `buildAttachmentMessages` 里三处只放图的卡片（贴的图；按路径附图的 `pathImg` 新路和 `fs.readFile` 旧路）都在
    图片块前面加这一行。视觉桥转写的卡片（`mode: "bridged"`）本来就有文字，不动。
- `server/serialize.ts`：`serializeMessage` 发给页面时，图片卡片（`customType: "file"` 且
  `details.mode === "image"`）去掉文字块：页面上还是只有那张图，不多出复制按钮；重新编辑提问时附件照旧从
  图片块恢复。页面拿到的都是序列化过的消息（左栏摘要、折叠、分页也是），所以前端不用改。
- 不装 billion-context-pi 时模型照样收到图，只是多一行文件名。

### 回归

- `tests/unit/image-aside-label.test.ts`（7 项）：贴的图是「一行名字 + 图」，没名字时用 image.png；名字里的引号、
  尖括号转义；按路径附的图那行是路径；文字模型关了视觉桥时照样带这一行；页面上的图片卡片只剩图，内联文件和
  视觉桥卡片的文字不动。
- `tests/image-aside-acp-test.mjs`（8 项，不花 token）：真 billion-context-pi（`BCP_PKG`，默认
  ~/.pi/agent/npm/node_modules/billion-context-pi）+ 收图的模拟模型，走 WebSocket 协议，不开浏览器：
  - 请求里有 `<acp …>` ref 标签（扩展确实在跑）；
  - 第 1 轮贴一张图：请求里有这张图和 `<image name="shot.png" />`；页面上的卡片只有图；
  - 第 2 轮按路径附工作区里的图：请求里两张图都在（第 1 轮的还留着），还有 `<image path="pics/red.png" />`。
  - 服务端的 HOME 指到临时目录：billion-context-pi 往 `~/.pi/acp.log` 写日志，不碰真的那份。
  - `IMAGE_ACP_DEBUG=1` 打印模拟模型收到的请求。
- 反证（2026-09-25）：同一个 E2E 在改动前的构建（92fe842）上挂 4 项：两轮的请求里一张图都没有，也没有那行
  文字；ref 标签和页面卡片两项照样过。

---

## tldr-sidebar

**状态**：`local`
**基线**：v0.96.1

**诉求**（用户 2026-09-25）：不点进对话也能跟上所有 agent：左栏每条对话标题下面显示它最新的一行 TL;DR，
需要你的行要醒目。用户的选择：
- 代替标题下面的「N 条消息」（行高不变）；正在打开 / 当前对话照旧（当前对话还是「当前」）。
- 只显示最新的一行：在 TL;DR tab 里把它折叠了（看过了）就回到条数；更早的行永远不上左栏。
- 只有服务端加载着的对话有；历史行（运行时已释放的）照旧显示条数，也不去读它们的会话文件。
- 需要你的行用 TL;DR tab 的同一种高亮；一行放不下加省略号，悬停看全文。

### 改法

- `server/tldr-lines.ts`：`latestUnseenTldr(lines)`：只看最新一行，折叠了就返回 undefined，否则
  `{ text, needsYou }`。
- `server/protocol.ts`：`ConversationSummary.tldr?: Pick<UiTldrLine, "text" | "needsYou">`。可选字段：老页面
  忽略它，老服务端不发，协议版本不用升（`check:protocol` 也不要求）。
- `server/agent-service.ts`：
  - `emitConversations`：每条加载着的对话都带 `tldr`，用 TL;DR tab 的同一份缓存（`tldrOf` /
    `conv.tldrCache`：会话树没动就不重扫）。历史行（`recentHistoryRows`）不带。
  - `entry_appended` 是 pi-tldr 的 `tldr` 条目时 `ClientSession.emitConversationsToAll()`：所有窗口的左栏马上
    换上新的一行，后台对话也是。原来的 `scheduleSessionsRefresh` 要等 800ms，而且只推订阅这条对话的那一个
    窗口。
  - `setTldrCollapsed` 写完折叠条目也 `emitConversationsToAll()`：折叠 / 展开最新一行，所有窗口的左栏跟着在
    这一行和条数之间切换。
- `web/src/components/LeftPanel.tsx`：活行的第二行有 `c.tldr`、又不是正在打开或当前对话时，显示这一行
  （`.session-sub.tldr-sub`，`title` 是全文）；需要你的行加 `needs-you`。
- `web/src/styles.css`：`.tldr-sub` 一行加省略号；`.tldr-sub.needs-you` 用 `.tldr-line.needs-you` 的同一种高亮
  （琥珀色左边线 + 12% 琥珀底），文字用正常色。
- 没有新文案：行的内容是 agent 写的，悬停就是全文。

### 回归

- `tests/unit/tldr-lines.test.ts`（+7 项，共 15）：只看最新一行；最新一行折叠了就没有（更早没折叠的行也不上）；
  折叠更早的行不影响；重新展开就回来；折叠后又来一行就显示新的；needsYou 带过去；没有行就没有。
- `tests/unit/recent-chats.test.ts`：假会话补上 `tldrOf`（这些用例的对话没有 TL;DR 行）。
- `tests/tldr-sidebar-test.mjs`（34 项，不花 token）：真 pi-tldr + 模拟模型，四条对话按提问区分：A 写三行（第二行
  很长，第三行需要你），B 不写，C 写一行，D 马上答。窗口 1 依次开 A、C、B，停在 D；窗口 2 开一个新对话。
  - A 的行在两个窗口里都实时换上每一行，不刷新；窗口 2 在第 3 行发出之前就拿到了第 2 行（写一行推一次给
    所有窗口，不是跑完才推）。
  - 长行一行加省略号，悬停是全文；行高不变（有 TL;DR 的、显示条数的、当前的行一样高）。
  - 需要你的行高亮，普通行不高亮；B 没写 TL;DR，还是条数；打开着的对话显示「Current」，有没看过的行也一样。
  - 窗口 1 打开 A，在 TL;DR tab 里折叠最新一行 → 窗口 2 的 A 行实时回到条数（不会换成更早的第 2 行）；
    重新展开 → 第 3 行实时回来。两个窗口都没刷新过，没有页面错误。
  - pi-web-ui 自己也往请求里加用户消息（「同一项目另有 N 处运行」的提醒，里面有别的对话的标题），所以模拟
    模型只认以提问开头的那条用户消息。
  - `SIDEBAR_SHOT` 存一张窗口 1 的截图，外加左栏一张（`-left.png`）；`SIDEBAR_DEBUG=1` 打印模拟模型收到的请求
    和左栏各行。
- 反证（2026-09-25）：同一个 E2E 在改动前的构建（7bfc94b）上挂 17 项：所有等这一行的检查都挂；条数、
  「Current」、行高、没刷新这些照样过。

---

## tldr-answered

**状态**：`local`
**基线**：v0.96.1

**问题**（2026-09-25，用户同意的收尾活）：「需要你」的 TL;DR 行一直高亮，直到 agent 写下一行或者用户在 tab 里
折叠它。用户已经回了话，左栏和 TL;DR tab 还在喊「需要你」。

### 改法

- `server/tldr-lines.ts`：
  - `isTldrReply(message)`：算不算用户回话。用户发的消息算（文字、只有图都算），自动发的不算：定时任务唤醒
    `[定时任务`、pi-queue 交任务 / 催办 `[Queue]`、pi-web-ui 自己的系统提醒 `（系统`。问卷（`ask_user_question`）
    和任务计划批准框（`queue_add`）的工具结果也算，错误结果不算（用户取消问卷回的是错误）。
  - `tldrLinesFromEntries`：沿分支按顺序重放，回话之前所有还在等的 needs-you 行带 `answered: true`；之后的行不算。
  - `latestUnseenTldr`：`needsYou` 取 `needsYou && !answered`，左栏不再高亮，行还在。
    `latestAwaitingReply(lines)`：最新一行正等着用户（左栏高亮着）。
- `server/protocol.ts`：`UiTldrLine.answered?: boolean`。可选字段，协议版本不升。
- `server/agent-service.ts`：
  - `message_end` 是回话、最新一行又在等用户时：`emitConversationsToAll()`（所有窗口的左栏），并给正看着这条对话的
    窗口马上发快照（`flushSnapshot` + `checkpointViewers(id, true)`）。不发的话 TL;DR tab 要等模型下一步的检查点
    才去掉高亮（E2E 里等了 4 秒还亮着）。SDK 先通知监听方、后把消息写进会话，所以放在微任务里。
  - `tldrOf` 的缓存签名算上 `answered`（同折叠）：行 id 没变也要换数组，delta 才会带上。
- `web/src/components/TldrPanel.tsx`：`awaitingYou(line)` = `needsYou && !answered`，决定高亮和「需要你」徽标。
- 没有新文案。

### 回归

- `tests/unit/tldr-lines.test.ts`（+6 项，共 21）：什么算回话；回话后左栏和「在等」都不再高亮；答了问卷算、取消
  不算；自动发的消息和这行之前的消息不算；一次回话答掉它之前所有 needs-you 行、不管之后的；折叠了的最新行
  不算在等。
- `tests/unit/tldr-panel.test.ts`（+1）：答过的 needs-you 行没有高亮、没有徽标。
- `tests/tldr-sidebar-test.mjs`（+7 项，共 41）：窗口 1 在 A 里回话，模拟模型慢慢答（6 秒）。回话前 tab 和左栏都高亮；
  回话一落盘，窗口 2 的左栏就不高亮了（实测 ~30ms，A 还在跑），窗口 1 的 tab 去掉高亮和徽标、行还在；跑完之后
  左栏还是这一行、不高亮。
- 反证（2026-09-25）：同一个 E2E 在改动前的构建（845d403）上挂 4 项，正好是新加的这几项，其余 37 项照样过。

---

## busy-endpoint

**状态**：`local`
**基线**：v0.96.1

**问题**（2026-09-25，用户同意修）：`pi-web-deploy`（~/projects/agent-tools）等没有对话在干活才换构建、重启。它像新
客户端一样读 `conversations` 推送，可推送是按窗口给的（后台对话 + 这个窗口自己正看着的那条），别的窗口前台里
跑着的对话它看不到，可能在对话干到一半时重启。

### 改法

- `server/agent-service.ts`：`BusyConversation { id, title, cwd, doing: "run" | "compaction" | "bash", subagent? }`；
  `ClientSession.busyConversations()`（static）走一遍进程共享的对话表：`isStreaming` → run、`isCompacting` →
  compaction、`isBashRunning` → bash；会话替换中按没在干活算。每条只出现一次（不像 `activeConversations()` 按
  客户端累加）。`AgentService.busyConversations()` 转调它。
- `server/index.ts`：`GET /api/busy` → `{ busy: BusyConversation[] }`；引擎没有这张表（dsh）回 501。带对话标题，
  所以和其它接口一样受 `PI_WEB_TOKEN` 保护（`/api/health` 不受）。
- `pi-web-deploy` 先问 `/api/busy`；老服务端（这个接口回的是 index.html）退回推送，再加控制 socket 的
  `activeConversations` 计数兜底。

### 回归

- `tests/busy-endpoint-test.mjs`（6 项，不花 token，模拟模型）：窗口 1 换到第二个项目、在那里开一轮慢的、不离开
  这条对话；新连上的客户端的 `conversations` 推送里没有在忙的对话（盲区本身）；`/api/busy` 在两个客户端连着时
  只列这条一次，带标题、项目和 doing "run"，而且那时这一轮还在跑；跑完之后为空。
- 反证（2026-09-25）：在改动前的构建（845d403）上第一项就挂：`/api/busy` 回的是 index.html，不是 JSON。

---

## rewind-to-here

**状态**：`local`
**基线**：v0.96.1

**同步 v0.96.1（2026-09-26）**：上游 v0.95/0.96 新加了两个消息操作：「派生分支」（`host:msg-fork`，order 15）和
「回滚到此」（`host:msg-rollback`，order 16：正在跑就先停，`sessionManager.branch(entry.id)` 后重载，可选用 git
影子快照恢复工作区）。上游的回滚**不写摘要**，确认时不说丢几条，也没有 413 太大卡片，这些本补丁的测试
都在测，所以保留本补丁（「倒回这里」，order 12），两者并存。合并处：`prompt()` 里
`if (conv.rewindDone) await conv.rewindDone;` 放在上游新加的 `activePromptAc` 之前；`Message.tsx` 上游把操作按钮
收成数组（放在第一个思考/工具头那一行，没有就放底下一行），本补丁的备用倒回按钮推进这个数组（key
`fb-rewind`），文字包进 `msg-action-label`；上游只在不跑时显示派生/回滚，本补丁的倒回在跑时显示但禁用。

**问题**（2026-09-26，用户同意修）：temper 对话做 Slack 测试截了几十张图，每次请求 ~42 MB，超过 Anthropic 的
32 MB 上限，每次都 413 `request_too_large`；billion-context-pi 又取消自动压缩，对话就卡死了。页面上只有一行原始
报错，用户自己没法救，只能找 agent 用 pi 的 `SessionManager.branchWithSummary` 回退。（图片不再越堆越多由单独的
pi 扩展 pi-image-trim 管：请求接近上限时换掉最旧的图；这个补丁管「已经卡住了怎么自救」。）

### 改法

- 「回到这里」：每条用户 / 助手消息的操作栏多一个按钮，对话在跑（或在压缩、在回退）时禁用。点了先在气泡下面
  确认：说明后面几条不再发给模型、仍然存在对话文件里、会加一段简短的自动摘要；回到用户消息时这条的文字回到输入框。
- 协议：`rewind_to { messageId, fit? }` → `rewind_done { ok, conversationId, editorText?, error? }`；`UiState.rewinding`
  （回退中，页面显示「正在写摘要」）、`UiState.tooBig`（卡片数据）。
- 服务端 `ClientSession.rewindTo`：气泡 id → 当前分支上的条目（`server/rewind.ts` `findItemIndex`）→
  `planRewind`（用户消息 → 它自己的条目，pi 把叶子挪到父条目、文字进输入框；带工具调用的助手消息连同它的工具结果
  一起保留）→ `session.navigateTree(entryId, { summarize: true })`，即 pi 的 /tree。跳过的分支原样留在文件里，只
  多一条 `branch_summary`。对话在跑时拒绝；回退进行中发来的话等回退做完再发。pi 生成摘要时把消息转成纯文字
  （不带图片），所以摘要请求本身不会超限（E2E 里核对：摘要请求 0 张图）。
- 「对话太大」卡片：一轮以 413 / `request_too_large`（bytes）或上下文窗口超限（tokens，`tooBigKind`）的报错结束
  时，服务端量一次当前分支（`measureTooBig`：总 MB、图片数、32 MB 上限），并挑一个回退点
  （`suggestRewindIndex`：保留部分 ≤ 24 MB 的最新一条，优先完整回复的结尾）。页面用这张卡片代替那条原始报错：
  白话说大小、图片数和上限，「回到那里」按钮（`rewind_to` + `fit`），「或自己挑一条消息用它的『回到这里』」的提示，
  原始报错收在「详情」里。服务重启后重开的对话若最后一条就是这种报错，会补量一次。
- 文案：`web/src/i18n.tsx`（en / zh）+ `locales/*.json`（de es fr it ja ko pt ru）。

### 回归

- `tests/unit/rewind.test.ts`：回退落点与保留条数、跳过条数、图片计数（含工具结果里的图）、建议回退点（24 MB、
  优先级、没有可回退的点）、报错识别（不把「413 requests left」这类当成太大）、气泡 id 解析、卡片数据。
- `tests/rewind-to-here-test.mjs`（不花 token：假的 Anthropic 接口记录每个请求体，超过 32 MB 回 413；一个小扩展
  像 billion-context-pi 那样取消压缩）：
  - A（浏览器）：每条问答都有「回到这里」；从第一条回答回退，确认条写着「后面 4 条」「仍保存」「摘要」；回退后后面
    的问题从对话里消失、摘要出现、文件里一条都没少、多了 `branch_summary`；下一个请求带着保留部分和摘要，不带跳过
    的问题；从问题回退时文字回到输入框；回复进行中按钮禁用，结束后恢复。
  - B（WebSocket + 浏览器）：回复进行中 `rewind_to` 被拒；堆 3.5 MB 的图直到请求 > 32 MB 被 413；卡片数据有大小、
    7 张图、32 MB 上限、原始报错和 ≤ 24 MB 的回退点；页面卡片白话写出这些、原始报错在详情里；按钮回退后下一条消息
    成功，发出的请求只带 4 张图、不带跳过的部分；文件里的条目和图片一个没少；页面无报错。

---

## crash-guard

**状态**：`local`
**基线**：v0.96.1

**同步 v0.96.1（2026-09-26）**：`newChat` 里不用会抛错的 `conv` getter（改成 `this.convs.get(this.activeId)`）；WS 分发处
上游新加了 `attachDone`（attach 完成前的消息先排队），与本补丁的 `guardCalls` 合在一起：`if (!session || !attachDone)`。

**问题**（2026-09-26，用户同意修）：2026-09-25 17:15 和 2026-09-26 09:11 pi-web-ui 整站崩溃，所有对话正在跑的回合全断。
两次是同一条栈：`ClientSession.prompt → flushSnapshot → emitSnapshotNow → currentMessages → get conv` 抛
`no active conversation`。对话表是进程共享的（server-owned-chats），而没有 socket 的窗口（页面刷新了）不算「有人
在看」（`viewedElsewhere`），所以另一个窗口点「新对话」能把它的当前对话关掉；它之前发出的那句话一结束，`prompt()`
收尾刷新快照就抛错。分发器用 `void cs.prompt(...)` 发起它，成了未处理的 promise 拒绝，Node 退出，systemd 重启服务。
上游 v0.96.1 是同样的代码。

### 改法（三层）

1. 根因（`server/agent-service.ts`、`goal-service.ts`）：
   - `removeConversation` 关掉一条对话时，还指着它的别的窗口（只可能是没 socket 的）马上换到一条开着的对话：
     `recoverLostActive` → `planForLostActive`（`server/crash-guard.ts`，纯函数）：优先这次发送所在的对话，其次本项目
     最近活跃的（同 reload-adopt 的 `pickAdoptTarget`，不挑子代理对话）；都没有时有人在看就开新对话，没人看就等它
     重连（`attach` 先 `ensureActiveConversation`）。每次写一行 `[crash-guard]` 日志。
   - `emitSnapshotNow` 没有当前对话时先恢复，恢复不了就跳过这次快照；`prompt()` 收尾先回到这次发送所在的对话
     再刷新；`newChat`、`displaceActive` 不再经过会抛错的 `get conv`。
   - SDK 事件（`onEvent`）里比较 id（`this.activeId`）；`onEvent` 整体包一层：处理器抛错时带栈记日志（同一
     错误每分钟最多一次）并继续，不再把错误扔进 pi 的运行循环。目标栏 `emitGoalStatus` 没有当前对话时跳过。
2. 分发器（`server/index.ts`）：处理一条窗口消息时，`cs` 是 `guardCalls(session, msg.type, report)` 包出来的代理：
   每个方法返回的 promise 挂上 `.catch`（同一个 promise 原样返回，await 的人照样看得到错误），同步抛错被接住并
   返回 `undefined`；整个 switch 外面再包 try/catch。出错时带栈记日志，并给这个窗口发一条错误通知（「这一步出错了
   （prompt → prompt）：…。服务器照常运行。」）。约 89 处 `void cs.x(...)` 一处不用改。
3. 兜底（`server/index.ts` 调 `installProcessGuards()`）：进程级 `unhandledRejection` 带栈记日志，服务继续跑。
   **不**接 `uncaughtException`：同步异常没人接住时进程可能真的坏了，保留 Node 默认（退出）。

### 回归

- `tests/unit/crash-guard.test.ts`：`describeError` / `errorMessage`；`guardCalls`（拒绝被报告且 await 的人仍看得到、
  `void` 调用不留未处理的拒绝、同步抛错被接住、私有字段 / getter / 返回值不受影响）；`planForLostActive` 的顺序；
  `unhandledRejection` 带栈、只装一次、不装 `uncaughtException`；快照守卫（无处可去就跳过不抛、有开着的就换过去、
  发送结束回到它的对话、有人看才开新对话）；`onEvent` 抛错只记日志不抛、每分钟一次；目标栏跳过。
- `tests/no-active-chat-crash-test.mjs`（不花 token：假的 Anthropic 接口，带 `SLOW-<n>` 的消息 n 秒后才答完）：窗口 C
  在对话 W 开一个 14 秒的慢回复；窗口 A 新开对话 X 发一条 6 秒的慢消息，再点新对话（Y）；A 的页面关掉（没有
  socket 了，发送还在等 X）；新页面 B 落在 Y 上再点新对话，Y 被关掉；X 答完。核对：服务进程还在、`/api/health`
  正常、W 的回复照常到达、B 还能聊天、A 用同一个 clientId 回来拿到的是开着的对话并能聊天、日志里没有
  `no active conversation`、有 `[crash-guard]` 那一行。
- 反证（2026-09-26）：同一个 E2E 在改动前（766f613）上服务进程以 exit code 1 退出，日志里正是线上那条栈
  （`get conv ← currentMessages ← emitSnapshotNow ← flushSnapshot ← prompt`）。

---

## dangling-tail-only

**状态**：`local`
**基线**：v0.96.1

**问题**（2026-09-26，同步到 v0.96.1 后第一次重启，17:26）：重启后几秒内有三个对话被发送，之后每次发送都被
Anthropic 拒绝：`400 messages.N.content.1: unexpected tool_use_id found in tool_result blocks: toolu_… Each
tool_result block must have a corresponding tool_use block in the previous message.`，重试也一样。
原因是上游 v0.95.0 加的发送前守卫（#280，`prompt()` 里 `findDanglingToolCalls(agent.state.messages)`）扫的是**整段**
对话：凡是出现过、后面没有结果的 toolCall 都算「悬空」，然后把合成 toolResult 追加到对话**尾部**。老的无结果调用
很常见（重启把一个回合在工具中间打断、用户接着聊；问卷没答就换了话题），而且本来就合法：pi-ai 发请求时会在下一条
user 之前自己补「No result provided」。合成结果一追加到尾部，就成了前一条 assistant 里没有对应 tool_use 的孤儿
tool_result；这条坏记录已经落盘，所以对话从此发不出去。上游在 #332 里只收紧了落盘版 `healDanglingToolCallFile`
（只修当前分支尾部那条 assistant），发送前守卫和强制重置后的复查仍然扫全文；上游 main（v0.96.1）还是这样。

### 改法

- `server/dangling-tools.ts` 新增纯函数 `findTailDanglingToolCalls`：从尾往前，只返回尾部那条 assistant 还没拿到结果的
  调用；先遇到进上下文就成为 user 回合的消息（`user`、`custom`、`bashExecution`、`branchSummary`、`compactionSummary`，
  以及落盘的 `custom_message` / `branch_summary` 条目）就返回空；尾部 assistant 是 `error` / `aborted` 也返回空（pi 发送
  前会丢掉它，不能越过它去修更早的回合）；`custom` 状态条目这类不进上下文的跳过。
- 落盘版用的 `tailAssistantToolCallIds` 同样在这些消息和条目处停下（原来只认 `user`，会越过扩展消息、分支摘要）。
- `server/agent-service.ts`：发送前守卫和强制重置后的复查（`transcriptBlocked`）都改用 `findTailDanglingToolCalls`。
  复查也要改，不然一个老的无结果调用会让对话一直处于 `transcriptBlocked`，发送全被拒。

**已经坏掉的对话怎么救**：会话文件尾部有一串合成结果条目（文案「上一次运行被强制终止…」）。先备份，再把紧跟在这串
条目后面的那一条（通常是用户的下一句话）的 `parentId` 改成这串条目前面那一条的 id，然后重新打开该对话（或重启）。
坏条目留在文件里，但不在当前分支上了，什么都不删。

### 回归

- `tests/unit/dangling-tools.test.ts`：`findTailDanglingToolCalls`（尾部未答的调用照报；老调用后面有 user 回合就不报，
  同一段对话 `findDanglingToolCalls` 仍会报出来，即旧守卫会去补的那些；五种 user 回合角色都会挡住；`error` / `aborted`
  尾部不越过；跳过 `custom` 状态条目、认 `{ message }` 包装；重复 id 只报一次）；`tailAssistantToolCallIds` 在
  `custom_message` / `branch_summary` 条目和 `bashExecution` 消息处停下；`healDanglingToolCallFile` 遇到尾部是
  `custom_message` 时不动文件。
- `tests/dangling-tail-test.mjs`（不花 token）：假的 Anthropic 接口按 Anthropic 的规则核对每个请求里 tool_use /
  tool_result 的配对，不合规就用同样的措辞回 400。打开两个存好的对话各发一句：「老调用 + 用户接着聊」的对话必须
  照常得到回答、文件里不多出任何合成结果、没有「已自动填入」提示；「尾部是没有结果的调用」的对话，那个调用正好补上
  一条合成结果（接在它后面），也照常得到回答；假接口一次 400 都没回。
- 反证（2026-09-26）：同一个 E2E 在改动前（bbb5e4d）上，第一个对话被补了 2 条合成结果、假接口回 400，没有回答。

---

## lazy-images

**状态**：`local`
**基线**：v0.96.1

**问题**（2026-09-26，用户：「只加载相关的部分，懒加载」）：大对话打开慢。页面本来就只拿最新 100 条消息（`chat-window-pagination`），
但还有两处重：

1. 这些消息里的图片随快照整张发出（data URL）。09-26 早上量：temper 对话最新 100 条共 9.9 MB，其中 9.6 MB 是 9 张截图。
2. 服务端每次快照都把整段对话转成显示格式（`messagesOf` 序列化 `agent.state.messages` 全部，按消息缓存），虽然只发 100 条。
   temper 对话 14,620 条消息、181 张图（图片数据共约 91 MB）。

### 改法

- **图片占位**（`server/serialize.ts`、`server/image-meta.ts`、`protocol.ts`）：发给页面的消息里，图片块只带
  `url`、`mimeType`、`bytes`、`width`、`height`（`imageMetaOf` 从 PNG / JPEG / GIF / WebP 文件头读尺寸），不带数据。
  用户贴的图、custom 消息里的图、工具结果里的截图都一样。占位不占快照，所以工具结果图片的 2e6 字符上限（超了换成
  `[image result]` 文字）只在内联时生效：以前被换掉的大截图现在也看得到。每条工具结果最多 8 张照旧。
  `serializeMessage(m, seq, imageUrl?)` 不给 `imageUrl` 时照旧内联（DSH、插件读取对话走这条）。
- **图片端点**（`server/index.ts`，纯函数在 `server/chat-image.ts`）：`GET /api/chat-image/<会话>/<消息>/<n>?v=<指纹>`。
  `v` = 图片 base64 文本的 sha1 取前 16 个 base64url 字符（`imageVersion`）。跟其它 `/api` 一样过鉴权（`<img>` 带不了
  请求头，地址经 `withToken`）。只在内存里、进程共享的对话表中找（`ClientSession.chatImage`）：先按消息 id 和序号，
  对不上（倒回、派生后 id 变了）再按指纹在整段对话里找。从不拿地址拼文件路径，奇怪的 id 只会找不到。
  地址格式不对 400，找不到 404；回 `Cache-Control: private, max-age=31536000, immutable`（同一地址内容永远不变）、
  `Content-Security-Policy: sandbox`、`X-Content-Type-Options: nosniff`。
- **只构建要发的消息**（`server/agent-service.ts`）：`chatIndexOf(conv)` 保存整段对话的原始消息、缓存键和 UI id
  （便宜：不转格式、不碰图片），消息表变了才重建。显示格式只为发出去的那段构建（`fullAt` / `fullRangeOf`：窗口、
  「加载更早」页、跳转要的那段），按消息缓存，`pruneMessageCache` 清掉已不在对话里的。快照增量比的是键
  （`emittedKeys`），不再是构建好的消息。提问索引（`question-index.ts`）和折叠摘要（`exchange-digest.ts`）直接读原始
  消息，摘要用到的那几条才构建。切换缓存的指纹用 id 列表算（`window-hash.ts` 的 `idsHash`，结果和 `messagesHash`
  一样）。整段构建（`messagesOf`）只剩插件读取对话在用。编辑 / 派生按 id 找条目（`findEntryByUiId`）用的还是同一个
  计数器（`uiMessageKeyOf`），id 不变。
- **页面**（`web/src/components/ChatImage.tsx`、`web/src/chat-image.ts`）：占位先画一个同尺寸的灰框（SVG，宽高取自
  占位；页面的 max-width / max-height 规则像缩放图片一样缩放它，图片到了不跳动）。快滚到时（IntersectionObserver）
  用 `new Image()` 预取，加载完再换上；失败重试（地址加 `retry=n`）。本页加载过的地址记着（最多 2000 个），往回滚、
  切回来直接显示（字节在浏览器缓存里）。放大查看取原图。
  - 编辑重问（`question-attachments.ts`、`App.tsx`）：占位还原成 `imageUrl` 附件（编辑框的缩略图照样显示），发送前
    取回字节（`resolveImageUrls`）；取不到就报错、不发，不会丢了图重问。
  - 「复制为图片」（`message-image.ts`）：导出前把还没加载的图换成真地址（`resolveLazyImages`）。
  - 切换缓存（switch-cache）存的就是带占位的消息，不存图片。
- 协议号 23 → 24（两份）。
- 没改：会话文件、pi、billion-context-pi；打开对话时 pi 仍读整个文件（模型要用）。长文本输出不做懒加载（每个窗口
  0.02–0.5 MB，不值得，用户同意）。

### 量出来的（2026-09-26，测试服务器，4 个最大对话的副本在同一进程里按顺序打开，`/tmp/lazy-measure.mjs`）

| 对话               | 打开时 WS      | 首次绘制     | 往上 10 页（1000 条）           | 服务端 heap（GC 后，累计） |
| ------------------ | -------------- | ------------ | ------------------------------- | -------------------------- |
| temper（01a09d92） | 2.95 → 0.31 MB | 4.8 → 4.3 s  | 5.74 → 3.84 MB，867 → 513 ms    | 321 → 308 MB               |
| EPD（01a0b25d）    | 0.44 → 0.44 MB | 3.4 → 3.3 s  | 3.13 → 3.13 MB，881 → 607 ms    | 554 → 517 MB               |
| rollcall（01a0ca43）| 0.32 → 0.32 MB | 2.5 → 2.4 s  | 5.09 → 4.60 MB，1119 → 954 ms   | 726 → 677 MB               |
| tooling（01a0a269）| 0.66 → 0.66 MB | 2.3 → 2.4 s  | 2.92 → 2.63 MB，849 → 601 ms    | 872 → 813 MB               |

- 四个都开完后 RSS 1313 → 1274 MB。内存大头是 pi 自己那份整段对话（模型要用），这个补丁不碰。
- temper 改前打开时是 2.95 MB 而不是早上的 9.9 MB：对话又长了，最新 100 条里只剩 2 张图；而且 2e6 上限已经把最大的
  截图换成了 `[image result]` 文字。改后这些截图也回来了（以占位的形式）。
- 首次绘制的大头是 pi 读整个会话文件、建对话，不在这个补丁的范围里。

### 回归

- `tests/unit/lazy-images.test.ts`（32 项）：文件头尺寸（PNG、GIF、WebP 的 VP8 / VP8L / VP8X、JPEG 的基线 / 渐进
  （SOF2）/ DHT 和填充字节之后 / 超过前 4 KB 的 EXIF 之后，认不出、太短、零尺寸给 null）；`base64Bytes`、`imageVersion`、
  `servedImageType`（嗅字节，只信声明的图片类型）；带图片 URL 的 `serializeMessage`（用户图按顺序编号、文字不动；不给 URL
  照旧内联；3 MB 截图变成小占位而不是 `[image result]`；工具结果最多 8 个占位、n 是在这条消息所有图里的序号；远程 URL
  原样；custom 图片卡只剩占位）；`isShownMessage` / `imageDataOf` / `imageBlocksOf`；端点的纯函数
  （`parseChatImageAddress` 的各种非法地址、`imageIfVersion` 原字节且指纹不对不给、响应头）；读原始消息的
  `buildQuestionIndex` 和只构建显示那几条的 `snapshotDigests`；页面的 `isShownImage`、`imageSrc`、`placeholderSrc`、
  `retrySrc`、加载过的地址、`splitDataUrl`、`fetchImageBase64`（大图也行）、`resolveImageUrls`（只取占位、取不到就失败）、
  `resolveLazyImages`；编辑重问时提问自己的占位图和紧跟的图片卡都变成 `imageUrl` 附件。
- `tests/lazy-images-test.mjs`（不花 token：假的 Anthropic 接口）：种一个 15 轮的对话（每轮用户贴一张图 + 工具返回一张
  截图，共 30 张真 PNG，约 29 MB，其中一张 2.5 MB），窗口设成 40 条。核对：打开时快照很小（14.4 KB，窗口里 20 张图共
  20.2 MB）、里面没有图片数据、20 张都是带类型 / 字节 / 宽高的占位、2.5 MB 截图也是占位；提问列表有全部 15 个提问；
  打开时只取屏幕附近的图（3/20），屏幕上的图显示且是原图原尺寸；还在路上的图是同尺寸灰框，到了不跳；往上滚取回窗口
  全部 20 张、每张只取一次；折叠行展开后里面的截图也加载；放大是 1200×700 原图；「加载更早」拿到的也是占位（5 张图
  3.4 KB），滚到就显示；端点给原字节、类型、长度、缓存头、sandbox，没密码 401，指纹不对 / 未知对话 404，n 不是数字、
  指纹格式不对或缺、id 超长 400，路径把戏 404，消息 id 变了（倒回、派生）按指纹仍找得到；提问栏到得了第一个提问，
  跳过去（窗口外）它的图显示；新对话里回答途中到的截图在回答结束前就显示、回答正常结束；种的会话文件没变（只有 pi
  自己加的 `thinking_level_change`）；服务端没有图片错误，页面没有错误。
- `tests/unit/crash-guard.test.ts` 的快照守卫用例跟着改：快照现在从读 `this.conv` 开始（原来是 `currentMessages()`），
  假窗口用一个 getter 记下「快照开始了」。

---

## carry-on

**状态**：`local`
**基线**：v0.96.1

**问题**（2026-09-26，用户同意修，队列任务 #11）：装新版要等所有对话都停下来（`pi-web-deploy` 的等待），常常一等
几个小时；崩溃时正在跑的对话全断，要人一个个去点「继续」。用户要的是：装新版马上重启，被打断的对话自己接着干，
计划内重启和崩溃都一样。

上游其实有一套「重启后继续」（`recordInterruptedRuns` 在关机时把每个客户端正在跑的对话记进 `client-state.json`
的 `interrupted`，下次**同一个 clientId** attach 时 `resumeInterrupted` 重开并发「继续」）。在本 fork 里它几乎不生效：
`client-per-load` 让每次页面加载都是新的 clientId，页面一刷新（装新版后页面会自己刷新）旧 id 就不会再回来。线上 `client-state.json` 里攒了 220 条没人
取的记录（09-15 到 09-26）。而且它只在关机时记，`kill -9` / 崩溃什么都留不下。

### 改法

1. **正在干活的对话表**（新文件 `server/running-chats.ts`，`<dataDir>/running-chats.json`）：
   `{v, pid, shutdown?, chats:[{sessionFile, title, cwd, startedAt, cutoffs, tools:[{id,name,detail}], step?, awaiting?}]}`。
   `agent-service.ts` 在 `onEventNow` 顶上调 `trackRunning`：`agent_start` 加进来，`tool_execution_start/end` 更新
   正在跑的工具（bash 记命令，其他工具记路径 / 模式 / URL 等一行），`agent_end`（不是 `willRetry`）移出去，
   关掉对话也移出去。子代理、临时对话不记。每次变化同步原子写（tmp + rename），所以 `kill -9` 之后文件也是对的。
   用户自己点停止 = 回合结束 = 不在表里；空闲的对话也不在表里。
2. **关机先冻结**：`recordInterruptedRuns()` 改成 `runningChats.freeze("shutdown")`（写上 `shutdown` 标记，之后的
   事件不再改表），`index.ts` 的 `shutdown()` 一开头就调（在拆 scheduler / MCP 之前），`restart_service` 也调。
   否则关机时被中止的回合会以 `agent_end` 把自己从表里删掉。
3. **启动时接着干**：`prepareCarryOn()`（`httpServer.listen` 之前）读上一个进程留下的表，`planCarryOn` 算出：
   - 原因：有 `shutdown` 标记且 `restart-reason.json`（`pi-web-deploy` 重启前写的 `{reason, at, by}`，读完就删）
     不超过 15 分钟 → 用它的原因（如 `install of 1a2b3c4`）；有标记没原因 → `a restart`；没有标记 →
     `it crashed or was killed`。
   - 每个对话一条提示（普通的用户消息）：`pi-web-ui restarted at HH:MM (reason). You were in the middle of <step>;
     it was cut off. Check where it stopped and carry on.` step 是 `writing a reply`、`running the bash command \`…\``、
     `running the read tool (…)`、多个工具时 `running 2 tools at once: …`；在等用户回答（`ask_user_question`）时是
     `asking the user a question (ask_user_question) (they hadn't answered yet, so ask it again)`，它就会重新问。
   - 防循环：`cutoffs` 是「连续被重启打断、中间没做完一个回合」的次数。第 3 次不再发提示，改成给窗口一条警告
     （「连续 3 次被重启打断都没做完…请打开它，告诉它接下来做什么」）。回合正常结束就清零。
   新表先放进这些对话（`awaiting`，保留 `cutoffs`），它们的回合开始后照常记。
   `carryOnAfterRestart()`（listen 后 1.5 秒）用伪客户端 `carry-on:startup`（`isPseudoClientId` 认它，空白开局）
   逐个 `switchSession` + 发提示（`ClientSession.carryOn`：等到回合开始或消息进去，最多 20 秒，再 `listed = true`，
   这样切走时它继续跑，所有窗口的运行列表里看得到），完了把伪客户端的 sink 摘掉（不算「有人在看」）。重开不了的
   从表里拿掉并提示用户。
   这期间真窗口的 `attach` 先等（最多 30 秒）：否则窗口打开最近的对话（`continueRecent`）会给同一个会话文件第二个
   writer。之后 10 分钟内每个连上来的窗口收到一次通知（接着干了哪些、哪些被防循环拦下、哪些没重开成）。
4. **过渡**：还没有 `running-chats.json` 时（第一次装这个补丁），从 `client-state.json` 的旧 `interrupted` 记录里
   取**最近一次**关机的（最新一条 15 分钟内、与它相差 1 分钟内的），按会话文件去重，step 从会话文件尾部读
   （`stepFromTranscriptTail`：最后一条 assistant 消息里没结果的工具调用）。然后清掉所有客户端的旧记录
   （`client-state.ts`：`saveInterrupted/takeInterrupted` 换成 `takeAllInterrupted`）。上游那条 per-clientId 的
   `resumeInterrupted` 删掉（和新路径重复发「继续」）。
5. **定时唤醒**（`server/scheduler-tasks.ts`）：`start()` 时错过不到 15 分钟（`RESTART_CATCHUP_MS`，重启的空档）
   的一次也补发，即使 `catchUp` 是 `skip`。
6. **队列**（pi-queue，另一个仓库）：pi 重开会话时 pi-queue 把在跑的队列暂停（`pause restart`）；收到以
   `pi-web-ui restarted at` 开头的提示时，`resumesAfterRestart` 让它接着跑（这条提示不算用户对卡住任务的回答）。

`pi-web-deploy`（`~/projects/agent-tools`）同时改成默认马上重启（`--when-idle` 保留原来的等待），重启前写
`restart-reason.json`。

### 回归

- `tests/unit/running-chats.test.ts`（18 项）：提示原文、`describeStep`（回复 / 一条命令 / 等回答 / 多个工具 / 超过 4 个）、
  `toolDetail`；`planCarryOn`（三种原因、过期的原因文件、防循环、去重、坏记录）；`RunningChats` 的开始 / 工具 / 结束 /
  冻结后不再变 / `seed` 保留 `cutoffs` 和 `awaiting`；`takeRestartReason`（读完删、ISO 或毫秒）；`newestInterrupted`；
  `stepFromTranscriptTail`。
- `tests/unit/scheduler-tasks.test.ts`：重启错过 68 秒的一次会补发，错过超过 15 分钟的不补。
- `tests/carry-on-restart-test.mjs`（不花 token：假的 OpenAI 接口；独立的测试服务、临时数据目录；用真的 pi-queue）：
  六个对话：IDLE（答完了）、STOP（用户停了）、REPLY（在写长回复）、CMD（在跑 `sleep 60`）、ASK（在等用户回答）、
  QUEUE（队列任务 #1/2 进行中）。
  1. 计划内重启（SIGTERM + `restart-reason.json`）：表里正好是 4 个忙的，步骤是命令 / 提问；冻结后标为计划内；
     4 个各收到一条提示，写着时间、原因和各自的步骤（ASK 被要求重新问）；连上来的窗口听到「4 个对话在接着干」；
     队列接着跑（任务 #1 完成、#2 开始）；它们都又在干活，`cutoffs` 是 1（队列的新任务从 0 起）。
  2. `kill -9`：没有关机标记；提示写「it crashed or was killed」；CMD 重跑的命令又被打断；QUEUE 在任务 #2 里被打断；
     `cutoffs` 变成 2（队列 1）。
  3. 没原因的计划内重启：REPLY、CMD、ASK 第 3 次 → 没有第三条提示，各一条警告；QUEUE 收到写着「a restart」的提示；
     表里只剩 QUEUE。
  三轮里 IDLE 和 STOP 都什么也没收到。
- `pi-queue` 的 `tests/queue.test.ts`：`resumesAfterRestart`；`pi-web-deploy` 的测试：默认马上重启并写原因、
  `--when-idle` 等待、`--reason`、`--now` 仍然接受。
- 反证（2026-09-27）：同一个 E2E 在改动前（`mine` 28ab26b）上 20 项失败：没有一个忙的对话收到任何东西
  （上游的 per-clientId 恢复对不上新的 clientId），表文件不存在，队列停着。

---

## sealed-tests

测试一律在密封的临时家目录里跑，碰不到真的对话、真的模型和真的数据。主人的规矩（2026-09-26）：测试绝不碰真对话；
要用真对话就拷一份临时的，用完就删。

### 以前的问题

- ~180 个 E2E 脚本里 104 个不设 `PI_CODING_AGENT_DIR`、35 个不设 `PI_WEB_DATA_DIR`：一次全量往真的
  `~/.pi/agent/sessions` 里留几十个 `--tmp-*` 文件夹，有的还读写正在跑的服务的 `~/.pi-web-ui`。
- 几个测试用真的模型（`questionnaire`、`title-jsonl`、`supplement`、`goal-review-loop` 等），跑一次花真 token。
- `check.sh` 要手动加 `TZ=UTC`；`plugin-updater` 的 prune 偶发失败。

### 做法

这台机器开不了沙箱（bwrap / unshare 建不了 user namespace，要管理员改设置，2026-09-26 查过），所以
密封 = 环境变量 + node 里的一道栅栏：

- `scripts/sealed.sh [--report] [--keep] <命令>`：在一个临时根目录下建新的 `HOME`、`PI_CODING_AGENT_DIR`、
  `PI_WEB_DATA_DIR`、`TMPDIR`，用 `env -i` 加白名单起命令（不带任何模型的 key）。跑完停掉命令留下的进程、
  删掉临时根目录，报告真 sessions 列表里新出现的文件夹（`scripts/sealed-summary.mjs` 写总结、定退出码）。
  临时 pi 文件夹里放一个连不上的替身模型（`fastfail`，重试关掉），不然页面会弹首次配置窗口、挡住点击；
  `PI_SEALED_MODEL=none` 就不放。已经在密封里时直接跑命令。
- 栅栏 `tests/lib/sealed-fence.cjs`（经 `NODE_OPTIONS=--require` 加载，所以每个 node 子进程都带着）：碰真的
  `~/.pi`、`~/.pi-web-ui`、`~/.pi-scheduler` 的 fs 调用直接抛错并写出路径（`--report` 只记录不拦）；已装的扩展
  代码（`~/.pi/agent/npm`、`~/.pi/agent/git`）只能读；不许连正在跑的服务的端口；不许在真文件夹里起程序。
  命中一次，整个命令就算失败（退出码 97）。
- `scripts/check.sh` 自己设 `TZ=UTC`，并且总是经过 `sealed.sh`。
- `tests/unit/setup-temp-pi-dirs.ts`（`vitest.config.ts` 的第一个 setupFile）：不经过 sealed.sh、直接
  `npx vitest` 时，每个测试文件也拿到自己的临时 pi / 数据目录。
- `tests/run-sealed.mjs`：所有 E2E 脚本，每个一个独立的密封家目录，并行跑（`--jobs`）。用同一个固定端口的脚本
  （也算 `MOCK_PORT = PORT + 1` 这种推出来的，和 `SITE = 8972` 这种别的固定服务）不同时跑。每个脚本的输出和
  栅栏摘要写到 `--out` 目录。全量时跳过不适用本 fork 的上游测试并写明原因（`NOT_FOR_THIS_FORK`，见下）。
- `tests/lib/real-chat-clone.mjs`：`cloneRealChat()` 把一个真对话（连同 `.acp.json`）通过栅栏的只读小门拷进
  密封家目录，跟着这次运行一起删掉；不在密封里就拒绝。
- 测试公共件：`tests/lib/mock-model.mjs`（假模型：脚本化回复、工具调用、目标向导问答 `wizardReply`、
  `noRetries`）；`tests/lib/own-server.mjs`（用自己的临时目录、端口和假模型起 `dist/server`）；
  `tests/lib/topbar.mjs`（`topbar-crowding` 和上游 ui-slots 把设置、浏览器控制、版本号等收进了「…」菜单，
  测试经它去点）；`tests/lib/port-utils.mjs` 的 `freeTcpPort()`（系统给的空闲端口）；`tests/lib/chrome.mjs`
  （从账户主目录找 playwright 的 headless shell；浏览器语言固定 `zh_CN`，因为测试找的是中文标签，
  `PI_TEST_BROWSER_LANGUAGE` 可改）。
- pi-queue（8c43863）、pi-tldr（5973b5a）、pi-image-trim（be30e3f）的测试也改成在密封里跑。

### 测试顺带查出来的 bug（代码已修）

- `server/goal-service.ts`（上游 2739ef8）：目标向导的 `goal_ask` 遇到开放题（没有选项）时
  `params.options!.join` 抛错，向导拿到的是报错而不是用户的回答。
- `server/plugin-updater.ts` 的 `stamp()`：同一毫秒的两次备份同名，第二份盖掉第一份，prune 就少一份
  （那个「expected 2 to be 3」）。新单测「backups made in the same millisecond each get their own folder」。
- `server/agent-service.ts`：会话列表有 3 秒缓存，一轮在打开历史列表后 3 秒内结束，就会重推旧列表，新对话要等
  下一轮才出现在历史里（`title-jsonl-test` 换成快的假模型后查出来）。
- `web/src/components/scroll-classify.ts` + `MessageList.tsx`：大对话里一轮结束时页面忙，用户向上一滑会变成一次
  ≥500px 的滚动事件，被当成布局收缩，流结束时的吸底又把人拉回底部。现在记住用户自己的向上操作（滚轮、手指
  下拖、PageUp / ↑ / Home），500ms 内的向上移动一律算离开底部。单测在 `tests/unit/scroll-classify.test.ts`。
  上游的 `scroll-attr-collapse-test` 在上游构建上过，是因为那边新到的消息根本不进这一页；`server-owned-chats`
  下会进来。
- `web/src/styles.css`：手机宽度（320–414px）跑着一轮时，输入框左边六个图标挤不下、互相压住；现在换行。
- `plugins/mermaid/client/entry.mjs`：Mermaid 12 的深色主题默认用渐变边框（`useGradient: true`），不理
  `nodeBorder`，所有深色主题的节点边框都是同一种灰；关掉后用主题的强调色。

### 测试的改法

只修不删、不放水。几类：

- 改用自己的临时目录 + 假模型（原来用真目录或真模型）：`questionnaire`、`title-jsonl`、`supplement`、`freeze`、
  `goal-wizard`、`goal-wizard-cancel`、`goal-review-loop`、`goal-abort`、`goal-autostart`、`tool-status`、
  `commands`、`edit-reask`、`file-upload`、`image-paste`、`live`、`projects`、`ws-session`。
- 找账户主目录下的东西（扩展代码等）用 `userInfo().homedir`，不用 `HOME`（密封里 HOME 是临时的）。
- 固定端口改成 `freeTcpPort()`：并行时会互相杀掉对方的服务，8931 在本机被 Docker 占着。
- 种子对话要等模型出错那条消息的，给替身模型关掉重试（`noRetries`）：`lazy-window`、`scroll-*`。
- 上游改了界面、测试没跟上的（纯 v0.96.1 上一样挂）：顶栏「…」菜单、第二个隐藏的文件输入框、目标栏、声音设置
  7 行、模型选择器搬进输入框、连接状态搬到底栏、`composer-overlap` 的药丸宽度、`notes-ui` 的新图标、
  `vision-bridge-ui` 的系统提示词模板、`scroll-stick` 的输入框长高（现在由 ChatInput 处理，测试改成真的打字）等。
- 本 fork 的行为：`terminal-smoke`（`terminal-view-lifecycle`：退出的终端先关掉再同名新建）、`terminal-browser`
  （留下用过的那个终端，对话才留在列表里）、`conv-cross-project`（打开 `PI_WEB_UI_CHAT_FOLLOWS_CWD=1`）、
  `conv-group-flash`（按 `flat-recent-chats` 重写）、`panel-layout`、`ui-layout-ui`（本 fork 的右栏标签）、
  `projects`（`no-cwd-restore`）。
- 时序：固定的等待换成等条件（`panel-layout`、`global-search-ui`）；`goal-wizard-switch` 按转录文件切回第一轮的
  对话（空闲的对话在新建对话后会被卸下，旧的内存 id 就没了；纯 v0.96.1 上一样时好时坏）；`prompt-templates`
  跑完显式退出（服务的管道让它挂到超时）。
- `spawn-helper-test`：node-pty 只在 macOS 上带 spawn-helper，别的平台打印 SKIP、退出 0。

`tests/run-sealed.mjs` 全量时跳过这 7 个（点名跑照样跑；文件保持上游原样，同步时不冲突）：

- `takeover`、`idle-takeover`、`remote-answer`、`elsewhere-lifecycle`、`elsewhere-click-takeover-ui`：测上游的
  「一条对话属于一个窗口」（过户、elsewhere 行、跨页作答）；`server-owned-chats` 下对话归服务端，没有 elsewhere 行。
- `orphan-adopt`：`reload-adopt` 让刷新的页面回到自己的对话，不领养孤儿。
- `model-config-ui`：上游的模型工作室取代了它驱动的那个弹窗，纯 v0.96.1 上也挂。

### 怎么跑

- 类型检查、lint、单测、构建：`scripts/check.sh`（已经密封、已经 UTC）。
- 全部 E2E：`node tests/run-sealed.mjs`（默认 6 个并行，先构建；2026-09-27 用 `--jobs=4 --no-build` 跑完 173 个约 6 分钟）；只跑几个就把名字写在后面，
  构建是新的就加 `--no-build`。
- 任意命令：`scripts/sealed.sh env PI_TEST_PREBUILT=1 node tests/xxx-test.mjs`；`--report` 只记录不拦，
  `--keep` 留下临时目录。

### 回归

- `tests/unit/sealed-fence.test.ts`（16 项：读写删、ESM 导入、子进程、扩展代码只读、符号链接、活端口、克隆小门、
  sealed.sh 本身）。
- 2026-09-27：`TZ=UTC scripts/check.sh` 连过两次，不带 TZ 也过；`run-sealed` 全量 173/173 过、7 个跳过、
  0 次栅栏命中；真 sessions 列表没有多出文件夹。

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
- **quiet-duplicate-open**（旧 `1401fbf`，同步 v0.96.1 时退役）：在第二个窗口打开空闲对话时不再弹「该对话
  在另一处也开着」。被 `server-owned-chats` 取代：对话归服务端之后只有一个 writer，它把整段持有者检查
  删掉了，这个补丁到栈顶已经没有任何效果（2026-09-23 逐行核对过）。做法：rebase 时把它的提交
  并进 `server-owned-chats`（`fixup -C`），最终的树逐字节不变；它的回归断言还在
  `tests/cross-client-session-test.mjs` 里。

---

## 同步时的已知失败（不是回归）

下次同步先对照这里：失败原因还是这里写的那个，就不是同步引入的。

- 测试怎么跑、哪些上游测试不适用本 fork：见 `sealed-tests`。`scripts/check.sh` 自己设 `TZ=UTC`（上游的
  `tests/unit/notes-plugin.test.ts` 有两条用例把 UTC 的 ISO 字符串当本地时间读，非 UTC 时区必挂），
  并且总在密封里跑。`plugin-updater` 的 prune 偶发失败（`expected 2 to be 3`）已修：同一毫秒的两份备份同名。
- 全部 E2E 用 `node tests/run-sealed.mjs` 跑。它取代 `tests/run-smoke.mjs`：那个不密封，会往真的
  `~/.pi/agent/sessions` 里留 `--tmp-*` 文件夹，`questionnaire-test` 还会花真 token（2026-09-25 误跑过一次）。
  2026-09-27 在 v0.96.1 + 本 fork 上 173/173 过，7 个跳过，0 次栅栏命中。以前记在这里的失败都修了或进了跳过名单：
  - 跳过（原因见 `sealed-tests`）：`takeover`、`idle-takeover`、`remote-answer`、`elsewhere-lifecycle`、
    `elsewhere-click-takeover-ui`、`orphan-adopt`、`model-config-ui`。
  - 修好了：`conv-cross-project`、`terminal-smoke`（55 项全过）、`conv-group-flash`、`scroll-attr-collapse`、
    `lazy-window`、`questionnaire`，以及 v0.96.1 上因为上游改界面而过时的一批浏览器测试（纯 v0.96.1 上一样挂）。
  - `plugin-http-test`、`token-auth-test`：密封、端口不撞之后都过。
- 「上游修好了就删」的两个补丁在纯 v0.96.1 上用它们自己的单测复查过，都还挂：`terminal-view.test.ts`
  （11 项挂，`tm.note is not a function` 等）、`mute-mcp-restart-nag.test.ts`（3 项挂，重启提示照弹），两个都留着。

## wake-reopen

**状态**：`local`
**基线**：v0.96.1

**问题**（2026-09-27 真实发生）：04:15 装新版重启了 pi-web-ui。重启只重新打开正在干活的对话（carry-on），
temper 那个对话当时闲着，就没被打开。04:22 它定的一次性唤醒到点了：找不到原对话，就按上游 issue #231 的
「视口兜底」投给了同项目（`/home/shinelay`）最近活跃的对话，也就是另一个正在干别的活的对话。那个对话收到一件
不是自己的任务。

E2E 还查出第二条错投的路：任务同时记着对话 id 和转录文件。转录没开着时，`wakeConversation` 接着按 id 找，
而对话 id 每次重启都从 c1 重新数，旧 id 会对上同项目里另一个对话（同 cwd，护栏拦不住），唤醒就进了它。

### 改法

1. **`AgentService.wakeClosedChat(sessionFile, text)`**（新）：原对话没开着但转录还在，就像 carry-on 一样用一个
   伪客户端（`carry-on:wake`）重新打开它、把唤醒发进去（`ClientSession.carryOn`：打开 → 发消息 → 等回合开始 →
   `listed = true` 留在运行列表里），然后让所有窗口刷新对话列表（`pokeExternalRunning`）。一次只开一个（串行链），
   因为那个伪客户端同一时间只有一个当前对话。打不开（转录没了、项目开满了、quiesce）回 `ok:false`，照旧回落。
2. **调度执行器**（`server/index.ts`）：顺序变成：已开着的原对话（按转录）→ **重新打开原对话**（新）→ 同项目
   视口兜底（带「已转到本窗口」提示）→ 无头。重新打开成功时向所有窗口发一条提示，任务跟着换到新的对话 id
   （非单次任务照旧 `rebind`）。原对话正在压缩（`busy`）时不重开（它开着，不能有第二份）。
3. **`wakeConversation` 的 id 相位只在不知道转录时用**（老任务、插件的 `chatFromPlugin` 只给 id）。知道转录时，
   转录就是这个对话是谁；旧 id 可能已指向别的对话，不再按 id 投。转录已被删掉的任务照旧走视口兜底。

### 测试

`tests/wake-reopen-test.mjs`（密封服务器 + 模拟模型，不花 token）：BOUND 定了唤醒，OTHER 之后用过（最近活跃）；
重启，两个都闲着没被打开；触发唤醒：BOUND 被重新打开、收到并回答，OTHER 什么都没收到；开着的窗口收到提示、
列表里出现它，之后新开的窗口也有；任务换到新 id；再触发一次直接进已开着的 BOUND，不重开第二份；转录没了的任务
照旧回落并提示。修之前的构建上跑，7 项挂（唤醒进了 OTHER）。`tests/unit/schedule-agent-tool.test.ts` 加了
`wakeClosedChat` 的空参 / 转录不存在 / quiesce 三种。

**同步上游时**：上游若也改了「原对话不在」的处理（issue #231 那套），先看它是否已经会重开原对话；会的话本补丁可删。
