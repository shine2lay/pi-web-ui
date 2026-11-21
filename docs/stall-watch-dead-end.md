# stall-watch: the dead-end rule

Part of [stall-watch.md](stall-watch.md) (what the watch is, its rules, how to switch it off, and its parts).

## Dead end (Ops #483, AGENTS.md rule 30)

Owner order bp-36910028 (Oct 23, "Everything is stalled again... how come the pokes are not doing its job?";
"Ok do both"). Accountable lead: Ops. No model anywhere (rule 17).

### H-DEADEND-1 (written before the code)

- **What's wrong, with evidence.** Work kept stopping at "MISSING / dropped, no successor": a lead dropped a task
  or got a negative blocker reply, its turn ended with nothing queued, and the project sat. The empty rule waits
  2 h, and both older rules count a blocked task as open, so a project whose only task is blocked on a need
  text never looks empty, and the silent rule takes 24 h.
- **The change.** One test, `deadEndOf` in server/dead-end.ts, used by the stall watch's new `dead-end` rule and
  by pi-queue's drop and reply results (through the queue host's `deadEnd`). A dead end is found at once and
  wakes the project's lead in the same round; it holds until a way out is taken.
- **Expected result.** Every dead-ended project gets a fix task, a link or an owner question within one wake;
  no moving project is flagged. On fixed fixtures (tests/unit/dead-end.test.ts, the dead-end cases in
  tests/unit/stall-watch.test.ts and stall-wake.test.ts), 100% of must-catch cases fire and 0 of must-pass ones,
  the same on two runs.
- **What would prove it wrong.** A dead-ended project sits a full wake cycle with no action, or a moving
  project is flagged.

### The test

A project is dead-ended when it is active, its wait doesn't hold, it has at least one linked task, and none
of these moves it:

- A task of it (in any queue) at work, waiting on a `queue_wait` check, or with its question at its lead
  (`asking`).
- A ready task that could start now: no open `after`, or an `after` on an open task outside the project (a
  link). A ready task only after its own project's tasks doesn't count.
- A blocked task linked to an open task in another queue (`queue_blocked` `on`); a task not in the registry
  counts as open. A task blocked only on a need text, or only on its own project's tasks, doesn't count.
- A blocked task its queue has let go (`block.poke`: a lead's answer, or what it waited on is over): it comes
  back to work next.
- A question with the owner: a task waiting on him (stuck, or the page's `needsYou`), or an open owner ask on the
  Roles page (a TL;DR or dialog question that isn't a task's) naming the project or its initiative (its id as a
  whole word, or its whole name, any case).

Quiet, as for the other rules: not active, a wait that holds, no task linked yet, its last task done (the empty
rule gives the usual 2 h), or every open task paused by the owner or in a stopped queue.

The stretch starts at the newest block, closing or link among its tasks (a block's own start, not its
reminders), or the end of a wait. It is checked before the empty and silent rules, so one project gets one
finding. Replies, TL;DR lines and the lead's own messages don't end it: only a way out does (the fix task
queued under the project, a link, an owner question, a wait, or closing the project).

### Waking, and what the lead sees

- Step 1 (the project's lead) goes in the same round it is found (no 2 h wait); the next steps (initiative
  lead, then the owner through COO) follow the usual chain, `gapHours` apart, with the same caps, owner pauses,
  disabled wakes and quiet hours as the other rules. Nothing more is sent past the chain; it stays on the page.
- The wake's item reads "nothing moving since <when>: no task at work or ready, none linked to another queue's
  task, no question with the owner", then "To clear it: <the ways out> Answering this message doesn't clear it."
  Its hint (`STALL_DEAD_END_HINT`) folds on the page like the others. A reply to it is refused with the ways out.
- The Initiatives page shows "Nothing moving" on the project while the test still holds on the live page.
- pi-queue: `queue_control` `drop`, and a lead's `queue_reply` `checkpoint` (the task stays blocked), ask the
  queue host's `deadEnd` with the task at its new status (the registry may not have it yet) and, when the
  project is dead-ended, end the result with "Project <name> has nothing moving now (rule 30): <why>. Before
  this turn ends, take a way out: ...". 5 s at most; no answer, nothing more said.
- Nothing queues, drops, approves, restarts or asks the owner by itself: the code only tells and wakes.
