# stall-watch: the cost of a round and H-STALL-COST-1

Part of [stall-watch.md](stall-watch.md) (what the watch is, its rules, how to switch it off, and its parts).

## Cost of a round

**Where it ended (H-STALL-COST-1 and -2 below):** a round now reads only the records file's new lines and
takes the Roles overview pages-fresh made in the last 60 s. On its own (refresher held, overview seconds
old), a round is 34 ms of main-thread CPU at p50; at p90 165 ms and as live 172 ms, both under the plan's
200 ms bar. Those p90s also count other work in the same window (below). Only when no overview is that young
does it make its own, at the old cost.

First measure, before the install: the replay and the rules alone, on a copy of the real registry (2,015
lines, 297 task links, every link given queue facts with a 200-character TL;DR line and a 300-character done
summary), sealed, 20 warm runs: median 10.6 ms, max 14.3 ms (replay 6.9 ms, extra times 3.8 ms, rules
0.2 ms). That left out two of the round's reads: the Roles overview the work page is made from, and the
kept records the lead updates come from. So it was not the round's cost.

The whole round, measured after the install: the landed code (5d3ff25) in its own sealed server on a
temporary copy of the live data (15 roles, 48 chat files, 2,062 registry lines, the 22.9 MB records file),
with the main thread's own CPU time read from `/proc/self/task/<pid>/schedstat` (other threads and processes
left out), 10 runs per part, the page refresher held so its rounds don't mix in (p50 / p90 / max, ms):

| part                                        | main-thread CPU     | longest blocking slice |
| ------------------------------------------- | ------------------- | ---------------------- |
| whole round, registry changed               | 166 / 176 / 192     | 20 / 23 / 27           |
| whole round, nothing changed                | 118 / 143 / 181     | 20 / 23 / 29           |
| Roles overview                              | 103 / 145 / 197     | 16 / 27 / 34           |
| work page from that overview                | 11 / 14 / 14        | 11 / 12 / 13           |
| extra times (registry changed)              | 8 / 11 / 12         | 7 / 8 / 13             |
| kept records, when the records file changed | **230 / 266 / 325** | **234 / 272 / 353**    |

### H-STALL-COST-1 (written before the change)

- **What's wrong, with evidence:** a round asks `keptRecords()` for the lead updates. Whenever
  `decisions/records.jsonl` has changed since anyone last read it, that parses the whole file again: 9,195
  lines, 22.9 MB, in one block of 230-353 ms on the main thread, during which no chat is served. The file
  only grows, by about 2 lines a minute (123 in the last hour on Oct 20), so nearly every 10-minute round
  finds it changed. A round then costs about 166 + 230 = 400 ms of main thread, twice the 200 ms bar, for 133
  lead-update lines out of 9,195. The table above was measured with the records file unchanged, which hid it.
- **The one change:** the round reads only the records file's new lines. A small reader keeps its place in
  the file (inode and byte offset), reads just the bytes added since its last look, and parses only the lines
  that hold `"source":"update"`, keeping each initiative's newest lead update. It starts over when the file
  is replaced or shrinks. It gives the same answer as `keptRecords()`: first record per (source, ref) wins,
  half-written lines are skipped. The round keeps building its own work page from a fresh overview, as
  decided. Reusing the refresher's copy was left out: it can be up to 15 s older than the registry times the
  round reads with it, and mixing the two could flag a project that has just got a task.
- **Expected result, and how it's measured:**
  - On a copy of the live records file, the new reader's lead-update times equal `keptRecords()`'s exactly,
    for every initiative.
  - In the same sealed timing run, with lines appended to the copy's records file before each round, the
    whole round's main-thread CPU stays at p90 under 200 ms and no slice is over 50 ms.
  - The reader's own part, after its first read, is under 5 ms a round.
- **What would prove it wrong:** any initiative's time differs from `keptRecords()`'s, the round with
  appended records goes over 200 ms at p90, or any slice in it is over 50 ms.

**Result: miss on the round as a whole; the records part hit.** Measured Oct 20, 10:16-10:21, sealed, on
copies (machine load average 5-9 on 20 cores):

- Same answer: on a copy of the live records file (9,208 lines, 22.9 MB), the new reader's times equal
  `keptRecords()`'s for both initiatives with lead updates (team-in-temper Oct 19 05:09:01 PDT,
  team-in-temper-2 Oct 20 07:57:47 PDT). That held on the first read and on each of 10 later reads after
  lines were appended. Hit.
- The reader's own part: first read 7.5-13.3 ms of main-thread CPU (the whole parse it replaces: 168 ms);
  later reads 0.2-3.9 ms. In the sealed server, 0 / 0 / 2 ms against the old way's 162 / 211 / 213 ms (one
  slice of 166-217 ms). Hit.
- The whole round with records added, the refresher held: main-thread CPU **136 / 205 / 816** ms, longest
  slice 18 / 23 / 146 ms. As live, the refresher running: 162 / 369 / 394 ms, slices 19 / 45 / 72 ms. Over
  200 ms at p90 and slices over 50 ms: miss.
- What was learned: the records' block is gone, but the round still makes a whole Roles overview of its own.
  In this run that took 170 / 250 / 271 ms of main-thread CPU (103 / 145 / 197 ms in the run before; it
  varies with the machine's load), in slices up to 76 ms. The overview is now nearly all of the round.
