# stall-watch: find stalled projects and initiatives from the records (dry run)

Ops #283, owner-requested via COO rm-f7806412 (Oct 20 ~08:25 PDT): "we need to close the gap so no initiatives
are forever stuck". Accountable lead: Ops. No model anywhere (rule 17). The next task (Ops #284) sends the wakes;
this one only finds the stalls, works out whom to wake and in what order, and logs it.

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

## The rules

Per project and initiative whose registry status is `active`. Everything is a pure function of the work page,
the extra times, the time now and the settings (`stallFindings(page, extra, now, settings)`).

- **Open task**: a linked task whose recorded status is ready, working, asking, stuck, waiting or blocked (a
  link with no status recorded yet counts as open). Not open: done, dropped, removed.
- **Under it**: a project's tasks are those linked to it. An initiative's own tasks are those filed straight
  under it; its projects are those that name it.
- **empty**: no open task under it for at least `emptyHours` (default 2).
  - For an initiative: no active project and no open task filed straight under it. An initiative with an active
    project is covered by its projects' checks and is never flagged itself.
  - The empty stretch starts at the latest of: its last open task closing or moving away (for an initiative
    also its last active project closing or moving away), its creation, its last status or lead change, and the
    end of a wait (when it ran out, or when it was resumed).
- **silent**: it has open tasks but nothing recorded for at least `silentHours` (default 24). Something recorded
  is any of:
  - a registry event about the item or its tasks (create, change, met, unmet, wait, resume, task.link,
    task.state);
  - a TL;DR line from one of its open tasks' chats (the page's `progress.at`);
  - a lead update in the progress feed (an initiative);
  - the end of a wait (so a lead gets the full `silentHours` after a wait ends, as with `emptyHours`).
  - The silent stretch starts at the newest of these.
- **dead-end** (projects, Ops #483): nothing moving now, found at once; checked first. See
  [Dead end](#dead-end-ops-483-agentsmd-rule-30).

### Quiet, never flagged

- Status done or dropped (not active: not looked at).
- An active wait: the record's `wait` (`{until, why, at, by}`, written by pi-queue's `wait` action, Ops #282),
  active while now < until. A wait never counts for more than 14 days from when it was recorded (the store's
  own cap, kept here too). No `wait` field: no wait.
- Every open task under it paused by the owner (the task, or its whole queue).
- Any open task under it waiting on the owner (its question reached him, an open dialog, or a needs-you TL;DR
  line: the page's `needsYou`).

### Whom to wake, in turn

Unique role ids, in order; a role already earlier in the chain is skipped.

- A project: its lead, then its initiative's lead, then `owner`.
- An initiative: its lead, then `owner`.
- Lead `owner`: the chain is just `["owner"]`.
- The owner step goes through COO; that delivery is the next task's. Here it is only computed.

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

## Settings

`~/.pi-web-ui/stall-watch.json` (the server's data folder), read at every round. Missing or unreadable: the
defaults. Each field on its own; a bad value falls back to its default.

```json
{ "mode": "dry", "emptyHours": 2, "silentHours": 24, "gapHours": 2, "everyMin": 10 }
```

- `mode`: `off` stops it completely (no reads, no rounds, no log lines; turning it back on needs a restart),
  `dry` logs only, `on` is the next task's (Ops #284). An unknown mode is `dry`.
- `gapHours`: the time between steps of the chain (the dry run logs step 2 after `gapHours`, and so on).
- Tests: `PI_WEB_STALL_FILE` (the file), `PI_WEB_STALL_MODE`, `PI_WEB_STALL_EMPTY_HOURS`,
  `PI_WEB_STALL_SILENT_HOURS`, `PI_WEB_STALL_GAP_HOURS`, `PI_WEB_STALL_EVERY_MIN` (fractions allowed) override it.

## The contract (Ops #284 builds on it)

```ts
export interface StallFinding {
	kind: "project" | "initiative";
	id: string;
	name: string;
	rule: "empty" | "silent";
	since: number;
	stretch: string; // `${kind}:${id}:${rule}:${since}`, the dedupe key
	chain: string[];
	initiative?: string;
	lastDone?: { queue: string; task: number; title: string; summary?: string; at: number };
	open: { queue: string; task: number; title: string; status: string; waitsOn?: string }[];
}
export function stallFindings(page: UiWorkPage, extra: StallExtra, now: number, s: StallSettings): StallFinding[];
export interface StallSettings { mode: "off" | "dry" | "on"; emptyHours: number; silentHours: number; gapHours: number; everyMin: number }
export function stallSettings(): StallSettings;
export class StallWatch; // a round every everyMin minutes; hands the findings to act(findings, now)
```

- `queue` in `open` and `lastDone`: how people call the task's queue (a role id or the queue chat's title), else
  its chat file.
- `lastDone`: the newest done task under it (an initiative: straight under it or under one of its projects),
  with its queue_done summary when the Roles overview has it.
- `open`: its open tasks, oldest link first; `waitsOn` says what a blocked task waits on.
- `since` only moves when something happens (a task closes, a status changes, a wait ends, something is
  recorded), so the same stall keeps the same `stretch` from round to round and across restarts.
- `StallExtra` holds what the page lacks: per item, its last status or lead change, the newest registry event
  about it or its tasks, when an open task (or, for an initiative, an active project) last left it, and when a
  wait was last resumed (`stallExtraFrom(log, leadUpdates)` makes it from the registry's text in one pass); and
  each initiative's newest lead update.

## The dry run

- Each round reads the work page (the server's own `readWorkPage()`: the registry and the Roles overview's
  queue facts), the registry's text for the extra times, and the progress feed's lead updates. It does not
  depend on any open window.
- It logs changes only:
  - `stall: would wake <role> about <kind> <id> (<rule> since <local time>, step 1 of N)` for a new stretch,
    then step 2, 3 … as each comes due, `gapHours` apart;
  - `stall: <id> cleared (<why>)` when a stretch ends.
- It keeps the current findings for the control socket's `stall_list` (`pi-web-ui stall list` prints it): the
  findings and every active item's state (flagged, quiet with why, empty but not for long enough, covered by its
  projects, or fine).
- It sends nothing and writes nothing outside its own log lines. Its memory of what it logged is in the
  server's memory only: after a restart the current stretches are logged again once.
- A page that can't be trusted (unreadable, or bigger than is sent) skips the round with one log line and keeps
  the last findings.

## The wait field in the work page

pi-queue's `project.wait` / `initiative.wait` (`{id, until, why}`) and `project.resume` / `initiative.resume`
(`{id}`) events (Ops #282) are read by `server/work-page.ts`'s replay with the store's rules: a wait is kept on
the record as `wait: {until, why, at, by}`, replaced by a new wait, cleared by a resume or by a status change to
done or dropped; both need the item active. They add no activity line and don't change `updatedAt`, so the
Roles and Initiatives pages look exactly as before (they don't show waits yet). Without this, the first real
wait would mark the page "unknown change".

## Backtest

`TZ=America/Los_Angeles node --import tsx scripts/stall-backtest.mts --events <copy> --records <copy>`
over read-only copies of `~/.pi/agent/work/events.jsonl` (2,015 lines) and the progress feed's update records,
Oct 19 00:00 to Oct 20 09:00 PDT, every 10 minutes (199 steps, 2.7 s). It replays what the registry recorded;
the queues' past facts (owner pauses, questions waiting on the owner, TL;DR lines) aren't recorded, so they
don't count here (the live check has them).

| item | lead | rule | since | first flagged | after | chain | cleared |
|---|---|---|---|---|---|---|---|
| project app-screens-workflow | design | empty | Oct 18 20:51 | Oct 19 00:00 | before the window | design → owner | still flagged |
| project marketing-visuals-workflow | design | empty | Oct 18 20:51 | Oct 19 00:00 | before the window | design → owner | still flagged |
| project logo-identity-workflow | design | empty | Oct 18 20:51 | Oct 19 00:00 | before the window | design → owner | still flagged |
| project design-review-workflow | design | empty | Oct 18 20:51 | Oct 19 00:00 | before the window | design → owner | still flagged |
| project user-research-walks | design | empty | Oct 18 20:51 | Oct 19 00:00 | before the window | design → owner | still flagged |
| project message-approvals | ops | empty | Oct 19 02:04 | Oct 19 04:10 | 2 h 05 min | ops → owner | Oct 19 09:00 (a task opened 08:55) |
| project faster-landing | ops | empty | Oct 19 07:27 | Oct 19 09:30 | 2 h 03 min | ops → owner | Oct 19 20:10 (a task opened 20:08) |
| project team-vs-solo | architecture | empty | Oct 19 08:16 (created) | Oct 19 10:20 | 2 h 03 min | architecture → coo → owner | still flagged |
| project owner-real-task | architecture | empty | Oct 19 08:17 (created) | Oct 19 10:20 | 2 h 03 min | architecture → coo → owner | still flagged |
| project three-passing-projects | temper | empty | Oct 19 08:43 | Oct 19 10:50 | 2 h 07 min | temper → coo → owner | Oct 19 12:10 (tasks opened 12:04-12:05) |
| project parallel-queue-work | ops | empty | Oct 19 09:44 | Oct 19 11:50 | 2 h 06 min | ops → owner | still flagged |
| project owner-stop-and-notices | temper | empty | Oct 19 18:18 | Oct 19 20:20 | 2 h 01 min | temper → coo → owner | still flagged |
| project faster-landing | ops | empty | Oct 19 20:34 | Oct 19 22:40 | 2 h 05 min | ops → owner | Oct 19 23:00 (a task opened 22:52) |
| project faster-landing | ops | empty | Oct 19 23:32 | Oct 20 01:40 | 2 h 07 min | ops → owner | still flagged |
| project team-page-truth | frontend | empty | Oct 20 01:03 | Oct 20 03:10 | 2 h 07 min | frontend → coo → owner | still flagged |

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

| part | main-thread CPU | longest blocking slice |
| --- | --- | --- |
| whole round, registry changed | 166 / 176 / 192 | 20 / 23 / 27 |
| whole round, nothing changed | 118 / 143 / 181 | 20 / 23 / 29 |
| Roles overview | 103 / 145 / 197 | 16 / 27 / 34 |
| work page from that overview | 11 / 14 / 14 | 11 / 12 / 13 |
| extra times (registry changed) | 8 / 11 / 12 | 7 / 8 / 13 |
| kept records, when the records file changed | **230 / 266 / 325** | **234 / 272 / 353** |

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

| round | main-thread CPU | longest slice | overview |
| --- | --- | --- | --- |
| as live, refresher running | 99 / 172 / 437 | 44 / 92 / 108 | reused 10 of 10 (2-14 s old) |
| refresher held, overview seconds old | **34** / 165 / 171 | 16 / 83 / 94 | reused 10 of 10 (2-16 s old) |
| refresher held, overview 61 s old | 238 | 30 | made its own (1 of 1) |
| refresher held, none kept | 229 / 468 / 608 | 35 / 95 / 116 | made its own (10 of 10) |

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

## Live dry run

Installed only through `pi-web-deploy`: the check (5d3ff258, land 120-681236) at Oct 20 09:38 PDT, then
its cost fix (342232a3, land 122-1e8cb3) at 11:06. The latter install's server, page, throwaway reply,
big-chat copy and log checks all passed. Carry-on finished at 11:09:30; the stall timer starts after it.
No settings file was needed: mode dry, emptyHours 2, silentHours 24, gapHours 2, everyMin 10.

Read-only checks used `node bin/pi-web-ui.mjs stall list`, the service's `stall:` log lines, and
`scripts/stall-count.mjs --at <the round's time> --json`, independently replaying the registry rather than
calling the server's stall rules. Results:

| build | round, PDT Oct 20 | wall time (`tookMs`) | flagged empty | covered initiatives | fine projects | pending / quiet / silent | independent count |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5d3ff258 | 1, 09:40:51 | 1,007 ms | 11 | 3 | 4 | 0 / 0 / 0 | exact match |
| 5d3ff258 | 2, 09:50:51 | 247 ms | 11 | 3 | 4 | 0 / 0 / 0 | exact match |
| 342232a3 | 1, 11:10:39 | 345 ms | 11 | 3 | 4 | 0 / 0 / 0 | exact match |
| 342232a3 | 2, 11:20:39 | 62 ms | 11 | 3 | 4 | 0 / 0 / 0 | exact match |
| 342232a3 | 3, 11:30:39 | 50 ms | 11 | 3 | 4 | 0 / 0 / 0 | exact match |

The comparisons match each empty item's id, `since` and first lead, plus pending, quiet and covered sets.
There were no quiet items to explain in these rounds. Fixed fixtures cover the owner-pause, needs-you and
active-wait exceptions that the live snapshot did not contain. The independent event-only script cannot
reconstruct past queue-only facts (above); no silent candidates occurred in this live check either.

The dry list, all empty:

- Ops: faster-landing, parallel-queue-work; each ops → owner.
- Design: app-screens-workflow, marketing-visuals-workflow, logo-identity-workflow, design-review-workflow,
  user-research-walks; each design → owner.
- Team in Temper: team-page-truth (frontend → coo → owner), owner-stop-and-notices (temper → coo → owner),
  team-vs-solo and owner-real-task (each architecture → coo → owner).

Each install's first round logged these 11 `would wake` lines. Later rounds logged no changes because no
finding changed. Restarts do not reset `since` or `stretch`; they do reset this dry logger's in-memory
set, so it lists the same findings again. Persisting actual deliveries belongs to #284, not this dry check.

Nothing sent or written by the stall check: against the 09:38:35 baseline, by 11:31 there were no new
Board posts, still 15 queue-reminder lines, and no app/stall-authored registry event (80 new events, all
by roles doing their existing work). One new app-sent role message at 10:55:06 was the existing Initiatives
page's progress-report request to COO; none was about stalls. The runner's only default action is its log
hook; it has no role-message, queue, dialog or registry-write path.

The first cost-fix round includes its initial records read. The later wall times fell to 62 then 50 ms;
round 3 meets H-STALL-COST-2's live prediction of under 60 ms, though its stricter sealed CPU p90 prediction
remains a recorded miss. These wall times include I/O and scheduling, not just main-thread CPU.

## Result

**H-STALL-1: MISS as written (Oct 20).** All four intended overnight cases were found on time, with the
right chains; all must-catch fixtures fired and no must-pass fixture fired, identically on two runs.
But the backtest also flagged three-passing-projects, disproving the prediction that it would never do so.
The registry establishes why: temper #103 closed at Oct 19 08:43; #110 and #112 were linked at 12:04-12:05.
It really had no open task for 3 h 21 min. The hypothesis's premise, not the rule's answer, was wrong.
Lesson: verify historical open-task claims from event replay, not a later diagnosis snapshot. The rules
were not relaxed to hide that counterexample.

Proof of the implemented rules: 0 differences against an independent replay at all 199 backtest steps;
five checked live rounds across the two installs matched the independent empty count; no sends or writes.
The normal-path cost is under the plan's 200 ms main-thread bar at sealed p90 (165-172 ms), and live round 3
is 50 ms wall time. H-STALL-COST-1 and -2 retain their stricter misses and limitations above.

The final unchanged code landed as 122-1e8cb3: 456 unit files passed, 6,580 tests passed and 6 skipped,
plus protocol, PATCHES.md, typecheck, lint and formatting. An earlier land (121-b91ed9) failed only two
unrelated timing tests under load; Ops directed one sealed run of those two files (89/89 passed), then
an unchanged re-land. No timeout or threshold was loosened and no test was skipped for the re-land.
There are 31 stall-watch tests after the cost-reader and overview-choice cases. Tests use the repository's
`tests/unit/stall-watch.test.ts` convention rather than the initially proposed `server/` location; the
backtest uses `scripts/stall-backtest.mts`.

The exported `StallFinding`, `StallSettings`, `stallFindings` and `StallWatch` contract is unchanged for
Ops #284. Only dry logging is live. No delivery or escalation is enabled by this task.

Undo: a settings file with `{"mode":"off"}` stops the runner at its next round (or prevents start after a
restart). Otherwise revert the code and install through `pi-web-deploy`; no registry or queue data needs
undoing.

## H-STALL-WAKE-1 (Ops #284, written before delivery changes)

- **Wrong, with evidence:** a finding nobody hears moves nothing. Overnight four Team projects sat empty and
  no lead was woken (rm-8fb841ab). The progress feed asks for updates, not next work.
- **One change:** wake the chain in turn, batched per recipient, with ledger dedupe and caps. The leads still
  decide what happens; the check only sends wakes. No models or registry/queue writes.
- **Expected, measured from the ledger, role message store and registry:** the first live round creates exactly
  one step-1 message per due recipient and none for quiet items; a normal restart creates zero duplicates;
  within 24 h at least half of the flagged stretches end with a lead action (task queued under it, done or
  dropped, or a wait); no owner step without all earlier steps at least `gapHours` apart.
- **Disproof:** any duplicate step, message for a quiet item, exceeded cap, or fewer than half acted on in 24 h.
  A miss gets a new hypothesis about the wake text or chain, not an unmeasured tweak.
- **Result so far (Oct 20): HIT** on the fixed fixtures, the first live delivery (12:27 PDT) and the first
  normal restart (15:31 PDT), below. All 11 flagged stretches had a lead action within 9 minutes. The 24 h
  verdict (task-9x7fkl) is still due, so this is not a full 24 h HIT yet.

## Waking the chain (Ops #284)

The code default remains **dry**. With `"mode":"on"` in `~/.pi-web-ui/stall-watch.json`, each round hands
its findings to `StallWake.act` (`server/stall-wake.ts`) instead of the dry log. `"mode":"dry"` returns to
logging only; `"mode":"off"` stops at the next round. Settings are read each round. After **off** has stopped
the timer, starting it again needs the next normal `pi-web-deploy` restart; changing dry/on does not.

Step 1 goes when the stretch is first found. Each later step goes `gapHours` (default 2) after the preceding
step, only while the same stretch is still found. An action that clears or changes the finding ends it: a task
appears, done/dropped, a wait, recorded progress, a lead change. A later stretch starts at step 1.

The owner's step goes **only through COO**, once per stretch: the rule and since time, roles woken and times,
and “Put it to the owner as one dialog with the full package (rule 21): drop it, pause it, reassign it, or name
the next work.” When COO was an earlier step the text says “COO (you)”. An owner-led item goes straight to
COO. After the owner's step nothing further is sent automatically; the finding stays visible on the page.

### Delivery, dedupe and quiet cases

`RoleMessages.requestStall` is modelled on `requestPoke`: sender
`{role:"app",title:"the work check",chat:"Work check",file:""}`, kind report, its own chain (outside role
chains' caps), normal delivery after a running turn, normal retries. It carries
`stall:{items:[{kind,id,name,rule,since,step,owner?}]}`. Header:
`[Role message rm-… from the work check · stalled work · <names>]`.

Hint: “(The work check found work you lead that isn't moving. Act with your tools: queue the next task under
it (queue_add with its project or initiative), close it (work_project or work_initiative change, status done
or dropped), or record a wait with its end (work_project or work_initiative wait). Nothing starts by itself.
No reply is needed: the check sees what you do. Write nothing for the owner in this chat.)” The owner's step
has its own hint telling COO to put it to the owner. Its chat turn is folded like a role's, not an owner report.

One message per recipient per round holds all due items. Each item is about 600 characters: name/kind/id,
plain rule and time, last done task/title/summary, open tasks and waits, who comes next and when, and the three
ways to clear it. Essential action and next-step text is never truncated to fit context.

Ledger `~/.pi-web-ui/stall-watch.jsonl`: `{stretch,step,to,at,id?,state,owner?}`, one line per step/status
transition. `sent`, `held`, `wakes-off`, `no-chat`, `capped`. Historical detail is kept for 30 days. Compact consumed-step
markers (`sent`, `wakes-off`, `no-chat`, with original step times) are kept for every unresolved stretch,
including partially advanced chains. A verified stretch end adds `endedAt`; its markers then stay for 30 more
days. No extra file or registry write. Absence from a round is **not** an end: suppression, pauses or failed /
incomplete reads retain markers conservatively. The role message store also identifies a sent step if a crash
lost its ledger line. Dedupe persists across installs/restarts with no hard horizon.

This is **Ops's technical retention clarification** (rm-8b9b535a), not new owner consent.

#### H-STALL-WAKE-RETENTION-1 (written before the retention fix)

- **Wrong, with evidence:** the original ledger reader filtered every line by `now - at < 30 days`. That loses
  sent and skipped steps of an unresolved chain after a long pause/restart; the role store cannot recover
  skipped steps. A compact marker was therefore insufficiently durable for the promised no-repeat guarantee.
- **One change:** retain every consumed step with its original time until positive registry/finding evidence
  proves that stretch ended, then retain it 30 more days. Never infer an end merely from missing findings.
- **Expected:** fixed fixtures twice show no replay after >30 days/reload, partial chains retain their gap,
  suppression/failed reads keep markers, verified end +30 days allows cleanup and a new stretch starts normally.
- **Disproof:** any replay/reset gap, marker lost under suppression/read failure, or verified-ended markers
  remaining beyond their retention window. **Result: HIT** in the corrected sealed gate (land 125-10cfad):
  all fixed retention cases passed twice, including unresolved/partial chains after 30 days and reload,
  conservative suppression/read failure, and verified end +30 days cleanup with a new stretch.

Caps: **6 messages per recipient per local day; 20 total in any rolling hour**, counting a batch once.
`capped` waits for the next round with room. While role messages are paused nothing is created (`held`);
on resume only findings still present go. A held or capped state is recorded once until it changes.

The disabled-wakes switch is **`wakeOnDone` in `~/.pi/agent/pi-queue.json`**, absent/true = on, false = off.
It is global, not per-home-chat: this is the same switch pi-queue's wake-on-done and queue-block lead reminders
honour. False suppresses **every** stall message, including the COO owner step; there is no per-chat override
or bypass. With it off the step is `wakes-off`, sends nothing and the chain moves on after the gap. A role without
a home chat is `no-chat` and moves on likewise. Ordinary role messages do not otherwise read this switch.
Paused, needs-you, done, dropped and actively waiting items are filtered out by the rules before delivery.

The check never starts, unpauses, approves, completes or changes work; no queue/registry writes; no model;
no message straight to the owner. The Roles page stays unchanged. Its record reader recognises wait/resume
as known events without adding any fields there.

### On the Initiatives page

The work page records have optional `stall:{rule,since,asked:[{role,at}]}` from the last findings and sent
steps, and `wait:{until,why,at,by}` from #282/#283. Existing project row, loose-project item and initiative
card note slots show “No open task since <time> · <Role> asked <time>”, “Nothing recorded since …”, or
“Waits until <date/time>: <why>”. Owner steps read “Owner (through COO)”. No new slots or layout changes.

### Final-check correction: H-STALL-WAKE-LOCALES-1

- **Wrong, with evidence:** land 124-c44f62 was rejected. The 6 new message labels exist in the built-in
  English dictionary but not the 8 downloaded language packs, so `locales.test.ts` fails key and placeholder
  parity (2 failures). Prettier also rejects one overlong new dictionary line. No code reached live.
- **One change:** complete those 6 labels in every pack, preserving `{id}` / `{names}`, and wrap the dictionary
  line exactly as the formatter requires. No message behavior or checks change.
- **Expected:** the final sealed land gate passes locale parity for all 8 packs and formatting, with the
  delivery/retention fixtures still passing twice. **Disproof:** any missing/empty label, placeholder mismatch,
  formatting failure or delivery regression. **Result: HIT** in the corrected sealed gate (125-10cfad):
  459 unit files, 6,653 passed / 6 skipped, plus protocol, PATCHES.md, typecheck, lint and formatting.
  No check was bypassed or loosened.

### 24 h verdict

`node scripts/stall-verdict.mjs --since <first-on-round ISO> --hours 24 [--json]` is read-only. It counts
flagged stretches, lead actions, messages/steps, cap hits, duplicates, cap breaches and owner-step gaps from
`stall-watch.jsonl`, `role-messages.json` and `~/.pi/agent/work/events.jsonl`. Fixtures use `--ledger`,
`--store` and `--events` overrides. Use the actual first-on timestamp, not the dry round's time.

## Live wakes (Ops #284, Oct 20)

Delivery landed as `50a96313` (125-10cfad), installed through `pi-web-deploy --landed` at 12:15 PDT;
server, page, throwaway reply, big-chat copy and log checks passed. The code default was still dry.
Both prerequisites (#282 waits, #283 dry check) were complete before activation. COO's pre-switch FYI
rm-6ddee8b8 named all 11 projects and their five leads from the dry list. Only then was the owner-changeable
settings file set to `{"mode":"on"}`. No extra restart, queue/registry write or model probe was used.

The first on-round was **Oct 20 12:27:26.696 PDT** (`2026-10-20T19:27:26.696Z`). Read-only comparison of
that round's exact findings, the ledger and role-message metadata established:

| recipient | stalled projects / step-1 lines | messages |
| --- | --- | --- |
| ops | 2 | 1 |
| design | 5 | 1 |
| frontend | 1 | 1 |
| temper | 1 | 1 |
| architecture | 2 | 1 |
| total | 11 | 5 |

All 11 ledger steps match their app-authored role-message records. No duplicate, cap hit or cap breach;
no owner step yet. There were **zero quiet items** in this live cohort; their exclusion is covered by fixed
fixtures, not a claim that this live round exercised a quiet item. Before activation there were zero stall
messages or ledger lines. Before and first-round proof files, metadata only, are in
`~/kept-from-tmp/2026-10-20/stall-live/`.

Read-only live look reused **one** pseudo client, `carry-on:ops-live-look-stall`, with outgoing messages
restricted to hello and page watches. On desktop 1400×1000 dark/light and phone 390×844 dark, the Design
view showed five stall/asked lines. A second look of Team in Temper showed its stall line and three waits
recorded by Frontend and Architecture after the wakes. All six views had zero serious/critical axe issues,
zero incomplete axe checks and zero page errors. Only the changed note lines were captured. No chat,
task or registry controls were used. No stalled initiative existed live; initiative-card behavior is
covered by the fixed tests.

The read-only verdict script ran successfully on live files at 12:28 PDT: **PENDING**, 11 flagged stretches,
one lead action then, five messages / 11 sent steps, zero duplicates, cap breaches or early owner steps.
An early read deliberately does not judge the 24 h action threshold. Ops home confirmed (rm-9f8daac3)
one-shot **task-9x7fkl, Oct 21 12:30 PDT**, after the full 24 h window, using:

```sh
TZ=America/Los_Angeles node scripts/stall-verdict.mjs --since 2026-10-20T19:27:26.696Z --hours 24 --json
```

Normal restart (Oct 20 15:31 PDT, the ordinary deploy of 9c805232; no restart was made for this check):
the first round after it (15:36) sent nothing, all 11 original step lines are still there once each with
their message ids and times, the ledger read logged no error, and the ledger still matches the role
message store. **Restart: 0 duplicates.** The limit: nothing was still flagged at the restart (all 11
stretches had their lead action by 12:36: ten waits and one project marked met), so this restart could
not show a re-send being stopped. The fixed reload tests cover that, and the 24 h verdict re-checks
duplicates over the whole window, including any later restart.

A second verdict read at 15:37 PDT: still **PENDING** (window not complete), 11 of 11 flagged stretches
ended with a lead action, zero duplicates, cap hits or early owner steps.

COO's live FYI was sent as rm-942ba37b after the existing shared Ops role-message cap had room; no cap
was bypassed.

Undo: set `{"mode":"dry"}` to stop deliveries but keep finding logs, or `{"mode":"off"}` to stop the
check. No registry or queue data needs undoing. Existing sent-step markers must not be deleted on rollback.
