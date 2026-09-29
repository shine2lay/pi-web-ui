/**
 * Wire-protocol version. Bump whenever a protocol change would make an old
 * browser tab talk to a newer server (or vice versa) in a broken way — the
 * classic symptom is "UI is new, WS handling is old" after an in-place app
 * update before the auto-restart completes.
 *
 * Lives OUTSIDE protocol.ts (which must stay pure types). The frontend keeps
 * its own copy in web/src/protocol-version.ts; scripts/check-protocol-sync.mjs
 * verifies the two never drift.
 */
// 21: chat-window-pagination — 快照只带最新一截消息（messagesStart/questionIndex，
//     load_older/older_messages）。老页面配新服务端会静默只看到 100 条历史。
// 22: per-chat-dialogs — 对话的扩展弹窗随快照走（UiState.dialog），不再发 `dialog` 消息。
//     老页面配新服务端看不到这些弹窗，对话就一直等。
// 23: v0.96.1 同步 —— 上游 20（WS hello 防重放）加上我们的 21/22 正好又是 22，跟基于 v0.94.1 的上一版
//     同号；不再加 1 的话，开着的旧页面连上新服务端不会出「请刷新」横幅。
// 24: lazy-images — 消息里的图片只发占位（url/width/height/bytes），页面滚到才去取。
//     老页面只认 dataUrl，配新服务端图片全都不显示。
// 25: telegram-answers - permission prompts go to every open window, and a window closes only the one
//     whose id was resolved (old pages closed any on any tool_approval_resolved); the Queue tab answers
//     a stuck task with task_queue_answer.
// 26: optimistic-send - `prompt` carries a window-made id and the server answers it with
//     `prompt_ack` (after the snapshot that holds the message, or on any refusal). Old pages
//     never see the ack and would keep a faded "Sending" copy of every message they send.
export const PROTOCOL_VERSION = 26;
