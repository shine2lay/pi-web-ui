# Guard store: each send's cost fits the change (Ops #233)

Project faster-landing. Lead: Ops. The store is part of the Security-reviewed role-message ladder (#122), so Security
reviews this change before it lands, and it lands and installs only on Security's GO.

## H-GUARD-STORE-PERF-1

**What is wrong, and the evidence.** The role-message guard store (`server/role-message-guard-store.ts`) redoes
whole-state work on every call, so each role message costs time in proportion to everything the store holds, not to
what the message changes.

- #230's CPU profile of test (a) (receipts `~/.cache/pi/receipts/test-speed/prof-a/`; `docs/test-speed.md`,
  H-TEST-SPEED-2): the worker is CPU-bound in the store. Inclusive shares: the `transact` callback 47.8%, `sortedJson`
  18.5%, `structuredClone` 16.4%, `guardDigest` 13.7%, `decode` 10.8%, garbage collection 10.5%, `read` 10.2%. Disk
  flushes were only 3.7%: test (a) took 614 s on `/tmp` and 569 s on `/dev/shm`.
- Per call: `read()` hands out a `structuredClone` of the whole state; `transact()` hands the update another
  `structuredClone`, serialises the whole state and the canonical file (`sortedJson`), hashes them, then parses and
  verifies the text it has just composed itself (`decode`: `JSON.parse`, `guardStateIsValid`, `safeJson`, three
  digests per outbox entry), deep-freezes the result, and leaves all of it to the garbage collector.
- One send is about 4.7 store transactions and 6 reads (golden test G1 below: 107 sends, 505 transactions, 658
  reads, 114 lookups). At the ~5 MB fill of test (a)'s worst window that comes to about 0.5 s of CPU per send.
- Test (a) alone (428 sends): 316 s at 2efa583 (receipt `before-a`), 294-366 s inside lands. In the live app the
  same work blocks the server's event loop for about 0.5 s per role message at that fill, more towards the 16 MiB
  cap.

**The change, one step at a time, each measured.**

1. Reads hand out the store's frozen state instead of a `structuredClone`, wherever no caller changes it. Every
   caller was checked (the core's `transact` callbacks copy what they change through `mutable()`; the host and the
   core's reads only read) and the contract already types the state as read-only. A read still returns a fresh
   top-level object, so changing what a read returned changes nothing stored.
2. Text the store has just composed itself is not parsed and verified a second time. The store keeps what it
   verified when it built the text, and checks only what changed (the existing `knownBodyDigest` pattern, extended).
   Anything read from disk that the store did not just write is still fully decoded and verified.
3. Only if 1 and 2 miss the bar: the canonical text and its digest are built from cached parts, so only the changed
   items are serialised again.

**Expected result and how it's measured.** About 50 ms or less of event-loop time per send at the ~5 MB fill (was
about 500), and test (a) at 60 s or less inside a land (was 230-300 s). Measured with the benchmark below (median per
send, by band), test (a)'s own time, and after landing the land's vitest Duration and test (a)'s line.

**What would prove it wrong.** Either number missed after steps 1-3, or any difference in the files written, the
digests, the answers, or the verdicts on what is read from disk.

**Invariants.**

- The same sequence of operations writes the same bytes, and the same digests.
- The same crash, rollback and quarantine behaviour: every existing store and guard test passes unchanged.
- Nothing read from disk is verified less: anything the store did not just compose is still fully decoded and
  verified.
- No change to the files' format, the digests, the ladder's rules, limits, grants or messages.

## How it's checked

- **Golden test** `tests/unit/role-message-guard-store-golden.test.ts`. Every store under test is paired with the
  reference copy of the old store (`tests/unit/role-message-guard-store-reference.ts`, the store as it was at
  2efa5834) on a folder of its own. Each call goes to both; after every call their answers, the state each hands to
  the update, and `journal.json` and `accepted.json` byte for byte must be the same. G1 replays test (a)'s sends
  through the real host (every 8th send in the suite; all 428 with `GUARD_STORE_GOLDEN=full`). G2 drives both stores
  directly with awkward values (keys in any order, index-like keys, `-0`, a `Date`, an own `__proto__`, lone
  surrogates, one object twice, reordered items, `undefined`, a sparse array, an unknown kind, a throwing update),
  the size cap, a crash at each of the 12 file boundaries followed by recovery, and files changed on disk.
- **Benchmark** `tests/unit/role-message-guard-store-bench.ts`, on its own config (never in the suite):

  ```sh
  taskset -c 5-9,15-19 scripts/sealed.sh env TZ=UTC GUARD_STORE_BENCH_OUT=<file.json> \
    npx vitest run --config tests/unit/role-message-guard-store-bench.config.ts
  ```

  `GUARD_STORE_BENCH_IMPL=reference` measures the old store in the same tree. It replays test (a)'s sends, then
  grows the canonical file with copies of its accepted messages to about 15 MB and times 30 more sends. Per send:
  wall time; event-loop busy time (the stall: the server can do nothing else meanwhile) and idle time (waiting on the
  disk), from `performance.eventLoopUtilization`; process CPU; store calls; file sizes. Bands: journal 0.75-1.25 MB,
  4.5-5.5 MB, and the grown ~15 MB phase.

- **Test (a) alone**, pinned to the fast cores:
  `taskset -c 5-9,15-19 scripts/sealed.sh env TZ=UTC npx vitest run tests/unit/role-message-guard-host-worst-window.test.ts`.

Receipts: `~/.cache/pi/receipts/guard-store-perf/`.

## Results

### Before (2efa583)

- Test (a) alone: 316 s (receipt `before-a`, load average 10-18 from other chats' test runs).
- Benchmark (receipt `bench-before`), median per send:

  | Journal             | Event-loop busy | Idle (disk) | Wall     | CPU      |
  | ------------------- | --------------- | ----------- | -------- | -------- |
  | ~1 MB (31 sends)    | 156 ms          | 143 ms      | 288 ms   | 199 ms   |
  | ~5 MB (47 sends)    | 857 ms          | 218 ms      | 1,073 ms | 1,105 ms |
  | ~14.4 MB (30 sends) | 1,867 ms        | 475 ms      | 2,327 ms | 2,555 ms |

  Every send is 5 store transactions and 6 reads. Test (a)'s 428 sends: 267 s wall, 198 s busy, 70 s idle.

- **The disk floor.** Idle time grows with the files (143 ms per send at 1 MB, 224 ms at 5-6 MB): every transaction
  writes and flushes three whole files (prepare, commit, canonical), so a send makes 15 flushed writes. Those 70 s of
  test (a) are disk waits that no CPU saving removes, so test (a) at 60 s or less is out of reach on `/tmp` (ext4)
  with the files' format kept as it is. The CPU part is what this change can win.
- Golden test with the old store on both sides (the harness itself checked): G1 every 4th send, 107 sends, 505
  transactions, 658 reads, 114 lookups, 1,278 file comparisons, journal up to 1.35 MB, no difference; G2 all pass.

### Change 1: reads hand out the frozen state

- Golden test (receipt `golden-c1`): G1 every 8th send, 54 sends, 268 transactions, 354 reads, 684 file
  comparisons, no difference; G2 all pass. The 15 guard test files: 426 passed, 1 skipped (the visual proof that
  runs only with `GUARD_UI_PROOF_DIR`, skipped before too).
- Benchmark (receipt `bench-c1`), median per send:

  | Journal  | Event-loop busy      | Idle (disk) | Wall     | CPU      |
  | -------- | -------------------- | ----------- | -------- | -------- |
  | ~1 MB    | 111 ms (was 156)     | 125 ms      | 236 ms   | 137 ms   |
  | ~5 MB    | 600 ms (was 857)     | 219 ms      | 827 ms   | 774 ms   |
  | ~14.4 MB | 2,072 ms (was 1,867) | 451 ms      | 2,531 ms | 2,806 ms |

  Test (a)'s sends: 210 s wall (was 267), 142 s busy (was 198). The 15 MB band ran while the load average rose from
  1 to 12 (other chats' tests), so its numbers are noisy (p90 4.6 s). Miss on the bar so far, as expected: change 2
  next.

### Change 2: text the store has just composed isn't parsed and verified again

- What the store hands out and keeps is deep-frozen, so it remembers, per item, that the item came from its own
  canonical text and what that item's checks already found (a registry keyed by the frozen object). The full
  structural check still runs on every transaction, but each item's own predicates and digests are worked out once
  per item, not once per send. The value checked is built from the parts being written instead of parsed back from
  the whole text. Reads compare the file's bytes with the bytes the store last wrote; any other bytes are decoded
  and verified in full, exactly as before.
- Store-only measurement (`micro.mts` on a 5 MB copy of the files, receipt `micro-c2-5mb.log`, load average about
  10): a read 1.2 ms of busy time (was 28), a transaction 123 ms (was 146). The profile (`prof-c2/`) showed why the
  transaction barely moved: writing the whole state as sorted JSON, turning it into bytes and hashing it now
  dominated (sortedJson 19%, hashing 13%, Buffer conversion 8%, garbage collection 10%; verification only 2%).
- Golden test and the store, core and contract tests: 226 passed (receipt `c2-quick.log`).
- The whole-host benchmark (receipt `bench-c2`) ran at load average 15 and is not comparable. Change 3 next.

### Change 3: the files are built item by item from bytes the store already has

- Each frozen item keeps the UTF-8 bytes of its own canonical text. A transaction joins those bytes (new or
  changed items are written once), hashes the prepared and committed texts in one pass up to the `stage` field
  (the hash state is copied there, so the shared front is hashed once), and builds the value to verify from the
  same parts. It produces exactly what the old code wrote: a file is the join of its fields' texts and an array the
  join of its items' texts, the UTF-8 of a join is the join of the UTF-8, and a text's sha256 is its bytes' sha256.
  Anything that isn't plain data (a getter, a proxy, a hole, an unexpected prototype, a `toJSON` anywhere on the
  prototypes) makes the store write that transaction the old way, field by field.
- Store-only, side by side with the old store at the same time (5 MB copy; new store on cores 5-9, old on 15-19;
  load average 4.5; receipts `micro-c3-5mb.log`, `micro-c3-ref-5mb.log`), median busy time per call:

  | Call                              | Change 3           | Old store |
  | --------------------------------- | ------------------ | --------- |
  | read                              | 1.7 ms             | 28.1 ms   |
  | lookup                            | 2.0 ms             | 12.4 ms   |
  | transaction (+1 audit)            | 21.9 ms            | 146.3 ms  |
  | big `JSON.parse` calls in the run | 2 (the first load) | 17        |

- The whole host, side by side with the old store at the same time (receipts `bench-c3`, `bench-ref2`; load average
  0.5 rising to 26 from another chat's land, so absolute numbers are inflated; the ratio is the fair part), median
  per send:

  | Journal  | Busy, change 3 | Busy, old store | Wall, change 3 | Wall, old store |
  | -------- | -------------- | --------------- | -------------- | --------------- |
  | ~1 MB    | 69 ms          | 181 ms          | 202 ms         | 321 ms          |
  | ~5 MB    | 403 ms         | 830 ms          | 683 ms         | 1,024 ms        |
  | ~14.4 MB | 833 ms         | 2,344 ms        | 1,298 ms       | 2,802 ms        |

  Test (a)'s 428 sends: 198 s wall against 365 s, 109 s busy against 284 s.

- Golden test and the store, core and contract tests: 226 passed (receipt `c3-quick.log`).
- **Why the whole host gains only 2-3x while the store gains 7x.** A CPU profile of the whole benchmark with
  change 3 (receipt `prof-bench-c3/`, 78 s busy): building and hashing the files 25% (the hashing alone is a floor:
  every transaction must hash its prepared and its committed text whole, about 10 MB at the 5 MB fill, five
  transactions a send), garbage collection 16%, the core's `finish` recomputing a digest for every stored audit 14%,
  the core's `prune` 7%, verification, reads and writes about 7%, the rest in the host. See H-GUARD-STORE-PERF-2.
- A repeat of the change-3 benchmark alone (receipt `bench-c3s`, load average 8 rising to 18) and a second side-by-side
  run (receipts `bench-h2` and `bench-c3ab`, load average 9-12) agree: at the 5 MB fill about 330-380 ms of busy time
  and 560-640 ms wall per send; test (a)'s 428 sends 160-241 s wall, 84-119 s busy, 73-122 s idle.

### Verdict on H-GUARD-STORE-PERF-1: miss

Both numbers missed after changes 1-3; the files stayed byte-identical.

| Measure                                       | Bar         | Old store                         | Changes 1-3             |
| --------------------------------------------- | ----------- | --------------------------------- | ----------------------- |
| Busy per send, ~5 MB fill (whole host)        | about 50 ms | 830-857 ms                        | 330-400 ms              |
| Busy per store transaction, 5 MB (store only) |             | 146 ms                            | 22 ms                   |
| Test (a)'s 428 sends, benchmark wall          |             | 267-365 s                         | 160-241 s               |
| Test (a) alone, side by side                  |             | 262 s                             | 131 s                   |
| Test (a) inside the full suite                |             | 294-366 s (lands)                 | 179 s                   |
| Test (a) in a land                            | 60 s        | 313-586 s (5 lands, median 339 s) | 175 s (1 land)          |
| The land's unit tests (vitest Duration)       |             | 324-600 s (median 350 s)          | 182 s                   |
| Files and digests                             | identical   |                                   | identical (golden test) |

- Test (a) alone, side by side at the same time (receipts `alone-new` on cores 5-9 with changes 1-3, `alone-old` on
  cores 15-19 with the store of 2efa5834, load average 1-6): 131.2 s against 261.7 s.
- The full sealed unit suite after `npm run build` (receipt `suite`): 432 files, 6187 passed and 6 skipped (the tests
  of 2efa5834 plus the 6 golden ones; no existing test file changed), Duration 189 s, test (a) 179 s inside it.

### In the land

- **Security:** GO at source level for exactly cd0d124e, no must-fix (rm-c22487a8; report
  `/home/shinelay/security-lab/guard-store-perf-233/REVIEW-cd0d124e.md`). Two optional points, not done in this
  change: N1, the plain-data check counts an array's keys, so a hole plus one extra own key passes it (not a security
  gap: the bytes written and the value verified still come from one text); N2, a test that a nested write on
  `read().value` or on the update's input throws and leaves both files unchanged.
- **Landed although it missed the bars**, on the Ops lead's decision (rule 21; a department decision within the plan,
  not the owner's consent): the plan's "then don't land" guards against a file difference, and there is none.
- **The land** (request 45-7c3e2b, 2026-10-18 19:23-19:26; cd0d124e rebased onto e8affb4f as 6ea7f58a, same
  patch-id 6c7aebe8): 437 files, 6231 tests passed and 6 skipped; vitest Duration 181.9 s; test (a) 174.9 s; the
  golden test 89.5 s beside it. Beside the unit tests: typecheck 17 s, prettier 98 s. The whole land, build included,
  took 190 s (#230's lands: 341-463 s). The five lands before it that day with the same check (receipts
  `notes-check/land.log`, `225/land*.log`) took 324-600 s of unit tests and 313-586 s of test (a); the slowest ran
  at load averages of 16-34. One land is one sample: load moves these times a lot.
- The guard-core test "a crash at any store boundary of the transition ...", which hit vitest's 5 s timeout in four
  lands that day, took 2.9 s in this land (1.3 s alone; 2.4-2.6 s alone before).

### Live

- **Installed** 2026-10-18 19:28 (6ea7f58a; the next two installs, fd4bc4e3 and 90995a22 at 19:49, carry it). Every
  pi-web-deploy check passed each time: server, page, reply, the 40 MB chat copy and the log.
- **The new store hasn't served live traffic yet.** The approval ladder has been off on the live server since
  2026-10-14 06:43. At every start, `store.recover()` refuses with "legacy writer divergence; refusing stale snapshot
  overwrite", left by the role-mail wedge of 2026-10-14 02:59 (the #175 race, fixed since; Ops note n147), and the
  host falls back to the native depth-6 rule with no approvals. The guard files haven't changed since 02:59 that day.
  The refusal is the same line before and after this install, and the golden test's crash-and-recovery cases match
  the old store.
- **The log, 32 minutes after the install** (the store's error strings only, never message text): none of the
  store's errors and none of the ladder's other failure lines; only that start line, once for each of the 3 server
  starts.
- So the live effect, no stall of about 0.5 s per role message, starts only once the ladder is restored. That is its
  own task: a fresh-generation recovery designed with Architecture, with the owner's plan approval and Security's
  review.

What was learned, for the next hypothesis:

- **The 50 ms bar is at the floor the kept file format sets.** Each transaction must hash its whole prepared and
  committed texts on the event loop, and a send is five transactions. sha256 runs at 0.8 GB/s on a fast core here
  (12 ms per 10 MB, measured with `node:crypto` pinned to core 5; 43 ms on a slow core): 40-60 ms of hashing per send
  at the 5 MB fill before any other work. Only a format change (out of bounds here) or hashing off the event loop
  could go lower.
- **The 60 s bar is below the disk floor.** Every send makes 15 flushed whole-file writes; test (a)'s window spends
  70-76 s waiting on them on `/tmp` (ext4) with any store code.
- **The rest of each send is outside the store:** garbage collection about 16%, the core's `finish` and `prune`, and
  the host's own work.
- **Next try**, its own task and hypothesis, planned by the Ops lead: test (a)'s folder on tmpfs in the land check,
  which removes the disk waits; then hashing off the event loop.

## H-GUARD-STORE-PERF-2 (proposed after change 3; outside the approved plan, measured as an experiment only)

**What is wrong, and the evidence.** After changes 1-3 the store's own work is a minority of each send. A CPU
profile of the whole benchmark with change 3 (receipt `prof-bench-c3/`, 78 s of busy time) shows the core's
`finish` recomputing `guardTransactionId(identity)` (a sorted JSON and a sha256) once for every stored audit inside
`state.audits.some(...)`: 10.7 s, 14% of all busy time. `prune` does the same with `guardOperationKey(t.identity)`
for every tombstone (1.3 s) and builds the `outbox:<id>` text once per audit for every outbox entry (about 4 s).

**The one change.** Compute each of those values once, before its loop. They are pure functions of values that
don't change inside the loop, so every comparison, result and written byte stays the same.

**Expected result and how it's measured.** About 15-20% less busy time per send, measured with the benchmark run
side by side with the change-3 code on other cores at the same time.

**What would prove it wrong.** Less than 10% saved, or any difference in a test, the golden files or the digests.

The core is Security-reviewed ladder code too and isn't in this task's approved plan, so this lands only if the
lead adds it to the plan and Security reviews it.

**Result: miss (no measurable saving).** Side by side at the same time, change 3 with and without the hoists (receipts
`bench-h2` on cores 5-9 and `bench-c3ab` on cores 15-19, load average 9-12): test (a)'s window 87.8 s busy with the
hoists against 84.1 s without, 5 MB band 335 ms against 329 ms, whole benchmark 210.9 s against 209.3 s. Each scan
does get cheaper (receipt `audits.log`, `audits.mts` on the 5 MB copy: 1,086 audits, 7.6 ms per scan before, 0.06 ms
after). Over the window the audits grow from none to about 1,100, so that is at most about 7 s of the window's 84 s
of busy time (under 9%), and the side-by-side run could not tell it from the difference between the two core
clusters. Either way it is under the 10% bar. The core change was reverted; nothing of it is in this branch.
