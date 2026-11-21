# stall-watch: H-STALL-COST-2, reusing the newest Roles overview

Part of [stall-watch.md](stall-watch.md) (what the watch is, its rules, how to switch it off, and its parts).
The cost measures it starts from are in [stall-watch-cost.md](stall-watch-cost.md).

### H-STALL-COST-2 (written before the change)

- **What's wrong, with evidence:** the round's own Roles overview is 100-250 ms of main-thread CPU, about
  nine tenths of the round (above). The round uses it only for the queue facts the registry lacks: owner
  pauses, needs-you, TL;DR times and done summaries. Whether a task is open comes from the registry
  (`task.link` and `task.state`), not from the overview. And pages-fresh (Ops #245) already makes the same
  overview every 15 s, whether or not a page is open (live: 40 rounds in 602 s, 0 failed).
- **The one change:** the round uses the newest overview the server has made, in practice the refresher's,
  when it is at most 60 s old (`STALL_OVERVIEW_MAX_AGE_MS`). It makes its own only when there is none that
  young (the refresher stopped or failing) or its time is ahead of the clock. The work page is still made
  each round from the registry as read then, so open or closed, the times and the waits are as fresh as
  before. Only the queue facts can be up to 60 s old. That can't make an item look empty, since a task's
  state is the registry's; at most a pause, a needs-you or a TL;DR line from the last minute counts one
  round later.
- **Expected result, and how it's measured:**
  - The same sealed timing run, as live (refresher running): the round's main-thread CPU at p90 under 50 ms,
    longest slice under 30 ms.
  - With the refresher held for over 60 s, the round makes its own overview (the fallback), at about the
    cost measured above.
  - Unit tests: the choice (young: reused; over 60 s, none, or ahead of the clock: made anew), and the same
    findings from a reused overview as from a fresh one when nothing changed between them.
  - Live after the install: `stall list`'s `tookMs` under 60 ms from round 3 on (round 2 before: 247 ms),
    and the findings still match the independent count exactly.
- **What would prove it wrong:** the as-live round's p90 is 50 ms or more, the round doesn't fall back
  with the refresher held, or the live findings differ from the count.

**Result: miss on its own bar (p90 under 50 ms); the choice works, and the plan's 200 ms bar is met.**
Measured Oct 20, 10:31-10:34, sealed, on the same copies; the machine was busier still (load average 13-17 on
20 cores). Main-thread CPU, p50 / p90 / max ms:

| round                                | main-thread CPU    | longest slice | overview                     |
| ------------------------------------ | ------------------ | ------------- | ---------------------------- |
| as live, refresher running           | 99 / 172 / 437     | 44 / 92 / 108 | reused 10 of 10 (2-14 s old) |
| refresher held, overview seconds old | **34** / 165 / 171 | 16 / 83 / 94  | reused 10 of 10 (2-16 s old) |
| refresher held, overview 61 s old    | 238                | 30            | made its own (1 of 1)        |
| refresher held, none kept            | 229 / 468 / 608    | 35 / 95 / 116 | made its own (10 of 10)      |

- The choice works: reused whenever the newest overview was 0-60 s old (20 of 20); made its own when it was
  61 s old or missing (11 of 11). Hit.
- The round's own cost fell from 136-166 ms to 34 ms at p50: the work page from the overview, the extra
  times, the lead updates and the rules.
- The p90s, 165-172 ms, miss the 50 ms bar. That bar was set by a measure that can't hold it: the main
  thread's CPU during the round's window counts all the other work in that window. That includes the
  refresher's own build when it overlaps (about 500 ms on this machine at this load; idle 1-s windows with
  it running: 89 / 474 / 648 ms), garbage collection after the builds, and the probe's own 1-ms timer (71-80
  ms of every idle second with the refresher held). Two of the ten seconds-old rounds took 168 and 187 ms
  this way; the other eight took 27-46 ms.
- Against the plan's bar (a round under 200 ms of main thread), the normal path passes at p90 in both
  phases. The as-live max of 437 ms is a window that overlapped the refresher's build. The fallback, which
  happens only when pages-fresh has made no overview for a minute, stays at the overview's own cost.
- Next, if a round's cost ever needs a tighter bar than 200 ms: measure it with a CPU profile that counts
  only the round's own functions, not a window. That's a change in how it's measured, not in the code, so it
  isn't done here.
