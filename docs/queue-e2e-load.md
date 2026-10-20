# queue-e2e-load: the queue's browser tests on a busy machine

Ops #276 (essential maintenance of Ops' own tools; lead Ops; asked for by Ops #275, rm-f4fecfd2). PATCHES.md
entry `queue-e2e-load`.

## What failed

Ops #275 ran the same code twice (mine 05129317 with pi-queue 8e532de): sealed run
`pi-sealed-2026-10-20T04-45-21-600Z` passed 9 of 9, the rerun `pi-sealed-2026-10-20T04-47-58-853Z`
(`--no-build`, load average about 22 on 20 cores during a pi-web-deploy install) passed 7 of 9:

1. `tests/queue-panel-test.mjs`: "A: done cues for #2's chat and the queue's chat's turn, none for #1's asking
   chat (2), one start tick (that turn)" (window A got one done cue, window B the expected two), and "the mock
   got no unscripted messages (no reminders, no continues) — queue chat: a user message".
2. `tests/queue-main-chat-test.mjs`, at "#5: the owner stops the task's run": "[mc-window-b] state never
   matched" (window B never showed #5's chat with its run going, 15 s).
3. `tests/per-chat-dialogs-test.mjs` (in #275's run before its fix only): "chat A shows up in the list" (10 s).

## How they were run

The plan's condition: each test alone on two cores, so only its own server, browser and mock compete there:
`taskset -c 0-1 node tests/run-sealed.mjs --no-build --jobs=1 <test>`, and the same on CPUs 2-3 at the same
time (two suites at most). The runs start from a `systemd-run --user --scope`, outside pi-web-ui's service, so
the sealed runner runs in place and keeps the pinning (inside the service it relaunches itself in a unit of
its own).

Pinning alone doesn't make the cores busy. With other chats' work on the machine (load 12-41, which also
runs on CPUs 0-3) the tests failed; on a quiet machine (load 12 falling to 5) the same pinned runs passed 4 of
4. To get a busy machine on demand without loading it, the pinned scope also gets a CPU quota
(`systemd-run --user --scope -p CPUQuota=N%`): only the test's own server, browser and mock slow down, and
nothing else on the machine does. No CPU burners.

## Before

Branch `queue-e2e-load` = mine 1d7076a6 (#275 landed), pi-queue 8e532de. 5 pinned runs of each test,
22:21-22:31, machine load 12-41 from other chats' work. Run folders `/tmp/qel/before/{a-1,a-2,a-3,b-1,b-2}`.

| Test | Passed | Failing checks |
| --- | --- | --- |
| per-chat-dialogs | 2 of 5 | a-1, b-1: only "chat A shows up in the list"; a-2: that check and 10 after it (chat "B" showed A's pop-up, B's row never appeared, `locator.click` timeout at line 435) |
| queue-main-chat | 3 of 5 | a-1: "[mc-window-b] state never matched"; b-1: "the model saw no message it had no script for — queue chat: a queue message" |
| queue-panel | 3 of 5 | a-1: "dialog 1 shows the plan" and "no approval dialog"; b-1: "the mock got no unscripted messages … — queue chat: a user message" |

The cue check of failure 1 passed in all 4 runs that reached it.

Timings on a quiet machine (4 pinned runs, 22:40-22:43, details added to the checks): A's first request reached
the mock 2.3-4.3 s after the send and A's row showed 0.2-0.5 s after that; queue-panel's planning request
reached the mock 2.1-3.0 s after the send and dialog 1 showed about 0.8 s after that. With the pinned scope at
CPUQuota=60%: A's first request after 7.5 s (row after 8.4 s, the check allows 10 s); queue-panel's planning
request after 5.7 s, and the queue-panel run failed with "queue chat: a user message" (server log: "[pi-queue]
woke the queue's chat about finished tasks #2, #1").

At CPUQuota=40% (CPUs 0-1) and 30% (CPUs 2-3), one run each (`/tmp/qel/stress/{a40-1,b30-1}`), every test
failed:

| Test | 40% | 30% |
| --- | --- | --- |
| per-chat-dialogs | "chat A shows up in the list" (A's run not started after 11.7 s), then a-2's cascade | "chat A shows up in the list" (not started after 12.3 s), then `locator.evaluate` timeout |
| queue-main-chat | "[mc-window-a] state never matched (… last messages: ready)": window A's first state, 20 s | "[mc-window-b] state never matched (… last messages: switch_failed …); #5's file undefined, #5 working" |
| queue-panel | "dialog 1 shows the plan" (planning run not started after 32.9 s) | the same (not started after 31.4 s) |

## H-QEL-WAKE: the unscripted message is wake on done

- **Wrong (evidence).** queue-panel failed with "the mock got no unscripted messages … — queue chat: a user
  message" in #275's rerun, before-run b-1 and the CPUQuota=60% run; each time its server log ends with
  "[pi-queue] woke the queue's chat about finished tasks #2, #1". queue-main-chat failed with "the model saw
  no message it had no script for — queue chat: a queue message" in before-run b-1 (its server log isn't
  kept without `QMC_DEBUG`). pi-queue's wake on done sends the queue's chat a user message 30 s after a task
  finished in its own chat (`WAKE_SETTLE_MS`, pi-queue queue.ts), once per task, several tasks together in
  one message ("[Queue] 2 tasks are done in their chats: …"). Quiet runs finish within those 30 s; slowed
  down they don't, and the wake arrives. Neither mock has a script for it. One wake naming #2 and #1 once is
  the designed behaviour (pi-queue `tests/wake-on-done.test.ts`), not a second delivery.
- **Change.** queue-panel and queue-main-chat turn wake on done off in their own agent folder's
  `pi-queue.json` (`"wakeOnDone": false`), with a comment saying why.
- **Why it should work.** The wake is the only queue message on a timer these tests don't script; with it
  off, nothing reaches the queue's chat that the test didn't cause. Wake on done keeps its own tests in
  pi-queue, and its look in pi-web-ui in `tests/quiet-turns-test.mjs`.
- **Expected, and how it's measured.** No unscripted message in 5 slowed-down pinned runs of each test, where
  the before code fails that way; no "woke the queue's chat" line in their server logs.
- **Disproved if.** An unscripted message still reaches the queue's chat with the wake off (then it is
  something else), or a server log shows two wakes for the same task (then it is an app bug, fixed in
  pi-queue instead).

## H-QEL-START: the first run's start is slow, and the checks give it a fixed time

- **Wrong (evidence).** A fresh server's first message reaches the model 2-4 s after the send on a quiet
  machine, 7.5 s at CPUQuota=60%, and more than 10 s in before-runs a-1, b-1 and a-2 of per-chat-dialogs
  ("chat A shows up in the list" failed while A's later checks passed, so A did show up, later). The row
  shows 0.2-0.5 s after the run starts: the wait is the run's start, not the list. queue-panel's first
  dialog has the same shape (planning request 2-3 s quiet, 5.7 s at 60%, over 20 s in before-run a-1).
  per-chat-dialogs also gives A fixed time: A's mock waits 4 s (`A_DELAY`) before it asks, and the test
  must open chat B inside those 4 s.
- **Change.** The checks wait for the real event instead of a fixed time: the test waits until the mock has
  the chat's first request (the run has started; 90 s at most, for a hang) and only then runs the check with
  its old wait. In per-chat-dialogs A's mock holds A's first request until the test has opened chat B,
  instead of sleeping 4 s.
- **Why it should work.** How long a run takes to start depends on the machine; how fast the row and the
  dialog follow the start is what the checks are about, and that stays under a second slowed down.
- **Same shape: a window's first state.** queue-main-chat's first window waits 20 s for its first state. The
  server says "ready" before it starts the window's session, on purpose (issue #295: that start can take tens
  of seconds, and the app shows "Session init is taking a while"); the state follows the start. At 40% it
  took more than 20 s. Change: that wait keeps its condition and gets 90 s, for a hang only.
- **Expected, and how it's measured.** "chat A shows up in the list", "a new chat (B) is open before A asks"
  and "dialog 1 shows the plan" pass in 5 slowed-down pinned runs of each test, where the before code fails
  them; each check's detail shows the time from the run's start to the row or dialog.
- **Disproved if.** The row or the dialog still misses its wait after the run has started (then the delay is
  in the app after the start, not in the start).

## H-QEL-B5: #5's chat isn't known yet when the test opens it

- **Wrong (evidence).** queue-main-chat failed at "#5: the owner stops the task's run" with "[mc-window-b]
  state never matched" in #275's rerun and before-run a-1. With the state in the message (30% run): window B
  got `switch_failed`, and the test had read #5's chat file as `undefined` while #5 was working. The check
  before ("#5's run is going") waits for the mock to get #5's first request and #5 to be working, then reads
  `task(5).chat.file` without waiting for it. pi-queue saves the start (working) first and the chat's file
  only once `startChat` returns, after the run has started (pi-queue index.ts ~1064 and ~1108; pi-web-ui
  `openTaskChat` returns once the session streams). Window A gets that second update a moment later, and on
  a busy machine later than the test reads it.
- **Change.** "#5's run is going" also waits for `task(5).chat.file`.
- **Why it should work.** The test then opens the chat it means to; the order of the two updates is pi-queue's
  design (a task shows working while its chat starts), not a fault.
- **Expected, and how it's measured.** No "state never matched" at #5 in 5 slowed-down pinned runs.
- **Disproved if.** Window B still fails with #5's file known (then the switch itself is at fault).

## H-QEL-ASKWAIT: the ask-wait checks time pi-queue by when window A sees it (found in the after runs)

- **Wrong (evidence).** After-run a-3 (40%) failed queue-main-chat's "#4 asks; the main chat's turn is still
  going when the wait is over" at "... not before the wait, and while the main chat's turn still went on —
  4901 ms, turn ended: false": from window A first showing #4 asking to window A first showing it stuck,
  4.9 s, where the check wants at least 5.5 s (the wait is 6 s). It passed in the other 4 after runs and in
  the 6 before runs that reached it. pi-queue can't have moved it early: its timer moves a question on only
  once `askDue` = the ask's time + the wait has passed (pi-queue index.ts `lookAtAsks`), and the queue's copy
  of the ask keeps the task's own time (queue.ts `syncOps`: "The main chat's time counts from the task's own
  ask"). But the queue's chat, and so window A, hears of the ask only after a `/queue sync` round trip from
  the task's chat (index.ts ~1820). So window A saw the ask at least 1.1 s late, and the move on time: the
  check measured the window's delays, not pi-queue's wait. #3's check ("at once when that turn ended, not
  after the wait": under 5 s between the same two sightings) has the same shape, from the other side.
- **Change.** Both checks use pi-queue's own record in the queue's chat's session file: the "ask" op's time
  (the task's own ask) and the first "stuck" op's time after it. #4: at least the wait (6 s, no margin needed),
  and before #4's main-chat turn ended (the mock returned its late answer); #3: before the wait was over (so
  the timer can't have moved it; the question's "ended its turn without answering it" says which path did).
  Each run prints the recorded times and how late window A saw them.
- **Why it should work.** The record holds when pi-queue did each thing; how late a window shows it is a
  matter of the machine's load and doesn't change what the checks are about.
- **Expected, and how it's measured.** queue-main-chat passes 5 of 5 slowed-down (40%) pinned runs; their
  printed times show the recorded gap for #4 at 6 s or more, and window A seeing the ask later than the
  move to the owner at least once.
- **Disproved if.** A recorded gap for #4 is under 6 s (then pi-queue moved it early: an app bug, fixed in
  pi-queue), or the check still fails with the recorded times.

## H-QEL-CUES: window A heard one done cue instead of two (#275's rerun only)

- **Evidence.** "A: done cues for #2's chat and the queue's chat's turn … — start +1, done +1" failed once,
  in #275's rerun, with window B at done +2. It passed in all 4 before runs that reached it and in the 60% run.
  Possible causes, neither seen: the window missed #2's idle state because pi-queue lets go of a done task's
  chat within half a second of its idle (the row leaves the list, and a row that leaves while running rings
  no cue); or both stops fell within the 1.5 s that merge done cues into one sound.
- **Per the plan:** the before runs never failed it, so it is recorded as not reproduced and nothing changes
  for it. The 40% after runs reach this check for the first time under that much load (the before runs at
  40% and 30% stopped at dialog 1); their result is recorded below.

## H-QEL-NEWCHAT: New chat reuses a chat whose first message is on its way (app bug)

- **Wrong (evidence).** In before-run a-2 the test clicked New chat about 10 s after sending A's first
  message, before A's run had started. The window stayed on A's chat: "chat B" showed A's pop-up, B's own
  message went into A's chat, and B never got a row. The server's New chat (`newChatNow`,
  server/agent-service.ts) reuses the window's chat when it is blank, and the blank test
  (`isBlankChat`, server/chat-slots.ts) only looks at saved messages, terminals, queue entries and Team
  participants. A message on its way (pi's add-ons are still in their "before the AI starts" step, so it
  isn't saved yet) counts as a run for closing chats (`running` uses `sendsInFlight`), but not here. The
  owner would see the same: send a first message, click New chat at once, and the message lands in the chat
  he took for a new one.
- **Change.** A chat with a send on its way isn't blank: `BlankFacts` gets `sending`, `isBlankChat` requires
  it false, and the pi engine fills it from `sendsInFlight`.
- **Why it should work.** New chat then opens a new chat, as it already does once the message is saved; the
  chat with the message keeps it.
- **Expected, and how it's measured.** A new step in `tests/optimistic-send-test.mjs` sends a first message
  with the add-ons' start step held, clicks New chat, then lets the message go on: the new chat stays empty
  and the message and its answer are in their own chat once. It fails without the change and passes with it.
  A unit check in `tests/unit/chat-slots.test.ts`.
- **Disproved if.** The new step passes without the change (then a-2 had another cause).

## After

The changes above, on the same branch; dist built with the app fix. Each test alone, pinned to two cores and
slowed down to 40% (`taskset -c 0-1` / `2-3`, `CPUQuota=40%`, `--jobs=1`): the condition under which the
before code failed all three. Run folders `/tmp/qel/after/{a-1,a-2,a-3,b-1,b-2}` (23:08-23:20, machine load
4-12) and, for queue-main-chat with H-QEL-ASKWAIT's change, `/tmp/qel/after2/{a-1,a-2,a-3,b-1,b-2}`
(23:23-23:27).

| Test | Pinned at 40% | Normal run | Measured |
| --- | --- | --- | --- |
| per-chat-dialogs | 5 of 5 | passed | A's run started 8.3-13.3 s after the send (quiet: 2.6 s), A's row 1.1-2.5 s after that; the old 10 s check would have failed at least 4 of the 5 |
| queue-panel | 5 of 5 | passed | the planning run started 8.2-25.2 s after the send (quiet: 2.7 s), dialog 1 1.9-3.8 s after that; the old 20 s check would have failed 3 of the 5; no unscripted message; cues start +1, done +2 in both windows every time |
| queue-main-chat | 4 of 5, then 5 of 5 with H-QEL-ASKWAIT's change | passed (both) | no "state never matched", no unscripted message; #4's question went to the owner 6003-6004 ms after the task asked, by pi-queue's record; window A saw the ask 103-183 ms late and the move 5-8 ms late |

The normal runs: `node tests/run-sealed.mjs --no-build` from a scope outside pi-web-ui's service, not pinned
(`/tmp/qel/after/n-1`, all three side by side, 35 s; `/tmp/qel/after2/n-1`, queue-main-chat, 33 s).

The app fix: `tests/unit/chat-slots.test.ts` failed without the change ("a sending chat isn't blank") and passed
with it; `tests/optimistic-send-test.mjs` failed only its new step 8b without the change ("New chat shows
nothing of it — [1,0]", then "…and the new chat still shows nothing of it — [0,1]": the message landed
in the chat New chat left open) and passed all of it with the change, beside `conv-cwd-test` and
`chat-slots-test` (`/tmp/qel/proof/{nofix-1,fix-1}`).

## Results

- **H-QEL-WAKE: HIT.** No unscripted message in 10 pinned runs at 40% and 2 normal runs, where the before code
  had it in 3 runs (2 of them at the plan's condition).
- **H-QEL-START: HIT.** The row and dialog 1 followed the run's start within 1.1-3.8 s every time, while the
  start itself took up to 25 s; all such checks passed.
- **H-QEL-B5: HIT.** No "state never matched" at #5 in 10 pinned runs at 40%; before, 1 of 5 at the plan's
  condition and the 30% run.
- **H-QEL-ASKWAIT: HIT.** By pi-queue's record #4 always moved on at 6.0 s, never early; window A always saw
  the ask later than the move (103-183 ms against 5-8 ms; in a-3, over 1.1 s later, which made 6 s look like
  4.9 s). 5 of 5 pinned at 40% with the change.
- **H-QEL-CUES: not reproduced, nothing changed.** It passed in all 4 before runs that reached it, the 60% run,
  the 5 after runs at 40% and the normal run: 11 of 11. If it comes back, its own task looks at the two
  possible causes above.
- **H-QEL-NEWCHAT: HIT.** The new step and the unit check fail without the change and pass with it; the
  per-chat-dialogs cascade (a-2) didn't come back.
- **Each test passes 5 of 5 pinned:** per-chat-dialogs and queue-panel in `/tmp/qel/after`, queue-main-chat
  in `/tmp/qel/after2`, all at 40%, harder than the plan's pinned-only condition.
