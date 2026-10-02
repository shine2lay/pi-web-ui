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
// 27: fast-mode - the snapshot carries the chat's Fast button (UiState.fastMode) and pages send
//     `set_fast_mode`. Old pages never show the button; an old server would drop the toggle.
// 28: no-plan-board - the Task Plan Board and the AI's tool that filled it are gone: the snapshot
//     no longer carries the board, and the board's messages are gone both ways. An old page would
//     still offer a board whose buttons the server now ignores.
// 29: identities - chat rows and history rows carry the chat's identity (pi-identity), the server
//     pushes `identities`, and pages send set_chat_identity / identities_get / identity_file_get /
//     identity_file_save. An old page shows no labels; an old server would drop the new messages.
// 30: identity-notebook-tab - the right panel's Notebook tab: pages send identity_notebook_watch and
//     the server pushes `identity_notebook` on every change; identity_file_save/_saved carry a ref.
//     An old page shows no tab; an old server would never answer the watch.
// 31: queue-grouping - chat rows carry queueHomeId: an open queued task's chat sits under the queue
//     chat it came from. An old page shows the task chats as rows of their own.
// 32: identity-config - identity rows carry a role's settings (prompt, skills, tool limits, unique,
//     problems, a waiting draft); identity_file_get/_save take "prompt" and "config"; pages send
//     identity_draft_get / _save / _accept / _discard and the server answers identity_draft /
//     identity_draft_done. An old page shows none of it; an old server would drop the new messages.
// 33: identity-config - a role's own skills (from its private folder) leave the identity rows, which
//     only count them (ownSkills); Settings asks for them with identity_skills_get and the server
//     answers identity_skills. An old page would list no own skills; an old server would drop the ask.
// 34: subs-limits-box - subs_limits (every subscription's limits, pushed to every window) answers
//     subs_limits_get / subs_limits_refresh. An old page would show no Limits box; an old server would
//     drop the asks and the box would stay on "Not checked yet".
// 35: identity-notes - identity_notebook carries `memory` (pi-identity's notes index and what rules +
//     index take) and its cap is the rules' (notebookCap minus indexBudget); pages send
//     identity_notes_search / identity_note_get / identity_note_save / identity_note_delete and the
//     server answers identity_notes_found / identity_note / identity_note_saved. An old page shows no
//     notes; an old server would drop the asks.
// 36: per-chat speed — explicit Standard/Fast/Ultrafast and conversation-fenced changes.
// 37: owner-only per-queue Auto approve / Auto start, session-fenced settings.
export const PROTOCOL_VERSION = 37;
