# Gate: the landing check runs only the unit tests a change can affect

Ops #693, for Systems rm-c24ccd7a: the owner asked (via COO rm-f6106b33) that lands stop running test suites a change can't affect. Accountable lead: Ops. The range comes from wt (Ops #691, agent-tools `docs/wt-check-range.md`); the daily read map is Ops #694.

## What it does

`scripts/check.sh --fast`, the check `wt land` runs for pi-web-ui, used to run every unit test file (575 on `mine` 5e36933a) for every code change. In the last 10 lands before this change the unit step alone took 637 to 1,480 s, median 924 s (their `== times, side by side` lines, Oct 31 08:04 to Nov 1 01:47 PDT).

Now, before sealing, `check.sh --fast` asks `scripts/select-tests.mjs` which unit test files the land's range `WT_BASE..WT_HEAD` can affect, and runs only those. It prints one line before the unit tests:

- `unit tests: N of M files (A related, B read map, C changed, D since map <commit>, map <commit>)` (parts that are 0 are left out), or
- `unit tests: all (<reason>)` when it runs every file.

Unchanged: plain `scripts/check.sh` (no `--fast`), which always runs every unit test; `--notes`; the quick steps (protocol, PATCHES.md, typecheck, lint, Prettier scope); sealing and the CPU launcher.

Check a range by hand: `WT_BASE=<base> WT_HEAD=<head> node scripts/select-tests.mjs` prints `all <reason>` or the test files, one per line.

## How it picks

The selected set is the union of:

1. **Related**: unit test files that reach a changed path through the import graph at `WT_HEAD` (`scripts/test-import-graph.mjs`). The walk starts from every changed path still there, not only code: an asset a module imports (`./surface.html?raw`, a JSON file) reaches the tests of that module, and a test file another test imports (`tests/unit/task-queue-canonical.test.ts` imports seven) reaches its importer. The graph reads static `import`/`export ... from`, `import()`, `require()`, `new URL(..., import.meta.url)` and `import.meta.resolve()` with a literal relative specifier; queries such as `?raw` are stripped; a type-only import is skipped only when every import of that specifier is type-only. Checked once against rolldown's parser on the whole repo: 7,543 value specifiers, none missing from ours. Tests whose recorded modules (read map) are in the reach count too, which covers computed imports.
2. **Read map**: tests that read, listed or copied a changed path while they ran (below).
3. **Changed**: unit test files the range changes or adds.
4. **Since map**: unit test files changed between the read map's commit and `WT_BASE`, and tests the map marks incomplete.

It runs everything (`all`) when it can't be sure:

- `WT_BASE` unset, not a commit or not an ancestor of `WT_HEAD`; `WT_HEAD` not a commit; any git error;
- a changed `package.json`, `package-lock.json`, `vitest*.config.*`, `vite*.config.*` or `tsconfig*.json` (any folder);
- a changed `setupFiles` entry of `vitest.config.ts`, or any file those entries or `vitest.config.ts` import; `vitest.config.ts`'s `include` no longer the single `tests/unit/**/*.test.ts`;
- a changed gate or selector file: `scripts/check.sh`, `scripts/sealed.sh`, `scripts/sealed-summary.mjs`, `tests/lib/sealed-test-launch.mjs`, `tests/lib/sealed-fence.cjs`, `scripts/select-tests.mjs`, `scripts/changed-files.mjs`, `scripts/is-main-module.mjs`, `scripts/test-import-graph.mjs`, `scripts/test-read-map.mjs`, `scripts/test-read-map-store.mjs`, `scripts/unit-test-files.mjs`, `tests/lib/record-file-reads.ts`, `tests/lib/file-read-recorder.cjs`;
- a deleted or renamed-away non-test file (a rename counts as its old path deleted and its new path added, as wt's range does);
- an unknown path: neither a source file, nor a file a module imports, nor a path in the read map, nor a notes path (`PATCHES.md`, `docs/**/*.md`);
- a source file the graph can't read;
- no read map whose commit is an ancestor of `WT_BASE`;
- a range that changes no files, or a change no unit test reaches (none of the last 100 code changes);
- the selector failing or printing nothing (`unit tests: all (selector failed)`).

The changed files come from `scripts/changed-files.mjs` (`git diff --no-renames`), which `scripts/prettier-scope.mjs` uses too.

## The read map

Why: 133 of the 571 unit test files at the map's commit read repo files by path while they run (`readFileSync`, `readdir`, a child process running a script), which no import graph sees; 18 of them also list folders. Every test also reads `plugins/page-picker/extension/_locales/zh_CN/messages.json` (through `tests/unit/setup-chrome-i18n.ts`) and its snapshots.

- Recorder: `tests/lib/record-file-reads.ts`, the first `setupFiles` entry, does nothing unless `PI_TEST_READ_MAP` is set. Then `tests/lib/file-read-recorder.cjs` records, per test file, every repo path read, stat-ed, opened, listed (`readdir`, `opendir`), copied or loaded: `fs` sync, callback and promise forms, `createReadStream`, child processes (their `node` gets the recorder through `NODE_OPTIONS`, and argv words naming repo files count), and the modules vitest evaluated for that file (covers `?raw` and computed dynamic imports). `node_modules`, `.git` and paths outside the repo are left out.
- `node scripts/test-read-map.mjs` (in a clean checkout, through `wt slot --`) runs the whole unit suite sealed with the recorder and writes `~/.cache/pi-web-ui/test-read-map/<commit>.json` (folder 0700, file 0600): per test file its `reads`, `dirs`, `trees` and `modules`, plus `incomplete` (tests that failed or never finished). Paths only, never file contents. `PI_TEST_READ_MAP_DIR` points it, and the selector, at another folder.
- The recorder adds no failures: the map run at the time of writing ran 571 files, 571 passed.
- The selector uses the newest map whose commit is an ancestor of `WT_BASE` (fewest commits between); none means `all`. Tests changed since that commit are always selected, so an older map only grows the "since map" part.
- Seeded by Ops #693 on its landed commit. Keeping it fresh (daily) is Ops #694.

## Build output

`dist/` and `web/dist/` are gitignored, so no change ever names them, yet 5 unit tests use them: `durable-env-and-migrator`, `durable-migrator`, `durable-w3-cutover` and `systemd-install` load or read built server code in `dist/server/`, and `vite-build-target` reads the web bundle in `web/dist/assets`. The read map records those paths as they are; the selector traces them back to what they are built from (`builtFrom` in `scripts/select-tests.mjs`):

- `dist/server/<path>.js` is tsc's output of `server/<path>.ts` (`tsconfig.server.json`: `rootDir` `server`, `outDir` `dist/server`), file by file; any other file there is a copy of `server/<path>` (`scripts/copy-dsh-runtime.mjs`). A test that loaded or read a built file is selected when its source changes, and through the import graph when a change reaches that source.
- `web/dist/**` is vite's one bundle of the web app (`web/vite.config.ts`): a test that used it is selected when anything under `web/` changes, or anything the web app imports from outside `web/`.
- Any other `dist/` path (none today) isn't traced: a test that uses it runs on every change.

These tests run against whatever `dist/` the land's checkout holds, as in the full run; building before a land (`npm run build`) is unchanged. When `dist/` is missing, the scripts they run fall back to the TypeScript source through tsx, and a map recorded then holds those sources as modules directly.

## What it can't see

- A test that fails for a reason no change in the range can cause (a soak test timing out under machine load, a test already failing on `mine`) no longer stops an unrelated land. The full check and the daily map run still run every file.
- A file read by a non-Node child process of a test (a shell script's `cat`, `git show`) is in the map only as the command's argv words; when such a file is in no other test's map and no module imports it, a change to it is an unknown path, so everything runs.
- A test whose reads changed since the map (through a changed helper) keeps its old reads until the next map; tests changed since the map are always selected.

## Hypotheses

### H-SELECT-SAFE

**Wrong now, and the evidence.** Every code land runs all unit test files, whatever it changes (above).

**The one change.** Run only the files the range can reach, as above, and everything when unsure.

**Expected, and how it's measured.** The selection never drops a test the full run would fail. Measured two ways: (1) every recorded unit test failure in past pi-web-ui land checks: the selection for that land's range must include every failing test file; (2) 8 injected faults: each full run's failing files must be among the selected run's failing files.

**What would prove it wrong.** A single failing file missing.

**Result: part 2 HIT; part 1 MISS as written, 0 change-caused misses; landed on the lead's decision.** The 8 injected faults: no failing file missed. The past failures: 42 failing files in 32 of the 58 failed runs were outside the selection (Results). Checked one by one, none was caused by its land's change: rerun alone, 28 passed at the land's own commit, 2 failed and passed at the same commit, and 8 failed at the land's base too, that is before the change. So the selection drops failures a change doesn't cause, the trade-off under "What it can't see"; it dropped none that a change caused.

**Lead decision (Ops, 2026-11-01):** land, with part 1 MISS as written. Reason: the bar is there so that no failure a change causes gets dropped. All 38 distinct pairs outside the selection were not caused by their land's change: 28 pass alone at the land's own commit, 2 are flaky at the same commit, 8 fail at the base. So 0 change-caused failures were dropped. No selector rule can include tests a change can't reach without running everything, and running everything is what the owner asked to stop (COO rm-f6106b33). The trade-off stays under 'What it can't see'. The full check and Ops #694's daily full run still run every file.

### H-SELECT-SPEED

**Expected, and how it's measured.** Replaying the selection only (no test runs) over the last 100 code changes on `mine`, the median selection is at most 15% of the files. After the land, the next 10 code lands' unit-test time has a median of at most 3 min, against 924 s, the median of the last 10 lands before.

**What would prove it wrong.** A median selection above 40%.

**Replay: HIT** (median 9.70%). **After the land: open**, measured on the next 10 code lands once this change and the seeded map are live (bar: median unit step at most 180 s, against 924 s before).

### H-SELECT-ASSETS (found while measuring, before the land)

**Wrong, and the evidence.** The first version walked imports only from changed code files, and called any other path not in the read map unknown. A change to `web/src/initiatives-u0/surface.html`, which `surface.ts` imports with `?raw`, selected only the 5 tests that read it by path; the 12 tests that import `surface.ts` were left out.

**The one change.** Start the import walk from every changed path still there (assets and test files too), and count a file a module imports as known.

**Expected, and how it's measured.** The new unit test (a `?raw` HTML file and a JSON file imported by a module, and a JSON file a test loads with a computed import) fails on the old selector and passes on the new; the replay median stays at most 15%.

**What would prove it wrong.** The test still failing, or the median rising above 15%.

**Result: HIT.** The test failed on the old code (`expected 'unknown path web/panel.html' to be undefined`) and passes now; replay median 9.61% at the time.

### H-SELECT-BUILT (found while measuring, before the land)

**Wrong, and the evidence.** The read map records built files by their build path (`dist/server/durable-migrator.js`, `web/dist/assets`), which no change names. 5 tests use built code ("Build output"): a change to `server/durable-migrator.ts` landing together with any other change that selects a test would have left `durable-migrator.test.ts` out.

**The one change.** Trace build output back to its sources in the read index, as under "Build output".

**Expected, and how it's measured.** Two new unit tests (built server code loaded, read and listed; a web bundle with an asset and an import from outside `web/`; untraced build output) fail on the old selector and pass on the new; the replay median stays at most 15%; no past failing file newly missed.

**What would prove it wrong.** A test still failing, the median above 15%, or a past failing file newly missed.

**Result: HIT.** Both tests failed on the old code (`expected [ 'tests/unit/alpha.test.ts' ] to deeply equal [ 'tests/unit/alpha.test.ts', …(1) ]`, the built-code test dropped; `expected 'unknown path web/public/logo.svg' to be undefined`) and pass now. Replay median 9.70%, against 9.61% before (below). No past failing file newly missed; none of the past failures was in these tests' reach through built code, so it changed none of them.

## Results

Receipts: `~/kept-from-tmp/2026-11-01/gate-selected-tests/` (scripts and their outputs).

**Replay (H-SELECT-SPEED).** The last 100 code changes on `mine` up to 5e36933a (Oct 25 on), selection only, with the landed selector and the map of 571 files (all passed) standing in for each change's own map, stamped with its parent: median 49 files, 9.70% (p25 2.80%, p75 16.76%, mean 19.34%). 12 of the 100 ran everything: `package-lock.json` 3; `vitest.config.ts`, `vitest.question-coupled.config.ts`, `tsconfig.question-coupled.json`, the setup file `tests/unit/setup-hang-guards.ts` and `scripts/check.sh` 1 each; a deleted non-test file 2 (`tests/board-test.mjs`, `docs/roles-contact.md`); an unknown path 2 (`README.md`, `deploy/pi-web-ui.service`). With a map up to a day old, as Ops #694 will keep it: median 57 files, 10.57% (p75 18.42%, mean 21.42%). With each stamped map cut down to the paths that existed at its commit (a real map made then couldn't know later files): median 9.72%, one more full run (a change no test reached); a day old, 10.52%.

**8 injected faults (H-SELECT-SAFE part 2).** One throwaway commit each on the worktree (572 unit test files then), each run in full and selected, sealed, `VITEST_MAX_WORKERS=2`, then dropped. Missed failing files: none.

| Fault | Selected | Failing in the full run | Failing in the selected run |
| --- | --- | --- | --- |
| `server/dsh/dsh-agent-service.ts`, a module tests read as text | 12 (4 related, 10 read map) | `conversation-limits.test.ts` | the same |
| `server/dsh/dsh-usage.ts`, a module tests import | 11 | `dsh-usage.test.ts` | the same |
| `web/src/components/PendingRecoveryPanel.tsx`, a web component | 5 | `pending-recovery-panel.test.ts` | the same |
| `server/protocol.ts`, the shared protocol types | 59 (51 related, 11 read map) | `no-plan-board.test.ts` | the same |
| `tests/lib/sealed-runs.mjs`, a tests/lib helper | 2 | `sealed-runs.test.ts` | the same |
| `tests/fixtures/role-messages-persistence-golden.json`, a fixture read by path | 1 (read map) | `role-messages-persistence.test.ts` | the same |
| `docs/patches-union.md`, a doc a unit test reads | 1 (read map) | `patches-union.test.ts` | the same |
| `server/dsh/dsh-usage.ts` deleted | all (deleted non-test file) | `dsh-usage`, `usage-accounting-collector`, `usage-accounting-pi-sessions` | the same |

**Past failures (H-SELECT-SAFE part 1).** wt's records (`~/.local/state/wt/lands.jsonl`, `batches/`, the land units' journals) hold 58 failed pi-web-ui land checks with failing unit tests, Oct 18 13:43 to Oct 31 16:47 PDT (51 single lands, 7 batches): 95 failing (run, file) pairs. With the map stamped at each land's base, the selection holds every failing file in 26 of the 58 runs (8 of them full runs) and 53 of the 95 pairs. The other 42 pairs (32 runs; 38 distinct pairs of land commit and file) failed by timeout 27, assertion 9, module not found 4, other 2. Each was rerun alone, sealed, at the land's commit and, when it failed there, at its base; the 5 that failed at the commit and passed at its base were rerun again, up to 3 times at the commit and 2 at the base (for those 5, neither the test's imports nor its recorded reads and modules contain a changed file: its code is the same at base and head). The rerun checkouts had no build; the scripts that load built server code fall back to the TypeScript source then, so each rerun ran its own commit's code:

| Rerun alone | Distinct pairs |
| --- | --- |
| Passed at the land's own commit (failed only under the land's load) | 28 |
| Failed and passed at the same commit (35 `role-message-guard-host-late-handoff`, 54 `durable-w3-cutover`) | 2 |
| Failed at the land's base too (runs 2, 47 with two files, 51; on the second rerun 36, 41, 48 and 49: the soak tests time out at both, `durable-migrator` too) | 8 |

## Undo

Revert this patch. It changes only the landing check: nothing to install or restart. The read maps in `~/.cache/pi-web-ui/test-read-map/` can stay or be deleted; without this patch nothing reads them.
