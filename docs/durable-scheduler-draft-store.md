# Authored scheduler draft persistence (#596)

## Hypothesis recorded before implementation

Ops is accountable. H-SCHEDULER-DRAFT-PERSISTENCE-1: accepted #590
`680d88d8aeaa8e96b323d72a797f1cf33268ee74` preserves complete submitted originals
and evolving current forms only in page memory. A purpose-scoped transactional
browser store, exact owner/lifetime/revision fences and an independent reader
will preserve those complete forms across reload without saving, enabling or
running a schedule. This is the same authored scheduler source purpose, not a
generic journal, consent record or command codec.

Expected positive result: synthetic new/update sources retain all twelve form
fields, whitespace, inactive/raw interval/cron/preset strings, empty clears and
Unicode, independently for current edits and submitted originals, after actual
IndexedDB completion, reload and a fresh look-only reader. Explicit inspection
and export do not install anything into an editor or dispatch an action.

Expected negative result: malformed/foreign/conflicting records, stale owner or
form lifetimes, A/B/ABA and out-of-order concurrent writes, stale retirement,
unavailable/quota/aborted/readback-failed storage cannot silently overwrite or
delete recoverable data. A request-success event followed by transaction abort
must reject. A committed write followed by a readback failure stays recoverable
but is reported as uncertain, never silently undone or called confirmed.

Falsifier: any field or metadata differs, an immutable submitted original changes,
a stale operation changes a newer/different record, an aborted transaction is
reported as confirmed, a reader creates/upgrades/mutates storage or dispatches an
action, or page-memory-only state survives the genuine reload loss control.

## Scope and pre-implementation coordination

The small typed API proposal was sent directly to #570/c108 before implementation:
exact `[workspace, taskId, formId]` lifetime keys; versioned strict source/record
codec; explicit create/current-update/submitted-retention/retirement; atomic
full-record compare-and-swap with incarnation identity; transaction completion
plus exact readback; existing-only reader; publishing and genuine provenance
remain host responsibilities. Actual #570 host decision **rm-a7bfa763**, relayed here by Ops, accepted this
contract before implementation, with these explicit corrections: retirement is
an exact-CAS **marker retaining all current/submitted bytes**, never deletion;
readonly discovery must distinguish missing/corrupt/unavailable, never empty
success; submitted A can coexist with newer current B under a freshly read exact
CAS without rolling B back; reader visibly exports raw unknown purpose-store
records. Workspace must be genuine ownership, not authored cwd. No SID/CID is
invented. Positive `schedule_result` does not prove inactive form fields were
persisted. Host owns actual flush/error/result/restore/route hooks. This answer
is technical ABI acceptance, not new execution/cleanup/release authority.

Only these six new files belong to the handoff:

- `web/src/scheduler-draft-store.ts`
- `web/src/scheduler-draft-reader.ts`
- `web/scheduler-draft-recovery.html`
- `tests/unit/scheduler-draft-store.test.ts`
- `tests/scheduler-draft-store-test.mjs`
- `docs/durable-scheduler-draft-store.md`

No SchedulerPanel/App/protocol/server/C/#581/build configuration change, migration,
existing database access, independent landing or deployment is authorized here.
#570 still owes real editor hooks, publishing, correlated-result retirement,
fresh-New behavior, full release gate and lossless rollback.

## Typed store and codec contract

Runtime module: `web/src/scheduler-draft-store.ts`. Its only component dependency
is `import type`: the independent reader bundle has just the store and reader
modules, no React, App, SDK or server dependency.

- `copySchedulerDraftSource(unknown): SchedulerAdmissionSource` strictly validates
  and creates a recursively frozen owned copy. Same #590 allowlist: exact five
  enumerable data properties, plain/null-prototype objects, exact twelve form
  fields, safe nonnegative integer revision, known preset, matching task/form id.
  Getters, symbols, missing/extra/hidden/inherited/nonplain fields are rejected.
  No trimming, normalization, cron validation or conversion to command fields.
- `encodeSchedulerDraftSource(unknown): string` exports exact source JSON;
  `copySchedulerDraftRecord(unknown)` validates a raw structured-clone/parsed
  record; `encodeSchedulerDraftRecord(unknown): string` is canonical full-record
  JSON used for CAS/readback/export. Even numeric negative zero round-trips.
  Field insertion order is canonical, not claimed as original JSON formatting.
- `schedulerDraftKey({workspace, taskId, formId})` is exact JSON of those three
  values, including `taskId: null` for New. Workspace never comes from `form.cwd`.
  Different forms/workspaces/tasks never replace one another. Host must supply
  the genuine active form lifetime; claimed timestamps/revisions are not proof.
- Record v1: `{purpose: "authored-scheduler-draft", schemaVersion: 1,
recordId: string, version: safeInteger, retired: boolean,
current: SchedulerAdmissionSource, submitted: SchedulerAdmissionSource[]}`.
  `recordId` is generated on explicit creation (default `crypto.randomUUID()`);
  store version starts at zero and advances on changes. No SID/CID/timestamp.
  Submitted sources share the exact lifetime, cannot be ahead of current, and
  contain at most one exact original per source revision.
- `createSchedulerDraftStore(storage, newRecordId?)` performs no IO at creation.
  Its explicit async methods return immutable, validated records only after
  transaction completion **and** exact complete readback:
  `create(source)`, `updateCurrent(expectedRecord, source)`,
  `retainSubmitted(expectedRecord, source)`, `retire(expectedRecord)`.
- `create` only fills an absent exact key. `updateCurrent` requires same lifetime
  and increasing source revision; identical same-revision retries still perform
  an exact CAS/readback. Different bytes at the same revision refuse. Submitted
  originals remain untouched. A/B/ABA values do not erase revision history.
- `retainSubmitted` appends the exact original once, never resets current. A late
  original A may be appended beside B only with a freshly read exact B record;
  stale expected records refuse, as do conflicting bytes at an existing revision.
- `retire` only sets `retired: true` and advances record version under exact CAS.
  **All current and submitted bytes remain readable/exportable.** Retired records
  reject edits/submissions/recreation at that key. An exact already-retired retry
  still checks CAS/readback. There is no deletion, pruning, clearing, migration
  or cleanup API. A fresh New needs a genuine new form lifetime from #570.
- `load(identity)` returns a validated exact record, explicit `undefined` for an
  absent key, or rejects for corrupt/unavailable storage. `inspect()` and
  `inspectSchedulerDrafts(scanBoundary)` discover prior forms without guessing an
  authoritative one. Status is `missing` (no committed database), `empty` (exists
  but no rows), `ready` (valid records), or `corrupt` (one or more invalid/foreign/
  wrong-key rows, alongside any valid rows). Unknown raw rows remain available;
  access failures reject, never return an empty-success list.

`SchedulerDraftStorage` is the testable boundary: `read(key)`, `scan()`,
`swap(key, expectedCanonicalRecordOrNull, replacement)`. A supplied swap must be
atomic and resolve only at transaction completion. The native boundary
`createSchedulerDraftIndexedDB(indexedDB)` uses only the purpose database
`pi-authored-scheduler-drafts-v1`, object store `authored-scheduler-drafts`,
IndexedDB schema v1. A writer creates this schema only on an explicit write.
Reads/discovery are existing-only, even on a writer boundary. No existing app DB
is read, upgraded or migrated. Separate test database names are injection points,
not runtime host configuration or a generic store purpose.

Readwrite transactions request `durability: "strict"`; request success never
settles the operation. Atomic read/compare/put is synchronous within one
transaction callback. The database is closed after each completed/aborted
operation, and on version change; blocked opens fail explicitly. Existing-only
opens abort `onupgradeneeded` for a missing DB rather than committing creation.
No application writeback, snapshot timer or automatic retry is installed.

### Failures and reconciliation

`SchedulerDraftError.code` distinguishes invalid source/record, conflict, retired,
unavailable, blocked, transaction failure, readback failure and readback mismatch.
`transactionCompleted` is `false` for a known precommit/abort/refusal, `true` when
the write transaction completed but readback could not confirm, or `"unknown"`
when an injected storage boundary rejected without a reliable completion receipt.
There is no silent catch-to-success, auto-delete, compensating rollback or replay.

A readback may see a competing newer record after this writer committed. That is
an explicit uncertain/mismatch result, not authority to overwrite the newer
record. Reload/inspect the actual record and surface the uncertainty. A committed
write followed by an error remains recoverable; the caller must not clear the
editor or blindly recreate/retry. Failed/aborted transactions retain the prior
record. Browser eviction, deleted origin data, disk failure, profile loss and
storage-policy changes are not solved by this local transaction guarantee.

## Independent reader/export and publishing

`web/scheduler-draft-recovery.html` loads `web/src/scheduler-draft-reader.ts`.
`mountSchedulerDraftReader(root, scanOnlyBoundary?)` exposes `inspect()` only.
The page renders via DOM `textContent`, not HTML, and offers only inspect/export.
It never calls restore, admit, save, enable, run, fetch, WebSocket or replay; it
never chooses a recovered current form as authoritative or installs it in UI.
Missing, empty, corrupt and unavailable states are visibly distinct.

Validated records, current sources and each submitted original have explicit
local JSON download buttons. Retired records are labelled as byte-retaining
markers, not deleted or proven server-saved. Unknown purpose-store rows are
visibly labelled RAW UNKNOWN and exported with
`exportRawSchedulerDraftRow(row)` as a tagged raw graph, not admitted sources.
This preserves raw properties, reference cycles, undefined, special numbers,
bigints and standard stored date/map/set/blob/binary values that ordinary JSON
would silently erase. It is an inspection/export representation, not an import,
command codec, credential/config journal or consent source. An unsupported raw
value/export/access failure is visible, never interpreted as empty recovery.
Keep downloaded raw files private; unknown rows are not sent to any server.

**Not published by this task.** Existing Vite configuration does not automatically
make this HTML a production entry. #570 must add a separate production HTML entry
(or equivalent same-origin static publication) and ensure its relative module
reference becomes the emitted reader asset, with no App bootstrap or write hooks.
A direct isolated esbuild build of the reader is proven by the native test; this
does not claim a live route. Serve the reader on the exact owning origin/storage
partition. Another hostname, protocol, port or browser profile sees different
IndexedDB; an independent origin cannot recover the owner's forms.

Rollback must preserve this purpose DB and the independently published reader
and compatible codec, even when rolling the app/editor back. A page-memory-only
old host cannot itself recover these records; do not remove the last accessible
reader or clear storage as uninstall/rollback cleanup. No cross-version migration
or physical cleanup authority is supplied. A future schema must fail visibly,
retain old bytes, and keep an old compatible look-only path until lossless
recovery is proven. #570 owns the actual publishing, access, rollback and full
release verification, not this helper.

## Host work still owed by #570

1. Capture genuine owning workspace/form lifetime and all current edits, including
   empty/inactive fields. Persist/flush them with visible pending/failure/uncertain
   feedback before any destructive UI transition; hook and test the real editor.
2. Read `getSchedulerAdmissionSource(originalMessage)` synchronously before clone
   or await. Retain the exact immutable original sidecar independently of current
   edits and exact outbound `command.payload`. No C/#581/wire JSON changes here.
3. Serialize/reconcile competing source checkpoints with fresh full-record CAS;
   never substitute a large revision, execution cwd or guessed SID/CID as authority.
4. Discover after reload, show provenance explicitly, and offer deliberate
   LOOK-ONLY restoration through #590 validation without displacing newer current
   edits. The standalone reader never performs restoration for the host.
5. Define actual correlated-result/retirement authority and invoke exact marker
   retirement only then. Local admission, list refresh, `payloadCommitted`, and
   even a positive `schedule_result` do not prove inactive raw fields persisted.
   Marker retirement is not cleanup authority or permission to discard bytes.
6. Implement/test fresh-New identities, actual pending/edit/close/navigation
   behavior, failure recovery, published route, full gate and lossless rollback.
   This helper alone does not solve all scheduler or W2 data-loss risks.

## Verification and undo

The unit suite uses only synthetic forms and a transaction-boundary fake; the
native script builds isolated fixture/reader bundles in memory, starts only an
ephemeral static-asset server, and launches a fresh temporary headless Chromium
profile. It never starts the app/scheduler/Temper or touches real user data. The
native fixture imports accepted #590 unchanged for a genuine page-memory reload
loss control and explicit LOOK-ONLY restoration compatibility. No real scheduler,
chat, profile, account, model or command dispatch is involved.

### Measured result — HIT (2026-10-26)

H-SCHEDULER-DRAFT-PERSISTENCE-1 HIT for this isolated module, not for the live host:

- 155 unit tests passed: 67 new store/reader cases and 88 unchanged #590 admission
  regression cases. Exact full-form/metadata, strict rejection and immutable
  copies, fresh-CAS submitted A beside B, A/B/ABA/incarnation/owner fences,
  aborted/uncertain writes, marker-only retirement, raw exports and LOOK-ONLY
  restore compatibility passed. Unavailable/corrupt is not empty success.
- 21 isolated native Chromium cases passed on real IndexedDB. The genuine #590
  page-memory-only reload control lost the source as expected; new/update ×
  cron/interval sources and empty inactive fields survived storage/reload exactly.
  Two independent pages, delayed old writes, native put-success then abort,
  quota, committed-then-error/readback failure/mismatch, stale retirement and
  immutable submitted-original cases passed. The fresh standalone entry exported
  exact current/submitted JSON and visible raw unknown data; observed writes,
  schema commits and schedule/network actions were all zero. Reload retained
  marker bytes and a fresh #590 LOOK-ONLY restore sent/admitted nothing.
- Full `npm run typecheck`, isolated `npm run build`, targeted oxlint (zero
  warnings/errors), six-file Prettier and `git diff --check` passed. The normal
  build's existing Vite warnings (future native loader imports, deprecated
  advancedChunks and chunk size) are not new failures. The default build still
  does not publish the independent HTML entry; the isolated browser script
  separately builds and proves its only two inputs are the store and reader.

Commands (from this worktree; tests run once after implementation):

```sh
PI_SEALED_MODEL=none TZ=UTC VITEST_MAX_WORKERS=2 scripts/sealed.sh node node_modules/vitest/vitest.mjs run tests/unit/scheduler-draft-store.test.ts tests/unit/durable-scheduler-admission.test.ts --maxWorkers=2
PI_SEALED_MODEL=none TZ=UTC scripts/sealed.sh node tests/scheduler-draft-store-test.mjs
npm run typecheck
node node_modules/oxlint/bin/oxlint web/src/scheduler-draft-store.ts web/src/scheduler-draft-reader.ts tests/unit/scheduler-draft-store.test.ts tests/scheduler-draft-store-test.mjs
node node_modules/prettier/bin/prettier.cjs --check web/src/scheduler-draft-store.ts web/src/scheduler-draft-reader.ts web/scheduler-draft-recovery.html tests/unit/scheduler-draft-store.test.ts tests/scheduler-draft-store-test.mjs docs/durable-scheduler-draft-store.md
PI_SEALED_MODEL=none TZ=UTC scripts/sealed.sh npm run build
git diff --check
```

No independent land/deploy is performed. Undo before integration: do not
import/publish the six new files (or revert their single handoff commit); existing
behavior is unchanged. After host use, code rollback must retain the
database/reader and recovery path as described above; deleting storage is not undo.
