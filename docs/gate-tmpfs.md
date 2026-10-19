# Gate: sealed test folders in memory

Ops #243, project faster-landing (item 6): the next try promised after #233 (`docs/guard-store-perf.md`) for the
owner's question "can we improve the speed of tests?". Accountable lead: Ops.

## H-GATE-TMPFS-1

**Wrong, and the evidence.**

- After #233, a pi-web-ui land's check takes about 190 s, and one test file takes nearly all of it: test (a),
  `tests/unit/role-message-guard-host-worst-window.test.ts`, took 174.9 s in land 45-7c3e2b (vitest Duration
  181.9 s, whole land 190 s), against a 60 s bar. Every other step finishes beside it.
- 70-76 s of test (a) are disk waits (`docs/guard-store-perf.md`, "The disk floor"): each store transaction writes
  and flushes three whole files (prepare, commit, canonical) and a send is five transactions, so test (a)'s 428 sends
  make about 6,400 flushed whole-file writes of up to 5 MB.
- They go to the main disk: `scripts/sealed.sh` made its temp root with
  `mktemp -d "${TMPDIR:-/tmp}/pi-sealed-XXXXXX"` and set `TMPDIR=$root/tmp`, the test's harness makes its folder
  with `mkdtempSync(join(tmpdir(), "rmguard-host-"))` (`tests/unit/role-message-guard-host-harness.ts:197`), and
  `/tmp` is on `/dev/nvme0n1p2` (ext4).
- Against it: #230 once ran test (a) side by side on `/tmp` and on `/dev/shm` with the old store (busy machine, not
  pinned): 614 s against 569 s, 45 s saved (`docs/test-speed.md`). The files have stayed byte-identical since, so the
  waits should be about the same size: a saving near 45 s would clear the miss line below but fall short of the
  expected 50 s.

**One change, and why it should fix it.** `scripts/sealed.sh` makes its temp root in `/dev/shm` when that is a
writable folder, not mounted noexec, with at least 8 GB free; otherwise under `${TMPDIR:-/tmp}`, as before.
`/dev/shm` here is a 61 GB tmpfs, 1% used, mounted `rw,nosuid,nodev`: on tmpfs a flush has nothing to wait for.
The whole sealed run moves with it (HOME, TMPDIR, the pi and web data folders: every test's temp files, not test
(a)'s alone). `PI_SEALED_TMP_PARENT=<folder>` picks the folder instead, and is the off switch:
`PI_SEALED_TMP_PARENT=/tmp` puts it back on disk. A folder sealed.sh can't make its root in falls back to
`${TMPDIR:-/tmp}`, with a note on stderr. Removal on exit is unchanged.

- 8 GB free leaves room for what else uses `/dev/shm` (Chrome's shared memory); a sealed run's own files are far
  smaller (peak measured below). Measured with `df` in MiB (8192), since `-B1G` rounds up.
- Not noexec: added by this task's chat (the plan named only writable and free space). Tests run programs they
  write into their temp folders, so a `/dev/shm` hardened to noexec would break them with confusing errors. The
  check can only make sealed.sh fall back to disk.

**Expected result, and how it's measured.**

- The registered pair (below): test (a) in memory at least 50 s faster than the same run on disk beside it. #233's
  pinned run alone took 131 s, so about 60-80 s in memory.
- The real land's check: about 120-130 s instead of about 190 s, read from its log (test (a)'s time, vitest
  Duration) and `wt land-status` (the whole land).

**What would prove it wrong.**

- The pair saves less than 30 s.
- A test passes on disk but fails in memory.
- Leftover `pi-sealed-*` folders in `/dev/shm` once the runs have ended.

**The measure, registered before any timed run.** On this busy machine a fair pair is the old and the new run at
the same time on separate fast-core clusters (cores 5-9 and 15-19, all Cortex-X925; lessons of #231 and #233).
Started together:

```sh
taskset -c 5-9 env PI_SEALED_TMP_PARENT=/tmp scripts/sealed.sh env TZ=UTC npx vitest run tests/unit/role-message-guard-host-worst-window.test.ts
taskset -c 15-19 scripts/sealed.sh env TZ=UTC npx vitest run tests/unit/role-message-guard-host-worst-window.test.ts
```

One pair only, no extra runs. The number compared is vitest's own time for the file (its "✓ … (1 test) N ms"
line); each run's wall time is recorded too. Then the real land's numbers from its log. Receipts:
`~/.cache/pi/receipts/gate-tmpfs/`.

Checks besides: four new cases in `tests/unit/sealed-fence.test.ts` (`/dev/shm` with room and no override; less than
8 GB free, through a stand-in `df`; `PI_SEALED_TMP_PARENT=/tmp`; an unwritable override falls back, with its note),
one focused run of that file, then the landing gate, whose whole suite then runs in memory.

## Result

**The registered pair** (Oct 18, 20:57:41-20:59:40 PDT, on mine `23ec64d2` plus this change; load average 1.1 at
the start and 4.1 at most; no other test run on the machine). Both runs passed.

| Run                                   | Cores | Temp root          | Test (a), vitest's time | vitest Duration | Wall    |
| ------------------------------------- | ----- | ------------------ | ----------------------- | --------------- | ------- |
| On disk (`PI_SEALED_TMP_PARENT=/tmp`) | 5-9   | `/tmp` (ext4)      | 117.5 s                 | 118.4 s         | 119.5 s |
| In memory (the new default)           | 15-19 | `/dev/shm` (tmpfs) | 70.9 s                  | 71.8 s          | 72.9 s  |

- Saved 46.6 s (40%): above the 30 s line that would have proved it wrong, below the 50 s expected. In memory test
  (a) took 70.9 s, inside the expected 60-80 s; the gap came out smaller because the disk run, on a quiet machine,
  was quicker than #233's 131 s.
- It agrees with #230's 45 s (614 s against 569 s). So the flush waits are about 45-47 s of test (a), not the 70-76 s
  of event-loop idle time #233 measured. Likely reason (not measured): that idle time also covers the writes, opens
  and renames, which tmpfs still does; only the flushes become free.
- The in-memory root peaked at 11 MiB (sampled every 5 s), against the 8 GB kept free.
- Nothing left in `/dev/shm` afterwards: no `pi-sealed-*` folder.

Receipts: `~/.cache/pi/receipts/gate-tmpfs/pair/` (`disk.log`, `memory.log`, `*.exit`, `monitor.log`,
`machine.txt`) and `pair.sh`.

**Checks.**

- `tests/unit/sealed-fence.test.ts`, sealed with `TZ=UTC`: 20 of 20 passed, the four new cases in about 0.7 s each.
- The same four cases against the old sealed.sh (the change stashed for that run): three fail; the "less than 8 GB
  free" case passes there too, as it should, since the old script always used TMPDIR. Receipt
  `old-sealed-new-tests.log`.
- By hand, since a real noexec mount can't be made in a test: the noexec line on sample mount lines (noexec last,
  first, a lookalike `noexecx`, none, `noexec` on another mount only, no mounts file) finds it only where it should.
  Also by hand: a relative `PI_SEALED_TMP_PARENT` becomes absolute, and `/proc` (unusable) falls back to `/tmp`
  with the note.
- No test or script compares the temp folder with `/tmp` (searched `tests/unit`, `tests/lib`, `server`, `scripts`).

**The land** (request 54-85f8d4, Oct 18 21:01:41-21:04:21 PDT; rebased onto `a482b2e`, landed as `dfaccd0`;
machine quiet at the start: load average 0.9, no other test run). `scripts/check.sh` runs itself through
`scripts/sealed.sh` (its line 16) and no `PI_SEALED_TMP_PARENT` was set, so the whole check ran in `/dev/shm`. 440
files, 6,265 tests passed, 6 skipped. Against #233's land, the same check on disk; two lands at different times, so
this comparison is only a rough guide and the pair above is the fair measure:

| Step                                            | Land 45-7c3e2b (on disk) | Land 54-85f8d4 (in memory) | Change  |
| ----------------------------------------------- | ------------------------ | -------------------------- | ------- |
| Test (a)                                        | 174.9 s                  | 145.9 s                    | -29.0 s |
| `role-message-guard-store-golden.test.ts`       | 89.5 s                   | 74.2 s                     | -15.2 s |
| `role-message-guard-host-hops.test.ts`          | 37.0 s                   | 23.3 s                     | -13.7 s |
| `sealed-fence.test.ts`                          | 14.7 s (16 tests)        | 36.1 s (20 tests)          | +21.3 s |
| vitest Duration                                 | 181.9 s                  | 155.3 s                    | -26.5 s |
| Unit tests step                                 | 182 s                    | 156 s                      | -26 s   |
| Prettier, beside the tests                      | 98 s                     | 106 s                      | +8 s    |
| Whole land (`wt land-status`, started to ended) | 185.9 s                  | 159.6 s                    | -26.3 s |

- The check took 156 s, not the expected 120-130 s; the whole land 160 s (14% less). Test (a) is still the
  longest step: 146 s, twice its 71 s alone in memory.
- `sealed-fence.test.ts` grew 21 s: the four new cases took 4.9-6.0 s each in the land (0.7 s each alone), like the
  two older sealed.sh cases beside them (4.8 and 6.0 s), since each starts a whole sealed run on the land's busy
  cores. That file runs in its own worker beside test (a), so it doesn't lengthen the check.
- Nothing left in `/dev/shm` after the land: no `pi-sealed-*` folder.

Receipt: `~/.cache/pi/receipts/gate-tmpfs/land.log`.

## Verdict: MISS on size, not proved wrong

- Not proved wrong: the pair saved 46.6 s (the line was 30 s), every test passed in memory (the pair and the land's
  6,265), and nothing was left in `/dev/shm`.
- Missed what it expected: 46.6 s instead of at least 50 s in the pair, and a 156 s check instead of 120-130 s in the
  land. Two estimates were wrong. The flush waits are about 47 s of test (a), not 70-76 s. And in the land the saving
  shrinks to 29 s. Likely reason (not measured): test (a) shares the cores with the rest of the suite, so while it
  waited on disk, other tests used its core, and part of the wait was hidden behind work the check does anyway.
- The change stays on mine: it takes about 26 s off every land and costs nothing measured. Undo:
  `PI_SEALED_TMP_PARENT=/tmp` for one run, or revert `dfaccd0`.

**Next hypothesis (H-GATE-PIN-1, not started; Ops' home chat picks item 6's next step).**

- Wrong, and the evidence: in the land test (a) takes 146 s, against 71 s alone on a fast core. The land spreads 440
  files, prettier and typecheck over all 20 cores, and half of them are slow ones (cores 0-4 and 10-14 top out at
  2.8 GHz, against 3.9 GHz for cores 5-9 and 15-19), so test (a) shares a core and may run on a slow one.
- One change: the check runs test (a) in its own vitest run pinned to one fast cluster (`taskset -c 5-9`), and the
  rest of the unit tests beside it on the other 15 cores.
- Expected: test (a) about 75-90 s in the land, and the unit tests step about 100-120 s, read from the land's log.
- Wrong if: test (a) still takes more than 110 s in the land, or the step saves less than 20 s.
- Then prettier is the next floor: it took 98-106 s beside the tests in both lands.
- The other open try from #233 remains: hashing off the event loop (cuts test (a)'s own work, but changes
  production code and needs Security's review).
