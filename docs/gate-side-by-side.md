# Gate: the quick checks run beside the unit tests

Ops #231, project faster-landing: the owner's pick "Quick checks side by side" (Oct 18, on making tests faster). Accountable lead: Ops.

## H-GATE-SIDE-BY-SIDE-1

**Wrong, and the evidence.** pi-web-ui's landing check, `scripts/check.sh --fast`, runs every step one after another (lines 20-31 before this change): the protocol check, the PATCHES.md check, typecheck, lint and prettier first, and only then the unit tests. So every land waits 30-40 s before its unit tests even start. The quick steps don't need the tests' result and the tests don't need theirs, so that wait buys nothing. The last five pi-web-ui lands on Oct 18 (`wt land-status <id> --json` for the land's start and end, the land log's vitest "Start at" and "Duration"):

| Land      | Land started (UTC) | Unit tests started | Wait before the tests | Unit tests | Whole land |
| --------- | ------------------ | ------------------ | --------------------- | ---------- | ---------- |
| 9-964190  | 19:50:23.7         | 19:51:05           | 41 s                  | 370.3 s    | 415.4 s    |
| 11-93cfd4 | 20:10:16.3         | 20:10:55           | 39 s                  | 392.6 s    | 435.4 s    |
| 15-5049da | 20:36:19.6         | 20:36:56           | 37 s                  | 359.8 s    | 399.7 s    |
| 20-5acb55 | 21:25:52.2         | 21:26:23           | 31 s                  | 319.5 s    | 351.4 s    |
| 21-e6fd00 | 21:46:34.8         | 21:47:10           | 35 s                  | 343.8 s    | 382.5 s    |

The wait also holds wt's few seconds of rebase and set-up; the receipts of 20-5acb55 are in `~/.cache/pi/receipts/roles-links/land2/land.log`.

**One change, and why it should fix it.** `scripts/check.sh`: the five quick steps (`npm run check:protocol`, `node scripts/check-patches-md.mjs`, `npm run typecheck`, `npm run lint`, `npm run format:check`) start together in the background while `npm test` runs. Each quick step's output goes to its own temp file and is printed after the tests, in today's order, under its usual "== " heading. The script waits for all of them, then fails if any step failed (the unit tests included), naming each failed step. The temp files are removed on exit. Same steps, same commands and options, same sealed temp home; only when they run changes. The full mode's build and real-PTY steps still run after, one after another, unchanged. The machine has 20 cores and the unit tests' run is mostly spread over its workers; the quick steps are short, so they should take little from the tests.

**Expected result, and how it is measured.** `check.sh --fast` takes about the unit tests' time plus a few seconds: 25-30 s less than the quick steps and the tests one after another. Measured by one sealed timed run of the new script, next to one sealed run of the old order (the same five commands, then `npm test`) on the same tree right after it, since the unit tests' own time moves by tens of seconds from land to land (319-393 s above). Then the next real land's time (`wt land-status`) against the five lands above.

**What would prove it wrong.**

- No saving: the tests slow down by about as much as the quick steps used to take (they compete for the CPU).
- A failing step's output is lost, or a failed step doesn't fail the check (wrong exit code). Checked once on the real thing: a temporary lint error in the worktree, then `check.sh --fast` must exit non-zero, show lint's output under "== lint" and name lint as failed.
- A step that fails only when it runs beside the tests (for example a test writing a file into a folder lint, prettier or typecheck reads). Checked by watching those folders for new files during the timed run.

## Result

**Failure path: a failing step still fails the check, loudly (checked Oct 18, 15:10-15:19 PDT).** In the worktree, a temporary `debugger;` in `server/permission-preset.ts`, and `"eslint/no-debugger": "error"` added for the moment to `.oxlintrc.json` (with this repo's lint settings `debugger` is only a warning, so no plain code mistake makes lint fail on its own). Then `TZ=UTC scripts/check.sh --fast`:

- exit 1;
- lint's whole output printed under "== lint", including ``x eslint(no-debugger): `debugger` statement is not allowed`` at `server/permission-preset.ts:23:2` and "Found 47 warnings and 1 error.";
- the last line: `check.sh: FAILED: lint (exit 1). Each step's output is above, under its == heading.`;
- the unit tests ran to the end and passed (423 files, 6159 tests), and the other four quick steps passed, each under its own heading.

Both temporary edits were removed right after. Receipt: `~/.cache/pi/receipts/gate-side-by-side/failure-path.log`. That run took 518 s, because another land's unit tests ran at the same time; it is not the timed run.

Also checked on stand-in steps (a scratch repo whose five quick steps, tests, build and PTY steps only sleep, print to stdout and stderr, and exit with a chosen code), running this `scripts/check.sh` itself:

- every mix of failures is named with its exit code (one quick step; two quick steps and the tests; all five quick steps; the tests alone), and the check exits non-zero;
- a quick step that outlasts the tests is waited for, and its output is printed whole;
- the full mode stops at a failed build with the build's exit code, and doesn't build when a step failed;
- stopping it partway leaves no step running and no temp file behind: Ctrl-C (INT to the whole process group; the check then fails, naming the stopped steps), TERM to the script alone or to the whole group, and HUP to the script alone.

**Trade-off found while testing.** A failing quick step is now reported when the tests end (5-6 minutes in), not at once. In return, one run shows every failure, the tests' included, instead of stopping at the first. Lands rarely fail on a quick step: the chats run this check before they land.

**Timed runs, attempt 1 (Oct 18, 16:08-16:21 PDT).** On this change rebased onto mine `bced3635` (after test-speed, #230, landed), sealed, with `timed-pair.sh`. Receipts are in `~/.cache/pi/receipts/gate-side-by-side/`: `new-run.log`, `old-run.log`, `monitor.log` (load and test runs every 10 s), `watch.log`, `timed.txt`, and the scripts in `harness/`.

- The new script passed (431 files: 6181 tests passed, 6 skipped) in 415 s. The unit tests took 414 s of that (vitest Duration 413 s), so the five quick steps added about 1 s on top of the tests. Beside the tests they took: protocol 0 s, PATCHES.md 0 s, typecheck 17 s, lint 0 s, prettier 111 s.
- No file appeared or vanished, during the run, in the folders that typecheck, lint and prettier read (`watch.log`).
- It isn't a fair comparison yet. Another land's whole test run started 2 minutes in and ran beside it for 4 min 43 s of its 6 min 53 s (`monitor.log`). The old order's run right after it had two other test runs beside it (load up to 37), so I stopped it before its tests ended. Its quick steps, one after another, took 83 s there, using 160 s of CPU in user mode and 16 s in the kernel.

So, in one run, the quick steps no longer add their time to the check. That run doesn't show whether the tests themselves ran slower beside them, which would eat the saving. The unit step's critical path is now one test, test (a) of the guard host tests, on one core for 230-300 s (`docs/test-speed.md`). The quick steps' 176 s of CPU, spread over 20 cores, would cost it about 9 s if every core were busy the whole time. In practice it should cost less: after the first minute that one test runs nearly alone. That is a reason to expect a hit, not a measurement.

**Decided by this task's chat, as Ops' implementer: land first, then take the fair pair.** The plan had the timed pair before the land. I swapped them for three reasons:

1. The change can't loosen the gate: the failure path above shows that, and the land's own gate runs the new script on the landed tree.
2. Every pi-web-ui land tonight (the Initiatives steps, #233, #234) gets the saving at once (rule 26), instead of waiting hours for a quiet machine.
3. The fair pair can be taken any time after: the old order is just the same five commands, one after another, then `npm test` (`harness/old-order.sh`).

Undo: revert the commit.

**Fair pair (Oct 18, 16:39-16:50 PDT).** The landed tree (mine `ca9e409`) in a fresh worktree, built first, sealed: the new script, then the old order right after it (`pair2/pair.sh`). Receipts are in `~/.cache/pi/receipts/gate-side-by-side/pair2/`. The machine was quiet: no land, and no other test run during either (`monitor.log`). Both passed: 431 files, 6181 tests passed, 6 skipped.

|                                                                      | Old order (one after another)                            | New order (side by side)                                                   |
| -------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `check.sh --fast`, start to end                                      | 329.4 s                                                  | 319.5 s                                                                    |
| the quick steps                                                      | 33.7 s before the tests (80.1 s user CPU, 11.6 s kernel) | beside the tests: typecheck 15 s, prettier 100 s, lint 1 s, the others 0 s |
| the unit tests                                                       | 294.9 s                                                  | 319 s                                                                      |
| test (a) (`tests/unit/role-message-guard-host-worst-window.test.ts`) | 289.0 s                                                  | 306.8 s                                                                    |
| vitest Duration minus test (a)                                       | 5.5 s                                                    | 10.9 s                                                                     |
| the other five guard host files                                      | 11.5-35.4 s                                              | 13.1-40.3 s, each 8-42% slower                                             |

**The land.** wt land 32-2df30b landed `ca9e409` (23:32:35-23:38:15 UTC) in 339.8 s, its tests starting 1 s in (Duration 335.2 s, test (a) 326.6 s). The last land before it that had the machine to itself, 29-3c4e9f (initiatives-exact, old order), took 340.6 s, its tests starting 38 s in (Duration 299.1 s, test (a) 293.7 s). That isn't a fair comparison either: #233's own test run shared the machine for the land's first 3 min 10 s (load up to 24, `land/monitor.log`). The five lands in the first table came before the test split (#230), so they don't compare.

**H-GATE-SIDE-BY-SIDE-1: MISS on its 25-30 s bar (Oct 18).**

- The check now ends within a second of the unit tests, as expected. But on a quiet machine it saved 9.9 s (3%), not 25-30 s: the 33.7 s of quick steps no longer come first, but the unit tests took 24 s longer beside them.
- Nothing was lost: no step was dropped, a failing step still fails the check by name with its output (above), and the landing gate passed.
- Test (a)'s time moves by about 20 s between runs even on a quiet machine (289-309 s in the four old-order runs since the split), so one pair puts the saving at about 10 s, give or take that much. The slower start of the tests and the slower guard host files, all in the first minutes while both run, say at least part of the cost is real.

**Kept, decided by this task's chat as Ops' implementer (not the owner's consent).** The check is about 10 s faster on a quiet machine and just as strict; reverting would cost a land and give that up. Its cost stays as written above: a failing quick step shows when the tests end. Undo: revert `ca9e409`.

**Next hypothesis, H-GATE-SIDE-BY-SIDE-2 (not started; Ops queues it or drops it).**

- Wrong, and the evidence: the quick steps' 92 s of CPU (measured in a row) lands in the first 100 s or so, while vitest's 431 files already keep the 20 cores busy (load up to 23). Prettier took 100 s there, against its part of 34 s in a row. After that, test (a) runs alone for about 200 s while 19 cores sit idle.
- One change: start the quick steps with `nice -n 19`, so they get only the CPU the tests leave idle.
- Expected: the unit tests as fast as in the old order, and the check about 30 s faster than the old order. Measured with three alternating pairs on a quiet machine, comparing the means, because of test (a)'s spread.
- Disproved if the tests are still slower by about as much, or the quick steps end after the tests.
- Wait for #233 (the guard store speed-up) first. If it makes test (a) short, the unit step becomes one burst on all 20 cores with no idle tail. Then `nice` would hold the quick steps back to the end, and the plain side by side should come close to 30 s by itself (92 s of CPU over 20 cores is about 5 s). So after #233, re-measure the plain side by side with a fair pair first.
