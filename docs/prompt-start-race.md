# prompt-start-race: a second message at the same moment can't break a running turn

Ops #261, reported by Temper (rm-49f5fbd2): Temper #106's chat refused every request with a 400 from
09:30 PDT on 2026-10-19. Patch: `server/prompt-start-guard.ts`, PATCHES.md entry `prompt-start-race`.

## H-PROMPT-RACE-1

- **Wrong (evidence).** In #106's session (`2026-10-19T15-51-38-549Z_01a154dc-…`), pi-queue's
  `queue-report` note was written at once, during a running turn, 4 times (16:18:01, 16:23:32, 16:25:31,
  16:29:09 UTC). Each matches, to the second, a server-log line `[extension] current chat (<runtime> ·
  send_user_message): Agent is already processing a prompt`: the only 4 such lines since the log starts
  (2026-09-12; recounted 4 on 2026-10-19). The last note landed between a bash tool call and its result.
- **Mechanism (SDK 1.0.1, `agent-session.js`).** `prompt()` checks `isStreaming`, then awaits input
  handlers, auth, compaction and `before_agent_start` before `_runAgentPrompt` marks the run active. A second
  start in that gap also passes the check; its `agent.prompt()` throws "already processing a prompt"; its
  `finally` sets `_isAgentRunActive = false` and emits `agent_settled` while the first run goes on. For the
  rest of that run the chat looks idle: senders that test `ctx.isIdle()` send without `deliverAs` and are
  refused the same way (lost), and no-turn notes are no longer held in `_pendingCustomMessages` to the end of
  the turn, so one can land between a tool call and its result (the 400 for good).
- **Change.** Per session, one prompt start at a time: a start that arrives while another is under way, or
  with a run going, becomes a follow-up of that run; a start that still reaches the run step while a run is
  active is queued as a follow-up (backstop), so a refused start never clears the flag or settles a live run.
- **Expected.** The sealed repro fails before and passes after (both messages delivered in order,
  `isStreaming` true until the real end, the note after the tool result, no "already processing" error).
  Live, 2 h after install: zero such log lines and zero notes between a tool call and its later result.
- **Disproof.** The repro passes on the old code, or after the fix the second message is still lost or the
  flag still drops.

## What happened in #106's chat (structure only)

Session entry types, customTypes and pi-queue's own queue ops, plus the server log; no message text or
tool results were read.

| UTC | entry | what it is |
| --- | --- | --- |
| 16:18:00.475 | queue `release` #106 | the owner's token pause lifted (bp-60e8f2dd); the queue gives the task its lane back |
| 16:18:00.761 | user message | pi-queue's "back to work" wake (sent without `deliverAs`: the chat was idle) starts run A |
| 16:18:00-01 | (refused, no entry) | a second pi-queue send that found the chat idle in A's start gap; refused, its `finally` settles A |
| 16:18:01.489 | queue `ask` n=1, lead temper | pi-queue's settle handler read that false settle as a failed run and asked the lead |
| 16:18:01.870 | `queue-report` (asking) | written at once: the chat looked idle |
| 16:18:02 | log "already processing" | the refused start's error, logged after its settle work |
| 16:23:31.782 | queue `resume` answered=1 by temper | Temper's answer, sent without `deliverAs` (chat looked idle), refused: lost |
| 16:23:32.077 / .154 | `ask` n=2, `queue-report` | the same false settle again |
| 16:25:31.092 / .323 / .377 | `resume` answered=2, `ask` n=3, `queue-report` | again: answer lost |
| 16:29:08.649 / 09.297 / 09.427 | `resume` answered=3, `ask` n=4, `queue-report` | again; this note landed between a bash call and its result: every later request refused (400) |

Who sent the second start at 16:18: pi-queue in #106's own chat. The lane came back (`release`, then
`/queue back`), which sends the wake; a second pi-queue send followed within the second (the release
schedules its checks 1 s later, `scheduleChecks(ctx, 1000)`). Which of the two was refused can't be told
from structure alone (the refused one leaves no entry, and reading the user message's text is off limits).
It doesn't change the fix: any two starts in the same gap race, whoever sends them. The three later
"already processing" lines are Temper's three lead answers (`resume answered=1..3`), each lost because the
first false settle left the chat looking idle; each of them caused the next false settle.

## Scan of sessions changed in the last 30 days

Notes (`custom_message` entries) written between an assistant tool call and that call's later result,
2026-10-19, 715 session files (role folders left out):

- #106's session: 1 (16:29:09 `queue-report`); the only one since SDK 1.0.1 was installed (2026-10-03).
- 9 older ones, all in September (SDK before 1.0): 3 sessions, kinds `file`, `parallel-work-reminder`,
  `manual-retry`; a different mechanism, and those chats went on working afterwards.

So nothing else to heal; #106 is being closed by Temper.

## Upstream

`@earendil-works/pi-coding-agent` 1.2.0 (2026-10-12, PR #10739) fixes the same race at the source: the
session counts as busy from the moment a run starts (`_startRun` sets `_isAgentRunActive` before
`before_agent_start`), so `ctx.isIdle()` is false while starting, `pi.sendMessage()` queues into the starting
run, `pi.sendUserMessage()` needs `deliverAs`, and a Stop meanwhile aborts the run once it exists. 1.3.0 is
the newest (2026-10-15). No SDK upgrade in this task. The guard gives the same outcome for our senders from
outside the SDK (a racing start waits for the start before it and then follows the run) and is dropped with
the upgrade to 1.2.0 or later: the canary test ("the SDK alone still has the race") then fails, which is the
signal. Differences until then: `ctx.isIdle()` still reads true during a start's gap (the guard makes that
harmless), and an extension send without `deliverAs` during a run becomes a follow-up instead of failing.

## Test (sealed, faux model, no real chat)

`tests/unit/prompt-start-race.test.ts`, real SDK session with an inline extension:

- the #106 race: two `pi.sendUserMessage` back to back on an idle chat, then a `triggerTurn:false` note
  while the first run's tool runs;
- a `triggerTurn` message racing an extension start; three queued sends in order; the backstop;
- kept behaviour: idle single prompt, UI steer and followUp while streaming, extension send mid-run,
  Stop mid-run (flag held to the real end), nextTurn aside, installing twice;
- canary: without the guard the race still happens; the SDK internals the guard leans on are there.

**Before** (guard a no-op on today's code, 2026-10-19): the race test failed (1 "already processing");
the canary passed, showing all three failures on the SDK alone: the second message refused and never sent
to the model, `isStreaming` false mid-run, the note before the tool result. The triggerTurn race hung
(5 s timeout); the three-sends test lost two messages.
**After**: 12 of 12 pass, three runs in a row.

## Result

Pending the live check (2 h after install).
