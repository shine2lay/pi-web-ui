# Gate: lighter tests that timed out under load

Ops #251 (project faster-landing, 2026-10-18). Accountable lead: Ops. Requested by Ops #244 (rm-5024a008), whose lands failed on these tests. Two tests made lighter with every assertion kept, and one production move (`getClientId` into its own module, behaviour unchanged). Nothing to install of its own: the next `pi-web-deploy` carries the move.

## The timeouts seen

vitest's test timeout is its default, 5000 ms (`vitest.config.ts` doesn't set it). The land logs of 2026-10-18 (`~/.cache/pi/receipts/`, `~/kept-from-tmp/2026-10-18/`) with "Error: Test timed out in 5000ms.":

| Test | Timed out | Where (land request: time over) | Passing times in land logs |
| --- | --- | --- | --- |
| `tests/unit/initiatives-page-tasks.test.ts` "says nothing is waiting only when the registry is loaded whole, live, and nothing is" | 2 | #244 67-534917: 5214 ms; #244 68-f11dd0: 5173 ms | 2.6-3.6 s (10 lands since the test came in, 20:51) |
| `tests/unit/client-id.test.ts` "同一次页面加载内稳定（同一个窗口就是同一个客户端）", the first case | 2 | roles-retry-pill 7-3764fb: 5034 ms; #244 68-f11dd0: 5105 ms | 0.3-4.4 s |
| `tests/unit/role-message-guard-core.test.ts` "a crash at any store boundary of the transition leaves all of it, none of it, or an unknown hold" | 3 | #225 36-43bc8b: 5134 ms; #236 37-97df19: 5148 ms and 39-dd29ae: 5171 ms (Ops note n205) | 2.1-4.9 s before #243 (sealed test folders in memory, 21:04); 1.1-2.3 s in the 10 lands since |
| `tests/unit/roles-exact.test.ts` "omits the helper row through updates without hiding real ON YOU markers or panels" | 1 | initiatives-exact 26-5d10c0: 5848 ms | 0.9-4.4 s |
| `tests/unit/plugin-telegram.test.ts` "no input makes tags Telegram can't take, unbalanced ones, or a bare < > &" | 2 | roles-config-history land 2 (11:02): 5182 ms; #244 71-a85055 (23:19): 5866 ms | 0.8-5.0 s |

The last two are outside this change. roles-exact is recorded only (one sighting; the plan's decision). plugin-telegram's second timeout came while this task ran; it is a seeded fuzz case (3,000 random texts, each converted three ways, then 400 whole messages), and it goes to the Ops lead for a task of its own.

## H-GATE-LIGHT-TESTS-1

From the task's approved plan, written before any change.

**Wrong, and the evidence.** The first two tests in the table timed out in pi-web-ui land gates, and each failure cost a whole re-run of the check (3-6 minutes). Both are heavy in a way the code shows:

- initiatives-page-tasks: that one case mounts the whole Initiatives design view 8 times (its `said` helper, once per registry state), so one 5 s timeout covers 8 mounts. It passes in 2.6-3.6 s in land gates, so a gate half again as slow times it out.
- client-id: each case runs `vi.resetModules()` and then imports `web/src/use-chat.ts` (2,891 lines, 30 imports) to reach a 3-line function, so the first case pays to transform and load use-chat's whole module graph.

**The one change, and why it should fix it.**

- initiatives-page-tasks: the case becomes a `describe` of the same name with 8 cases, one per registry state, each mounting once, with the same inputs and the same expected strings and counts. Each 5 s then covers one mount. No other test in the file changes.
- client-id: `getClientId`, `cachedClientId` and their comment move unchanged to `web/src/client-id.ts`, which imports only `./uuid`. `use-chat.ts` imports it for its own two calls and re-exports it, so `file-transfer.ts`, `components/FilePreview.tsx` and `download.ts` stay unchanged. The test imports `web/src/client-id`: the same four cases, each still on a fresh module (`vi.resetModules()`), since a fresh page load is what it tests.

No assertion is loosened; vitest's global `testTimeout` and `hookTimeout` stay unchanged; no retry in the gate.

**Expected result, and how it is measured.** The sealed command `TZ=UTC scripts/sealed.sh npx vitest run tests/unit/initiatives-page-tasks.test.ts tests/unit/client-id.test.ts --reporter=verbose`, with a JSON report added for exact per-test times, runs 3 times on the unchanged branch and 3 times after the change; the medians count. Alone, each new initiatives case takes under 300 ms (the old whole case: 1.3 s in #244's worktree), and the client-id file (its four cases together) is at least 3x faster. In the next land gates, none of these cases takes over 1.5 s.

**What would prove it wrong.** A new initiatives case over 600 ms alone, client-id less than 3x faster, or another 5 s timeout of these tests in a gate.

**The guard-core test (n205).** Its crash-boundary test is measured alone after #233 (the guard store rewrite), 3 times. Only if its median is over 2.5 s does that one test get an explicit timeout, with its reason in a comment.

## Before and after (2026-10-18, sealed, `TZ=UTC`, 20 cores)

Before: mine at 5502ea8, unchanged, 23:15:01-23:15:19 PDT, load average 2.8-3.6. After: the change, 23:18:00-23:18:11, load average 5.4-5.8. Per-test times from vitest's JSON report, in ms: runs 1, 2 and 3, then the median.

| Case | Before | After |
| --- | --- | --- |
| initiatives "says nothing is waiting…", as one case | 624, 1539, 712: **712** | split into the 8 below |
| … loading | | 38, 71, 46: **46** |
| … failed before any page was read | | 37, 84, 44: **44** |
| … failed after a page with questions | | 91, 135, 94: **94** |
| … failed after a page with no questions | | 82, 88, 95: **88** |
| … loaded, but too big to read whole | | 90, 88, 85: **88** |
| … loaded, but with a change it couldn't read | | 83, 78, 81: **81** |
| … loaded whole and live, with no questions | | 74, 78, 77: **77** |
| … loaded whole and live, with no tasks | | 66, 70, 63: **66** |
| client-id, the first case | 247, 1682, 612: **612** | 17, 32, 45: **32** |
| client-id, its four cases together | 256, 1711, 633: **633** | 24, 35, 50: **35** (18x faster) |
| initiatives-page-tasks, the whole file | 1363, 3775, 1988: **1988** | 1269, 1540, 1406: **1406** |

Every test passed in every run: 14 before, 21 after (17 in initiatives-page-tasks, 4 in client-id). The 8 new cases together take about what the one case took (their medians add up to 584 ms, against 712 ms): the work is the same, but each piece now has its own 5 s.

Against the bars: each new initiatives case is under 300 ms alone (largest median 94 ms, largest single run 135 ms), and client-id is 18x faster (at least 3x was the bar). Neither disproof by the alone runs happened.

**Guard-core crash-boundary test, alone** (`TZ=UTC scripts/sealed.sh npx vitest run tests/unit/role-message-guard-core.test.ts -t "a crash at any store boundary"`, with #233's 6ea7f58a and #243 in the branch; 23:18:32-23:19:05, load average 6.8 rising to 18.5): 1475, 1240 and 1310 ms, median **1310 ms**. n205 had it at 2374 ms alone before #233. Under 2.5 s, so it gets no explicit timeout: recorded only. In land logs it took 2.1-4.9 s before #243 and 1.1-2.3 s in the 10 lands since.

Files: `~/.cache/pi/receipts/251/` (`time-runs.sh`, and `before-N`, `after-N`, `guard-core-N` with `.log`, `.json` and `.load` each).

## Result

**H-GATE-LIGHT-TESTS-1: HIT** (recorded 2026-10-18, 23:40 PDT, after this change's land gate and the next one). Every bar held and no disproof happened.

- Alone (above): each new initiatives case took 44-94 ms (median), and the largest single run was 135 ms. The bar was under 300 ms, and over 600 ms would have disproved it. client-id got 18x faster; the bar was at least 3x.
- Its own land gate, wt land request 73-a16e41 (23:26-23:30 PDT, `scripts/check.sh --fast`): passed, 443 files, 6,320 tests passed and 6 skipped, with no timeout. Unit tests took 179 s, prettier 121 s beside them, typecheck 16 s (so `use-chat.ts` still gives `getClientId` to its other three importers). The 5-minute load average was 12.2 at 23:32, about the 9-12 of #244's 67-534917, where the old case timed out at 5214 ms. It landed as 32aa358 on mine.
- The next land gate, #248's request 74-202fbb (23:31-23:35 PDT): passed, 443 files, 6,336 tests passed and 6 skipped, with no timeout. Unit tests took 198 s, prettier 107 s, typecheck 17 s. The 5-minute load average was 14.2 at 23:35.
- In both gates, none of these cases took over 1.5 s (the slowest took 1038 ms), and none of these tests timed out.

These cases' own times in the land gates' logs, in ms. Vitest's default reporter lists a test's own time only when it is over 300 ms (its default slow-test threshold), so "not listed" means under 300 ms.

| Case | 73-a16e41 (this change) | 74-202fbb (#248, the next land) |
| --- | --- | --- |
| initiatives: loading | not listed | not listed |
| initiatives: failed before any page was read | 364 | not listed |
| initiatives: failed after a page with questions | 495 | 412 |
| initiatives: failed after a page with no questions | 800 | 332 |
| initiatives: loaded, but too big to read whole | 399 | 374 |
| initiatives: loaded, but with a change it couldn't read | 506 | 433 |
| initiatives: loaded whole and live, with no questions | 343 | 372 |
| initiatives: loaded whole and live, with no tasks | 1038 | 561 |
| initiatives-page-tasks, the whole file (17 tests) | 8565 | 6581 |
| client-id, the whole file (4 tests) | 46 | 36 |
| guard-core crash-boundary test | 2159 | 1089 |
| roles-exact "omits the helper row…" (recorded only) | 1992 | 1502 |
| plugin-telegram fuzz case (outside this change) | 1797 | 1925 |

What it shows:

- The 8 initiatives cases add up to about 4 s (73-a16e41) and about 3 s (74-202fbb) in a gate: the same work as the old single case, which took 2.6-3.6 s when it passed and timed out at 5.2 s. Now each piece has its own 5 s, and the slowest took 1038 ms.
- Under gate load one mount took up to 1.0 s (mostly 0.3-0.6 s), 4-16x its median alone. That is more than the 2-4x n205 saw for the guard-core store transitions, so in-gate times are the ones to watch, not the alone times.
- client-id is no longer heavy at all: 46 and 36 ms for its four cases in the two gates, where its first case used to take 0.3-4.4 s.
- The guard-core crash-boundary test took 2159 and 1089 ms, within the 1.1-2.3 s it has taken in gates since #243. It stays without an explicit timeout.

Next:

- Watch later land gates for these cases over 1.5 s or any 5 s timeout of them; either one reopens this.
- plugin-telegram's fuzz case timed out a second time during this task (5866 ms, #244's 71-a85055 at 23:19). By n205's rule that calls for its own faster-landing task, which is left to the Ops lead, outside this change.
- Not changed here, and it has never timed out: `tests/unit/initiatives-page-model.test.ts` "never says nothing is waiting, loading, failing, stale or not read whole" mounts the view 5 times in one case (4 states in a loop, then one more). It took 1.2-3.1 s in today's land gates (1751 and 1675 ms in these two). It is the same pattern, so it is the next one to split if it comes near 5 s.
