# stall-watch: H-STALL-1 and the backtest

Part of [stall-watch.md](stall-watch.md) (what the watch is, its rules, how to switch it off, and its parts).

## H-STALL-1 (written before the code)

- **What's wrong, with evidence.** Nothing notices an active project or initiative that has no open task, or no
  recorded progress. Overnight Oct 19-20, in Team in Temper: team-page-truth had no open task from 01:03;
  owner-stop-and-notices had none from Oct 19 18:18; team-vs-solo and owner-real-task never had one. No lead was
  woken (Ops' read-only diagnosis rm-8fb841ab).
- **The change.** Deterministic rules over the records (the work registry, the queues' facts the Roles overview
  already has, and the progress feed's lead updates), run every 10 minutes, dry: it logs whom it would wake.
- **Expected result.**
  - A backtest over the registry events from Oct 19 00:00 to Oct 20 09:00 PDT, every 10 minutes, flags exactly
    those four within 2 h 10 min of becoming empty (team-page-truth by about 03:13), each with the right chain.
  - It never flags three-passing-projects, which always had open tasks.
  - Any empty Ops, Design or architecture items are listed with their reason.
  - On fixed fixtures, 100% of the must-catch cases fire and 0 of the must-pass cases do, the same result on two
    runs.
- **What would prove it wrong.** The backtest flags three-passing-projects or misses one of the four, or a
  must-pass fixture fires.

## Backtest

`TZ=America/Los_Angeles node --import tsx scripts/stall-backtest.mts --events <copy> --records <copy>`
over read-only copies of `~/.pi/agent/work/events.jsonl` (2,015 lines) and the progress feed's update records,
Oct 19 00:00 to Oct 20 09:00 PDT, every 10 minutes (199 steps, 2.7 s). It replays what the registry recorded;
the queues' past facts (owner pauses, questions waiting on the owner, TL;DR lines) aren't recorded, so they
don't count here (the live check has them).

| item                               | lead         | rule  | since                  | first flagged | after             | chain                      | cleared                                 |
| ---------------------------------- | ------------ | ----- | ---------------------- | ------------- | ----------------- | -------------------------- | --------------------------------------- |
| project app-screens-workflow       | design       | empty | Oct 18 20:51           | Oct 19 00:00  | before the window | design → owner             | still flagged                           |
| project marketing-visuals-workflow | design       | empty | Oct 18 20:51           | Oct 19 00:00  | before the window | design → owner             | still flagged                           |
| project logo-identity-workflow     | design       | empty | Oct 18 20:51           | Oct 19 00:00  | before the window | design → owner             | still flagged                           |
| project design-review-workflow     | design       | empty | Oct 18 20:51           | Oct 19 00:00  | before the window | design → owner             | still flagged                           |
| project user-research-walks        | design       | empty | Oct 18 20:51           | Oct 19 00:00  | before the window | design → owner             | still flagged                           |
| project message-approvals          | ops          | empty | Oct 19 02:04           | Oct 19 04:10  | 2 h 05 min        | ops → owner                | Oct 19 09:00 (a task opened 08:55)      |
| project faster-landing             | ops          | empty | Oct 19 07:27           | Oct 19 09:30  | 2 h 03 min        | ops → owner                | Oct 19 20:10 (a task opened 20:08)      |
| project team-vs-solo               | architecture | empty | Oct 19 08:16 (created) | Oct 19 10:20  | 2 h 03 min        | architecture → coo → owner | still flagged                           |
| project owner-real-task            | architecture | empty | Oct 19 08:17 (created) | Oct 19 10:20  | 2 h 03 min        | architecture → coo → owner | still flagged                           |
| project three-passing-projects     | temper       | empty | Oct 19 08:43           | Oct 19 10:50  | 2 h 07 min        | temper → coo → owner       | Oct 19 12:10 (tasks opened 12:04-12:05) |
| project parallel-queue-work        | ops          | empty | Oct 19 09:44           | Oct 19 11:50  | 2 h 06 min        | ops → owner                | still flagged                           |
| project owner-stop-and-notices     | temper       | empty | Oct 19 18:18           | Oct 19 20:20  | 2 h 01 min        | temper → coo → owner       | still flagged                           |
| project faster-landing             | ops          | empty | Oct 19 20:34           | Oct 19 22:40  | 2 h 05 min        | ops → owner                | Oct 19 23:00 (a task opened 22:52)      |
| project faster-landing             | ops          | empty | Oct 19 23:32           | Oct 20 01:40  | 2 h 07 min        | ops → owner                | still flagged                           |
| project team-page-truth            | frontend     | empty | Oct 20 01:03           | Oct 20 03:10  | 2 h 07 min        | frontend → coo → owner     | still flagged                           |

No silent finding and no initiative finding: every active initiative (design-in-temper, team-in-temper-2,
system-arch-in-temper) had an active project all along, so its projects' checks cover it. Still fine at 09:00:
initiatives-page (ops), homepage-workflow (design), three-passing-projects (temper, 8 open),
arch-stage-context (architecture).

**Against H-STALL-1:**

- The four Team in Temper items are all flagged, each within 2 h 10 min of becoming empty, each with its right
  chain (the project's lead, then team-in-temper-2's lead coo, then the owner): team-page-truth at 03:10
  (2 h 07 min after 01:03), owner-stop-and-notices at 20:20 (2 h 01 min), team-vs-solo and owner-real-task at
  10:20 (2 h 03 min after they were created). Hit.
- **three-passing-projects was flagged** from Oct 19 10:50 to 12:10, which the hypothesis said would never
  happen. The registry shows the hypothesis's premise was wrong, not the check: its only task, temper #103,
  closed at 08:43, and the next ones (temper #110 and #112) were linked at 12:04-12:05. For 3 h 21 min it
  really had no open task. Miss as written (see Result).
- Empty Ops, Design and architecture items, with their reasons: Design's five workflow projects, empty since
  Oct 18 20:51 (their last tasks closed then; homepage-workflow, Design's sixth, kept open tasks);
  Ops' message-approvals, faster-landing (three stretches) and parallel-queue-work; architecture's two Team in
  Temper projects above.
- **Independent count:** `scripts/stall-count.mjs --from … --to … --every 10` re-derives the empty items
  straight from the events, without the server's code. At all 199 steps it names exactly the same items with
  the same `since` as the backtest (0 differences).
