# Private usage collector store — W1 / Ops #312

Accountable lead: **Ops**. This module is inert until an explicitly supplied
worker opens it. This task installs nothing, scans no source directory, reads no
real chat and starts no worker/service/scheduler/model/network operation.

## H-WIRE-1 — written before implementation

Wrong/evidence: #300 supplied injected durability interfaces, not production
filesystem I/O. W0 (#311, `8fcd3bf6`) delivers paged replay and derived numeric
indices, but explicitly cannot prove a disk path, a synced prefix or native
cursor provenance. Its 100,000-attempt/65-source fixed case recovered 75,714,977
bytes with reads <=262,144 bytes and worker heap <=33.93 MiB. Substituting whole
file reads, a new lock algorithm, or trusting an index label would defeat that
boundary and could lose evidence or expose an uncommitted cursor.

One change/why: implement the worker-private `PagedCollectorIO` and numeric-index
port under `dataDir/usage-accounting`, using the unchanged reviewed
`GuardFileLock`, bounded synchronous worker I/O, exclusive fixed segment creation,
length-CAS append, file/directory fsync and scratch/fsync/rename checkpoints.
Replay only the retained numeric journal, never source chats. Derived indices
may be rebuilt; original journal bytes and opaque native tokens remain evidence.

Expected/measurement: temporary-directory adversarial and injected-crash cases
preserve original evidence, do not steal a live writer's lock and never publish
a cursor beyond the synced validated prefix. Pages, staging, disk capacity,
work units and cache memory remain within W0's finite bounds. Newer store majors
are refused without mutation. A compatible copy precedes any future migration;
rollback stops the writer and restores that copy, or leaves the older meter
unavailable. No in-place downgrade is permitted.

Falsifier: followed symlink/hardlink, unsafe permissions, lock theft (including
same-process workers), cursor advancement before file AND directory durability,
missing/corrupt cache becoming a negative lookup, evidence truncation/deletion,
a native token invented from an ordinal, unbounded allocation/read/work, or a
newer-major store modified by an old reader.

First final-gate result: **MISS**. All 130 small W1 fault/security fixtures passed,
as did protocol, patch manifest, typecheck and lint. The 100,000-attempt real-index
fixture failed ingestion with the collector's fixed `io-failure`; one unrelated
CLI test also required a worktree-local server build, and the final backup guard
needed formatting. No gate was bypassed or installed. Focused diagnosis records
only fixed store status, counters and collector metrics at the failing batch;
no source content or raw filesystem/model request is logged. Final HIT remains
conditional on the large case and normal detached gate passing.

## H-WIRE-1g — one checked payload append per bounded index page

Wrong/evidence: the staged normal gate passed 131 small W1 cases and 7,396 tests
but large ingestion exceeded its unchanged 240-second phase deadline. The
65-source corpus creates 501,690 live numeric keys. Each payload formerly
repeated the reviewed ownership/lock checks and a filesystem write; node-page
coalescing did not remove that cost. Independent read-only review confirms a
full page can reduce these payload writes from 256 to one without weakening a
checked-write boundary.

One change/why: prepare one bounded payload buffer per existing index write
page, with individual hashes/byte offsets, then append it through the unchanged
checked write before sequential trie mutations. A conservative capacity proof
handles ordinary pages; a bounded exact preflight handles near-capacity repeated
keys/deletes/reinserts and transient entry peaks. Charge payload/planning scratch
to the same 8 MiB workspace/cache ceiling. Leave lock, FD authentication, node
flushing, durability fences, real clocks and resource deadlines unchanged.

Expected/measurement: exactly one payload append for a nonempty page, none for
delete-only pages; byte-correct repeated-key ordering, pre-append capacity refusal
and poisoning on short writes or ownership loss. The same staged 100,000-attempt
proof must meet its original 240-second phase deadlines, <30-second warm
publication and 100 ms work-unit guard. Falsifier: insufficient measured syscall
reduction, any semantic/security regression, or another resource-bar miss.
Verdict: **MISS** for the resource claim. The normal four-worker gate passed
137 small W1 cases and 7,401 tests, but W1 ingestion timed out at 240 seconds
(16/65 sources at 155.53 seconds). Payload batching itself worked: 1,008 payload
writes for 123,536 live keys. The unchanged W0 resource case also timed out;
shared contention is a competing explanation, not a reason to loosen a bar.

## H-WIRE-1h — attribute index work before changing its policy

Wrong/evidence: 64-slot node buckets may amplify sparse writes and charged work;
the 16-source sample already yielded 71,449 times. Yield totals mix mandatory,
quantum and real-clock boundaries, however, and smaller node-cache capacity or
contention could instead dominate. The prior gate is not a passing proof.

Measurement first: add only fixed-size aggregate counters for flush density,
written/dirty/predicted trimmed slots, retained reads, cache misses/evictions,
read classes and yield reasons; charge their scratch to the existing cache
ceiling. Scheduling and checked I/O remain unchanged. A fixed 8,192-key case
exceeds cache, then performs 32 pages of 128 predetermined scattered updates,
with dense-append and read-only controls. Snapshot counters before exact-value
verification. Compare isolated and four-copy runs in separate temporary stores;
CPU measurements are process-wide, never summed across overlapping workers.

Expected/falsifier: sparse amplification is supported only by excess written
slots/retained bytes and measured flush work. If confirmed, trim each existing
bucket to its first/last dirty slot, skipping retained reads only when the span
is entirely dirty; retain one checked write per bucket and charge every written
slot. One dirty slot would change 12,288-byte read plus write to one 192-byte
write, not promise a wall-time speedup. Comparable operation counts with sharply
worse loaded throughput instead support contention. Little predicted saving,
another dominant hotspot, no reduced measured work/CPU, or any failed unchanged
correctness/resource guard falsifies the change. No full-corpus rerun before
this bounded diagnosis. The four-copy profile is opt-in (`W1_INDEX_PROFILE=1`,
select `bounded index attribution`); it is diagnostic, not a replacement for the
mandatory full-corpus gate, and does not add four engine workers to that gate.
Measurement result: **HIT for attribution, not yet acceptance**. Two isolated
and two four-copy trials passed exact-value/order and resource checks. For each
scattered-update control, counts were identical: 6,964 guarded flush writes,
28,459 dirty slots versus 445,664 written slots, 85,567,488 retained-read bytes,
5,556 cache misses and 1,737 flush-quantum yields; no clock-triggered yields.
Trimmed prediction: 145,877 slots and 27,479,040 retained bytes (67% less).
Exact runs would instead require 21,917 guarded writes. Isolated total wall/CPU
was 1.73/2.60 and 1.77/2.66 seconds; four-copy wall/process-wide CPU was
2.95/16.18 and 4.59/26.84 seconds. Contention also exists, but cannot explain
the deterministic sparse amplification. Worst work unit was 15.27 ms.

Chosen single change: trim spans within the same 64-slot buckets, with no read
for fully dirty spans. Keep the same checked-write count, cache sizing,
individual hashes, work accounting and durability boundaries. Add regression
checks for exact first/last dirty bounds, unchanged gap/outside bytes, skipped
retention for fully dirty spans and unchanged lookup/order. The identical
profile must reproduce predicted counts and reduce measured work/CPU; resource
acceptance still requires the unchanged large case and normal gate.

Paired candidate result: **INCONCLUSIVE for CPU/resource acceptance**, not a
pass. Both isolated trials and the new byte-preservation regression passed.
Actual sparse counts exactly matched the prediction: 145,877 written slots,
27,479,040 retained-read bytes, the same 6,964 checked writes and 5,556 misses;
flush-quantum yields fell to 611–612. But isolated wall/CPU was 8.84/8.69 and
8.97/8.72 seconds, and the unmodified read-only control also slowed about
fivefold. Both four-copy trials failed the unchanged `store-capacity` guard.
Concurrent process-only inspection showed many CPU-heavy Node children and
host load 24.47 across 20 CPUs; no model payload or unrelated file was read.
Read-only review found no correctness, guard or ownership regression. Timing
comparison is confounded, so no full-corpus rerun or performance HIT is claimed;
a coordinated measurement window is needed before acceptance.

## Acceptance — Ops decision #397 verification leg

Ops decision #397 (H-COST-VERIFY-DECISION-1, section 2) reserved no quiet window.
It allowed at most two runs of the unchanged normal gate (`scripts/check.sh --fast`,
four workers, `TZ=UTC`). Each run had to start after load stayed under 4.0 with no
other check running, and was judged per run with a 5-second CPU sampler. Source and
test were pinned (`08e7d1bc…8f97`, `70f684fd…9a22`) and unchanged for both runs.

Run 1 (01:22 PDT): **NOT ATTRIBUTABLE**. The large case's ingestion stage timed
out at 55/65 sources while foreign load reached 14.56 CPUs; every other file passed.
Run 2 (03:10–03:17 PDT): **PASS**, so H-WIRE-1h and the staged harness (H-WIRE-1f)
are a **HIT** for acceptance. All 471 files passed (7,404 tests, 10 skipped).
The first land check (`wt land` 159-a3d985, 03:39–03:46 PDT, rebased onto `mine`
0888d552) ran the large case again and it passed again. That land failed only in
`tests/unit/prettier-scope.test.ts`, because the land was given `CI=1`, which makes
Prettier colour its output (Ops #418 fixes that test). Both passes stayed inside
every unchanged limit:

| Stage | Run 2 | Land check | Limit |
| --- | --- | --- | --- |
| Ingest 100,000 attempts / 65 sources | 231.8 s | 238.7 s | 240 s |
| Cold replay + fold | 136.6 s | 143.3 s | (inside replay stage) |
| Warm update + publication | 20.6 s | 21.2 s | 30 s |
| Replay stage total | 157.3 s | 164.5 s | 240 s |
| Combined | 389.1 s | 403.2 s | 480 s |
| Peak heap / RSS | 37.8 / 185.8 MB | 38.4 / 194.7 MB | Worker limits |
| Longest work unit (ingest / replay) | 23.0 / 8.1 ms | 25.3 / 10.3 ms | 100 ms |
| Index cache peak | 8,388,296 B | 8,388,296 B | 8 MiB |

The trim matched its prediction on the full corpus too (run 2: no clock-triggered
yields; land check: 3), and the W0 collector case passed in both. Evidence (all 0600):
`~/kept-from-tmp/2026-10-22/ops312-verify/ops312-verify-{1,2}.{log,samples.tsv,attribution.txt,verdict.txt}`
and `ops312-land-1.verdict.txt`.

Known risk: ingestion has thin headroom even when it starts on a quiet machine: 3.4%
in run 2, 0.55% in the land check. Under load it exceeds 240 s (runs g1 and 1).

### The large case is opt-in

Ops decided on #312 that the large case (`real-index W0 resource envelope`) runs
only when `W1_LARGE_CASE=1` is set. In every gate it took about 6.5 minutes, set
the length of every pi-web-ui land's unit tests (414 of 416 s in run 2), and could
fail a land started on a busy machine. Its body, data and limits are unchanged.
The other 138 store cases stay in every gate (the file now takes about 7 s;
its four `W1_INDEX_PROFILE` trials stay opt-in too).

Any change to `server/usage-accounting-store.ts`,
`tests/unit/usage-accounting-store.test.ts` or this document needs one opt-in pass
at the unchanged limits before it lands. Start it only when the machine is quiet
(1- and 5-minute load under 4.0, no `check.sh` or Vitest running), from the change's
worktree:

```
TZ=UTC VITEST_MAX_WORKERS=4 scripts/sealed.sh env W1_LARGE_CASE=1 npx vitest run tests/unit/usage-accounting-store.test.ts
```

The pass counts only if the whole file passes and the large case is not skipped
(its `W1-STORE-INGEST` and `W1-STORE-MEASURE` lines are printed).

## Parallel ownership and safety

Owned paths only: `server/usage-accounting-store.ts`,
`tests/unit/usage-accounting-store.test.ts`, this document. Read-only interface
and security reviews may run beside implementation. Test implementation may run
independently after the module API is fixed. Tests run after implementation and
review; the normal `wt land` gate remains mandatory. No install is authorized.

The host must supply one process-lifetime shared in-process lease to every
worker that could open this store. `GuardFileLock` deliberately requires its
caller to provide that lease: worker threads share a PID. A live PID, including
this process's own, means **waiting-for-previous-writer**, never stale takeover.
An abruptly terminated worker's lease is not automatically cleared. W6 owns
graceful shutdown and stale/unavailable cache reporting; an uncertain writer
must remain unavailable rather than be replaced optimistically.

## H-WIRE-1b — publication race and prior-state retention

Evidence: independent read-only review found a scratch-name swap could evade the
last target check, and catch-only preservation cannot survive loss of ownership
or process death after rename. One change: keep the verified scratch FD through
publication, validate its inode/link count after every final hook and sync, and
atomically fsync one bounded exact prior checkpoint/native state **before** the
primary rename. The same atomic routine handles these two fixed backup files;
there is no new lock algorithm or unbounded healthy-backup series. Failure-only
hash-named copies still preserve corrupt metadata. Expected: swap/lock-loss/crash
fixtures cannot return a successful bad fence, and prior bytes survive without
any post-loss write. Falsifier: a bad target acknowledged, absent prior bytes after
rename, or metadata exceeding capacity. Verdict: pending final fixtures.

## Storage format and recovery contract

`UsageAccountingStore.open({dataDir, lease})` is worker-only. Open returns a
fixed status, not a raw filesystem exception: `ready`,
`waiting-for-previous-writer`, `unavailable` or `closed`. Every unavailable or
waiting instance must still be `close()`d. A waiting instance never retries or
steals a live PID lock. Reopening is an explicit host/lifecycle decision. A
worker killed while holding its process-lifetime shared lease leaves the lease
busy; an uncertain writer is not declared dead merely because its Worker exited.
The unchanged reviewed helper supplies ext4 device/inode/PID checks. Its own
transient lock names are its responsibility; W1 does not sweep accounting files.

All directory components are opened without following symlinks. A pinned,
owner-controlled data directory contains owner-only `usage-accounting` (0700).
Files are exclusive-create 0600, regular, expected-owner and single-link, opened
with `O_NOFOLLOW | O_NONBLOCK`; FD/path identity is checked before use. Held
index FDs and directory FDs are used, never a pathname-reopening database. Root
replacement or lock loss makes the worker unavailable before its next operation.
These protections do not claim isolation from root or a hostile same-UID writer.

Fixed names:

- `header.numeric`: closed version/major/minor plus a random persistent store
  generation. The header is validated **before** lock takeover or cache reset.
  Major >1 is refused without mutating any store byte; unknown older schemas and
  unsupported minors are refused too. A missing header beside retained evidence
  is not permission to invent a fresh store.
- `journal-000001.numeric`, `journal-000002.numeric`, …: consecutive 1 MiB
  segments containing W0's exact canonical numeric frames. `append` checks the
  expected inode/length, next sequence and one complete bounded line. Creation
  is exclusive; no gap reuse, truncate, overwrite, automatic repair or pruning.
  Recovery must read every retained numeric byte and sync every segment before
  append. It never reads source chats.
- `checkpoint.numeric`: W0's closed sequence/end/SHA-256 prefix only. Journal
  append → journal file **and directory** fsync → derived index → index fsync →
  scratch write/file fsync → rename → directory fsync. Only then is the prefix
  published. Partial writes fail; no hidden retry fills a short write.
  `checkpoint.previous.numeric` / `native.previous.numeric` hold one exact durable
  prior metadata state, copied before primary replacement. They are bounded
  derived metadata, never an authority to restore a cursor automatically.
  Only exact remembered/replay-trusted primary bytes rotate over a previous
  state. An untrusted/corrupt primary is hash-preserved instead; it cannot
  overwrite a valid backup before a new primary publication succeeds.
- `native.numeric`: checksummed `usage-store-native/1` envelope around W0's
  `usage-meter-index/1`, binding native file/feed cursors to the same persistent
  store generation, rebuilt numeric-content digest and exact synced prefix.
  `commitNative(cursors, committedPrefix())` is allowed only after successful
  collector publication. This is metadata persistence, **not** native provenance:
  W3/W4 must first verify anchors and token/epoch handling.
- `fault-<fixed-code>.numeric`: bounded, exclusive, fsynced fault receipts.
  Repeated alarms have one stable code/count, not raw paths, tokens or errors.
  On head/reopen, existing receipts are validated and reloaded; corrupt or unknown
  receipt contents fail unavailable without deleting or silently replacing them.
  Receipt failure remains unavailable; a failed write is never called durable.
- `evidence-checkpoint-<sha256>.numeric` / `evidence-native-<sha256>.numeric`:
  exact bounded copies of invalid/untrusted metadata before a replacement.
  An interrupted scratch file is retained and counted, not swept.

W0 replays and validates native numeric semantics; W1 independently hashes the
same canonical byte chain. A syntactically valid checkpoint is not proof.
Torn tails and corrupt complete frames stay byte-for-byte in their original
segments. A torn suffix is fenced by a new segment, not truncated. Corrupt
complete frames stop collection. A missing/mismatched/unpublished checkpoint is
UNKNOWN: W1 returns a transport-only invalid checkpoint marker to make W0 carry
its fixed `checkpoint-corrupt` fault; it does not rewrite the original file.
A complete unpublished frame can be replayed exactly once, but is not silently
called clean. A source cursor is never exposed from an unvalidated cache label.

`status().alarms` includes retained historical receipts. W5/W6 must carry these
fixed alarms through their closed fault/health DTO mapping; native cursor
availability is **not** a healthy/complete/zero-spend verdict and cannot erase
an existing UNKNOWN or exposure gap.

`nativeCheckpoint()` returns available only after full numeric replay, all file
and directory syncs, the exact prefix proof and an identical logical index
content digest. It may then rebind **only the derived generation**, keeping
opaque tokens/epochs byte for byte. Missing, corrupt, stale or mismatched native
mapping is unavailable; the retained mapping is not a usable seek cursor. It is
never guessed from a maximum ordinal, timestamp, hash or journal sequence.

## Numeric cache: authenticated, bounded Patricia index

A reviewed design comparison rejected Node SQLite for this seam: it reopens a
canonicalized filesystem path instead of adopting the validated FD, and its
normal pages do not authenticate negative lookups. No dependency or new lock
algorithm is introduced. The index is a binary Patricia/Merkle trie over ASCII
W0 keys, with append-only payloads and in-place **derived** node updates.

`index.nodes` and `index.values` each begin with a 96-byte header: an eight-byte
`UMIDX1N\\n` / `UMIDX1V\\n` magic, 32-byte generation, 24 zero padding bytes,
then SHA-256 of bytes 0–63. Node slot `id` is at `96 + (id-1)*192`:

| Bytes            | Meaning                                               |
| ---------------- | ----------------------------------------------------- |
| 0–3, 4, 5–7      | `UMN1`, leaf=0/branch=1, zero padding                 |
| 8–11, 12–15      | big-endian node ID and discriminating bit             |
| 16–19, 20–23     | left/right child IDs (zero for leaf)                  |
| 24–31, 32–35     | big-endian payload offset/length (zero for branch)    |
| 36–67            | exact index generation                                |
| 68–99, 100–131   | child SHA-256 values; leaf uses first for payload SHA |
| 132–159, 160–191 | zero padding, SHA-256 of bytes 0–159                  |

A leaf payload is canonical `{key,value}` numeric JSON, <=256 KiB. Every loaded
node validates ID, generation, padding, kind, offset/length, checksum and expected
parent hash. A private immutable cached node retains that authenticated hash;
cache hits still match the expected parent hash. The trusted current root stays
worker-local. Absence requires either the trusted empty root or an authenticated
complete terminal key; missing/truncated/corrupt pages throw, never return a
negative lookup. Index partial mutation poisons the worker immediately. Reopen
resets **only these two derived files**, then W0 rebuilds from numeric pages.

Keys use `1` + eight byte bits per ASCII byte and a terminal `0`, preserving
binary order and making complete keys prefix-free. Prefix seeks omit the
terminator. Branch bits increase strictly. Lower-bound seeks compare the
terminal key at the first differing bit, so skipped Patricia bits cannot omit
valid keys. Left-before-right iteration provides ascending prefix pages and
exclusive `after`, without filtering the full cold history for each page.

W0's longest constructors combine bounded 256-character references and escaped
fact/task tuples; a conservative 2048-byte ASCII key bound covers them. This is
**not a balanced tree**: the finite path bound is `2048*9+1`, not 256. Traversal
is iterative, with a compact fixed ID/bit/hash workspace; 256 nodes is the work
quantum, yielding earlier near 25 ms. Workspace and conservative 704-byte cached
node charges together stay <=8 MiB. Pages remain <=256 rows/256 KiB; reads and
hashing are worker-local, individual reads <=256 KiB, recovery staging <=1 MiB.
Each write page prepares one <=256 KiB payload append, retaining per-entry byte
offsets/hashes and sequential mutation order. Delete-only pages append no
payload. Payload/planning buffers and sort/read-modify-write scratch are charged
to that same 8 MiB workspace/cache budget, reducing retained node capacity rather
than expanding the limit. Conservative admission proves ordinary pages; near
capacity an exact bounded preflight includes transient entry peaks, abandoned
nodes and every overwritten payload before any append. Checked writes still
revalidate the original root/lease/reviewed lock; no fence is skipped.
One serialized operation and at most one pending caller are admitted; there are
no asynchronous filesystem/thread-pool operations or outstanding hash jobs.

The persistent index content checksum is SHA-256 over live entry count, exact
live canonical bytes and the XOR of per-key/value SHA-256 values. It is independent
of replay order/generation; node authentication remains the Merkle root, not XOR.
Rebinding checks this content checksum only **after** authoritative journal replay.
It is neither a signature nor permission to trust an index without replay.

Capacity counts actual node/data/header bytes, including abandoned slots and old
payloads, as well as live entries/bytes. Conservative `reserve` includes two new
nodes per anticipated entry, new payloads, and the physical two-entry/1 KiB final
fault margin. It also retains a journal segment/1 KiB fault reserve. No cache
compaction or evidence pruning makes room. Default hard limits remain W0's 4 GiB /
4096 journal segments, 1 GiB / 2,000,000 index entries. Metadata is separately
limited to 16 MiB and 8192 directory entries; checkpoints are <=512 KiB, transported
in bounded <=256 KiB reads/writes. Smaller fixture/operational capacities never
raise those ceilings. ENOSPC, permission failures, hard capacity and uncertain
syncs are fixed unavailable alarms, not zero totals or a successful durable fence.

## Compatible-copy migration and rollback

`prepareMigration()` is a preflight, **not** a major-version migrator. Under the
same lifetime lock it exclusively creates one 0700 `compatible-1` directory,
copies only bounded evidence/metadata pages to 0600 files, fsyncs each file and
both directories, and writes `copy.numeric`. Derived cache files need no copy.
It then seals further writes (`migration-prepared`). An existing or interrupted
copy is retained; never overwritten, deleted or accepted as a completed receipt.
The one copy is capped at journal+metadata capacity (4 GiB+16 MiB by default);
there is no unbounded backup series. Base store+index+one copy has a finite
9 GiB+32 MiB byte ceiling plus a <=512-byte copy receipt and bounded directory/
file-system overhead.

No implementation here writes major 2. A future approved migrator must require
this completed compatible copy, stop/close the old writer, and preserve the
newer evidence separately. Rollback must stop the newer writer first and restore
the compatible v1 copy as a separate store, or leave the old meter unavailable.
Never run an older reader against a newer store hoping it will downgrade it.
`copy.numeric` is recognized metadata when the compatible copy is restored;
its original header/generation and native mapping remain intact for replay.

## H-WIRE-1c — bounded dirty-node drain

Focused evidence: ingestion of 4,358 attempts failed at sequence 35 with fixed
`store-capacity`, despite only 3,295,062 journal bytes and 21,558,555 index bytes.
The index work slice reached 109.60 ms; the collector slice was 28.59 ms. Source
inspection found the final dirty-node flush synchronous over a full index-write
page, outside traversal yields. One change: drain dirty nodes with the same
bounded cooperative steps as traversal, before an index operation returns.
A later synchronous durability fence requires the dirty set already empty.
Expected: the 100,000-attempt fixed case passes the unchanged 100 ms per-work-unit,
30 s warm-publication and memory/page ceilings. Falsifier: the same capacity alarm
persists, any unflushed mutation is acknowledged, or any ceiling is exceeded.
Verdict: flush mechanism confirmed by independent source review; final resource
proof pending. The next focused case instead hit W0's separate cold input parser
`time-limit` (136.15 ms on the first 128-fact batch; index work 5.47 ms). This is
not a passing result and the 100 ms limit remains unchanged.

## H-WIRE-1d — match the delivered resource fixture

The W1 large fixture generated each page immediately before ingestion; W0's
reviewed resource fixture prepares bounded synthetic source files first, then
reopens and reads them by pages. Cold-parser timing was not reproduced in W0's
layout, so compare like with like before attributing that separate failure.
Change only fixture preparation to W0's disk-backed layout, keeping 128 facts per
batch, real clocks, preparation memory accounting, 100,000 attempts/65 sources,
all deadlines, and all heap/page/FD safety checks. No warm-up collects or retries.
Expected: a comparable measured production-store result; falsifier: unchanged
inputs still exceed 100 ms or any other ceiling. A repeat parser failure is W0
attention, not permission to relax the guard. Verdict: **MISS** for the complete
resource bar: the parser failure did not repeat, but the fixed case exceeded
240 seconds before completion. No timings or guards were relaxed.

## H-WIRE-1e — coalesce derived-node writes, preserve every fence

Evidence: the fixed case outlived 240 seconds with the guard-preserving dirty
node drain. Each 192-byte dirty node currently causes a separate synchronous
write plus the same root/lease/lock checks. A 128-fact mutation revisits many
nodes; draining cooperatively limits pauses but not syscall volume.
One change: coalesce sorted dirty node slots into bounded 64-node/12 KiB
read-modify-write pages. Keep the same checked filesystem write per page, file
identity checks, immutable authenticated nodes, empty-dirty-set durability
fence, finite capacity and yields. Charge the temporary sorted IDs and page
buffer against the unchanged 8 MiB cache budget. This is derived-cache I/O only;
journal, native/checkpoint bytes and every durability fence are unchanged.
Expected: the actual 100,000-attempt ingest/reopen and <30-second warm fold pass
unchanged deadlines and memory/FD/crash checks. Fixed scalar stage measurements
will distinguish ingestion, replay and publication if they still fail.
Falsifier: any unchanged deadline/ceiling fails, coalescing acknowledges a short
or corrupt write, or a cache lookup can ignore authentication. Verdict: **MISS**:
the staged normal gate still exceeded its ingestion deadline. Node coalescing
alone did not eliminate the per-value checked-write overhead; H-WIRE-1g tests
that specific remaining mechanism without removing any write check.

## H-WIRE-1f — separate the durable corpus stages honestly

The scalar-node case ingested all 100,000 attempts/65 sources in 149.43 seconds
(75,711,597 journal bytes, 501,690 index entries, 497,673,627 allocated index
bytes, 8,388,488-byte peak cache, 45.70 ms peak index work). The combined test
then exhausted its 240-second harness allowance during cold replay. This is
incomplete evidence, not a passing warm-publication result. W0's actual warm
budget is under 30 seconds, with cold phases measured separately; W1's extra
filesystem ownership/authentication work is real and must be reported.

One test-scope change: prepare/ingest and close the synthetic corpus in one
Worker; reopen/replay and publish in a fresh Worker. Each stage retains a
240-second test deadline, with an explicit combined limit of 480 seconds.
This **increases the aggregate W1 harness allowance**; it does not preserve the
previous combined 240-second limit or claim faster recovery. The 100,000 inputs,
65 exact source cursors, journal/index evidence, actual Worker resource limits,
100 ms work quantum, page/cache/heap/RSS ceilings and uninterrupted <30-second
warm update plus publication remain unchanged. Report every phase and the
combined elapsed time. Keep the directory until both workers terminate, then
remove only that synthetic directory. Independent read-only review accepted
this staged-harness change with these caveats. Falsifier: either stage >=240
seconds, combined >=480 seconds, warm publication >=30 seconds, a resource or
exact-output failure, or failure to close/reopen the durable state.

Separately, coalesced flushing now charges all written node slots to the
existing 256-node work quantum, yielding before a group would cross it. That
keeps write coalescing from silently multiplying the amount of work per turn.
The coalescing regression now subtracts the measured payload append count
before counting node/header writes; read-only review caught the original mixed
counter before the gate was allowed to finish. First staged normal gate:
**MISS**, ingestion exceeded 240 seconds (47/65 sources at 213.86 seconds).
All 131 small W1 cases passed and 7,396 tests passed overall; no deadline,
clock, quantum, lease or durability check was weakened. H-WIRE-1g addresses
that measured filesystem overhead; the staged limits remain as disclosed above.

## Handoffs

W0 owns numeric semantics and replay validation. W1 owns storage and never
infers source completeness. W3/W4 still verify native provenance/anchors and
explicit epoch/reset handling; syntactically valid metadata is not provenance.
W5 must propagate collector faults and incomplete scans. W6 supplies the shared
lease and worker resource limits, owns retry/lifecycle and keeps the main thread
limited to the closed scalar cache contract. No source registration, spending,
policy, automatic stop or runtime activation is added here.

Ops (gate owner): W1's large case is opt-in (see "The large case is opt-in"); a
change to the store runs it once before landing. W0's 100,000 collector case is
outside #312 and still runs in every gate (Ops #414 is speeding it up).

## Undo

Revert the single W1 commit before dependent wiring lands; otherwise revert its
dependents first. There is no installed service or active collector to undo.
Never delete accounting evidence or silently downgrade a store to roll code
back. Future migration requires an explicit compatible copy and stopped writer.
