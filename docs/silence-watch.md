# silence watch: wake a lead whose chat has gone quiet on a waiting task (Q-STALL-1)

Ops #1058 (step 1 of 2; step 2 is Ops #1059), owner Shine 2026-11-21: queue hardening proposal approved
(Show&Tell d_x5rdobqnby, record dr-d99bc6d69ea1), part B+ at 60 minutes. Contract: Architecture rm-71a63c5b
(Q-STALL-1 in `~/architecture-dept/conventions/queue-resilience.md`). The stall watch itself is in
[stall-watch.md](stall-watch.md); its whole-list read in [stall-watch-whole-list.md](stall-watch-whole-list.md).

## The rule (what)

A task that is asking or blocked, has waited X = 60 minutes, whose deciding chat has had no turn since the
wait began, and for which no reminder, checkpoint or climb is still due, gets one wake to the deciding lead;
after X more minutes with still no turn there, one wake to COO. A watch only: it never stops, pauses or
limits work. A watch that cannot read its whole input alarms within one round and never reports from a
partial list.

## H-SILENCE-1 (written before the build)

- **What's wrong, with evidence.** On 2026-11-20/21 backend #218 waited on its lead for hours while the
  queue's own reminders didn't reach the backend lead chat; question 19 (asked 05:34:01Z) was first woken at
  09:02Z. The 7-day replay of ops #1054 (`~/ops-checks/queue-hardening/replay_stalls.py`, window 2026-11-14
  09:12Z to 11-21 09:12Z) finds, at X = 60 with "no turn since it started waiting", 13 waits: 5 real (no other
  nudge due) and 8 covered, all blocks: 3 on another task (frontend #294, backend #210, backend #216), 1 before
  its checkpoint (ops #1014), 4 need-only (frontend #356, four times).
- **The change.** One pure function over the waits the queue mirror already holds and the home-chat turn
  times: a lead wake at start + 60 for a silent, uncovered wait; one COO wake 60 minutes after the lead wake
  if the chat is still silent. Sent through the stall watch's wake route and ledger, within its limits.
- **Expected result.** Over the frozen 7 days: exactly 5 lead wakes, all real, 0 for a covered wait:
  product #86 (11-15 13:02Z), product #91 (11-15 21:17Z), ops #979 waiting on RollCall past its checkpoint
  (11-17 08:26Z), backend #218 question 17 (11-20 14:13Z) and question 19 (11-21 06:34Z, 2 h 28 min before
  the wake it actually got). Measured by S12 (replay parity) and S1-S6.
- **What would prove it wrong.** Replay parity not exact (a wake more or fewer than the five, or at another
  minute), or any covered class woken.

## How (what the watch reads)

- **Waits.** Every task asking or blocked, from the one registry reader (`server/work-registry-reader.ts`) and
  the one queue mirror (`server/task-queue-replay.ts`, `server/task-queue-apply.ts`). A complete read only: on
  an incomplete one the round reports nothing and the whole-list alarm of the stall watch covers it.
- **When a wait began.** A question: `ask.from ?? ask.at` (when it reached the deciding chat). A block:
  `block.start`.
- **Deciding chat.** The home chat of the role that must act: the task's lead for a question; the owing role
  for a block that names one (`block.lead`). A climb to the next lead does not restart or cancel the lead step:
  the lead can still decide a climbed question.
- **A turn.** Any model turn in that home chat after the wait began, from the Roles page's reader of role
  chats (`server/roles-transcripts.ts`, `TranscriptScans`).
- **Covered (no wake).** A block on another task, or a need-only block the queue pokes (covered with no end:
  `nextNudgeAt` = Infinity); an owed block before its rule-16 checkpoint (`nextNudgeAt` = the checkpoint, from
  the mirror as `server/queue-blocks.ts` reads it). After the checkpoint the watch counts its own clock: the
  lead reminders that follow are the queue's timers, the very thing this watch backs up.
- **Questions read no pi-queue timer.** pi-queue's question reminder is due 30 minutes after the ask, so it is
  always past at 60; in the replay no question was ever covered by one. Its climb times live only in pi-queue
  (one shifts with when a card was shown, kept in memory), so reading them would mean a second copy of its
  formula, and the watch would fail together with the timers it backs up. So a question is never covered:
  `nextNudgeAt` is always null.
- **Delivery (step 2).** The stall watch's wake route (`RoleMessages.requestStall`) and ledger
  (`~/.pi-web-ui/stall-watch.jsonl`), under its `mode` (off, dry, on) and within its existing limits. One
  ledger key per wait and step (`silenceWakeKey`), so a restart never wakes twice. Wake text in plain words:
  the task, how long it has waited, and what is owed. Never an owner wake.
- **Known gap.** A question with no lead chat to send it to (pi-queue's parked "absent") is out of scope.

## The seam

`server/silence-watch.ts` (pure; step 1 landed the stubs, step 2 built them):

- `findSilentWaits(waits: SilentWaitInput[], turns: HomeChatTurns, now, { waitMinutes, sent }): SilentWait[]`.
  A wait is `{ task: { queue, id }, role, kind: "question" | "block", start, decidingRole, nextNudgeAt }`;
  a finding is `{ task, role, kind, start, decidingRole, waitedMinutes, step: "lead" | "coo", to }`. The COO
  step is due `waitMinutes` after the lead wake was sent (`sent`, read back from the ledger).
- `silenceRound(read: RegistryRead, waitsOf, turns, now, opts)`: on an incomplete read `{ complete: false,
reason, detail }` and `waitsOf` is never called; on a complete one the findings.
- `silenceWakeKey(wait, step)`, `SILENCE_WAIT_MINUTES` = 60, `SILENCE_COO_ROLE` = "coo".

## Acceptance cases

`tests/unit/silence-watch.test.ts`, in the land gate since step 2 (written outside it by step 1, red on the
stub). The frozen records are `tests/unit/silence-watch/replay-7d.json`
(325 waits, 2,385 turn times; ids, roles, times and states only), built by `build-fixture.py` beside it from the
replay's own episode reader.

- F0: the fixture holds only those fields (green by design).
- S1-S5: the five real waits: no wake a millisecond before start + 60, one lead wake to the deciding role at it.
- S6: one case per covered block class (backend #210 on another task, ops #1014 before its checkpoint,
  frontend #356 need-only): no wake, and the same wait with nothing due does wake; a question: none at + 59,
  one at + 60.
- S7: a turn in the deciding chat after the wait began: no wake (a turn before it doesn't count).
- S8: still silent: lead at + 60, one COO wake at + 120, then nothing more for that wait.
- S9: answered between rounds: no COO wake after it, no lead wake if answered before + 60.
- S10: a restart with the ledger read back: no second lead wake; the COO step still comes once.
- S11: an incomplete read: no finding, `waitsOf` not called; a complete read finds.
- S12: replay parity: rounds at every wait's start + 60 in the window give exactly the five lead wakes.

All but F0 failed on the step-1 stub; each case asserts the wake that made it fail until built.

## Built (step 2)

What was built, the off switch, the live result and H-SILENCE-1's label: [silence-watch-built.md](silence-watch-built.md).
