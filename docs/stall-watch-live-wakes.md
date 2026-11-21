# stall-watch: the live wakes (Ops #284, Oct 20)

Part of [stall-watch.md](stall-watch.md) (what the watch is, its rules, how to switch it off, and its parts).

## Live wakes (Ops #284, Oct 20)

Delivery landed as `50a96313` (125-10cfad), installed through `pi-web-deploy --landed` at 12:15 PDT;
server, page, throwaway reply, big-chat copy and log checks passed. The code default was still dry.
Both prerequisites (#282 waits, #283 dry check) were complete before activation. COO's pre-switch FYI
rm-6ddee8b8 named all 11 projects and their five leads from the dry list. Only then was the owner-changeable
settings file set to `{"mode":"on"}`. No extra restart, queue/registry write or model probe was used.

The first on-round was **Oct 20 12:27:26.696 PDT** (`2026-10-20T19:27:26.696Z`). Read-only comparison of
that round's exact findings, the ledger and role-message metadata established:

| recipient    | stalled projects / step-1 lines | messages |
| ------------ | ------------------------------- | -------- |
| ops          | 2                               | 1        |
| design       | 5                               | 1        |
| frontend     | 1                               | 1        |
| temper       | 1                               | 1        |
| architecture | 2                               | 1        |
| total        | 11                              | 5        |

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
