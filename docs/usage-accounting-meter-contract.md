# Usage meter worker groundwork — W0 / Ops #311

Accountable lead: **Ops**. Inert groundwork only; no live reads, lifecycle hook,
service, timer, credential, root registration, install or budget change.

## H-WIRE-0 — written before implementation

Wrong/evidence: #300 caps a whole retained store at 16 MiB, 10,000 unique rows
and 64 sources. Its recovery reads all segments and retains a checkpoint image
for every frame; each append canonicalizes, sorts and validates the entire
history. Those fixture limits and quadratic work cannot cover a production
100,000-attempt week. Blanket no-import tests also preclude the reviewed worker
modules. Importing the guard host merely to reuse its lock would load unrelated
runtime code.

One change/why: add an opt-in, paged/yielding collector lane, bounded numeric
indices and explicit fault-bearing evidence plus a closed worker DTO contract.
Keep the legacy injected I/O lane and its exact oracle. Extract only the reviewed
lock algorithm and replace blanket importer bans with exact worker-side edges
and positive main-thread reachability checks. Cold evidence stays in the
append-only store and is paged; no larger whole-journal string is accepted.

Expected/measurement: all legacy numeric/crash/privacy outcomes stay exact;
recovery above 10,000 rows, 64 sources and 16 MiB yields between bounded reads.
A fixed 100,000-attempt current week updates/publishes in under 30 seconds,
within measured finite Worker heap/process RSS bounds. Main-thread filesystem
callback latency remains inside the documented baseline/load envelope. Capacity
refusal is durable, leaves cursors unchanged and makes the remainder UNKNOWN.
Worker termination leaves the host healthy and the cache stale/unavailable.

Falsifier: lost/duplicate/repriced evidence, an advanced uncommitted cursor,
quarantine becoming healthy, truncation disguised as a complete week, unbounded
allocation, a direct/transitive engine import on a main-thread cache/page path,
lock behavior drift, missed latency/memory bar, or host failure on Worker loss.

Result: **HIT** in the final post-#331 sealed normal gate: 470 test files,
7,265 passing tests and six existing skips, with unchanged numeric/crash/privacy,
100 ms work-unit, memory and publication bars. Measurements and earlier misses
are retained below. Detached normal landing still requires its mandatory checks.
Resource limits are operational bounds, not budget caps.

## Parallel ownership

Collector/contract/measurements are one workstream. Lock extraction and the
reader/membership importer guards are independent, disjoint workstreams.
Tests run once after implementation; normal detached `wt land` remains required.
No existing money/privacy assertions or lock regressions may be weakened.

## Closed worker messages (adapter handoff)

`server/usage-accounting-meter-contract.ts` has **no imports**. The only host
command is bounded `usage-meter-command/1` / `evaluate(request, asOf)`; it cannot
register a root, fetch a path, grant money, stop a role or change a cap. Worker
replies are `usage-meter-snapshot/1` or fixed `usage-meter-health/1`. Snapshot
validation rejects extra fields at every level, arbitrary fault text, duplicate
subjects/sources, oversized lists/bytes, invalid money, optimistic watermarks and
headroom in a partial/stale/unavailable/non-policy view. Public faults are fixed
codes plus counts, not raw evidence references or exceptions. Task queue identity
is a SHA-256 `queueKey`, not a canonical local queue filename.

Generation is `{epoch: sha256, sequence: integer}`. W6 owns the process-lifetime
epoch and monotonic cache replacement; a new epoch requires the current worker
identity, not a numerically larger sequence. W6 must independently invalidate an
old Pacific week and the 60-second freshness age on every cache read. A snapshot
publication time does not refresh `observedAt`, `complete_through` or
`lastProgressAt`. For **Pi/ACP/metadata only**, required enabled sources stalled
for five minutes produce the fixed `source-stalled` alarm; read/publication
never resets the progress clock.

### S0 correction — Temper v1 is never complete

Ops lead's contract correction consumes Security #17 at `c7a0755c`,
`docs/usage-accounting-security.md`, “Cursor and failure boundary”. The earlier
shared source shape would have allowed a frontier to masquerade as coverage.
The corrected discriminated Temper shape fixes `coverage: "unknown"` and allows
only available/unavailable state, **no `complete_through`, complete/partial state
or completeness alarm**. Its `frontier` is explicitly `diagnosticOnly: true`:
`recorded_through`, `pending_count`, `oldest_pending`, `last_drain`, an inspected
`assessed_from`/`assessed_through` interval, frontier freshness, and closed
normalized stall codes. Delayed, stalled and dead-man labels diagnose frontier
freshness only. Required Temper therefore forces `oldestCoveredThrough: null`;
no fresh frontier, poll, empty page or drain can enable a complete subject or
remaining budget. Pi coverage remains the frozen #293 contract. Outcome **HIT**:
fixed negative controls reject the superseded shape and reassuring coverage.
The separately owned wiring document is deliberately unchanged.

Worker-private `usage-meter-index/1` checkpoints separate the journal prefix and
numeric-index generation from native cursors. File cursors include header hash,
incarnation, byte/line and an anchored byte range ending exactly at the cursor.
Feed cursor tokens are opaque route-issued strings (maximum **256 characters**)
paired with a reader epoch, retained byte for byte. The feed cursor shape has
**no ordinal, `seq`, `after`, `through_seq`, `max_seq` or coverage watermark**;
collector journal sequence and occurrence identity are separate metadata.
Only a durable batch commit may advance the native token sidecar. On 409, the
old token/epoch is retained with `state: "quarantined"`, never reset to zero or
a maximum; the separately approved explicit epoch handshake owns any re-read.
Off, 403, 503, timeout or malformed page retains the last good token/evidence
with an unavailable fault and UNKNOWN coverage. `MeterFeedFailure` encodes this
closed retain/quarantine distinction; W3/W7 must execute it, not infer success
from a structurally valid token. Checkpoints and feed tokens are forbidden in
public snapshots. Parsing a structurally valid index
checkpoint proves no prefix: W1 must validate/rebuild it from the synced journal,
and W3/W4 must verify native anchors/cursor reset handling before accepting it.

The legacy normalized `SourceCursor` remains unchanged for frozen injected I/O;
private adapters keep their native cursor metadata in the separate index seam.
Worker exit/resource-limit errors can publish only a fixed unavailable health
code; a retained last-good snapshot is stale evidence, never fresh zero/headroom.
There is no production Worker creation, lifecycle or cache installation in W0.
The test-only Worker is isolated to synthetic temporary files.

## W1 paged store / W5 evidence handoff

`UsageAccountingCollector.open()` and its injected `CollectorIO`, limits, public
numeric input and reporting behavior remain the legacy oracle. The additive
`openPaged({inventory, verifier, io, clock?})` accepts only an explicit
`usage-collector-paged-io/1`; it has no default filesystem adapter. No verifier or
I/O means unavailable, not an invented source, root or clean zero.

The paged port supplies `head(limits)`, `readPage({segment, offset}, maxBytes)`,
`append`, `sync`, `checkpoint`, a true event-loop `yield`, and a private derived
numeric index. `head` checks consecutive private segment identities, regular-file
ownership and sizes before allocation. Native anchoring/file protections belong
to W1/W3; accepting a label or cursor is not native provenance. A page is at most
256 KiB / 256 rows, segments remain 1 MiB, and source-batch limits are unchanged.
The recovery buffer holds only a bounded frame plus one page, not a journal
string. Recovery yields after every bounded page/frame/index operation. Active
work units are limited to 100 ms, with 25 ms the scheduling slice target.

Index API: `reset`, `reserve(newEntries,newBytes)`, bounded `get`, binary-key
`scan(prefix,after,limits)`, and bounded `write`. The index is numeric cache, not
accounting authority. W1 must reject corrupt/missing pages rather than return an
optimistic negative lookup; validate checksums, generation and the journal
prefix; cap disk entries/bytes and page cache; and invalidate any partial write
on failure. W0 rebuilds it from the exact append/synced replay prefix on open.
The collector's `usage-paged-checkpoint/1` is a small sequence/end/digest prefix
anchor, not the richer `usage-meter-index/1` native cursor/index sidecar. W1
must bind that sidecar to the same proven generation/sequence/prefix and preserve
opaque native tokens there; it must not append extra fields to the collector's
closed checkpoint or derive a native token from an ordinal/hash. A missing or
invalid native mapping is unavailable and requires verified native recovery.
Do not skip replay on the strength of an index/checkpoint label. `reset` deletes
only derived cache contents, never a journal. Index writes need not fsync on each
page: journal append+sync precedes them; checkpoint durability publishes their
journal anchor. A failed index/checkpoint write closes the collector and the next
open rebuilds, without appending a second frame at the same sequence.

Private keys: `n:` identity-to-component, `r:` canonical numeric component rows,
`w:` earliest consistency witness, `b:` exact canonical batch receipt, `qref:`
active quarantine pointer, ordered `q:` quarantine receipts, `a:` earliest active
fault bucket, `f:` earliest permanent fault bucket, `e:` occurrence-week exposure,
`x:` reverse exposure manifest, and `c:` through-week source coverage. Hashes
address normalized rows/components; actual duplicate receipts compare canonical
bytes, never only a digest. Components join fact revisions, aliases, native event
identity and event-time task membership; roots/policies/snapshots keep their own
conflict identities. Phase/order witnesses preserve the legacy first-error order,
including a quarantined cold revision or binding repaired in a later batch.

The **dependency ceiling is 4096 rows / 4 MiB per touched working set**, not a
100,000-row in-memory ledger. A very large connected alias/task/revision group,
or too many outstanding conflicting groups, is intentionally capacity UNKNOWN;
there is no silent truncation or claim that every possible 100,000-attempt shape
fits. The fixed large case establishes the documented independent-attempt shape.
Record that ceiling when building W3/W5; do not blindly increase it. All retained
numeric history stays in the journal and private bounded disk index, cold rows
are paged, and current-week exposure does not scan unrelated cold fact rows.

Ordinary writes reserve one segment, one frame and at least 1 KiB for the final
capacity fault; the index leaves two entries / 1 KiB for that fault too. Derived
row/receipt/witness envelopes and conservative index admission are checked
**before** journal append. A capacity refusal persists a `store-capacity` frame,
keeps the prior cursor and seals collection. Reopen remains sealed/partial.
Unexpected I/O failure is unavailable; it must not pretend a fault receipt was
durable. W1 must provision the reserve and never delete history to make room.

`evidence(asOf)` is fault-bearing, with storage/inventory state, required sources,
sequence, normalized faults and `faultCounts`. Counts mean affected code/source
buckets, not attempts or charges. Multi-source references collapse conservatively
to `collector`; private index receipts retain the underlying numeric history.
`evidencePages(asOf, "current-week" | "all")` yields closed private numeric pages
with that same header, not an optimistic bare `input()`. Page byte limits include
the header. Stream-name metadata is capped at 128 KiB; row envelopes leave room
for all fixed fault kinds. As-of views never hide current corruption/capacity.
A queued write or changed sequence aborts a pinned scan rather than mixing
indices. W5 must catch an aborted/incomplete scan, publish unavailable/partial,
carry every fault into subject usage/funding dimensions and withhold remainder.
It must preserve event-time windows, revisions and aliases when folding pages;
pages are transport boundaries, not independent charges or standalone ledgers.

## Operational isolation bar (written before measurement)

These are operational limits, **not spending caps**, and do not grant roots,
policy authority, activation or admission. The exported immutable limits are:
1024 sources; 4 GiB / 4096 segments / 1,000,000 frames of journal; 1 GiB /
2,000,000 entries of derived numeric index; 8 MiB index page cache; 1 MiB I/O
staging; 4096 rows / 4 MiB dependency working set; 512 KiB checkpoint; 256 KiB
public snapshot / 256 subjects / 64 fixed fault kinds. The ordinary-write reserve
means usable capacity is strictly below those hard ceilings. Inventory metadata
is bounded separately before approval. No heap-bound whole-week array is added.

W6 must pass `METER_WORKER_RESOURCE_LIMITS` to the single lifetime-locked Worker:
old generation **512 MiB**, young generation **32 MiB**, code range **16 MiB**,
stack **4 MiB**. The acceptance bar is peak observed worker heap **<=448 MiB**
and containing process RSS **<=1280 MiB**, leaving V8/native/index/host margin;
resourceLimits are V8 limits, not an RSS guarantee. A process/native allocator
failure still requires stale/unavailable reporting, never fabricated coverage.
The synthetic current-week update/publication must be **<30,000 ms**. Record
replay and initial ingestion separately rather than hiding cold recovery in an
update measurement. Main-thread fs callback acceptance is load p95 no more than
`max(100 ms, 10 × baseline p95)` and max **<=1000 ms**, with host health after
Worker loss. The death fixture uses a deliberately smaller finite Worker heap to
exercise termination without spending the production heap merely to crash it.

Final measurements and HIT/MISS are recorded below; failed stages remain failed.
The post-#331 normal gate is green. Normal landing repeats the required checks.
No resource ceiling was raised to turn a miss into a hit.

## First-stage finding and H-WIRE-0a

The first sealed stage run is **MISS**: 981 passed, 28 failed, one pre-existing
skip. All unchanged lock regressions and the legacy numeric/DTO suites passed.
The import-guard parser reused the first virtual file's AST for later texts;
therefore its mutation checks were not valid proof. The large dependency fixture
hit its 30-second test setup timeout, and the 100,000-attempt fixture stopped on
an unsuccessful ingestion result before any measurement could be accepted.
Server typechecking also exposed missing discriminant narrowing and one inferred
page type; these are corrected without changing runtime behavior.

H-WIRE-0a: make each virtual parse observe its actual supplied text, retain every
existing direct/transitive mutation and add consecutive/empty-text controls.
Expected: the unchanged guards classify each mutation independently, including
erased edges, while the real tree remains clean. Falsifier: stale references,
a missed mutation, or an import-guard timeout. In parallel, expose only the fixed
status/code/sequence of the failing synthetic ingestion, then isolate the doubtful
numeric stage; do not change a resource limit or numeric assertion to hide it.
Outcome **HIT** in the final gate: consecutive/empty-text controls, direct and
transitive mutations and real-tree checks pass independently. Numeric ingestion,
capacity, cursor and crash cases pass without weakening their assertions.

## H-WIRE-0b: batch derived writes, not durability

The isolated numeric stage preserved all 100,000 attempts and exact decimals,
including 65 source cursors and 75,714,977 journal bytes. Dependency exhaustion
passed. However, replay plus publication took 30,174.97 ms against the unchanged
30,000 ms fixture bar (initial ingestion 27,986.95 ms; ordinary current-week
update/publication 9,453.15 ms). This is **MISS**, not a rounding exception.
The adapter observed 613,027 event-loop yields. Each independent one-fact
component unnecessarily flushed its five-entry derived-index write separately.

One change: stream component mutations through the existing bounded write pager
across component boundaries. The journal append/sync, derived-cache update,
checkpoint ordering, per-page row/byte ceilings and page yields remain unchanged;
no resource or timing bound increases. Expected: fewer tiny writes/yields and
meaningful margin below the 30-second fixture bar. Measure the same fixed worker
case and all numeric/crash fixtures. Falsifier: any oracle/crash/cursor difference,
allocation/page limit violation, or no replay timing improvement. Outcome **MISS**:
combined stages kept all numeric/crash checks, and yields fell from 613,027 to
417,837, but ingestion/replay/publication were 43,185.46/54,014.26/15,875.58 ms.
The direct/transitive guard repairs now pass; 1,010 tests passed, two performance
cases failed, one pre-existing skip. Batching alone is not the throughput fix.

## H-WIRE-0c: avoid revalidating already-proved new components

Evidence: each clean 128-fact batch is parsed/normalized once at the source
boundary, then each new independent one-row component is parsed, normalized,
checked and yielded again. No retained dependency exists on this new-component
path. One change: when there are no old components, prove consistency of the
already parsed/normalized delta once; only if it is clean, preserve its canonical
subsequences as healthy component plans. Keep the existing dependency/witness path
for every retained component and every non-clean delta. No index lookup, limit,
append/sync/checkpoint rule or assertion changes. Expected: eliminate 100,000
redundant component validations/yields while preserving every legacy/crash result;
measure the unchanged 100,000-attempt case. Falsifier: any changed numeric/fault/
cursor result, or continued failure of the unchanged timing bars. Outcome **MISS**
for the over-broad fixture bar: yields fell again to 217,836, and all exact totals
remained correct, but initial/replay/update were 48,498.36/36,725.17/18,081.00 ms.
Worker heap peaked at 34,962,192 bytes and RSS at 224,260,096 bytes. Reducing yields
did not establish a universal cold-start throughput gain; do not claim it did.

## H-WIRE-0d: use a full legal page in dependency-capacity setup

The dependency test is a correctness fixture, not the current-week latency bar;
it times out while repeatedly rebuilding a growing connected component using
half-full 128-row pages. One change: fill its existing legal 256-row page instead,
keeping 5,120 candidate facts, exact-decimal assertions, cold dependency exhaustion,
durable fence/reopen and prior-cursor checks. Expected: fewer repeated prefixes
without changing the capacity boundary or any bound/assertion. Falsifier: a page
rejection, lost numeric proof, or continued setup timeout. Outcome **HIT** in
the isolated stage: the full-page fixture preserves the capacity/reopen/decimal
assertions and completes within its unchanged 30-second setup deadline.

## H-WIRE-0e: align the measurement oracle with the approved budget

The approved W0 plan and the isolation bar above require **current-week update
plus publication below 30 seconds**, with cold ingestion/replay reported
separately. The new harness accidentally applied that budget to all three phases.
That extra cold-start requirement was not an owner acceptance criterion. It
caused the last failure despite the required update/publication passing at
18,081.00 ms, exact totals passing, bounded pages, safe Worker loss and fs latency.

One change: assert the approved 30,000 ms bound on update/publication; keep both
cold measurements finite/nonnegative and keep the existing 120,000 ms total
fixture deadline, now also asserted explicitly. No runtime resource limit,
monetary/numeric oracle, page/cursor/crash assertion, or test deadline increases.
This is a test-scope correction, not a claim that cold recovery meets 30 seconds.
Expected: the fixture reports cold costs honestly and enforces the actual warm
publication requirement. Falsifier: warm publication >=30 seconds, total fixture
**>=120 seconds**, nonfinite cold timing or any changed numeric/crash/memory result.
Outcome **MISS** in the first full 467-file gate: the harness expired at 120
seconds while cold work competed with the full suite; no warm result was accepted.

## H-WIRE-0f: retain the global index-health/witness barrier

The full gate exposed two real regressions in H-WIRE-0c: its early clean-delta
return skipped the retained witness scan, so a faulty/failed index could commit
an empty new batch. The existing negative controls correctly failed. One change:
keep the local clean-component optimization, but always perform the existing
bounded global witness/index-health scan before selecting the batch code.
Expected/falsifier: both existing failed-index controls reject without advancing
a cursor, and all legacy/witness repair cases stay exact. Outcome **HIT** in the
second full gate: both unchanged failed-index controls and all numeric/crash
controls pass; the remaining failures are harness integration below.

## H-WIRE-0g: distinguish harness startup from runtime budgets

The full gate passed 7,196 tests but also exposed two harness issues: a clean
worktree needs its normal build before the systemd CLI test can import
`dist/server/plugin-updater.js`; and the native real-tree membership parse crossed
the default 5-second test timeout only while 467 test files competed for CPU.
These are not collector allocation or money limits. The 100,000-attempt cold
fixture previously measured 104.42 seconds in isolation and exhausted its
120-second **test harness** deadline in that full concurrent gate.

One change to scheduling allowances only: build first; give the full native
membership-graph test a bounded 15-second harness allowance, and give the cold
measurement fixture a bounded 240-second harness allowance (also asserted on its
reported total). Its warm update/publication remains strictly below 30,000 ms;
all 100 ms work units, page/source/store/heap/RSS/fs-callback bounds, exact money,
crash and cursor assertions stay unchanged. Add a closed unavailable-health DTO
assertion to the existing handled Worker-death proof. This is evidence-based
harness headroom, not a runtime/resource-cap increase or a cold-speed claim.
Falsifier: an actual guard error, warm-budget/memory/latency miss, total >=240
seconds, unsafe Worker death or any changed numeric/crash outcome. Outcome **MISS**
for the gate, with the numeric measurement **HIT**: warm publication 23,328.19 ms;
cold ingestion/replay 101,320.87/112,648.75 ms; total 238,314.96 ms. Heap/RSS were
33,387,464/217,862,144 bytes. Exact totals, capacity/crash controls and all page/work
limits pass. The reader's equivalent real-tree parse also crossed its default
5-second setup allowance; it receives the same bounded 15 seconds, without
changing virtual mutation deadlines. The new health assertion passed an object
to the deliberately string-only wire parser; that also causes typechecking to
fail. The production parser correctly rejects that non-wire input.

## H-WIRE-0h: test the actual serialized Worker-loss wire

Evidence: handled Worker termination reports `ERR_WORKER_OUT_OF_MEMORY`, but the
new assertion calls `parseMeterWorkerMessage` with an object instead of its
required bounded JSON string. One change: serialize both the unavailable message
and the forbidden ready mutation, exactly like a real Worker message. Expected:
unavailable parses, ready remains rejected, parent fs callbacks stay healthy,
and typechecking passes. Falsifier: either message is classified incorrectly,
a Worker error escapes, or a parent callback exceeds 1000 ms. Outcome **HIT**:
the third full gate passes typechecking and the handled death/health controls;
parent fs p95/max 13.2/122.15 ms and after-death callback 10.23 ms.

## H-WIRE-0i: bound test-runner fan-out, not meter limits

Evidence: the full parallel gate's cold fixture consumed 238.31 of its unchanged
240-second harness deadline versus 104.42 seconds in isolation; its parent fs
baseline p95 rose from 1.8 to 14.3 ms, and the parallel formatter took 149 seconds.
One scheduling change: bound test-runner fan-out, never meter limits. The first
invocation put `VITEST_MAX_WORKERS=4` outside `sealed.sh`; its clean environment
correctly removed that variable, so this was **not an executed fan-out trial**.
The unchanged fan-out gate safely rejected a synthetic batch at its 100 ms
work limit, and the collector's equivalent real-tree guard crossed its 5-second
setup deadline. It receives the same bounded 15-second native-setup allowance;
mutation and runtime deadlines remain unchanged. An unrelated webmail fixture
also failed under that run; this task does not edit it.

Attempted correction: pass `env VITEST_MAX_WORKERS=4` **after** `sealed.sh`, and
pin the detached verification process to four available CPUs with `taskset`.
CPU affinity is inherited through sealing. This changed only that temporary test
process, not app services, the host, repository config or Worker limits; no
landing was attempted with this affinity.
Every test still runs; no cold, warm, memory, work-unit, fs or numeric assertion
changes. Expected: avoid unrelated test-runner pressure while retaining the
measured main-thread probes under actual meter load. Falsifier: any missed
runtime envelope, changed outcome or total >=240 seconds. Outcome **MISS**:
7200 tests pass and all guards/typechecking/lint/format checks pass, but pinning
the entire gate (including native typechecking and formatting) to four CPUs still
causes a correct 100 ms refusal during initial ingestion. The prior cursor stays
at ordinal 76; no numeric success or cursor advance is fabricated. The handled
Worker-death probe remains healthy (fs p95/max 0.5/5.87 ms; after 1.53 ms).

The remaining test-runner seam is outside W0's nine-file ownership:
`scripts/sealed.sh` must preserve a deliberately supplied bounded Vitest fan-out
for the normal `wt land` check, without pinning unrelated native tools to four
CPUs. Its environment-fence regressions must still show that secrets are removed.
No such outside-file edit is made here.

### Ops coordinator decision: separate prerequisite #331

The Ops lead chose a separate gate prerequisite, #331, not a W0 ownership change.
W0 retains its original nine paths and is blocked until #331 normally lands the
bounded passthrough and supplies its effective invocation. It preserves only an
explicit inherited `VITEST_MAX_WORKERS` exactly 1, 2, 3 or 4; unset defaults stay
unchanged, invalid values fail before temp-home creation without echoing them.
Secret stripping, the Node fence/cleanup and already-sealed behavior stay intact.

After that result, rebase normally and verify W0's owned files/evidence, then run
its real normal gate once with four workers and normal CPU availability and land
detached with the same setting and mandatory checks. If the effective cap still
produces a work-guard failure, stop and return the concrete failure to the lead;
no unchanged retry, relaxed guard, global affinity or skipped test is authorized.
Do not spoof `PI_SEALED` or put `wt land` in a temporary HOME. The manual
`scripts/sealed.sh env VITEST_MAX_WORKERS=4 scripts/check.sh` alone does not fix
the normal land hook's outer scrub. This is the coordinator's technical decision,
not owner consent, collector readiness, activation or installation permission.

Retained full-gate measurement evidence (`ops-311-groundwork-check-v2.service`):
100,000 attempts across 65 sources; 75,714,977 bytes / 845 frames recovered;
100,001 published facts after one update in 395 pages, at most 256 rows /
194,315 bytes. Exact USD before/after: `4333.390000033333` /
`4333.390000033334`. Index 501,697 entries / 292,496,442 bytes with an 8 MiB
SQLite cache; maximum journal read 262,144 bytes. Maximum active work
63.06 ms initially / 36.07 ms on replay. Main fs baseline p95/max
14.3/61.39 ms; under meter load 4.1/255.42 ms (accepted p95/max 143/1000 ms).
Worker limits 512/32/16/4 MiB old/young/code/stack; heap/RSS measurement and
23,328.19 ms update are recorded above. These are retained measurements, **not a
passing final gate**: the subsequent safe refusals and failed gates remain MISS.
No install or runtime source admission follows from this evidence.

Prerequisite delivered: #331 normally landed `8122b540d8ac0d046bb0b37f510f14d6e54cde97`
(receipt `149-2d2658`), with 48/48 fence controls and both unchanged normal gates
passing. This proves the runner seam only, not W0 readiness. W0 was rebased onto
that commit: eight owned files retain identical SHA-256 contents; the host's only
inherited difference is #318's reviewed hourly exemption import/condition, kept
intact alongside the lock extraction. All 20 CPUs remain available, with no
`taskset`, fake HOME or asserted `PI_SEALED`. The final W0 gate used the genuine
normal `TZ=UTC VITEST_MAX_WORKERS=4 scripts/check.sh --fast` path after its isolated
build. On any remaining effective-cap failure during mandatory landing checks,
stop and return concrete evidence.

### Final post-#331 measurement — H-WIRE-0 / H-WIRE-0i HIT

`ops-311-groundwork-check-v5.service` completed successfully, with the worktree
build and unchanged normal gate: **470 files, 7,265 passed, six existing skips**;
unit duration 198.88 seconds. Protocol, PATCHES, typechecking, lint (zero errors)
and formatting passed. Both inherited fan-out and all 20 available CPUs were
preserved through the genuine seal. No runtime or numeric guard was relaxed.

The fixed case ingested/replayed **100,000 attempts over 65 sources**, recovering
**75,714,977 bytes / 845 frames**. Initial ingestion was **49,853.18 ms**, cold
replay **40,508.05 ms**, and the independent current-week update/publication
**12,324.69 ms**, below 30,000 ms; total fixture **104,415.93 ms**, below 240,000 ms.
Cold phases are not claimed to meet the warm deadline. Exact before/after USD:
`4333.390000033333` / `4333.390000033334`; all **100,001 facts** were published in
395 pages (maximum 256 rows / 194,315 bytes). Journal reads were at most
262,144 bytes; source batches at most 128 rows / 96,829 bytes. Peak active work
was **49.80 ms** initially and **17.32 ms** on replay, under the unchanged 100 ms
unit ceiling. Replay made 109,108 yields; the final update count was 209,515.

Observed isolated meter Worker heap/process RSS were **33,424,896 / 232,239,104
bytes**, within 448/1280 MiB. These are the synthetic meter process, not summed
memory of the concurrent build/test toolchain. The derived index held 501,697
entries / 292,496,442 bytes with an 8 MiB SQLite cache. Limits remain
512/32/16/4 MiB old/young/code/stack. Main-thread fs baseline p95/max were
**5.0/10.77 ms**, under meter load **1.3/37.77 ms**, inside the accepted
100/1000 ms envelope. The deliberate finite-heap death case, unavailable-only
health wire and healthy parent callbacks also passed. Legacy oracle, large
numeric, cold dependency, durable capacity/reopen, crash-prefix/cursor,
privacy/money, importer mutations and unchanged lock regressions all passed.

Normal detached `wt land` must use the same inherited four-worker setting and
unchanged hooks. This evidence authorizes neither installation nor live reads.

## Review corrections before execution

Read-only reviews retained the ext4 device/inode/pid and live-owner lock behavior.
They found a transitive type-only import-guard gap, escaped receipt/witness entry
capacity risk, degraded freshness/funding claims, a pending-fault reserve edge,
and property-order duplicate subjects. Those paths were corrected before the
stage run and receive fixed negative controls. No legacy numeric, privacy or lock
regression was weakened. Review alone is not proof of measured timing or memory.

## Undo

Revert the single #311 patch before any dependent adapter consumes it (or revert
its dependent patches first). Nothing is installed or started by this task;
there is no runtime switch, journal deletion, spend-file rewrite or service
rollback to perform here. Legacy `CollectorIO` remains the compatibility path.
