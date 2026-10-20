# Usage accounting collector v1 — inert, numeric only

Ops #300 · automatic-cost-accounting · accountable lead: Ops.

**Not a live meter.** Depends on frozen #293 (`ffb1c66e`), not capture or
Roles implementation details. No production importer, filesystem adapter,
source discovery, timer, model/network call, registration, activation or deploy.
Only injected, approved numeric feeds and injected durable I/O are accepted.
Tests write exclusively to unique temporary fixture directories.

## H-AUTOCOST-1 (written before implementation)

Wrong/evidence: manual `spend.json` and the frozen pure accounting projection do
not durably collect actual attempts. Re-reading, copied reporting views and a
crash between facts and a cursor could duplicate or omit charges.

One change: a closed bounded numeric source-batch API and an injected append-only
journal. Sync validated history before atomically replacing the cursor
checkpoint. Reconstruct state from journal history, not the checkpoint alone.
Preserve corrections, aliases, source faults and non-additive snapshots.

Expected: exact money and counts below survive permutations, two reads and crash
restart. Clean crash recovery gives the same full report. A torn journal tail or
corrupt checkpoint preserves provable committed numeric history and the last
provable cursor, but MUST expose a storage coverage fault, never completeness.
A reread can restore missing numeric facts without clearing that evidence gap.
There is no automatic repair/forgiveness of damaged retained history.

Falsifier: duplicate/lost reported charge after reread; cursor beyond durable
validated history; accepted payload metadata; invented alias/price/root/binding;
or a non-null reassuring balance with an incomplete source/store.

Fixed expected ledgers (synthetic only; USD decimal strings):

| Case | Exact expected result |
| --- | --- |
| Main `.10` + warming `.02` + delegate `.03` | 3 actual attempts, `.15` deduplicated |
| Fork/wait/report reread | Same 3 attempts, `.15`, no extra charge |
| Real retry `.10` and compaction `.000000000001` | 5 attempts, `.250000000001` |
| Pi/Temper observation of main, explicit native alias | Gross `.350000000001`, deduplicated `.250000000001` |
| Revision 1 main and native alias `.12` supersede `.10` | Gross `.390000000001`, deduplicated `.270000000001`; both revision 0 records retained |
| Snapshot of leaves, replayed | No additional charge |
| List `.10`, provider `.05`, invoice `.07` | Three separate bases, not `.22` |
| Missing price/root/feed, retention gap, stale as-of, bad task birth | Partial/UNKNOWN remaining, never free zero |
| Pacific Monday and both DST transitions | Occurrence week, not import/add/reparent week |
| Crash at append/sync/checkpoint boundaries | No checkpoint without durable facts; exact totals after reread |

Initial assigned check: **MISS in the written gross oracle**, 82/83 passed.
The test correctly refused to equate corrected `.12` and stale `.10` alias
observations. After correcting BOTH observations, the initial `.35…` gross rises
by `.02` twice, to `.390000000001`, not `.370000000001`. Independent Python
`decimal.Decimal` arithmetic confirmed `.12 + .12 + .02 + .03 + .10 + .000000000001`.
The deduplicated expectation remains `.270000000001`. No implementation or gate
change was indicated by this mismatch.

### H-AUTOCOST-1A (before correcting the fixture)

Evidence/change: correct only the mistaken gross oracle to include both native
observation corrections, and keep the alias-conflict/no-cursor assertions and
separate-basis/history/restart equality assertions unchanged. Expect all 83
assigned cases to pass with gross `.390000000001`, deduplicated
`.270000000001`, provider `.05` and invoice `.07`. Falsifier: any different exact
sum, silent alias-conflict acceptance, lost revision, replay mismatch or earlier
case regression. **H-AUTOCOST-1A HIT:** all 83 assigned cases passed after the
oracle correction, with no implementation changes or loosened assertions. The
sealed worktree build also passed. H-AUTOCOST-1's initial oracle was a MISS as
recorded above; its replay/crash/coverage behaviour passed the fixed cases.
The unchanged normal landing gate is required separately and its result belongs
to the immutable `wt land` receipt, not to these synthetic-case results.

## API and wiring

Exports live only in `server/usage-accounting-collector.ts`. The only production
import is the frozen pure `usage-accounting-contract.ts` module. No runtime
module imports the collector.

### Closed producer boundary

`SourceInventory` (`usage-inventory/1`) carries an approved `evidenceRef`, native
`observedAt`, an explicit `complete` flag and required `CollectorSource[]`.
Each source supplies its native feed `stream`, feed `incarnation`, approved
`adapterRef` (or `null` for unavailable), `producer`, original
`occurrenceStreams[]`, native `retainedFrom` (or unknown `null`), and explicit
`NumericRowKind[]` grants. The inventory must enumerate missing/unsupported
required feeds, not discover only the feeds that happened to work. Empty or
unapproved inventory is unavailable, not a complete zero-cost week.

`SourceBatch` (`usage-source-batch/1`) contains exactly:

- `stream`, feed `incarnation`, `adapterRef`;
- `fromCursor: SourceCursor | null`, `toCursor: SourceCursor`;
- native cumulative occurrence-coverage `from`, `through`, `observedAt`;
- `status: complete | partial | unknown | unavailable`;
- `reason: none | reported-gap | missing | unsupported | retention-gap | truncated`;
- `rows: NumericRows` — frozen facts, allocations, aliases, roots, policies,
  memberships and snapshots, with no extra fields.

`SourceCursor` is `{ ordinal: number; token: string }`, a native monotonically
increasing feed observation position, including empty coverage observations.
Only the exact last committed predecessor is accepted; source/feed-incarnation
and cursor token must all agree. Reusing an ordinal with different numeric data
or a different token is a conflict. Reordered keys/row arrays and repeated
identical rows are equivalent replays. No timestamp/model/amount dedup heuristic
exists. A copied/forked read keeps the original occurrence identity, original
source evidence, task birth and event-time membership; a different feed keeps
its own incarnation/cursor and needs approved `occurrenceStreams`, never a
rewritten call identity. Distinct retries/warming/compaction/delegates remain
actual charges. Different native observations of the same call need the frozen
explicit native alias mapping. Snapshots only reconcile leaf facts.

Coverage is not inferred from an empty page or the largest timestamp seen. A
producer paginates with partial coverage until its native feed proves a
**cumulative** window complete. The complete watermark must include all earlier
pages. Historical-window completion is not a new current-week watermark.
Partial/unknown coverage preserves known facts; unavailable/truncated input,
missing retention, cursor gaps and semantic conflicts are quarantined without
advancing a cursor. Structurally valid quarantined numeric evidence remains in
history and the known-usage projection, with explicit faults. A missing
predecessor/cross-feed correction can be reread and promoted after its evidence
arrives; conflicting same-revision evidence is never silently overwritten.

All prices remain decimal strings with their original reported basis and rate
version. All fact/allocation revisions are retained; observation chronology,
original occurrence metadata and task binding cannot be rewritten by a price
correction. List/provider/invoice bases stay separate. Unpriced/unknown model or
unsupported evidence never receives today's rate or fabricated free zero.

### Injected store and calling API

```ts
UsageAccountingCollector.open({
  inventory: unknown,
  verifier: CollectorVerifier | null,
  io: CollectorIO | null,
  clock?: () => number, // monotonic WORK clock only
}): Promise<UsageAccountingCollector>

collector.collect(stream: string, numericJson: string, receivedAt: string)
  : Promise<CollectorResult>
collector.checkpoint(): CollectorCheckpoint
collector.input(asOf: string): AccountingInput | null
collector.report({ policyRef, asOf, staleAfterMs }): AccountingReport | null
collector.requests(asOf: string, historicalFrom?: string | null): SourceRequest[]
```

`CollectorResult` returns a bounded code, sequence, last durable source cursor
and one of committed/duplicate/quarantined/rejected/unavailable. Invalid receipt
time produces an untimed collector fault (`0000-01-01T00:00:00.000Z` sentinel),
never an invented call timestamp. Raw rejects, exception strings and private
payloads are neither retained nor returned. No content hash is calculated.

The injected `CollectorVerifier.inventory` and `.batch` callbacks must validate
against approved native metadata, not merely return true for a provenance
label. Batch verification covers original attempt stamps/evidence, same-call
maps, original task-add and event-time parents, price provenance and any roots
or policies. Verifier arguments and public outputs are defensive copies. Missing
I/O or missing/unapproved metadata is unavailable; no I/O starts without both.
The fixture verifier is synthetic only, not an authentication implementation.

`CollectorIO` is a required injected interface with no default path/adapter:

```ts
read(limits: typeof COLLECTOR_LIMITS)
  : Promise<{ segments: string[]; checkpoint: string | null }>
append(segment: number, expectedBytes: number, line: string): Promise<void>
sync(segment: number): Promise<void>
checkpoint(text: string): Promise<void>
```

The separately approved adapter must hold lifetime single-writer exclusion,
pre-bound reads before allocating, use fixed consecutive segment numbers (never
source IDs as filenames), and compare expected byte length before append.
Create exclusively; never replace retained journal bytes. `sync` must fsync the
journal file **and directory**. Checkpoint replacement must write a scratch file,
fsync, rename atomically, and fsync the directory. Do not copy the deliberately
minimal temp-fixture adapter into a live store without a separately reviewed
permissions/symlink/locking/durability design. Its test crash hooks exercise the
normal append/sync/checkpoint boundaries; they are not a hardware power-loss
certification or tamper-proof storage claim.

Each canonical newline-terminated `usage-journal/1` frame contains the complete
validated batch and its acceptance/quarantine decision, or only a bounded fault
receipt. Append and sync that frame **before** publishing/updating a cursor;
only then replace `usage-checkpoint/1`. A failed I/O call stops that instance.
Reopen and reread instead of blindly retrying an uncertain write. Recovery
revalidates frames, their sequential history and decisions, compares the
checkpoint with the reconstructed prefix, and syncs surviving segments before
exposing recovered cursors. A stale checkpoint is a normal recoverable commit
boundary, never authority to skip journal facts.

A truncated final record is preserved, ignored as uncommitted, and sealed by
starting a new segment. Rereading the source from its last provable cursor
restores the numeric ledger exactly once. `collector:journal-tail` remains an
explicit storage coverage gap. Partial/ahead/conflicting checkpoints are rebuilt
from the journal but remain `collector:checkpoint-corrupt`; that fault is made
durable before a later checkpoint replacement. Corruption of a complete frame
stops ingestion and exposes only the provable numeric prefix with **no seekable
cursor**. There is no destructive truncation, automatic evidence-gap forgiveness,
retention erasure or unauthorised repair API.

Hard caps: 256 KiB UTF-8/batch, 256 rows/batch, 169 hours/window (a fall-DST
Pacific week), 100 ms monotonic validation work, 1 MiB/segment, 16 MiB/store,
128 segments, 4096 frames, 10,000 unique retained rows, 64 inventoried sources,
64 KiB/checkpoint. Capacity exhaustion stops safely and makes coverage unknown;
it is not permission to discard history. Date fields are strict UTC ISO strings.
No model grading or timers enforce these caps.

`input()` is a numeric history/export projection, **not a safe balance on its
own**: storage/quarantine/inventory faults are deliberately outside the frozen
contract. Future UI wiring must use `report()` or explicitly merge the same
collector faults, never call the frozen projector on `input()` and omit those
faults. `report()` sets partial coverage and null remaining on any collector gap,
preserves the frozen source/staleness faults, and returns `null` (unavailable,
not zero) when inventory/policy is unavailable. The only non-null balance is a
reporting result, never a provider allowance or budget enforcement permission.

`requests()` returns bounded hints with current-week work before historical-low
work. It starts no scan, continuation, timer or queue task. A historical hint is
one bounded reconciliation window, not permission to jump over an unread feed
suffix, advance its cursor, or infer completeness from a filtered read. A future
native adapter must republish/reconcile old occurrences with original stamps
and a contiguous native feed cursor, or define separately approved independent
native streams. The collector does not guess positions for a file/database API.

### Exact remaining wiring gaps (not implemented or authorised here)

1. Approved complete native feed inventory/incarnations, occurrence-stream maps,
   retention bounds and authenticated verifier implementation. No feed means
   unavailable, not an empty week. A changed inventory must still verify retained
   history; incompatible feed lifetimes require approved replay/migration, not a
   silently reset cursor.
2. Approved Pi actual-attempt and ACP producer capture, including retry,
   compaction, delegate, warming, original task birth/parent history, and
   source-backed price/rate versions. Numeric producer projections only; no
   session/model/private-role payload readers in this collector.
3. Temper's approved bounded numeric/basis leaf feed and explicit Pi/Temper
   same-call map. No DB/full-run API or inferred wall-clock joins. Its snapshots
   stay non-additive. Unsupported basis remains unknown.
4. An approved durable I/O adapter with locking, permissions, bounded reads,
   fsync/rename/directory semantics, storage monitoring and evidence-preserving
   repair/retention policy. This task ships only temp-test I/O.
5. Separate runtime importer/lifecycle/backfill scheduling and current-week
   pacing approval; safe Roles/task/initiative aggregation must carry collector
   gaps and all known initiative usage before policy allocation. Sibling capture
   and Roles tasks remain independent of this collector and of P3.

The journal is evidence, not an authority registry. Supplying a string labelled
native provenance does not authenticate anything. Approved native inventory,
actual-attempt stamps, original task-add/event-time parent history, source-backed
price basis/version and same-call mappings remain producer responsibilities.
Missing native roots stay empty; allocations stay unknown. No R0/RTPI root is
registered. All initiative usage is collected regardless of later policy
allocation. Manual spend/stopped files are neither read nor written. No cap,
debit, stop, pause, permission or provider-allowance behaviour changes.

## Verification and undo

Assigned check: `scripts/sealed.sh env TZ=UTC npm test -- tests/unit/usage-accounting-collector.test.ts`.
Normal unchanged gate: `wt land` (sealed repository check; no skip/no-verify).
Build is performed aside in this worktree, not the live checkout.

Measured fixed-case result: 83/83 passed (synthetic/temp only); sealed worktree
build passed. The exact final checked commit, unchanged normal gate result and
request ID are recorded by `wt land-status <request-id> --json` and returned in
the Ops completion handoff. Landing alone does not install or activate anything.
Tests cover exact decimals/counts, equivalent row permutations and two reads, copied fork
and ACP views, actual retries and compaction, explicit Pi/Temper overlap,
correction history and gaps/conflicts, each I/O commit boundary, torn journal,
partial/ahead checkpoint, unavailable/retained/stale sources, unknown prices,
wrong original task birth/event-time parent, Pacific rollover and DST. All I/O
is in unique temporary directories and removed after each test.

Undo before runtime wiring: revert the inert four-path change. There is no live
store, importer, registration, timer, service, install or activation to undo.
