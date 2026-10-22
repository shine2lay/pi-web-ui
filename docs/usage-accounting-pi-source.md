# Pi source intake — W3 / Ops #314

Accountable lead: **Ops**. Inert worker-only module; no runtime import, live scan,
watcher installation, timer, model, install, policy or budget write. Ownership is
exactly `server/usage-accounting-pi-source.ts`,
`tests/unit/usage-accounting-pi-source.test.ts` and this file. #304, #305 and W0 are
unchanged. W1 supplies durable storage; W6 owns worker lifecycle and scheduling.

## H-WIRE-3 — written before implementation

**Wrong/evidence:** #304 has only a 64-file/10,000-entry process-local identity
map; it cannot hydrate that map. #305 accepts bounded metadata pages but has no
native cursor, discovery or continuation. Restarting either with only today's
offset loses original identity and task birth. A catalog larger than one page,
watcher loss, or applying today's registry parent can falsely certify missing
sources.

**One change/why:** add a worker-owned source adapter with injected, committed
numeric index transactions and a paged approved catalog. Sequential anchored
native reads build occurrence, original identity and metadata indices;
independently bounded #304/#305 calls consume those indices. Current work may
promote an original parent's old window, never skip an unread prefix. Dirty
notifications invalidate reconciliation; overflow requires a complete bounded
inventory pass. Numeric state is restored from the store's proved committed
prefix, not a cached label.

**Expected/measurement:** fixed synthetic old/current/fork/restart and >64-source /
>10,000-event cases retain original identities, add times and event-time parents;
all units stay within bytes/rows/time limits. Unknown copies remain excluded;
Temper-owned files never yield Pi facts. Missing sequences, rewrites, truncation,
unsafe paths, unsupported ACP and watcher loss stay explicit gaps. Source-side
allowlists never visit planted/throwing payload properties.

**Falsifier:** skipped prefix, inferred/latest parent, duplicate charge,
uncommitted restored cursor, false completeness, unbounded read or payload
escaping into numeric state. Review found repeat-alias and stale-parent risks:
exact fact/alias receipts are now retained, and every bounded ancestor is
re-statted before its completed index can prove absence.

**Result:** source assertions **HIT**: all 52 synthetic cases passed. Delivery
verification **MISS / blocked**: the first sealed normal gate's unrelated W0
100,000-attempt fixture hit its unchanged 240,000 ms harness deadline. The gate
remains failed; no unchanged retry, relaxed guard or landing is authorized by
that partial result. No development command reads a real session or starts the
runtime.

## H-W3-GATE-W0-1 — one authorized isolated diagnostic

Ops lead authorized exactly one unchanged W0 synthetic stage on 2026-10-20
(queue decision for #314), not a W0 repair or full-gate retry.

**Evidence/question:** the full sealed gate timed out at 240,000 ms in the W0
100,000-attempt case, with no numeric measurement receipt. W3's 52 cases passed;
its module is not on that fixture's import path. Does the same case fail alone
under the genuine four-worker cap and normal CPU availability, or did the full
gate's contention prevent a result?

**One change / expected measurement:** select only the exact existing test,
without editing its implementation, fixture, assertions, limits or sealing.
Measure the diagnostic from outside the test with Python `time.monotonic()`;
record exit status, effective worker cap / CPU availability, bounded load and
child CPU/max-RSS observations. Retain `W0-MEASURE` only if actually emitted.
An isolated pass supports a full-gate-contention explanation but does not prove
its cause or make the failed normal gate green. An isolated failure falsifies
that explanation as sufficient and requires a separate W0 diagnosis/repair plan.

Exact existing case (`tests/unit/usage-accounting-collector.test.ts:2384`):

```text
W0 isolated worker resource and shared-pool callback envelope
ingests/replays 100000 current-week attempts across 65 synthetic sources then independently updates/publishes within finite budgets
```

Exact selected command, run in a detached unit with `TZ=UTC` and inherited
`VITEST_MAX_WORKERS=4`:

```sh
scripts/sealed.sh node_modules/.bin/vitest run tests/unit/usage-accounting-collector.test.ts -t 'ingests/replays 100000 current-week attempts across 65 synthetic sources then independently updates/publishes within finite budgets'
```

The unchanged harness stays 240,000 ms, work guard 100 ms, warm-publication bar
30,000 ms. Other tests are not selected by this stage diagnostic; it is not a
substitute for the normal gate. No affinity/quota changes, instrumentation patch,
source/provider/model read, install, commit or land.

**Result: MISS for a contention-only explanation.** The one selected case
failed alone at its existing `publication-health` assertion, not at the harness
deadline. Detached unit `ops314-w0-diagnostic-1.service`, invocation
`8229358e14f043189a522ff1dd7c5137`, exited 1 on 2026-10-20 at approximately
22:27 PDT. The test took 32,297 ms (Vitest duration 32.63 s); the outside
monotonic interval was `684622.538116724` to `684661.513148621` seconds,
**38.97503189695999 s** including sealing/cleanup. One selected test failed;
the other 146 in that file were deliberately unselected, not a passed gate.

Exact failure: `Error: fixture:publication-health`, surfaced at
`tests/unit/usage-accounting-collector.test.ts:2407:14`. Static source inspection
locates the check at lines 2231–2235: the page must have healthy storage, zero
faults and exactly 65 required streams. This aggregate assertion does not say
which conjunct failed. **No `W0-MEASURE` was emitted**, so there is no successful
100,000-attempt/update/publication throughput or resource receipt to claim.

Numeric outer observations (not collector acceptance measurements): inherited
worker cap 4; the installed Vitest resolver reads `VITEST_MAX_WORKERS` into
`resolved.maxWorkers`; 20 CPUs available before/after; unit CPU quota infinity,
no affinity or allowed-CPU override. Start load averages
`1.5537109375 / 4.509765625 / 7.0849609375`, end
`4.3564453125 / 4.8173828125 / 7.087890625`. Child user/system CPU
`39.968817 / 21.316057 s`; `getrusage` child max RSS `230512 KiB`; whole-unit
memory peak `544972800 bytes`, CPU usage `61455785000 ns`, swap peak zero.
These bounded external observations do not identify the underlying fault or
prove lack of machine contention. All original guards and files were unchanged.

**Proposed next plan for Ops lead, not authorized here:** create a separately
owned W0 repair/diagnosis task and block #314 on its result. In its own worktree,
write a new hypothesis for the publication-health failure; expose only bounded
numeric fixture fault codes/storage/required-count and phase timing, with an
explicitly coordinated ownership plan. Determine which conjunct fails, then
repair the actual collector/fixture cause without widening the 100 ms work,
30 s warm publication, 240 s harness, capacity, privacy, lock or crash guards.
Prove fixed synthetic clean/fault cases at the affected stage before approving
another normal gate. #314 can consume the landed repair and run the normal gate
before its ordinary detached land. No second diagnostic or full-gate retry is
approved by this result; no commit/land/install or live scan has occurred.

## Worker-only interfaces

`PiSourceAdapter.open({ index, catalog, roots, temperRoots, current, clock?,
yield? })` has no default paths. The caller must supply native approved roots
and a catalog of only supported session/registry/conversation/helper files.
Neither session titles nor transcript prose discover ownership or membership.

- `discover()` advances one catalog or missing-source sweep page. Keep calling
  by returned continuation state until `done`; a stable generation is required.
- `notify({ kind, file? })` consumes native dirty, directory or overflow notices.
  W6 subscribes to those notifications; this module installs no watcher.
- `required(after?)` returns a complete **paged** inventory, not just sources that
  yielded facts. Consume every continuation; retain prior pages and global gaps.
- `step(id, lane, observedAt)` performs one scan, prefix verification or #304
  window. `lane` is scheduling context, never evidence. Honor `promote` by
  scheduling that parent's bounded units in the **same** current lane before
  retrying the pending child.
- `membership(ids)` feeds #305 a bounded, explicit transitive dependency closure.
  Include the relevant registry/conversation/helper source IDs, not a guessed
  current-state substitute. Only gap-free parent history is committed.

Calls on an instance are serialized. A stale/uncertain index transaction, invalid
port response or exceeded hard budget seals that instance; reopen only from W1's
verified committed prefix. A successful step already committed its evidence;
returned rows are a scheduling/inspection result, **not** a second write request.

### W1: mandatory committed-index binding

`PiSourceIndex` is a narrow injected port, not an in-memory cache and not a new
filesystem journal. `head()` must return the actually recovered, checksum-proved
`pi-source-index/1` binding: store major 1, monotonic sequence and SHA-256.
`verified: true` alone is not recovery evidence.

`get` and lexicographic `scan` must read only this instance's pinned committed
prefix. A stale CAS must fail; never let an old adapter read a newer unpinned
index. No corrupt or uncommitted tail may appear as restored native state.

Each `commit(expected, unit)` must atomically:

1. Durably retain accepted resolved numeric rows in #300 or bounded durable
   staging, preserving occurrence event times and original native stamps.
2. Retain `unit.native`, the exact #304 receipt, for cursor/prefix auditing only.
3. Accept `unit.batch`, the resolved partial collector envelope, and bind its
   cursor to that accepted evidence. **Never ingest `unit.native.rows`** as a
   second or unverified feed.
4. Publish the private index puts/cursors and a new verified prefix only after
   the evidence and native receipt have committed. Failure before publication
   must not advance visible state; uncertain completion requires reopen/replay.

A metadata-only transaction has null native/batch and may contain accepted
membership history. Bounded puts include source inventory and file stamps,
line/prefix hashes, occurrence times/native IDs, original identities, exact
emitted facts/aliases, projected metadata, original queue-operation acceptance,
registry sequence and event-time parent rows. No transcript JSON is persisted.

Repeated IDs may have identical immutable rows. W1 must preserve #300's identical
replay semantics; it must not replace conflicting originals or re-date old rows
into the current reporting week. `current` versus `staged` is an output partition
by actual event time, not authority to skip a historical row.

### W6: inventory, liveness and continuation obligations

Catalog pages are native metadata cursors, not timestamp-sorted usage offsets.
They must be consistent within a stable generation and obey the requested byte
and row caps. Global gaps survive page boundaries. A failed or missing source is
retained in required inventory; it is not removed because a clean page arrived.

After startup, directory change, overflow, native catalog generation change or a
bounded native reconciliation checkpoint, schedule the complete paged catalog
and missing-source sweep. An ordinary missed file dirty event is also caught by
`step`/ancestor stamp checks. No all-chat minute polling or repeated transcript
rescan is installed here. W6 must provide checkpoint liveness for missed **new
file** events: the adapter cannot discover an unannounced file outside its native
approved catalog.

A required row's `complete-recorded` means this file's indexed prefix was fully
processed at its last observation. It is not complete usage coverage, a current
whole-inventory proof or a permission to omit other sources. Dirty/verification
state immediately prevents that recorded-file completion. Catalog completion
means only that a stable bounded catalog/sweep pass finished.

Collector descriptors expose both original and current occurrence stream names
across a proved rename. Preserve these descriptors over all inventory pages.
The adapter never fills the collector's missing sources from a page-local empty
list. No source-less/global default configuration is provided.

## Identity, ancestry and native events

Native files are consumed sequentially from byte zero using fixed buffers and
UTF-8/JSON line validation. Every processed window has a retained SHA-256 prefix
anchor. #304 receives a fresh bounded reader per unit, using the numeric
occurrence index to choose the next actual event-time window (at most 169 hours)
without prefix-skipping. A `window-mismatch` stays a real boundary and is resumed
with that next original occurrence window; #304's own limits are unchanged.

Fallback identity requires an original native entry ID and original entry time.
An existing response identity is keyed by producer/provider/response ID. A fork
cannot make an unseen copied record original merely because its parent was
scheduled in another lane. All bounded ancestors must have a complete, fresh
numeric index before absence can prove a new identity. Missing, cyclic,
unsupported or over-limit parents leave explicit gaps; incomplete parents are
promoted, and copies remain excluded until proven. Parent stamps are checked
even without dirty notifications, before admitting a child.

Accepted facts retain their native source stamps. Exact original facts and exact
alias facts/evidence are restored on repeat/resume/restart; a physical copy's
line number cannot create a different alias for the same immutable fact.
Fingerprint, timestamp or response changes to a repeated native entry are
conflicts, not permission to overwrite its original numeric identity. A verified
copy with a different fact ID emits an explicit native-call-map alias; #300
counts the original once. A same-ID resume in another file retains canonical
identity privately but emits no foreign-stream fact or self-alias under that
second file's descriptor, including after restart. Dependency-only pending
state does not prevent native EOF reconciliation; retryable parent scan gaps
are promoted rather than turned into a permanent missing-parent claim.

Task birth comes from the first original native add/assigned evidence; assignment
time is not birth. Queue replay filters native-rejected updates/requeue of
source-tagged tasks; original accepted/rejected operation witnesses are retained
privately. Native chain records retain their numeric witness without becoming a
parent mutation. Registry events must start at sequence 1, be contiguous and
have nondecreasing event times. Original task/registry metadata goes to #305;
latest links, titles and prose are never an alternate parent source.

Metadata pages are retained even beyond 10,000 events. This does **not** lift
#305's maximum source/record/byte limits: an oversized dependency closure stays
an explicit `record-limit`/partial gap, not a suffix-only map or fictitious
complete history. No canonical parent rows commit from a gap-bearing closure.

## Paths, ownership and privacy

Only regular catalog-approved files under supplied canonical absolute roots are
opened. Every path component is checked; symlinks, hard-linked files and path
escapes are rejected. File identity, size and stamps
are checked around reads. A rename may reuse an index only with proved inode
and header identity; it retains the original reference. Truncation, replacement,
changing prefix anchors and moving targets are explicit gaps. Prefix
reverification is one bounded historical window at a time, never a whole-file
synchronous read.

Only allowlisted identity, timestamp, usage-number and native membership fields
leave the read operation. Throwing getters in unapproved message content,
arguments, results, reasoning, titles or text are never evaluated; catalog
fields are primitive-validated before serializing. A raw line may be parsed
inside the source worker, never handed to a main-thread server path or stored as
a payload bag. Errors use closed codes, not input text.

Native approved Temper worker roots, not filenames or titles, classify
host-visible pi-worker sessions as `coverageOwner: temper:T0`, excluded from Pi
charging. Their source content is not scanned. Any ambiguity remains a gap;
there is no fabricated ACP witness or Pi charge beside a T0 row.

The inventory always includes required obligations for unsupported ACP without
a structured witness, fileless calls, unreported failed calls and aggregate
provenance. `usageCoverage` remains partial/unknown, including when all known
files have been processed. This patch cannot establish complete spend.

## Fixed resource limits

| Unit/resource | Bound |
| --- | --- |
| Index page/transaction | 262,144 bytes; 256 total puts + numeric rows |
| Native catalog page | 24 entries; 32,768 projected bytes |
| Native metadata scan | 32 lines; 131,072 new bytes plus bounded anchor |
| One native line | 65,536 bytes |
| #304 read | 131,072 bytes; 8 numeric rows; <=169-hour window |
| Index scan | Normally 32 entries; explicitly bounded smaller/larger pages |
| Required inventory | 60 sources + 4 obligations first page; 64 thereafter |
| Total sources | W0's 1,024; overflow is an explicit gap |
| Membership/ancestry | 64 dependencies; #305 limits remain authoritative |
| Unit hard work / soft slice | 100 ms / 25 ms; yield at every public unit |

The index port must implement bounded pages; replacing it with a full-store scan
inside `get`/`scan` defeats the contract. No total-event Map lives in the adapter,
and total source history is not loaded on startup. These limits establish safe
incremental work, not a throughput/service-level or complete-cost claim.

## Verification, delivery and undo

Synthetic fixtures only: old/current boundary continuation; >64 sessions and
>10,000 metadata events; current fork before old parent; repeat aliases; missed
parent append; committed-prefix restart/CAS/crash states; original add and
rejected reparent; registry sequence gaps; directory overflow/new file/rename;
truncation/replacement/changing anchors; unsupported/Temper ownership; strict
numeric-only projection; resource and yield limits. Normal gate runs sealed,
with inherited four-worker cap and no live source reads.

First final verification, 2026-10-20: detached unit `ops314-verify.service`
(invocation `2a4089fa921a4b9e9e4de37b42318fbf`) ran a sealed full build, then
`TZ=UTC VITEST_MAX_WORKERS=4 scripts/check.sh --fast`. Build, protocol, PATCHES,
all typechecks, lint and formatting passed. All 52 W3 cases passed in 7,767 ms;
470 test files passed, one failed; 7,316 tests passed, one failed, six existing
skips. The sole failure was
`tests/unit/usage-accounting-collector.test.ts:2384`, W0's 100,000-attempt /
65-source isolated worker fixture: `Error: Test timed out in 240000ms.` The
fixture did not return its numeric `W0-MEASURE` receipt, so no throughput or
resource claim is made. Overall unit duration was 447.78 seconds. The detached
unit retained `VITEST_MAX_WORKERS=4`, all 20 CPUs were available and no quota or
affinity restriction was applied. This adapter is not imported by that fixture;
its collector/store/limits/tests and the genuine sealing path were unchanged.
Stop at this failed gate and bring concrete evidence to Ops lead before any
rerun or coordinated repair. No land receipt yet.

Undo: remove downstream consumers first (if any), then revert this inert patch.
No live source, journal, budget, service or installation is changed by this task.
Do not erase committed W1 evidence or broaden any source/collector grant as part
of a revert. Activation, live scans and installation remain separate approvals.
