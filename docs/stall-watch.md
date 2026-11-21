# stall-watch: find stalled projects and initiatives from the records (dry run)

Ops #283, owner-requested via COO rm-f7806412 (Oct 20 ~08:25 PDT): "we need to close the gap so no initiatives
are forever stuck". Accountable lead: Ops. No model anywhere (rule 17). The next task (Ops #284) sends the wakes;
this one only finds the stalls, works out whom to wake and in what order, and logs it.

## The parts

This page keeps what the watch is, its rules (`empty`, `silent`, `dead-end`), whom it wakes, its settings and
off switch (`"mode": "off"` in `~/.pi-web-ui/stall-watch.json`). The rest is in these parts (Ops #1061 split):

| part                                                           | what it holds                                                                        |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| [stall-watch-dead-end.md](stall-watch-dead-end.md)             | the `dead-end` rule (Ops #483, rule 30): H-DEADEND-1, the test, waking               |
| [stall-watch-contract.md](stall-watch-contract.md)             | the `StallFinding` contract, the dry run's round and log lines, the wait field       |
| [stall-watch-backtest.md](stall-watch-backtest.md)             | H-STALL-1 (written before the code) and the Oct 19-20 backtest against it            |
| [stall-watch-cost.md](stall-watch-cost.md)                     | the cost of a round and H-STALL-COST-1 (read only the records file's new lines)      |
| [stall-watch-cost-overview.md](stall-watch-cost-overview.md)   | H-STALL-COST-2 (reuse the newest Roles overview) and its result                      |
| [stall-watch-dry-run-result.md](stall-watch-dry-run-result.md) | the live dry run (Oct 20) and the H-STALL-1 result                                   |
| [stall-watch-wake.md](stall-watch-wake.md)                     | H-STALL-WAKE-1, waking the chain (Ops #284): delivery, ledger, caps, wakes switch    |
| [stall-watch-wake-checks.md](stall-watch-wake-checks.md)       | H-STALL-WAKE-RETENTION-1, the Initiatives page, H-STALL-WAKE-LOCALES-1, 24 h verdict |
| [stall-watch-live-wakes.md](stall-watch-live-wakes.md)         | the live wakes (Oct 20): first on-round, restart, verdict reads, undo                |
| [stall-watch-whole-list.md](stall-watch-whole-list.md)         | H-STALL-WHOLE-1 (Q-STALL-1 A): read the whole registry, or raise the alarm           |
| [silence-watch.md](silence-watch.md)                           | silent waits (Q-STALL-1 B+): the rule, the seam and the cases                        |

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
  [Dead end](stall-watch-dead-end.md#dead-end-ops-483-agentsmd-rule-30).

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

## Silent waits (Q-STALL-1 B+, Ops #1058/#1059)

The backup for when the queue's own reminders fail: a task asking or blocked for 60 minutes whose deciding
chat has had no turn since, with no other nudge still due, wakes that lead once, then COO once 60 minutes
later. It shares this watch's read, wake route, ledger and limits. It reads no pi-queue timer for questions:
their reminder is always past at 60 minutes, and the watch must not fail together with the timers it backs up.
Rule, seam and cases: [silence-watch.md](silence-watch.md).
