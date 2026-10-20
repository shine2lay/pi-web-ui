# Roles and Initiatives open at once: kept fresh in the background

Ops queue task #245 (accountable lead: Ops; project initiatives-page). The owner, 2026-10-19 18:55: "can you make it so that roles and initiative are updated periodcally so we are not fetching for long everytime we load". It also covers the part of the earlier ask (2026-10-18, m58098, "i hate that it says reconnecting for along time when i change tabs") that #244 (docs/pages-live.md) left for the Initiatives page.

Server copy only. The owner didn't pick between a server copy and an extra copy in the browser (he answered "i see asks unconfirmed all the time" instead, which is #268); Ops chose the server copy: a browser copy would show older, unconfirmed data on every open, and it would store page data on his devices. It can be added later if he asks.

## Evidence before the change

- Look-only checks on the live server, 2026-10-19 19:05 (fairly quiet; 3 opens per page, from navigation start; `~/kept-from-tmp/2026-10-19/pages-load-timing/`): Roles' first overview 0.8-2.4 s, Initiatives' first work page 1.4-2.5 s. Earlier logs: up to 8 s for Roles, 7-66 s for Initiatives' first load (Ops note n209).
- The code. Roles keeps a copy and answers a new watch with it at once (`RolesWatch` in server/roles-overview.ts, since #244), then waits for a fresh overview to confirm it. Initiatives builds from scratch on every open: `WorkPageWatch.watch` (server/work-page.ts) waits for `readWorkPage` (server/agent-service.ts), which first builds a whole Roles overview of its own; with Initiatives open it builds both again every 5 s.
- The server's main thread stalls. Since 14:50 on Oct 19 it has had about 149 stalls of 1 s or more per hour (`~/.pi-web-ui/conn-events*.jsonl`, kind "stall"; p50 1.45 s, max 21 s that day). Their cause is unknown. An open that lands in one waits for it.

## H-PAGES-FRESH-1: the pages build their data when they're opened

**Wrong, and the evidence.** Both pages build their data when they're opened, and an open that lands in a server stall waits for it. Evidence above.

**One change.** One background refresher keeps both pages' data ready: every 15 s, while pi-web-ui runs, whether or not a page is open. Every open is answered at once from that copy.

**Expected, and how it's measured.**

- First data within 1 s p90 over 10 live opens per page (look-only, one fixed pseudo client id, from navigation start).
- Server stalls of 1 s or more per hour, in the 2 h after the install, no more than 10% above the 2 h before (conn-events, kind "stall").
- The refresher uses at most 2% of one core.
- In the sealed tab-return test (hidden 60 s), Initiatives shows fresh data within 3 s p90 over 10 runs.
- Real use: the trace's shownMs for both pages over the next 24 h (fewer than 5 returns per page is recorded as not enough data).

**What would prove it wrong.**

- First data is still over 1 s p90 with a fresh copy in place. Then the cost is the connection or the ~0.5 MB transfer, and a new hypothesis is written before more code.
- Stalls rise by more than 10%.

## The slice rule, written before measuring

A refresh every 15 s that blocks the main thread would add stalls of its own. So, before the timer is turned on:

- if a build's longest blocking slice is under 50 ms, the refresher runs it on the main thread;
- otherwise the build is made to yield between roles (or moved into a worker) until that slice is under 100 ms, and only then is the timer turned on.

## Measured before the change (step 2)

Sealed build timing: the server's own code, run in a sealed server on a temporary copy of the role data and the work registry (in /dev/shm, deleted after), 10 builds of each with 2 s between them; the longest blocking slice is the longest event-loop gap during a build (`~/kept-from-tmp/2026-10-19/pages-fresh/timing-*.mjs`).

| Build (code 0ce9bd8b, quiet machine) | Wall p50 / p90 | Longest slice p50 / p90 / max | Size |
|---|---|---|---|
| Roles overview (`readRolesOverview`) | 92 / 119 ms | 16 / 20 / 23 ms | 490 KB |
| Work page (`readWorkPage`, with its own overview) | 107 / 146 ms | 17 / 25 / 25 ms | 373 KB |
| Initiatives decisions page (`initiativesPage`) | 112 / 143 ms | 113 / 144 / 144 ms (one slice) | 205 KB |

The server's own first overview after a start (cold) took 8.9 s, with a 544 ms slice. A second run on the code then live (bb432079, after #268) while the machine was loaded (load average 25-32 on 20 cores, other tasks' gates and temper's tests) was 6-10 times slower across the board, the decisions page too, whose code hadn't changed: the machine, not the code.

Live, look-only, 10 opens per page with the fixed pseudo id, from navigation start to first data on the socket (Roles: its first overview; Initiatives: both its work page and its decisions page):

| Look | Roles first data p50 / p90 / max | Initiatives first data p50 / p90 / max | Initiatives watch to data p50 / p90 |
|---|---|---|---|
| 20:15-20:19 (a deploy build running) | 2363 / 3834 / 5950 ms | 1038 / 5343 / 13049 ms | 549 / 2457 ms |
| 20:33-20:36 (quieter) | 348 / 485 / 613 ms | 610 / 1366 / 2403 ms | 348 / 416 ms |

Roles' first overview was always the kept copy (#244), 4-10 s old, so on a quiet server Roles already meets 1 s; its slow opens were page load and the socket opening while the machine was busy. Initiatives waits 350-500 ms for its work page to be built even on a quiet server.

Stalls lined up with page use (times and kinds only): each of the 8 traced returns on Oct 18-19 with view roles or initiatives had a stall in its window (for example 14:11, Initiatives silent 20.6 s with a 21.1 s stall).

## The slice rule applied (step 3)

- Roles overview and work page: longest slice 23 and 25 ms, under 50 ms, so the refresher runs them on the main thread. Nothing was made to yield.
- Initiatives decisions page: one 80-144 ms slice, over 50 ms. Its code is Architecture's (not touched, below), so it is not put on the timer: it stays built when a window asks, as before. It is answered in the same turn as its watch, so it costs an open about 0.1 s, not a wait for the next poll.

## What changed

Server:

- `server/pages-fresh.ts` (new): `PagesRefresher`, one round every 15 s (`PAGES_FRESH_MS`) while the server runs, the first one 15 s after the start; a tick that comes while the round before still runs is skipped. It says its cost in the log every 10 minutes: rounds, skips, failures, wall time, and CPU as a share of one core (an upper bound).
- A round makes the Roles overview (`RolesWatch.refresh`, server/roles-overview.ts), then the work page from that same overview (`WorkPageWatch.refresh`, server/work-page.ts; `readWorkPage(overview)` in server/agent-service.ts), so a round builds one overview, not two. A part a watching window's own look made less than 5 s ago is taken as it is.
- Each is kept with its time and sent only where it changed, like any look. A new Roles watch was already answered from the kept overview with its time (#244). A new work-page watch is now answered at once from the kept page while it is at most 45 s old and the last look didn't fail; otherwise it waits for a look, as before, so a stopped refresher never passes an old page off as current.

Client (`web/src/work-page-state.ts`, `web/src/use-chat.ts`): the Initiatives page now has its own data signal, as Roles has had since #244. It counts as fresh once the server has answered this window's latest work-page watch, and not from a lost socket until the next answer. The last page stays on screen meanwhile; the app's "Updating…" note and 8 s grace (#244) apply to it, and the trace's shownMs now covers Initiatives returns too.

## Sealed browser test (step 6)

`tests/pages-fresh-test.mjs`, on the test's own server with one fixture role and initiative; the machine was busy throughout (load average 5-46 on 20 cores, the live server and temper's tests running).

- Tab returns (10 runs, 60 s hidden, socket cut): fresh Initiatives data after p50 112-182 ms, p90 128-350 ms, max 168-407 ms across three runs. No "Reconnecting" note, the page stayed on screen, and every return was traced with view initiatives and shownMs.
- Opens (10 per page): every Initiatives open was answered from the kept work page, made before its watch and 0.4-14 s old; every Roles open's first overview was 0.2-11 s old.
- First data from navigation start missed 1 s p90 in the first four runs (Roles 1.8-3.1 s, Initiatives 1.6-4.0 s). Split up, the time went mostly before the page asked: navigation to the socket opening was 0.7-2.7 s. Only the opens of one run that fell during a quiet spell (load 5) came in at 0.26-0.45 s.
  - H-PF-SEALED-1 (the young test server is still busy starting): miss. Its CPU was low before the opens and rose with them, also when they began 90 s after the start.
  - H-PF-SEALED-2 (each open as a new window leaves a blank chat whose cost grows): miss. With one fixed window id, the server's CPU still rose to 1.5-3.2 s per 10 s during the opens, from 0.1 s per 10 s at rest. Each fresh page load costs the server about that, with or without this change; it is noted for Ops, not changed here.
- So the test checks what the server controls: first data within 1 s p90 of the page's watch. From navigation start it is printed, not checked, with the machine's load beside it. Last run (load 23-35): from the watch, Roles p90 520 ms and Initiatives p90 436 ms; from navigation start, Roles p90 1991 ms and Initiatives p90 2293 ms.
- The live check (done when) stays from navigation start, as the before-looks above were measured.

## Kept as it is

- What the pages count or show (the registry, asks, budgets): this changes only when they get their data.
- "Nothing waiting on you" is never shown from an old copy without its time.
- No page data is stored in the browser.
- Architecture's decisions-page code (buildDecisionsPage, whoOf, initiativesPage, keptRecords; server/decision-view.ts, server/who-cache.ts) is not touched (Ops note n209, Architecture rm-f63e6fe6).
- Measuring never touches the live data folder: the sealed timing runs on a temporary copy, deleted right after; the live look is look-only, with one fixed pseudo client id (`carry-on:ops-live-look-pages-fresh`).
