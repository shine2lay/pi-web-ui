# Test speed: the role-message guard host tests

Owner 2026-10-18 (m57369): "can we improve the speed of tests?" (Ops #230, project faster-landing). Accountable lead: Ops.

Test-only change: no server, web or storage code changes, nothing to install or restart.

## H-TEST-SPEED-1 (written before any change)

**Wrong, and the evidence.** Every pi-web-ui land waits about 6.5-7 minutes for its checks (`scripts/check.sh --fast`), and one test file is most of it.

- The land requests of 2026-10-18 (`.git/wt-land-queue/` in the main folder) that landed took 382-441 s from start to end (one batched land 532 s, one 777 s); the median is about 400 s.
- In 14 land logs from the same day (`~/.cache/pi/receipts/*/land*.log`, `~/.cache/pi/left-task-status/*land*.log`, `~/.cache/pi/task-210/land*.log`), the unit tests' vitest Duration was 319-393 s and `tests/unit/role-message-guard-host.test.ts` alone took 312-387 s. Duration minus that file is 5-10 s in every log, so that one file is the whole critical path of the unit step.
- Inside it (`~/.cache/pi/receipts/roles-links/land2/land.log`, Duration 319.5 s, file 312.3 s): test "(a) Ops rm-fc4b9788: the worst real 5 hours twice plus 100 runaway sends …" took 230.3 s; the other 31 tests took about 82 s, one after another.
- The other 422 files are about 237 s of work spread over about 19 workers (20 cores) and finish in about 40 s. The next longest file is `tests/unit/role-message-guard-core.test.ts` at 27-33 s.

**Two causes (to be confirmed by the profile below).**

1. vitest runs the tests of one file one after another, in one worker. 32 heavy tests in one file make a 5-6 minute critical path while the other workers sit idle.
2. Test (a) replays 428 sends (two copies of the worst 5 hours plus 100 runaway sends) through the real guard store. Each send makes durable writes of the whole multi-MB journal and canonical file: write a temporary file, `fsync` it, rename it, `fsync` the folder (`server/role-message-guard-store.ts`, `durable()`; `server/role-message-guard-host.ts:269-279`, `writeDurable`). The test folder is on ext4 (`/tmp`), so every one of those flushes reaches the disk, under the load of 19 other workers.

**The change (one concern, test files only).**

1. Split `tests/unit/role-message-guard-host.test.ts` by its describe blocks into several files that share `world()` and the other setup through one helper module, so vitest runs them side by side.
2. Profile test (a) first, then make it fast while it proves exactly the same claim. Preferred: its temporary folder on tmpfs (`/dev/shm`), so `fsync` costs nearly nothing. Otherwise the smallest equivalent change the profile points to. Same events, same runaway sends, same bars.
3. If it's cheap, split `tests/unit/role-message-guard-core.test.ts` (about 30 s) the same way.

**Expected, and how it's measured.**

- The full unit suite (`scripts/sealed.sh env TZ=UTC npx vitest run`): vitest Duration 60 s or less, and every guard-host file 30 s or less, read from the run's own Duration and per-file times.
- Then the next real land of this change: its run time from `wt land-status` about 2 minutes (from about 6.5-7).
- The same 6165 tests (6159 passed, 6 skipped), and for the old host file the same 32 tests, now spread across the new files.

**What would prove it wrong.** Duration still over 120 s, a lower test count, or any changed assertion.

## Profile of test (a)

Measured before changing test (a). Receipts in `~/.cache/pi/receipts/test-speed/`.

- Test (a) alone (sealed, `-t "\(a\) Ops"`), two runs side by side on a busy machine: on `/tmp` (ext4) 614 s (`a-ext4.log`), with `TMPDIR=/dev/shm` (tmpfs) 569 s (`a-shm.log`). tmpfs saves about 7%, so the disk flushes are not the cost: **cause 2 as written is wrong.**
- CPU profile (`node --cpu-prof`, a 517 s run, `prof-a/`): the worker was busy almost the whole time (100-113% CPU); 17% of the samples are idle (waiting on file reads and writes).
  - Self time: `structuredClone` 16%, garbage collection 10%, `sortedJson` 10%, sha256 hashing 6%, then `sortedCopy`, `decode`, `keysSorted`, `composeSorted`, `safeJson`, `load`, `deepFreeze`. 35% of all self time is in `server/role-message-guard-store.ts`.
  - Including callees: the store's transaction (`server/role-message-guard-store.ts:515`) 48%; canonical sorted JSON 18.5%; `structuredClone` 16% (the store's `read()` returns `structuredClone(bundle.state)`: 10%; inside the transaction: 6%); `guardDigest` (`sha256(sortedJson(value))`) 14%; decoding and verifying the stored state 11%; the durable writes themselves, `fsync` included, 3.7%.
- So the time is the guard store's own whole-state work on every operation: a canonical sorted JSON and a sha256 of the whole state, deep copies, and a full verify, each in proportion to the state (up to about 5 MB in the worst window), for each of the 428 sends. That is about 0.5 s of CPU per send under land load (230-300 s in the land logs) and about 1.2 s in these runs. The test's own reading of the state after each send (to measure the fill) is a few percent.
- That is production code (the Security-reviewed guard store). The plan's stop rule applied: no store change in this task. Ops, the accountable lead, decided (2026-10-18, rule 21; its technical decision, not the owner's consent): land the split now, and making the store fast becomes its own Ops task, with Security review.
- What test files alone can do: the split takes the other 31 tests (about 82 s) off test (a)'s path, and a sequencer starts test (a)'s file first. The unit step then lasts about as long as test (a): 230-300 s under land load, not 60 s.
- Side finding for production: at the worst window's fill, each role message costs pi-web-ui's server about half a second of CPU on its main thread.

## What was changed

- `tests/unit/role-message-guard-host.test.ts` split by its describe blocks into seven files: `-hops`, `-grants`, `-approvers`, `-chain`, `-limits`, `-caps` (storage caps (b)-(f) and the approval history) and `-worst-window` (test (a) alone). Shared world: `tests/unit/role-message-guard-host-harness.ts`. A script compared every describe block with the old file's: byte-identical apart from the three clock moves (`now += …` and `now = …` became `setNow(…)`), and `stateOf`, which both storage-caps files keep.
- `vitest.config.ts`: a sequencer that starts `-worst-window` first (in a fresh copy vitest starts larger files first, and this file is small).
- Test (a) is unchanged: no test-only change can make it much faster (profile above).
- `tests/unit/role-message-guard-core.test.ts` (27-33 s) stays one file: it is far off the critical path while test (a) takes minutes.

## Results

### Full unit suite after the split (2026-10-18 15:35, sealed, `full-run.log`)

- Tests: 6165 (6158 passed, 6 skipped, 1 failed). The failure is `tests/unit/systemd-install.test.ts`, which needs a built `dist/` (`npm run build`, which a land runs first); unrelated to this change. The old file's 32 tests: 7 + 5 + 5 + 4 + 4 + 6 + 1 = 32 across the new files.
- vitest Duration 394.5 s (wall 396 s), with another land's full test run on the machine at the same time (load average up to 29).
- Slowest 10 files: `-worst-window` 388.5 s, `-hops` 49.3 s, `-approvers` 43.7 s, `role-message-guard-core` 32.1 s, `-caps` 25.1 s, `-limits` 20.5 s, `-chain` 16.8 s, `conn-events` 16.4 s, `sealed-fence` 12.9 s, `plugin-telegram` 10.1 s.
- Duration minus the slowest file: 6 s. Before, the slowest file also held the other 31 guard tests, 82-87 s under land load; those now run beside test (a).

### The land (request 28-8bc0b2, 2026-10-18)

- Landed 103c6c1 on mine at 16:01 and pushed it to origin/mine.
- 2.5 minutes in line, then 708 s (11 min 48 s) from start to end, because its checks ran twice. It first went in a batch with 29-3c4e9f (initiatives-exact), and the combined checks failed: `tests/unit/systemd-install.test.ts`, because a batch folder has no `dist/` (the known batch fall-back), and `tests/unit/roles-origin.test.ts`, which passed in this change's own run. Then wt checked this change on its own. Each of the two check runs took about 355 s.
- The next land, 29-3c4e9f, ran on its own on top of this change: 341 s from start to end (23:01:40-23:07:21 UTC).
- Tests in the land's own run: 6173 (6167 passed, 6 skipped), the same as the last land with the old file (initiatives-plan-data-result, 22:22 UTC: 6173, 6167 passed, 6 skipped). The 8 more than the 6165 above are in `tests/unit/work-page.test.ts` (aad34732), which landed in between.

### Before and after, from the land checks

|                         | Before: 19 land runs on 2026-10-18, old file  | After: 3 land runs, split                    |
| ----------------------- | --------------------------------------------- | -------------------------------------------- |
| vitest Duration         | 318-397 s, median 344 s (one 589 s)           | 299, 306, 314 s                              |
| test (a)                | 230-300 s, median 253 s (one 479 s)           | 294, 299, 309 s                              |
| Duration minus test (a) | 88-112 s, median 93 s                         | 5.0-6.4 s                                    |
| a land, start to end    | 382-441 s, median about 400 s (one check run) | 341 s (29-3c4e9f); about 355 s per check run |

The 589 s and 479 s run shared the machine with the profile runs of test (a). Before: `~/.cache/pi/receipts/*/land*.log`, `~/.cache/pi/left-task-status/*land*.log`, `~/.cache/pi/task-210/land*.log`. After: `~/.cache/pi/receipts/test-speed/land1/land.log` (two runs) and `~/.cache/pi/receipts/initiatives-exact/land2/land.log`.

### H-TEST-SPEED-1: MISS (the 60 s bar)

- The bar: MISS. The unit step now lasts as long as test (a): 299-314 s in the land checks, not 60 s, and a land takes about 5.7-6 minutes, not 2. The bar needs test (a) itself to get faster, which means the store (production code), outside this task.
- Cause 1, one file's tests run one after another in one worker: HIT. Everything besides test (a) went from a median 93 s of the Duration to 5-6 s: the other 31 guard tests now run beside test (a). Same 6173 tests, same assertions.
- But in all three runs after the split, test (a) itself took 294-309 s, against a median 253 s before. So the measured saving is about 40-60 s per land (Duration median 344 s -> 306 s; a land about 400 s -> 341-355 s), not the 87 s the split took off the rest. Why test (a) is slower was not measured. Candidates: it now starts cold, in a fresh worker that shares the processors with the other 429 files during the first minute, where before it began about a minute in, after the other guard tests had warmed the same worker, with the other files already done; or the machine's load (the last old-file land, at 22:35 UTC, also had test (a) at 285 s). The store task (H-TEST-SPEED-2) makes this moot if it brings test (a) near 60 s; if not, test the cold start on its own (rule 16) before changing anything.
- Lesson: test (a)'s time moves with the machine's load (230-479 s in the lands, 517-614 s alone beside other runs), so compare the Duration minus test (a), not one land's Duration against another's.
- Cause 2, `fsync` of the guard files on ext4: MISS. `/dev/shm` saved only about 7% (614 s against 569 s), and the durable writes, `fsync` included, are 3.7% of the profile. The time is CPU in `server/role-message-guard-store.ts`: per send, a canonical sorted JSON and a sha256 of the whole state, a `structuredClone` on every read, a full decode and verify, then garbage collection; about 0.5 s per send at about 5 MB, times 428 sends. Profile receipts: `~/.cache/pi/receipts/test-speed/` (`a-ext4.log`, `a-shm.log`, `prof-a/`).

### H-TEST-SPEED-2 (a starting point for the separate store task; not tested here)

- Wrong, and the evidence: every guard store operation costs time in proportion to the whole state, not to the change (profile above: sorted JSON 18.5%, `structuredClone` 16%, the digest 14%, decode and verify 11%), so each send costs about 0.5 s at about 5 MB, in test (a) and in the live server.
- The change: make the per-send work scale with the change, for example no deep copy when reading a frozen state, and cached digests of parts that didn't change; the same stored bytes and the same verdicts. The store task confirms this with its own profile first, and Security reviews it.
- Expected, and how it's measured: test (a) in 60 s or less (294-309 s in the land checks now, 569-614 s alone beside other runs), the unit step's Duration 60 s or less, a land in about 2 minutes; the same stored files and the same test results.
- What would prove it wrong: test (a) still over 120 s, or any stored byte or verdict changes.

## H-SOAK-ALS-2: the late-handoff soak in a worker of its own (Ops #558)

- Wrong, and the evidence (Ops #553): once worst-window got faster, the 3,000-acceptance soak of `tests/unit/role-message-guard-host-late-handoff.test.ts` became the land's longest file: 223.2 s of the 281 s unit stage in land 193-5151f5, against 101.1 s for `-worst-window`. 20.4% of its main-thread CPU was AsyncLocalStorage propagation for the hosts the file's earlier cases leave in the same worker, and it began about 54 s into its file.
- The change: the soak moved byte for byte (Ops #539's version, with its memory-only RoleMessages opt-in) into `tests/unit/role-message-guard-host-late-handoff-soak.test.ts`, with the same harness, helpers, describe title, counts, caps, assertions and 300 s timeout; every other case stays. #502's compare-move script proved the move (same calls, byte-identical text and syntax tree, identical helpers, only unused imports dropped, nothing else changed). `vitest.config.ts` lists the new file first in `SLOWEST_FIRST`, `-worst-window` second, so both start at once.
- Expected: the soak's AsyncLocalStorage share at or below 3% of its main-thread samples; the unit stage about 235-246 s (a prediction from #553's profile shares; #502's record suggests only 20-35 s may be gained).
- What would prove it wrong: an AsyncLocalStorage share above 10% in the moved soak, or a quiet land whose unit stage is still 271 s or more. Measured result: Ops #558's report.

## Undo

Revert this commit with `wt`. Nothing is installed or restarted.
