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
export const PROTOCOL_VERSION = 22;
