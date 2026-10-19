# Gate: lighten the cases that come near the 5 s limit

Ops #252 (project faster-landing, 2026-10-18/19). Accountable lead: Ops. One sweep over every test case on vitest's default 5 s limit that came near it in recent land gates, instead of one task per timeout. Test files only: no production code, nothing to install.

## The cases

vitest's test timeout is its default, 5000 ms (`vitest.config.ts` sets neither `testTimeout` nor `hookTimeout`). The newest 16 land logs at 23:47 PDT on 2026-10-18 (`~/.cache/pi/receipts/*/land*.log`, `~/.cache/pi/receipts/*/*/land*.log`, `~/kept-from-tmp/2026-10-1[89]/*/land*.log`; Ops note n219's slow-case one-liner, kept as `~/.cache/pi/receipts/252/slow-cases.sh`) hold 9 whole pi-web-ui land gates, all after #243 (21:04). vitest's default reporter lists a case's own time only when it is over 300 ms, and all 8 cases below were listed in all 9 gates.

In scope: cases on the default limit whose slowest time in those logs is over 2500 ms, at most 8, the ones that timed out first, then by their slowest time.

| # | Case | File | Slowest | Fastest | Timed out |
| --- | --- | --- | --- | --- | --- |
| 1 | "puts every initiative's chip, the projects in no initiative and the filter counts on those rules" | `tests/unit/initiatives-page-tasks.test.ts` | 6043 ms | 1393 ms | 1: #244's 71-a85055 |
| 2 | "no input makes tags Telegram can't take, unbalanced ones, or a bare < > &" | `tests/unit/plugin-telegram.test.ts` | 5866 ms | 1117 ms | 1: #244's 71-a85055 (and roles-config-history's land 2, 5182 ms, older than the 16 logs) |
| 3 | "never says nothing is waiting, loading, failing, stale or not read whole" | `tests/unit/initiatives-page-model.test.ts` | 4936 ms | 1231 ms | 0 |
| 4 | "G2d: a crash at each file boundary, then recovery by a fresh store, the same in both" | `tests/unit/role-message-guard-store-golden.test.ts` | 4927 ms | 1160 ms | 0 |
| 5 | "renders the design's sample (converted, test-only) with its names, counts, pills, chips and tabs" | `tests/unit/initiatives-exact.test.ts` | 4626 ms | 1703 ms | 0 |
| 6 | "draws the gap count, gaps, hand-offs and activity count, and the activity tab newest first" | `tests/unit/initiatives-page-gaps.test.ts` | 4288 ms | 1326 ms | 0 |
| 7 | "another journal", a row of `it.each(cases)` in "fresh start: no request, or one that doesn't match, changes nothing" | `tests/unit/role-message-guard-fresh-start.test.ts` | 3733 ms | 649 ms | 0 |
| 8 | "shows through the design: goal, start day, items, then the proof and marker when an item opens" | `tests/unit/initiatives-page-plan.test.ts` | 3397 ms | 1639 ms | 0 |

Out of scope, listed only:

- Cases with their own limit. Every `role-message-guard-host-*` case: the shared harness's `useGuardWorld()` sets `vi.setConfig({ testTimeout: 60_000 })` (`tests/unit/role-message-guard-host-harness.ts`). That includes guard-host-approvers "no self-approval: the requester can't decide its own request" (4961 ms), which the task's plan took for a default-limit case. Also sealed-fence (its describes: 60 s), session-index (30 s and 120 s), plugin-tool-guard (20 s), worst-window (a) and golden G1 (1 h).
- Cases that mostly wait on real time: conn-events' real-timer cases (about 5.3 s, own 20 s limit) and lsp-tool "speaks JSON-RPC 2.0 with a mock language server process" (3447 ms) and "handles shutdown cleanly…" (3033 ms), which wait on the mock server (`server/lsp-tool.ts`: `this.request("shutdown", {}, 3000)`).
- Already made lighter by #251 (`docs/gate-light-tests.md`): initiatives-page-tasks "says nothing is waiting…" and client-id's first case.
- Over 2500 ms but past the cap of 8, left for a later pass: fresh-start "starts generation 2 once: gen-1 kept byte for byte, request done, the last hour's sends still count" (3185 ms), roles-exact "omits the helper row through updates without hiding real ON YOU markers or panels" (3057 ms), fresh-start "ignores a request for its own generation; one for an older generation is marked done" (2889 ms), initiatives-exact "selects, switches tabs and filters the way the design does" (2868 ms), task-queue "draws the same lanes and the same 'after' as pi-queue itself" (2816 ms).

## Before (2026-10-18, sealed, `TZ=UTC`, 20 cores)

`TZ=UTC scripts/sealed.sh npx vitest run <the 8 files> --reporter=verbose`, with a JSON report added for exact per-case times, 3 times on mine at 84fd0f5, unchanged: 23:55:00-23:57:06 PDT, load average 9.4 rising to 15.2 (other chats at work). Times in ms: runs 1, 2 and 3, then the median.

| # | Case | Before |
| --- | --- | --- |
| 1 | initiatives-page-tasks chip case | 1835, 1314, 1623: **1623** |
| 2 | plugin-telegram fuzz case | 846, 857, 2379: **857** |
| 3 | initiatives-page-model "never says…" | 1056, 1889, 1561: **1561** |
| 4 | guard-store-golden G2d | 316, 876, 1020: **876** |
| 5 | initiatives-exact "renders the design's sample…" | 1520, 941, 1623: **1520** |
| 6 | initiatives-page-gaps "draws the gap count…" | 1659, 1476, 1289: **1476** |
| 7 | guard-fresh-start "another journal" | 396, 502, 469: **469** |
| 8 | initiatives-page-plan "shows through the design…" | 1409, 1623, 1444: **1444** |

What the before runs show: in each Initiatives file, the case that mounts the view first is the slow one, whatever it does. A later case that mounts once takes a fraction of it: initiatives-exact's drawn-state cases 126-516 ms against "renders the design's sample…" at 1520 ms (one mount and its checks, nothing else); initiatives-page-gaps "draws the box's gaps…" 323 ms against "draws the gap count…" at 1476 ms; #251's one-mount cases in initiatives-page-tasks 138-896 ms against the chip case at 1623 ms. So the file's first mount costs about 1-1.3 s more than any later one: the view's and jsdom's cold start in a fresh test file. Cases 1, 5, 6 and 8 are each their file's first mount, and that cost stays with whichever case mounts first, however the case is split. Only production code (or the test environment) could make it smaller.

## H-GATE-NEAR-LIMIT-1

From the task's approved plan (Ops lead, 2026-10-18 23:45), with the treatment of each case settled from the before runs, before any change.

**Wrong, and the evidence.** The two timeouts above cost a 3-6 minute re-run of the land check each and stalled the task that landed. Six more cases on the default limit reached 3.4-4.9 s in the 9 gates, so the next busy gate can time out any of them. Each failure so far came from a case doing a lot of work under one 5 s limit while the gate loads the machine (prettier runs beside the tests since #231, with as many vitest workers as cores).

**The one change, and why it should fix it.** Each listed case gets a limit that fits its work, without touching what it checks:

- Split where the work is in pieces, with the same inputs and checks, so each piece has its own 5 s:
  - Case 2 (plugin-telegram fuzz): the 3,000 texts and the 400 whole messages, with each message's final words, are made once at describe level in exactly the old order of random calls (seed 20260917). Then `it.each` checks the texts in 6 cases of 500 and the messages in 4 cases of 100, each with its own list of problems and `expect(bad).toEqual([])`. A one-off hash proves the inputs are the same (below).
  - Case 3 (initiatives-page-model "never says…"): one mount per case, as #251 did: a case per state (4) and one for the old-data mount.
- An explicit limit with its reason in a comment, where the case can't be split: 3x its slowest gate time, rounded up to whole 5 s.
  - Cases 4 and 7 (guard store): sequential scenarios and Security's review evidence, so not restructured; the guard store's work is CPU-bound and 2-4x slower under gate load (Ops note n205). G2d gets 15 s; the fresh-start `it.each` gets 15 s for all its 14 rows ("another journal", its slowest, reached 3733 ms).
  - Cases 1, 5, 6 and 8 (Initiatives): each is its file's first mount, and that cold start is most of its time (above). Case 1 already mounts once: the plan's "one mount per case" holds for it, and splitting its 3 filter clicks into more mounts would add mounts while the first piece kept the cold start. Case 5 is one mount and its checks. Case 6 is one mount, its checks and one click; case 8 is one long sequential scenario (one mount, five clicks, each checked from where the last left it). They get 20 s (case 1), 15 s (cases 5, 6 and 8).

Never: a change to the global `testTimeout` or `hookTimeout`, a retry in the gate, or a dropped or loosened assertion or input. Each file keeps at least as many cases as before.

**Expected result, and how it is measured.** The same sealed command, 3 times after the change; medians count. Alone, each new split case is under 300 ms. In the next 2 land gates: no timeout among the listed cases; none of the split cases over 2 s. The cases with their own limit are not expected to get faster; their bar is no timeout, and their gate times are recorded against the limit.

**What would prove it wrong.** A split case over 2.5 s in a gate, or a timeout of any listed case. On a miss, the next hypothesis is the gate's own load (prettier beside the tests since #231, as many workers as cores), not the cases' weight.

## The change

The 8 test files, this doc and a PATCHES.md entry (`gate-near-limit`); nothing else.

- `tests/unit/plugin-telegram.test.ts`: the fuzz case is a `describe` of the same name. `pieces`, the seeded `rand` and `gen` are unchanged. `texts` is the 3,000 `gen(30)` texts; then `messages`, 400 entries, each the same ask as before followed by its final words' texts, `gen(10)` then `gen(5)`, made in that order. `it.each` "texts %i to %i" (1 to 500 up to 2501 to 3000) runs the same three `expectFine` checks and the marks check on its 500 texts; `it.each` "whole messages %i to %i" (1 to 100 up to 301 to 400) runs the same message, length, button and final-words checks on its 100 messages. Each case has its own `bad` list, filled as before, and ends with `expect(bad).toEqual([])`. Pass and fail are unchanged: any problem anywhere fails, as before; a failure now also names the piece it is in.
- `tests/unit/initiatives-page-model.test.ts`: "never says nothing is waiting, loading, failing, stale or not read whole" is a `describe` of that name. `it.each` over the same 4 states ("loading", "failing before any page was read", "stale: failing after a page was read", "not read whole") mounts once per case with the same two checks; then "not read whole: says its data is old" makes the old-data mount and its check. The file's `afterEach` cleans each mount up, which the old loop did by hand with the same two lines.
- The other 6 cases: their own limit as the last argument of `it` (`it.each` for fresh-start), with the reason in a comment above, pointing here: `initiatives-page-tasks` 20 s; `initiatives-exact`, `initiatives-page-gaps`, `initiatives-page-plan`, `role-message-guard-store-golden` G2d and `role-message-guard-fresh-start`'s 14 rows 15 s. Their bodies are unchanged (fresh-start's only re-indented inside the call).

Every file keeps at least as many cases as before, and every old case name is still there except the two split ones, whose names are now the `describe` around their pieces (JSON reports, before against after): plugin-telegram 109 to 118, initiatives-page-model 11 to 15, the other 6 files unchanged (14, 13, 7, 17, 32 and 6).

### The Telegram inputs are the same

A one-off script, not committed (`~/.cache/pi/receipts/252/telegram-inputs-hash.mjs`), takes the old case from mine at 84fd0f5 and the new `describe` from the change, strips their types with esbuild, and runs each with the functions under test replaced by recorders, the cases in declared order, as vitest runs them. Every input reaches the code under test through those functions, and the random calls never depend on what they return, so the recorded calls (name and arguments, in order) are the whole input sequence.

| | Cases | `expect` checks | Calls | sha256 of the calls |
| --- | --- | --- | --- | --- |
| Old (84fd0f5, lines 1253-1439) | 1 | 1 | 13,600 | `a1372ffcaabac7659ed4ab5ab376d226455a470e907088589fa373c682e3d7a2` |
| New (lines 1256-1473) | 10 | 10 | 13,600 | `a1372ffcaabac7659ed4ab5ab376d226455a470e907088589fa373c682e3d7a2` |

In both: `toTelegramHtml` 9,000 calls (3 per text), `plainText` 3,000, `renderAsk`, `renderLine`, `renderAnswered` and `renderGone` 400 each. Same hash: the same inputs in the same order. A control run of the new code with the seed changed by one hashed to `96916d2d94648827ad2db6497d0baae24fc1629654ca24f06b945b37aa64ef4c`, so the hash does see the inputs.

## After (2026-10-19, same command, same 8 files, worktree gate-near-limit)

3 runs, 00:06:52-00:07:56 PDT, all passed, walls 17.3, 21.4 and 25.3 s (before: 27.3, 35.5 and 62.8 s). Load average 3.6 rising to 6.3, against 9.4-15.2 for the before runs: the cases whose work didn't change ran faster only because the machine was quieter.

The split cases; the bar is a median under 300 ms. Times in ms: runs 1, 2 and 3, then the median.

| Piece | After |
| --- | --- |
| Telegram texts 1 to 500 | 137, 293, 349: **293** |
| Telegram texts 501 to 1000 | 207, 270, 332: **270** |
| Telegram texts 1001 to 1500 | 81, 134, 654: **134** |
| Telegram texts 1501 to 2000 | 73, 109, 77: **77** |
| Telegram texts 2001 to 2500 | 213, 207, 76: **207** |
| Telegram texts 2501 to 3000 | 89, 506, 79: **89** |
| Telegram whole messages 1 to 100 | 79, 91, 77: **79** |
| Telegram whole messages 101 to 200 | 68, 66, 76: **68** |
| Telegram whole messages 201 to 300 | 97, 102, 256: **102** |
| Telegram whole messages 301 to 400 | 77, 66, 414: **77** |
| model "never says": loading | 156, 149, 191: **156** |
| model "never says": failing before any page was read | 162, 131, 171: **162** |
| model "never says": stale: failing after a page was read | 237, 361, 348: **348** |
| model "never says": not read whole | 221, 598, 213: **221** |
| model "never says": not read whole: says its data is old | 213, 378, 214: **214** |

14 of the 15 pieces are under the bar; "stale: failing after a page was read" is over it, at 348 ms. It is one mount of the whole page, drawn with a page and an error, the most this file's mounts draw; one mount can't be split further. The largest Telegram piece is about a third of the whole case's time (293 against 857 ms), and the largest model piece about a quarter (348 against 1561 ms), though the before runs had the busier machine.

The cases with their own limit do the same work as before; their bar is no timeout.

| # | Case | Limit | Before median | After |
| --- | --- | --- | --- | --- |
| 1 | initiatives-page-tasks chip case | 20 s | 1623 | 949, 1090, 1485: **1090** |
| 4 | guard-store-golden G2d | 15 s | 876 | 131, 148, 177: **148** |
| 5 | initiatives-exact "renders the design's sample" | 15 s | 1520 | 849, 1385, 1883: **1385** |
| 6 | initiatives-page-gaps "draws the gap count" | 15 s | 1476 | 1191, 1593, 1362: **1362** |
| 7 | guard-fresh-start "another journal" | 15 s | 469 | 470, 602, 510: **510** (the slowest row, "no request": 526, 379, 559: **526**) |
| 8 | initiatives-page-plan "shows through the design" | 15 s | 1444 | 1167, 1465, 1249: **1249** |

Sum of the case times per file, median of the 3 runs, before to after: initiatives-exact 6144 to 6439 ms, initiatives-page-gaps 1833 to 1990, initiatives-page-model 3460 to 3155, initiatives-page-plan 1471 to 1404, initiatives-page-tasks 6123 to 7397, plugin-telegram 7017 to 7060, guard-fresh-start 11948 to 8342, guard-store-golden 25326 to 14765. Splitting doesn't add work worth measuring: the Telegram file's sum is the same, and the other differences go both ways with the load.

## Result

**H-GATE-NEAR-LIMIT-1: HIT** on both land gates the plan named: this change's own and the next pi-web-ui one (recorded 2026-10-19 01:55 PDT). No listed case timed out in either, and no split case took over 2 s (the slowest: 759 ms).

- Alone (above): 14 of the 15 new cases had a median under 300 ms. "stale: failing after a page was read" had 348 ms, over that bar: one mount of the whole page, which can't be split further.
- Its own land gate, wt land request 77-c56aee (00:10-00:13 PDT, `scripts/check.sh --fast`): passed, 443 files, 6,349 tests passed and 6 skipped, with no timeout. Unit tests took 166 s, prettier 113 s beside them, typecheck 17 s. It landed as c83fdee on mine.
- The next pi-web-ui land gate, wt land request 78-3f986f (Ops #253's ladder-followups, 01:49-01:52 PDT, `scripts/check.sh --fast`, built on c83fdee, so with this change): passed, 444 files, 6,370 tests passed and 6 skipped, with no timeout. Unit tests took 183 s, prettier 106 s beside them, typecheck 17 s. It landed as 7a6bc2f on mine.

The listed cases' own times in the land gates' logs, in ms. Vitest's default reporter lists a test's own time only when it is over 300 ms, so "not listed" means under 300 ms.

| Case | Limit | 77-c56aee (this change) | 78-3f986f (next gate, Ops #253) |
| --- | --- | --- | --- |
| Telegram texts 1 to 500 | 5 s | 423 | 759 |
| Telegram texts 501 to 1000 | 5 s | not listed | 352 |
| Telegram texts 1001 to 1500 | 5 s | not listed | not listed |
| Telegram texts 1501 to 2000 | 5 s | not listed | not listed |
| Telegram texts 2001 to 2500 | 5 s | 321 | not listed |
| Telegram texts 2501 to 3000 | 5 s | not listed | not listed |
| Telegram whole messages, each of the 4 pieces | 5 s | not listed | not listed |
| model "never says": loading | 5 s | 341 | 561 |
| model "never says": failing before any page was read | 5 s | 364 | not listed |
| model "never says": stale: failing after a page was read | 5 s | 358 | 404 |
| model "never says": not read whole | 5 s | 425 | 357 |
| model "never says": not read whole: says its data is old | 5 s | 362 | 407 |
| initiatives-page-tasks chip case | 20 s | 2285 | 1365 |
| initiatives-exact "renders the design's sample" | 15 s | 1627 | 1429 |
| initiatives-page-gaps "draws the gap count" | 15 s | 2980 | 2201 |
| initiatives-page-plan "shows through the design" | 15 s | 1778 | 1214 |
| guard-store-golden G2d | 15 s | 1901 | 1894 |
| guard-fresh-start "another journal" | 15 s | 437 | 965 |
| guard-fresh-start, its slowest row | 15 s | 2569 ("a request that is a link") | 1613 ("a request that is a link") |

What it shows:

- The split pieces stay light under gate load: the slowest Telegram piece took 423 and 759 ms in the two gates, and the slowest model piece 425 and 561 ms. As whole cases they took 1.1-5.9 s and 1.2-4.9 s in the 9 gates before, and the Telegram case timed out twice.
- The cases with their own limit did the same work as before: at most 3.0 s in the first gate and 2.2 s in the second, no slower than in the 9 gates before (their slowest there: 3.4-6.0 s) and far under their 15-20 s. Some were over 2 s: three in the first gate (the chip case 2285 ms, gaps 2980 ms, fresh-start's "a request that is a link" 2569 ms) and one in the second (gaps 2201 ms). The plan's first wording ("none of the listed cases over 2 s") would count those against it. A limit stops the timeout but doesn't make a case faster, which is why this doc's bar for them, written before the change, is no timeout.
- The cold start holds in the gates too: the chip case took 2285 and 1365 ms against 334-750 ms for its file's later one-mount cases, and "draws the gap count" 2980 and 2201 ms against 693 and 836 ms for its file's next case.

Next:

- Left for a later pass, each on the default limit (Ops note n219): the 5 cases past the cap (above), and three fresh-start cases #248 landed at 23:35, under 2500 ms in the 16 logs but over 2 s in a gate since. Their slowest so far: "the fresh start and a rotation both begin theirs with beginGeneration, leaving the same files" 2231 ms, "a request over 4 KiB: nothing written (N1)" 2467 ms, "a journal that can't be parsed: refused, off with the reason, every guard file as it was" 2110 ms. Of the 5, roles-exact "omits the helper row…" took 3593 ms in the second gate, more than its 3057 in the 16 logs, and fresh-start "ignores a request for its own generation…" 2385 and 2505 ms: those two first.
- The Initiatives first-mount cost (about 1-1.3 s alone, 1.2-3.0 s in these two gates) can only shrink in the app's code: the view's cold start. If a first-mount case comes near its limit, that's the fix, not a bigger limit.
