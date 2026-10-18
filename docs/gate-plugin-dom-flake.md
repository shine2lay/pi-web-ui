# Gate: the plugin-dom teardown flake

Ops #229 (project faster-landing, 2026-10-18). Accountable lead: Ops. Essential maintenance (rule 14): the flake refuses every role's pi-web-ui lands. Test-only change: nothing to install or restart.

## H-GATE-PLUGIN-DOM-1

Written 2026-10-18 before any change.

**Wrong, and the evidence.** The landing gate (`scripts/check.sh --fast`, its `npm test` step) is refused with "Errors 1 error" while every test passed:

```
EnvironmentTeardownError: [vitest-worker]: Closing rpc while "onUserConsoleLog" was pending
This error originated in "tests/unit/plugin-dom.test.ts" test file.
```

Three times in two days: 2026-10-17 (the Roles exact land, `docs/roles-exact.md` H6), 2026-10-18 12:07 (#213's docs-only land: 419 files, 6117 tests passed; `~/.cache/pi/left-task-status/result-land-try3.log`) and 2026-10-18 14:31 (#222's docs-only land 20-5acb55: 423 files, 6159 tests passed; `~/.cache/pi/receipts/roles-links/land2/land.log:1174`). Each costs the task a retry of about 8 minutes and a lead decision. Fix 839ebcc2 (Oct 17) already replaced `console.log` with a spy in the file's integration fixture (`vi.spyOn(console, "log")` in `beforeEach`, restored in `afterEach`), and the error came back.

**How the error comes about (vitest 5.0.1, read in its source).** Vitest replaces the test worker's console: every write goes to the main process as an `onUserConsoleLog` call one microtask later, even with `silent: true`. When a file is done, the worker waits for the calls pending at that moment (`rpcDone()`), then rejects any call still pending with this error (`$rejectPendingCalls`), which then shows as an unhandled rejection. So a console write that comes after the file's last test, and whose call is still unanswered when the worker closes, fails the gate. Under load the main process answers later, so the window is wider.

**Suspected cause.** Async plugin work that the test doesn't wait for writes to the console after the test ends: either `console.log` after `afterEach`'s `mockRestore`, or `console.info`/`warn`/`error`/`debug`, which the spy doesn't cover.

A candidate read from the code, to be confirmed by the tracer and not assumed: `PluginManager.setDomConsent` starts a rescan of the plugins folder without waiting for it (`void this.pushToAll()`, `server/plugins.ts`). The last test ends with `setDomConsent("domplug", false)`, so one rescan may still be running while `afterEach` deletes the temp folder. `scan()` then logs `console.error("[plugin:<id>] manifest.json missing or unparsable …")` for each plugin it can no longer read.

**The one change, and why it should fix it.** Whatever the tracer shows. The tracer is temporary and never committed: it wraps the console methods for this file and records the method, the stack and whether the test had already ended. Preferred fix: `afterEach` waits for the plugin manager's pending work (or stops it) before it disposes the manager, deletes the folder and restores the spy; or the late writer itself is fixed. No weakening of the gate: no `dangerouslyIgnoreUnhandledErrors`, no `onConsoleLog` filter, no global console silencing, no retry in `scripts/check.sh`; no test deleted, skipped or loosened, permission assertions unchanged.

**Expected result, and how it is measured.** A script runs the file 40 times, 6 at once, each run sealed (`scripts/sealed.sh`) with `TZ=UTC`, and counts the runs whose output has "EnvironmentTeardownError". If the single file never shows it, the whole unit suite runs twice under the same load. The same loop runs before and after the fix. Before: at least one teardown error. After: 0, with all of the file's tests passing, and the `wt land` gate passing. Results in `/home/shinelay/kept-from-tmp/2026-10-18/gate-plugin-dom/`.

**What would prove it wrong.** The baseline can't reproduce the error (then nothing is changed: "not reproduced" is recorded here and Ops decides what's next), or teardown errors still show after the fix.

## Baseline and tracer (2026-10-18, before the fix)

Baseline, the measure loop on mine at d39954df, 3 loops of 40 (14:54-14:57, load average 12-20 on 20 cores): 1 of 120 runs had the teardown error (loop 1: run 2; loops 2 and 3: none). All 19 tests passed in all 120 runs. So the error is real but rare in a single-file run; the gate's whole suite runs under heavier load.

Tracer, 40 runs of the same loop with the tracer as an extra setup file (14:58-14:59):

- In 40 of 40 runs the file wrote to the console after its last test (after the outermost `afterAll`): 2 writes per run, 80 in all, and no other write at any time (the `console.log` spy holds the activation logs).
- All 80 are `console.error("[plugin:<id>] manifest.json missing or unparsable (<id>/), not a valid plugin …")` at `PluginManager.scan` (`server/plugins.ts:3093`), called by `PluginManager.pushToAll` (`server/plugins.ts:2041`), once for `domplug` and once for `plain`.
- Run 21 also had the gate's error: its second late write's `onUserConsoleLog` call ("[plugin:plain] manifest.json missing…") was rejected at teardown with "EnvironmentTeardownError: [vitest-worker]: Closing rpc while "onUserConsoleLog" was pending".

So the candidate is the cause. The last test's `setDomConsent("domplug", false)` starts a rescan it doesn't wait for (`void this.pushToAll()`). `afterEach` deletes the temp folder while the rescan is still listing it, so the rescan logs one `console.error` per plugin it can no longer read, after the file's last test. The error shows only when one of those calls is still unanswered when the worker closes. It is `console.error`, which the Oct 17 `console.log` spy never covered.

**The one change.** `afterEach` waits for every rescan the plugin manager started during the test (a spy on its `pushToAll` keeps their promises) before it disposes the manager and deletes the folder. The rescan then reads the folder while it still exists and logs nothing. Test-only; `server/plugins.ts` is unchanged.

**Added measure.** Besides the loop's error count, the same tracer run after the fix must show 0 console writes after the file's last test, in every run. The error itself is rare in a single-file run (1 in 120 before), so 0 errors after the fix alone would prove little; the late writes it needs were in every run.

## After the fix (2026-10-18 15:01-15:05)

The same loops on the fix, same machine, load average 7-17:

| | Before (d39954df) | After |
| --- | --- | --- |
| Measure loop, 3 × 40 runs: runs with the teardown error | 1 of 120 | 0 of 120 |
| Tracer loop, 40 runs: runs with the teardown error | 1 of 40 | 0 of 40 |
| Tracer loop: runs writing to the console after the file's last test | 40 of 40 (80 writes) | 0 of 40 (no write at any time) |
| Tracer loop: `onUserConsoleLog` calls rejected at teardown | 1 | 0 |
| Runs with a failed test (19 tests each) | 0 of 160 | 0 of 160 |

One normal run of the file afterwards (sealed, `TZ=UTC`, verbose): 19 of 19 passed.

Files in `/home/shinelay/kept-from-tmp/2026-10-18/gate-plugin-dom/`: `loop.sh` (the measure loop), `baseline-1..3/` and `after-1..3/` (each run's output, `summary.txt`), `tracer/` (the tracer, its config and `analyze.mjs`), `tracer-before/` and `tracer-after/` (runs and `analysis.txt`), `traces-before/` and `traces-after/` (one trace file per run), `normal-run.log`.

## Result

Pending the landing gate (the plan's third check).
