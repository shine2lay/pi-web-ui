# Gate: lighten the Roles and Initiatives view cases that time out under load

Ops #278 (project faster-landing, 2026-10-19/20). Accountable lead: Ops. Essential maintenance of the land gate: one sweep over the view cases that timed out on vitest's default 5 s limit while several lands ran side by side (AGENTS rule 26), instead of one task per sighting (Ops decision 2026-10-18, as #252, `docs/gate-near-limit.md`). Test files only: no production code, no gate or `scripts/check.sh` change, nothing to install.

## The cases

vitest's test timeout is its default, 5000 ms (`vitest.config.ts` sets neither `testTimeout` nor `hookTimeout`). Times below are from the newest 60 land logs at 22:55 PDT on 2026-10-19 (`~/.cache/pi/receipts/*/land*.log`, `~/.cache/pi/receipts/*/*/land*.log`, `~/kept-from-tmp/2026-10-1[89]/*/land*.log`; 10-18 18:22 to 10-19 22:44), read by `~/.cache/pi/receipts/gate-view-cases/case-stats.py`. vitest's default reporter lists a case's own time only when it is over 300 ms or failed; "listed" is how many of the logs listed it.

| # | Case | File | Min / median / max | Listed | Timed out |
| --- | --- | --- | --- | --- | --- |
| 1 | "omits the helper row through updates without hiding real ON YOU markers or panels" | `tests/unit/roles-exact.test.ts:153` | 1114 / 2208 / 6170 ms | 32 | 2: 10-18 15:42 land 26-5d10c0 (5848 ms, older than the 60 logs), 10-19 22:27 land 112-4d8c43 (6170 ms, load 19-22) |
| 2 | "draws the header, cards, box and detail, with the filters counted" | `tests/unit/initiatives-page-model.test.ts:180` | 1071 / 1998 / 6197 ms | 29 | 1: 10-19 20:55 land 92-587f9a (load 26-29) |
| 3 | "hides Message and Change lead where they can't work, and opens the box like an initiative" | `tests/unit/initiatives-page-model.test.ts:201` | 447 / 828 / 6085 ms | 32 | 1: the same land 92-587f9a |
| 4 | "puts the projects count under the outcomes count on each card with projects, and none without" | `tests/unit/initiatives-projects-done.test.ts:203` | 1194 / 2481 / 5467 ms | 12 | 1: 10-19 21:25 land 98-6864df (chat-slots-log) |
| 5 | "selects, switches tabs and filters the way the design does" | `tests/unit/initiatives-exact.test.ts:109` | 750 / 1485 / 3339 ms | 32 | 0 (near the limit) |
| 6 | "draws the same lanes and the same 'after' as pi-queue itself" | `tests/unit/task-queue.test.ts:640` | 590 / 1717 / 4665 ms | 32 | 0 (near the limit) |

Case 1's second timeout is the second sighting that makes a faster-landing task due (Ops rule n205). Each such failure costs a full re-run of the land check (about 6 minutes) and a new place in the repo's land line.

Out of scope, recorded only (first sightings):

- `tests/unit/role-message-guard-lease.test.ts:283` "keeps zero-delay kicks, the 300 ms list debounce, and ordinary working-chat delivery": an AssertionError, not a timeout (the 300 ms timer counted twice under load), in the same land 92-587f9a.
- `tests/unit/webmail-secrets.test.ts`: an AssertionError in the pages-fresh land.
- The gate's own structure (H-GATE-PIN-1: vitest's worker count while several lands run side by side) stays a hypothesis of its own.

## H-GATE-VIEW-CASES-1

From the task's approved plan (Ops lead, 2026-10-19), written before any change.

**Wrong, and the evidence.** The table above: four timeouts in the newest 60 land logs (case 1 twice counting the older 10-18 one), each at 5.5-6.2 s, all while the machine was loaded (load average 19-29, lands side by side), and two more cases reaching 3.3 and 4.7 s. Each of these cases does a lot of work under one 5 s limit: several updates or states in one mount, or its test file's cold first mount (the first view mount in a fresh test file costs about 1-1.3 s more than any later one, `docs/gate-near-limit.md`).

**The one change, and why it should fix it.** Each case gets a limit that fits its work, without touching what it checks, decided per case from reading it and from its before runs:

- A case that runs several updates or states in one mount is split into one-mount cases with the same inputs and the same checks, as #251 and #252 did, so each piece has its own 5 s and does a fraction of the work.
- A case whose time is mostly its file's cold first mount (or cold first import) gets its own limit of 15 s with the reason in a comment, as #252 gave the other Initiatives first-mount cases, because splitting can't make a cold start lighter.

Never: a change to the global `testTimeout` or `hookTimeout`, a retry in the gate, or a dropped or loosened assertion or input. The old and new cases hold the same assertions (counted below).

**Expected result, and how it is measured.**

- Each split piece is under 1 s alone (the plan's sealed command with `-t`, median of 5 runs) and under 2.5 s in this task's own land gate.
- No timeout in these cases (or their pieces) in the next 10 pi-web-ui land logs after this lands. Checked by a scheduled count on 2026-10-21 12:00 PDT (to 2026-10-22 12:00 once, if fewer than 10 lands by then).
- The cases with their own limit are not expected to get faster; their bar is no timeout, and their gate times are recorded against the limit.

**What would prove it wrong.** A split piece over 2.5 s in a gate at load under 10, or a timeout of any of the 6 cases or their pieces in those 10 lands.

## What each case spends its time on

Read, then timed step by step: a scratch copy of each case with a timer around each step (mount, each update or click, each group of checks), run alone 5 times, sealed, at load 7-9 (never committed; the copies and their output are in `~/.cache/pi/receipts/gate-view-cases/probes/` and `probe-*.txt`). "Cold" is the first view mount (or import) in a fresh test file; "warm" is a later one in the same file.

| # | What it does | Where its time goes (ms, range of 5 runs, median) | Kind |
| --- | --- | --- | --- |
| 1 | Mounts the Roles view, checks it, updates it twice ("closed", then "open") and opens Ops's panel, checking after each | mount 297-402 (347, cold; a warm mount 74-124), updates 7-11 and 5-8, opening the panel 53-84, checks about 7 | the file's cold first mount, about 80% of the case |
| 2 | Mounts the Initiatives page once and checks the header, cards, box and detail | mount 334-537 (421, cold; warm 142-227), all checks 6 or less | the file's cold first mount, nearly all of the case |
| 3 | Mounts the page, clicks Beta cleanup, then the "Projects in no initiative" box, checking after each | mount 143-252 (171, warm), the two clicks 14-28 (18) and 7-17 (8), checks about 2 | one mount, about 85% of the case; the second click starts where the first left off |
| 4 | Mounts the page once and reads each card's projects line | the file's first mount: about 375 ms in a whole-file run against 117 ms for a later one-mount case; no updates | the file's cold first mount (read from the whole-file runs, not probed) |
| 5 | Mounts the page, selects Reliability, opens its Decisions 3 tab, then filters on Paused by you 1, checking after each | mount 173-339 (177, warm; the file's cold first mount is the case before it, which has had its own 15 s since #252), the clicks 66-138 (87), 21-36 (24) and 12-22 (12), checks about 5 | one mount, about 57%, and three clicks in sequence, about 40% |
| 6 | Imports pi-queue's own `queue.ts` and replays the same queues through it and through the Queue tab's code | the import 167-276 (209; alone in an empty file 228-274, a second import 7-9), each replay 8-18, the settings checks 0-1 | the cold first import, about 95% of the case |

Case 6 is much slower in a land gate (median 1717 ms) than alone (about 210 ms), because vitest transforms `queue.ts`, a file outside this repo, in its main process, which every worker of the gate shares.

## The change

Every case keeps its body, and gets its own limit of 15 s with the reason in a comment above it (the plan's value, as #252 gave the other Initiatives first-mount cases; 2.4 times the slowest time seen, 6197 ms). None was split:

- In cases 1, 2, 4 and 6, most of the time is the file's cold first mount or import. In one-mount pieces, the first piece would still carry it: for case 1, mount and first checks are about 82% of the case, so a gate that took 6170 ms over the whole case would take about 5 s over that piece alone. Splitting only adds warm mounts to the gate.
- In cases 3 and 5, most of the time is one mount, and the clicks run in sequence: "Decisions 3" is Reliability's tab, and the filter is clicked from there. A piece with the same inputs as the old case's last check has to mount and replay every click before it, so it does about all of the old case's work.

This is the same call #252 made for its first-mount cases and its sequential scenario (`docs/gate-near-limit.md`: "only app code could take it away"). Making the views' first mount or the import cheaper would be an app or vitest-config change, outside this task (no app code, no gate change).

So the hypothesis's split-piece expectations (under 1 s alone, under 2.5 s in a gate) have nothing to measure. What it rests on is the land logs: no timeout in these 6 cases in the next 10 lands, with each case's slowest time there recorded against its 15 s.

## The same checks

`~/.cache/pi/receipts/gate-view-cases/same-checks.py` compares each case's body before (a copy of the file at `mine` 2ac85ae2) and after, line by line:

| # | Before -> after | Body lines | `expect(` calls | Only difference |
| --- | --- | --- | --- | --- |
| 1 | `roles-exact.test.ts:153` -> `:157` | 25 / 25, identical | 7 / 7 | `});` -> `}, 15_000);` |
| 2 | `initiatives-page-model.test.ts:180` -> `:183` | 20 / 20, identical | 9 / 9 | the same |
| 3 | `initiatives-page-model.test.ts:201` -> `:207` | 10 / 10, identical | 5 / 5 | the same |
| 4 | `initiatives-projects-done.test.ts:203` -> `:206` | 10 / 10, identical | 4 / 4 | the same |
| 5 | `initiatives-exact.test.ts:109` -> `:112` | 10 / 10, identical | 4 / 4 | the same |
| 6 | `task-queue.test.ts:640` -> `:643` | 87 / 87, identical | 7 / 7 | the same |

36 `expect` calls before and after. Over the five files, `git diff` adds only the comments and the six closing lines (25 lines added, 6 removed), and each file keeps its count of `expect(` (298, 68, 35, 45 and 314). No case was added, removed or renamed.

## Before and after

Every run sealed (`scripts/sealed.sh env TZ=UTC npx vitest run <file> [-t "<name>"]`), 5 of each, and every one passed. The scripts and vitest's JSON reports are in `~/.cache/pi/receipts/gate-view-cases/` (`before.sh`, `after.sh`, `runs/`).

- First before run (`before.sh`, 22:58-23:05 PDT): each case alone, at load 10-15.
- Then before and after interleaved (`after.sh`, 23:16-23:26 PDT): each run of the old file (a scratch copy of it at `mine` 2ac85ae2, removed afterwards) right before a run of the new one, so both see the same load. The cases alone ran at load 5-12, the whole files at load 3-6.

| # | Alone, first before run: median (5 runs) | Alone, interleaved: before / after median (5 runs each) | The case in its whole file, interleaved: before / after median |
| --- | --- | --- | --- |
| 1 | 1132 (595-1813) ms | 594 (352-3292) / 467 (399-2662) ms | 307 / 313 ms |
| 2 | 732 (587-1981) ms | 649 (542-796) / 610 (570-936) ms | 315 / 326 ms |
| 3 | 764 (596-824) ms | 703 (616-1047) / 660 (576-756) ms | 154 / 144 ms |
| 4 | 772 (510-1070) ms | 824 (372-1233) / 952 (345-1170) ms | 304 / 319 ms |
| 5 | 535 (474-1112) ms | 418 (391-703) / 490 (447-533) ms | 231 / 241 ms |
| 6 | 162 (145-1344) ms | 152 (141-171) / 156 (152-184) ms | 202 / 178 ms |

The times stay where they were, as they should with unchanged bodies: before and after differ by less than each one's own spread at the same load. Run alone, each case is its file's first, so it carries the cold first mount (or import) even where it doesn't in its whole file (cases 3 and 5). The whole files pass the same cases before and after: `roles-exact` 106, `initiatives-page-model` 15, `initiatives-projects-done` 7, `initiatives-exact` 14 and `task-queue` 73.

**The limit itself.** Each case alone with vitest's global limit set to 1 ms (`--testTimeout=1`): the old case fails with "Test timed out in 1ms", and the new one passes (in 169-559 ms), so each case now runs on its own 15 s, not on the global limit.

## Result

Pending. The count of these cases' timeouts in the pi-web-ui land logs after this change lands, with each case's times in this task's own land gate, is scheduled for 2026-10-21 12:00 PDT (to 2026-10-22 12:00 PDT once, if there are fewer than 10 lands by then). HIT or MISS goes here.
