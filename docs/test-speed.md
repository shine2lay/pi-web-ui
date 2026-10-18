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

### H-TEST-SPEED-1: MISS (the 60 s bar)

- The bar: MISS. The unit step now lasts as long as test (a) alone: 230-300 s under a land's usual load (390 s in this run, beside another land's tests), not 60 s. The 60 s bar and a 2-minute land need test (a) itself to get faster, which means the store (production code), which this task may not change. Expected for a land: about 5-5.5 minutes instead of 6.5-7.
- Cause 1, one file's tests run one after another in one worker: HIT. The other 31 guard tests used to add 82-87 s after test (a) in the same worker. Now they run beside it, and everything besides test (a)'s file adds about 6 s to the Duration. About 85 s saved per land, with the same 6165 tests and the same assertions.
- Cause 2, `fsync` of the guard files on ext4: MISS. `/dev/shm` saved only about 7% (614 s against 569 s), and the durable writes, `fsync` included, are 3.7% of the profile. The time is CPU in `server/role-message-guard-store.ts`: per send, a canonical sorted JSON and a sha256 of the whole state, a `structuredClone` on every read, a full decode and verify, then garbage collection; about 0.5 s per send at about 5 MB, times 428 sends. Profile receipts: `~/.cache/pi/receipts/test-speed/` (`a-ext4.log`, `a-shm.log`, `prof-a/`).

### H-TEST-SPEED-2 (a starting point for the separate store task; not tested here)

- Wrong, and the evidence: every guard store operation costs time in proportion to the whole state, not to the change (profile above: sorted JSON 18.5%, `structuredClone` 16%, the digest 14%, decode and verify 11%), so each send costs about 0.5 s at about 5 MB, in test (a) and in the live server.
- The change: make the per-send work scale with the change, for example no deep copy when reading a frozen state, and cached digests of parts that didn't change; the same stored bytes and the same verdicts. The store task confirms this with its own profile first, and Security reviews it.
- Expected, and how it's measured: test (a) alone in 60 s or less (569-614 s now), the unit step's Duration 60 s or less, a land in about 2 minutes; the same stored files and the same test results.
- What would prove it wrong: test (a) still over 120 s, or any stored byte or verdict changes.

## Undo

Revert this commit with `wt`. Nothing is installed or restarted.
