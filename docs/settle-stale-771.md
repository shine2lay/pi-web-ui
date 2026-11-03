# Stale ctx at settle: why a chat's session is replaced mid-turn (Ops #771)

**Status**: fix landed for cause BS (queue close); causes R and TE reported, not changed here.
**Result**: H-SETTLE-STALE-1 pending (24-hour passive count after the install).

## What was seen

Since at least 2026-10-31 the journal (`journalctl --user -u pi-web-ui.service`) has carried many
`[extension] <chat> (<extension path> · agent_before_settle): This extension ctx is stale after session
replacement or reload. ...` lines (pi-multi-pass's multi-sub, fast-mode, billion-context-pi, pi-queue's
`agent_settled`), often in the same second as `[extension] current chat (<boundary> · turn_end): turn_end
could not resolve the persisted assistant entry ID`. Ops #769 found one event at 2026-11-03 04:41:11 PST.

The SDK prints the stale error when a handler uses a ctx whose runner was invalidated: the conversation's
`AgentSession` was disposed (`runtime.dispose()` invalidates its extension runner) while its agent loop was
still going. The loop then finishes on the disposed session: its last stream is aborted and never saved
(the unresolved `turn_end`), and every settle hook meets a stale ctx.

Method: only the app's own state (journal lines, server and SDK code, and session-file entry types, ids
and timestamps); no model requests, prompts, tool lists or tool results. Scripts (metadata only):
`/home/shinelay/kept-from-tmp/2026-11-03/771/` `settle-stale-count.py` (per-day counts, restart-time vs
mid-run, events by pid + second + chat), `event-context.py`, `silent-at.py`, `session-tail.py`,
`close-before.py`; baseline `baseline.json`.

## Three causes

### R: restarts (about 97% of the lines)

A pi-web-deploy restart disposes every open conversation in the old process (`ClientSession.dispose` ->
`conv.runtime.dispose()`), without stopping the runs first. Each chat running at that moment leaves one
set: multi-sub `agent_before_settle` x3, fast-mode `agent_before_settle` + `agent_settled`, pi-queue
`agent_settled`, billion-context-pi `agent_settled`, one unresolved `turn_end`. Lines counted within 120 s
after a systemd `Stopping` line (44 restarts from 10-31 to 11-03 07:00).

Settle work is not lost in practice: the new process carries the cut-off chats on (`[carry-on]`), and
pi-queue rebuilds its state from the transcript. Example: 11-03 05:35:22 burst from the old process, then
`[carry-on] restarted (Show&Tell plugin 4fff6cf): carrying on 26 chat(s): ...` and
`[carry-on] carried on: "Ops lead", ...` in the new one. Not changed here (the process is going away;
stopping 26 runs first would only change which lines it prints).

### BS: the queue closes a finished task's chat while it still works (6 events)

pi-queue calls `closeChat` when a task is done (`starting.ts`: `if (after.status === "done" && after.chat)
queueHost()?.closeChat(...)`). The host's `AgentService.queueCloseChat` waited at most 120 s for the chat
to be idle, ignored the timeout, and went on: `releaseQueueChat` -> `removeConversation` disposed the
runtime of a chat still working after `queue_done`. Signature: unresolved `turn_end`, multi-sub
`agent_before_settle` x3, fast-mode `agent_before_settle` + `agent_settled`, pi-queue and
billion-context-pi `agent_settled`; no `context` line.

Each event comes 120.3-121.8 s after the task's `done` op, while the task chat was still running tools
(times UTC; files under `~/.pi/agent/sessions/--home-shinelay-rollcall--/`):

| Event | Chat file | Done op | Still working until |
| --- | --- | --- | --- |
| 2026-10-31T11:09:02Z | `2026-10-31T09-06-28-695Z_01a19135-dcd7-72ed-a910-b0fe68bbead7.jsonl` | L198 op=done id=363, T-121.4 s | L205 toolResult 11:08:51 (last line) |
| 2026-10-31T12:29:49Z | `2026-10-31T11-49-07-636Z_01a191ca-c5b4-72ed-a910-b14afc2b02c8.jsonl` | L203 op=done id=372, T-120.5 s | L211 12:28:33 (last line) |
| 2026-11-01T13:11:25Z | `2026-11-01T10-33-12-807Z_01a196ab-a166-7020-b395-ccc5d715012d.jsonl` | L535 op=done id=404, T-120.4 s | L547 toolResult 13:11:12 (last line) |
| 2026-11-01T15:12:40Z | `2026-11-01T11-42-11-577Z_01a196ea-c879-76f3-a924-a9c00ec43499.jsonl` | L707 op=done id=419, T-121.8 s | L712 toolUse 15:12:37 (last line) |
| 2026-11-01T15:13:25Z | `2026-11-01T12-15-23-489Z_01a19709-2d61-7405-bd48-dc49b22a4dc7.jsonl` | L571 op=done id=409, T-121.8 s | L583 toolResult 15:13:14 |
| 2026-11-03T12:41:11Z (the #769 event, 04:41:11 PST) | `2026-11-03T11-14-30-887Z_01a1a11e-2967-77b5-a4d6-9ea6b517f964.jsonl` | L425 op=done id=237, T-120.3 s | L437 toolResult 12:40:48 (last line) |

What was lost: the rest of that worker's run after `queue_done` (its final reply, any steps after it)
and its settle hooks. The task was already recorded done, so no queue state was lost and no chat was
left stopped that should have run.

### TE: the tool watchdog's force reset (7 events)

A tool that hangs past the tool watchdog's limit (20 min) gets `interruptRun(conv, "Tool timed out")`:
`session.abort()`, and when the run doesn't end in time, `forceResetConversation` disposes the stuck
runtime, writes a synthetic tool result into the file (`healDanglingToolCallFile`) and reopens the chat.
When the hung tool returns later, the abandoned loop runs one more turn on the disposed session.
Signature: multi-sub `turn_end` x3 + pi-tldr `turn_end`, `context` stale, unresolved `turn_end`,
`agent_settled` stale; no `agent_before_settle` (the abort flag is already set).

Evidence (toolUse -> synthetic tool result, entry id `synthetic-tool-result-*`, about 20 min later ->
event; UTC):

- `~/.pi/agent/sessions/--home-shinelay--/2026-10-31T08-41-19-654Z_01a1911e-d626-72ed-a910-b0f1897175e0.jsonl`:
  L388 toolUse 09:43:07.917 -> L389 synthetic 10:03:23.013 -> event 10:04:28; L517 10:37:23.409 -> L518
  10:57:39.478 -> event 10:58:12; L559 11:43:35.734 -> L560 12:03:56.294 -> event 12:07:06 (all 10-31).
- `~/.pi/agent/sessions/--home-shinelay--/2026-09-15T00-13-53-291Z_01a0a269-bb0b-7511-9cb4-259256821268.jsonl`:
  synthetic results L94960 (11-02 01:55:16) -> event 02:10:43; L96309 (17:43:06) -> event 18:18:11.
- `~/.pi/agent/sessions/--home-shinelay--/2026-11-02T00-39-27-431Z_01a199b2-63c7-72d7-9454-6afd5445c069.jsonl`:
  L374 toolUse 05:52:01.420 -> L375 synthetic 06:12:16.548 -> event 06:22:37 (11-02).
- `~/.pi/agent/sessions/--home-shinelay-rollcall--/2026-10-03T01-51-47-351Z_01a0ff75-d497-7177-a004-7467457b7d10.jsonl`:
  synthetic results L61572-L61573 (11-03 12:48:13.538) -> event 12:51:21 (04:51:21 PST).

What was lost: nothing beyond what the force reset drops by design (the hung tool's result). Every one
of these chats got its next message afterwards (the force reset reopens the chat; the next `user` or
queue entry follows), so none was left stopped. A fix belongs with the tools that ignore the abort, or
the SDK (an abandoned loop should not run another turn on a disposed session): not changed here.

## Settle-time work

- multi-sub's settle continuations (`returnContinuation.settle`, `refusalFallback.retry`,
  `signInContinuation.settle` in pi-multi-pass `extensions/multi-sub.ts`) act only after their
  `turn_end` observer saw a refused, limited or failed sign-in reply. For all 13 BS and TE events, the
  chat's entries in the 25 minutes before the event hold no `assistant/error` or `assistant/aborted`
  reply except one at 12:06:11 on 10-31 in chat 01a191ca, followed by 20 minutes of normal turns. So none
  was armed: no continuation was lost. No multi-sub fallback, refusal or sign-in line appears in the
  journal within 3 minutes of any of the 13 events.
- pi-queue's `agent_settled` (`events.ts`) retries recalled cards, updates the work index and, for a
  task's chat whose task is still `working`, sends a reminder or a question. In BS the task was already
  done, so only the work-index update was skipped (the next turn anywhere does it). In R, carry-on runs
  the chats again. In TE the force reset's reopened chat got its next message each time.

## H-SETTLE-STALE-1 (written before the change)

- **What is wrong**: `queueCloseChat` closes a finished task's chat after at most 2 minutes even when
  it is still working, which disposes its session mid-turn (BS: 6 events, 10-31 to 11-03 07:00).
- **The change**: wait for the chat to be idle however long that takes, looking the chat's session up
  again on every look (a session a force reset replaced doesn't hold it open; a chat no longer open ends
  the wait). No deadline (a hung tool is ended by the tool watchdog anyway).
- **Expected**: in the 24 hours after the install, no mid-run BS-signature event (a multi-sub
  `agent_before_settle` stale line outside a restart window from a task chat closed after its `done`
  op); before: 6 in about 3.3 days. R and TE lines unchanged (they track restarts and hung tools).
- **Measured by**: `settle-stale-count.py` with the same query over the 24 hours after the install,
  mid-run events with multi-sub `agent_before_settle` lines, each checked with `close-before.py`; and
  finished task chats still leave the running list (`queue-done-hidden` tests; Queue tab).
- **Proved wrong by**: any mid-run BS-signature event in that window whose chat had a `done` op 2
  minutes before, or a finished task chat that stays in the running list after its run ended.

## The fix

`server/agent-service.ts` `queueCloseChat`: `await waitUntil(() => { const session =
this.queueSessionFor(file); return !session || (!session.isStreaming && !session.isCompacting); },
Number.POSITIVE_INFINITY, 500)`. Test: `tests/unit/queue-done-hidden.test.ts`, "keeps waiting while the
chat still works after two minutes, and never closes it mid-run" and "looks at the chat's current
session while it waits: a replaced one doesn't keep it open"; on the old code both fail (`expected true
to be undefined`, `expected undefined to be true`), on the new code 11 of 11 pass. PATCHES.md:
queue-done-hidden, change 6.

## Undo

Revert the commit and pi-web-deploy it; nothing is stored.
