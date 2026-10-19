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

**The land.** Filled in after it.
