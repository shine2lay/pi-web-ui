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

One round, worst case (the registry changed, so the replay and the extra times are both made again), on a
copy of the real registry (2,015 lines, 297 task links, every link given queue facts with a 200-character
TL;DR line and a 300-character done summary), sealed (`scripts/sealed.sh`), 20 warm runs:
**median 10.6 ms, max 14.3 ms** (replay 6.9 ms, extra times 3.8 ms, rules 0.2 ms). Under the 200 ms bar by
about 19 times, so no narrowing was needed.

## Live dry run

(filled in after the install)

## Result

(filled in at the end)
