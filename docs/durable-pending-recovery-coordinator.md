# Browser pending-work coordinator (Ops #579)

Module acceptance only; #570 owns integration, rollback rehearsal and deployment.

## Hypothesis (before implementation)

H-PENDING-COORDINATOR-1: #578 commits full payloads, but its caller supplies the owner,
can write before startup restore, and can send or clear without waiting for save. A
cloned sessionStorage token can share an owner; a dead tab's token can be undiscoverable.
One serialized coordinator, with a reload-stable token protected by a lifetime Web Lock,
restore-before-write, immutable typed capture, and an independently readable export
should close these module-level gaps without changing the server or #578.

Expected: synthetic original IDs/session/body/attachments remain exactly equal through
awaits, reload, failure and artifact restore. No unsuccessful prepare grants dispatch;
no unseen recovery is overwritten; a cloned active token refuses mutation; a closed
owner can be explicitly recovered from the catalog without any timeout. Only matching
persisted evidence or explicit discard releases bytes. Wrong if any of those assertions
fails, or rollback depends on a new app bundle being available. Result: HIT at the module
boundary (96 focused checks, 15 isolated native-browser scenario groups); normal landing
gate remains mandatory. This does not establish integrated no-data-loss.

H-PENDING-STARTUP-READ-1 (self-review, before repair): startup currently rewrites the
#578 envelope even when all native records are already committed. A persistent write-only
quota/security failure can therefore prevent read/export after reload. The catch also
releases an acquired lease on source ambiguity, making the advertised raw export impossible;
its artifact omits a distinct unseen legacy envelope. Change: make ordinary restore read-only,
keep an acquired lease only for read/export on setup failure (all mutation remains refused),
and include any distinct unrecognized legacy source in the artifact as incomplete, never as
permission to import/replay. Expected: exact native bytes export after reload despite ongoing
write failure; source conflict exports both full sources without token/source changes; legacy
migration still commits before ready. Wrong if any source is erased, export silently omits it,
or failure enables prepare/release/import. Result: HIT in targeted unit plus native cases;
ongoing write-only failure allows reload/read/export with zero native writes; source conflict
exports both full raw sources while prepare and explicit release remain refused.

## Review repair hypothesis (Ops #581, before implementation)

H-RECOVERY-CARRIER-1: unchanged `48cec10e20ecc3870f0e2422fb990160c00e215d`
selects internal decoding from `JSON.parse(p.text).format`. A valid legacy prompt whose
literal text is `{"format":"pi-web-pending-work-v1"}` therefore reaches
`capture(undefined)` and disappears from usable owner/artifact recovery. A matching nested
object can instead substitute other work. Full raw retention alone is not successful recovery.

Change: a producer-owned, top-level provenance field separates internal carriers from literal
prompts; new-format decoding never dispatches from arbitrary prompt text or an ID prefix.
Read private provenance from the actual #578 native/envelope sources because its legacy
normalizer drops unknown fields. Mark only known session-legacy ingress as literal during its
existing startup commit. Quarantine ambiguous untagged old internal-shaped sources; retain
all raw bytes and require explicit classification of a copy, never guessed migration/deletion.

Expected: exact original prompt text/ID/session/metadata/attachment bytes through owner
restore, native reload, standalone export/read/import; genuine new prompt/command carriers
still round-trip; corrupt/unknown internal sources remain incomplete and unchanged. Wrong if
any valid legacy vector vanishes/substitutes nested work, tagged corruption becomes a plain
prompt, ambiguity is silently converted, or ownership/release/storage limits change. The
same public-API vectors run against the frozen source, with genuine-carrier and ordinary-text
controls, so a missing import/export is not accepted as a baseline red. Final result: HIT at
the module boundary after the R2–R4 refinements; original incomplete designs are recorded below.

H-RECOVERY-CARRIER-1-R2 (independent source review, before tests): the first repair missed
subsequent writes after envelope-only recovery. #578 merges normalized old records when
prepare/import supplies only new work, stripping private provenance from the others. Change:
reconstruct and supply all existing full stored records on every coordinator save, retaining
#578 conflict/transaction/envelope checks. Expected: literal and genuine-carrier provenance
and exact work survive both subsequent prepare and artifact import after envelope-only
restore, then native reload/export. Wrong if any old field/tag changes or work becomes
incomplete. Typecheck also caught `PendingSend` inference at the private-field reader; type
that source as the private `StoredPending` shape, without changing public/store contracts.
Result: MISS as a complete fix; R3 identified the preserved empty-array/body-identity conflict.

H-RECOVERY-CARRIER-1-R3 (second independent source review; before store changes):
full-record merging alone cannot preserve an envelope-only carrier with `attachments: []`.
#578's legacy parser drops that field, but #578's strict body identity distinguishes `[]`
from absence; resubmitting the complete original then conflicts. This is a source-traced
blocker, not a passing test. Scope question: may #581 also own
`web/src/pending-send-storage.ts` and `tests/unit/pending-send-storage.test.ts`?
Actual answer: Ops lead's native #581 decision admits exactly those two files under the
original reserved extension, keeping this repair together rather than creating a prerequisite.
This is Ops' technical decision, not new owner consent. Implement an internal opt-in
`fullEnvelope` mode, default OFF; only the coordinator enables it. Other callers keep today's
legacy parser. Full arrays use the same complete-record validation as native payloads. Keep integrity,
identity, attachment, transaction and conflict validation unchanged. Expected: full original
fields/private provenance survive envelope-only restore and both subsequent write paths,
without synthesizing native records, altering originals or weakening body equality. Wrong if
the default parser changes, malformed full records become accepted, conflict detection is
relaxed, or source metadata/bytes change. Preserve native corruption/release precedence;
malformed/mixed/duplicate full sources stay visibly incomplete and byte-retained. No backend
fabrication/write interception, other files, migration or deployment. Result: full-envelope
preservation HIT in final fixed-input tests; R4 separately repairs unsafe merge/source selection.
Normal landing proof belongs to the actual receipt, not a predicted result.

H-RECOVERY-CARRIER-1-R4 (final independent source review, before repair): two more source-traced
findings falsify the first repair's full preservation claim despite 109 focused/native checks
passing. A literal prompt and its nested command may share a stored key and the same #578
body; unconditional full-map replacement can then change literal provenance into a carrier.
Also an owner/key-rejected native row can be indexed without its owner component and replace
readable envelope bytes in the wrapper. Change: reject unequal complete stored records at the
same key before either prepare/import writes, and decode only #578's validated returned
payloads, never raw-map substitutes. Internal full mode returns exact complete metadata
without adding the UI parser's `needsCheck` retry hint; default callers keep that hint. Raw
native keys only establish same-owner source identity/provenance disagreement checks.
Expected: both collision writes refuse without changing source bytes/work, foreign/malformed
native keys cannot replace readable text in owner/composer/artifact reads, and full sending
metadata remains exact. Wrong if any new checks merely hide lost work, any original changes,
corrupt/released native sources fall back, or default callers change. Result: HIT in final
113 focused checks and 25 isolated native coordinator groups, plus unchanged #578 native
controls. The two stored-key collision operations retain identical before/after artifacts;
foreign-key native bytes cannot replace readable work. Earlier green runs were not acceptance.

## Caller contract (published to #570/c108 before caller implementation)

- `createPendingRecoveryCoordinator(options?).start({ recoverOwnerId? }?)` acquires a
  non-waiting exclusive lifetime Web Lock for the sessionStorage owner token, restores
  #578 before any write, and imports complete legacy-only work. Reload reuses the token;
  a clone with the same token refuses mutation, rather than guessing ownership. Missing
  Web Locks/storage or an ambiguous/corrupt source fails closed. No timeout takeover.
- `prepare(work)` captures all input before its first await. `work` is discriminated:
  `{ kind: "prompt", pending: PendingSend }` or `{ kind: "command", id, conversationId,
sessionId, createdAt, payload: string, attachments? }`. Command `payload` is the exact
  opaque original outbound string, not a prompt. New work requires a stable session.
  The internal storage carrier must NEVER be displayed or passed to a prompt sender.
- A prepare result is a discriminated success/failure, not a save notification. Failure
  always means **no send and no clear**, even with `payloadCommitted: true`. Success
  returns frozen original work, owner and SHA256 identity. Only first preparation may
  dispatch; existing/restored/returned work requires status/explicit user coordination.
  The module itself never sends, clears, retries or automatically replays commands.
- All mutating operations serialize; incomplete startup stays read-only. Session changes
  during await cannot retarget the captured work. #570 must route by the returned original
  session, recheck connection/target, and never reread the composer after persistence.
- `observe` accepts matching persisted proof only through an explicit caller verifier;
  volatile positive prompt_ack, text matches, negative/unknown status and time do nothing.
  `returnToComposer` returns the original work but retains recovery. `discard` requires
  explicit discard of the exact matching identity. `close` releases only the lock.
- `catalogPendingRecovery` enumerates #578 IDB and persistent owner-envelope names so an
  orphan is discoverable. Explicit recovery acquires that owner's lock; active/uncertain
  owners cannot be reclaimed. A separate empty recovery tab avoids stranding its own work.
- A standalone HTML reader generated by this module embeds the reader code and data format,
  runs without the new app, reads the original origin's IDB and owner envelopes, and exports
  a versioned integrity-checked artifact. Import validates owner/session/ID/content and
  refuses conflicting/released identities. #570 must keep the reader reachable through
  rollback and download/test the artifact before rollback; old UI/JSONL alone is not recovery.

## Exact integration order and API

Exports live in `web/src/pending-recovery-coordinator.ts`. Its types are the source of
truth; this example intentionally has no WebSocket, clearing or automatic replay:

```ts
const recovery = createPendingRecoveryCoordinator({ verifyReference, verifyPersisted });
const initial = await recovery.start();
if (initial.state !== "ready") {
	// Surface initial.issues and retained entries; do not replace sources or prepare new work.
}
const result = await recovery.prepare({ kind: "prompt", pending: completeOriginalPending });
if (!result.ok) {
	// Keep complete original composer/attachments, report error + payloadCommitted, NO send/clear.
} else if (result.dispatch === "first-send") {
	// #570 alone checks original session/connection; sends ONLY result.prepared.work.
	// Clear ONLY the matching captured composer revision, never a newer draft after an await.
} else {
	// status-required: unresolved/restored/returned/duplicate identity. Never automatic replay.
}
```

`prepare` synchronously captures full acyclic plain JSON (optional undefined object fields
are omitted as on the JSON wire; undefined array entries, nonfinite values, functions and
binary objects are rejected). Empty/missing stable sessions, incomplete prompt bookkeeping
or absent original command strings are invalid. Capture failure returns `work: null`: the
original caller still owns the unsanitized input. All other failures return frozen full
captured work. A command can be any opaque original string, including a serialized slash
prompt or a non-prompt user command; `kind`, original ID/session and `payload` stay explicit.
The command itself is never parsed into, sent as, or displayed as an internal prompt.

`PreparedRecoveryWork` is `{ ownerId, kind, id, sessionId, contentDigest, work }`.
`contentDigest` is SHA-256 of JSON-encoded complete discriminated work, not a text match.
An internal #578 carrier has a namespaced storage ID (`prompt:<id>`/`command:<id>`) and
opaque JSON in its text. It is private storage, NOT the wire prompt. Do not feed #578 raw
records, carriers or artifact `records[].payload` to the UI/send path. Read only decoded
`prepared.work` (or the artifact reader's `work`). Prompt body is `work.pending.text`;
opaque command body is `work.payload`. Keep exact attachment fields/bytes, original
`sessionId`, request ID and queue semantics. Unknown/read-only WS probes need not become
recovery operations: #570 owns command policy and original ID creation, not this module.

### Producer provenance and old-format compatibility (#581)

Public methods, `RecoveryWork`, prepared identity/digest, artifact header/version, owner keys,
Web Locks, native DB version, #578 body identity, memory/size safeguards and release authority
are unchanged. The private carrier JSON body still uses `pi-web-pending-work-v1`. Its **outer
stored PendingSend**, not its `text`, now has:

```json
{ "__piWebPendingRecovery": { "format": "pi-web-pending-work", "version": 2, "kind": "carrier" } }
```

Known session-legacy prompts get the same field with `kind:"literal"` during the existing
startup import. This is private record provenance, not a reserved user-text string: legacy
text may be any JSON, including a perfect nested carrier-looking object and matching
`command:`/`prompt:` IDs/bookkeeping. That exact user text remains literal. Literal provenance
is removed from returned `work.pending`; it stays in native storage and owner envelopes.
The native payload's existing full-JSON digest covers this field. It is not a signature, a
server receipt, or defense against arbitrary same-origin code fabricating complete records.
The only #578 contract addition is internal `PendingRecoveryOptions.fullEnvelope?: boolean`,
default OFF, enabled only by this coordinator/its independent reader. Complete envelope-array
records use unchanged native payload validation instead of `parsePending`: retain all producer
fields and absent/empty/nonempty attachments, detect duplicate identities as incomplete, and
never normalize malformed/mixed sources into apparent completeness. Other callers keep the
legacy parser/defaults/confirmed filtering. Full-mode sources lacking required complete-record
metadata remain incomplete/raw-exportable; do not guess missing metadata. DB/schema/keys,
limits, body equality, digest/reference/transaction rules and native corruption/release
precedence are unchanged.

Only valid `version:2,kind:"carrier"` provenance selects JSON carrier decoding. Every outer
carrier field must match the reconstructed original, including attachments/bookkeeping and
the producer tag; bad bodies/metadata, unknown versions/kinds/formats and disagreements
between native/envelope provenance report `corrupt`, never plain prompts. Native integrity
failure never falls back to an envelope. The coordinator/independent artifact reader decode
only #578's validated full results, never raw-source map substitutes. Import saves complete
stored records. #578's default legacy parser is unchanged and need not learn this private
format; only internal full-envelope mode avoids normalization and UI-only retry hints.
Complete source-aware resupply prevents a subsequent prepare/import from stripping older
producer data. A stored identity already containing unequal full JSON content/provenance
refuses either operation before writing, even if #578's narrower body digest would match.

Compatibility is explicit and non-destructive:

- An actual unrecognized session-legacy source (including an exactly copied owner envelope
  after interrupted setup) with no native record is known ordinary prompt ingress. Startup
  commits literal-tagged records before ready, retains original session bytes, and records
  the existing import hash. Subsequent restore is read-only. Different unrecognized sources
  still conflict; a native record always takes precedence over such a legacy inference.
- Untagged old native/envelope records outside the old storage skeleton remain ordinary
  prompts. Untagged `prompt:`/`command:` IDs with `status:"failed"`, empty `sameTextBefore`
  and `queueBase:0` could instead be #579 internal carriers. Without known literal ingress
  they are **ambiguous regardless of text**: report `compatibility`, expose incomplete,
  refuse prepare/import, and preserve full raw record/envelope export. There is deliberately
  no nested-body sniffing or guessed plain-prompt conversion. An ordinary old prompt that
  has that exact ambiguous shape also needs explicit classification; its text/ID alone
  cannot prove who produced the record. New literal provenance eliminates that ambiguity.
- A bounded recovery path uses a retained original raw artifact plus a **separate copy**.
  After the operator explicitly classifies each ambiguous record from its actual producer
  history, add the literal or carrier provenance to the copy's outer record and matching
  array-envelope entry. Do not alter nested/user work or IDs. Carrier classification must
  satisfy the full reconstructed-carrier validation; literal classification keeps original
  text/metadata/bytes. Recompute each changed record's full-payload SHA-256 digest and the
  outer artifact checksum (remove checksum, SHA-256 the JSON body). #578 `contentDigest`
  does not change when only the private field is added. Run `readPendingRecoveryArtifact`
  and require complete/exact equality before any explicit same-owner import in a separate
  empty recovery environment. Keep originals until recovery is independently verified.
  Classification is never automatic, original records are never edited/deleted, and this
  document does not authorize an unreviewed migration of actual browser data. With no
  producer evidence, retain/export the incomplete source and request that one decision.

#570 must build the rollback reader from the repaired pin before enabling producers; the
older #579 reader does not understand the new provenance. It is not a safe fallback for
these records. This compatibility change is not a deployment or integrated losslessness proof.

Public lifecycle operations:

- `snapshot(): RecoverySnapshot` returns frozen state/owner/entries/issues. Each entry has
  `{ prepared, lifecycle, complete, issues }`; per-entry reference errors include the #578
  `key`. An incomplete owner does not hide its other complete work: it stays readable,
  returnable and exportable. Owner-wide prepare/import still refuses mutation until all
  sources are restored/repaired, so an omitted blocked entry cannot be overwritten.
- `start({ recoverOwnerId? }?): Promise<RecoverySnapshot>` runs once per coordinator.
  `restore(): Promise<RecoverySnapshot>` rereads sources under the retained exclusive lease.
- `prepare(work): Promise<PrepareRecoveryResult>` has literal `ok`, `payloadCommitted`,
  and success-only `dispatch: "first-send" | "status-required"`/`prepared`. Failure has
  `error: { code, message, payloadCommitted? }` and `work`. No failure has `dispatch`.
- `observe({ kind: "persisted", identity, proof })` invokes optional
  `verifyPersisted(proof, prepared): Promise<boolean>` after exact identity matching.
  Its absence, false, throw, unmatched fields or failed IDB release keeps the copy.
  `observe({ kind: "volatile" | "unknown" | "negative" | "text-match" })` does nothing.
  There is no module replay/re-admission API. `status-required` defaults to no-replay plus
  return/export. A future explicit caller USER-retry gate must independently prove an exact
  matched server-unprocessed disposition, current WS generation/session and explicit intent;
  unknown/negative/age is not that proof. Such a disposition never deletes the retained
  original and is not an argument to `observe(kind:"persisted")`.
  A server lifecycle helper's transport/handler/disposition and a queued prompt ack are
  NOT persisted proof. #570 must not install an optimistic verifier to make tests pass.
- `returnToComposer(identity): Promise<RecoveryWork>` changes only in-memory lifecycle to
  `returned`; bytes remain. `discard({ intent: "discard", identity })` requires explicit
  user intent and matching owner/kind/session/ID/digest; never use it for ×/return or age.
  Release operations return `{ released, error? }`. Tombstone transaction failure retains
  all data; envelope cleanup failure may leave an honest released marker in IDB but the
  call reports failure and raw envelope remains. A later restore respects that marker.
- `close(): Promise<void>` drains earlier mutations, releases only the Web Lock and marks
  `closed`. Call on intentional teardown; document destruction releases native ownership.
  Never implement unload-time deletion, timers or automatic retry/replay around it.

States: `closed -> ready | incomplete | unavailable | conflict`; successful restore can
move `incomplete -> ready`. `ready` is the only preparation/import state. Envelope failure
after payload commit makes preparation `ok:false, payloadCommitted:true` and state
`incomplete`; restore then reports the committed work as unresolved, not permission to
send. New entry is `prepared` only after both payload and envelope commit; every restored
entry is `unresolved`. Return is not discard. Failed setup retains an already acquired
lease for raw export only; prepare, release/discard and import are refused. A collision has
no lease. Close the failed coordinator before a fresh setup attempt; never delete sources. Error codes include `invalid`,
`identity`, `ownership`, `conflict`, `incomplete`, `corrupt`, `compatibility`, `unavailable` and #578's
`quota`, `payload`, `reference`, `released`, `envelope`. Exceptions in export/import are
failures too: retain source artifacts and inspect `payloadCommitted`; do not clear/replay.

Owner metadata: `pi-web-pending-owner-v1` is a sessionStorage token; a lifetime Web Lock
`pi-web-pending-owner-lock-v1:<owner>` is its actual exclusive capability. A real opener's
cloned token cannot mutate while the original holds the lock. No heartbeat or elapsed
time reclaims an active owner. Reload reuses the token after document destruction releases
the prior lock. The persistent owner envelope is localStorage
`pi-web-pending-owner-envelope-v1:<owner>`; native #578 payloads use that same owner.
A committed legacy import records a hash under `pi-web-pending-legacy-imported-v1:<owner>`
so an unchanged legacy sessionStorage source is recognized on reload, without clearing it.
Different unknown sources fail conflict, not last-write-wins. `catalogPendingRecovery()`
reads IDB owner keys plus persistent envelope keys and reports `{ complete, owners:
[{ ownerId, active }], issues }`. It reports incomplete enumeration as incomplete, not an
empty recovery set. Use an empty tab and explicit `start({ recoverOwnerId })` to recover
an orphan; a tab with another owner or unowned legacy draft refuses such reassignment.
An active clone must return to the original, or close it and use explicit recovery; never
invent a new owner for the clone's unseen inherited work. Separate owners may work in
parallel. Test-only backend/listOwners/storage/ownership ports are not timeout lease APIs.

## Independent artifact and rollback obligation (#570)

`exportArtifact(): Promise<string>` exports raw full #578 records plus persistent owner
envelope under a versioned `pi-web-pending-recovery-export` header, owner and SHA-256 checksum.
Optional `legacyEnvelope` retains a distinct unrecognized session-only source verbatim;
its presence makes the artifact incomplete, not automatic repair/import. Already imported
unchanged legacy sources are recognized by their stored hash and are not competing sources.
Export also works in an incomplete state or failed setup with an acquired lease, provided
sources remain readable: raw corruption/ambiguity is retained, not silently omitted. Ordinary
reload performs no payload/envelope write and no identical token rewrite, so ongoing
write-only quota/security failure does not prevent inspection/export of committed work. `readPendingRecoveryArtifact(text, verifyReference?)` is read-only and
returns `{ artifact, work, complete, issues }`; it checks outer checksum, raw record owner,
keys/session/ID/content digests and full payloads, then decodes original typed work. It is
not a signature or trusted server proof. Missing durable references stay incomplete even
when metadata can be read. Broken artifact checksum throws; internally unreadable sources
remain raw and report incomplete. Keep both until a bounded repair can validate them.

`importArtifact(text)` requires a ready, exclusively owned destination with the same owner;
validates the entire artifact and all same-identity conflicts before any write; refuses
incomplete/foreign/corrupt input or resurrection of released local work. #578 supplies the
atomic payload commit and later envelope commit; envelope failure honestly reports committed
bytes and leaves the artifact/source intact. Released records in an artifact are history,
never permission to delete an unresolved local copy. No artifacts, owners, keys, unreferenced
pending data or release markers are garbage-collected by this coordinator.

`createPendingRecoveryReaderHtml(bundledModule: string): string` generates a self-contained
HTML reader from an esbuild **ESM, bundle:true, platform:browser** bundle of this exact
module. It imports the supplied source from a Blob, not from the installed app. Its native
IDB/localStorage/Web Locks actions are discover, explicitly recover owner, inspect/export
artifact, and explicitly restore an inspected complete artifact. It has no send/replay,
discard or server-engine action. The UI renders decoded original work with `textContent`;
opaque payloads are not reinterpreted as prompts/HTML. Blob modules must be allowed by the
reader page's deployment CSP. The caller must build/pin the input, not inject remote code.
The isolated browser fixture demonstrates generation and native recovery with
`/coordinator.js` returning 410 (current app unavailable), plus artifact restoration into
a fresh isolated browser context and checksum corruption refusal.

Before allowing new producers or rollback, #570 must:

1. Build and retain the reader HTML from this immutable pin, record its hash, serve it on
   the **same original origin** at a fixed recovery URL not replaced/removed by old-bundle
   rollback, and verify browser access/CSP. An arbitrary file:// reader cannot see another
   origin's IDB; a JSONL session backup and the old UI cannot read these new client records.
2. Expose discover/inspect/export (including incomplete/unknown errors) and explicit orphan
   recovery in the integrated UI. Do not hide retained work merely because an old tab vanished.
   Setup conflicts retain raw browser sources; acquired owners can export both legacy and
   persistent envelopes in one incomplete artifact before a bounded repair. A collided active
   owner cannot export until explicitly selected after the original owner closes. A damaged/missing tab token is not permission to guess
   an owner or overwrite legacy work.
3. Export and independently read full artifacts for every unresolved owner before rollback;
   keep downloaded private artifacts plus reader outside the replaced app bundle. Rehearse
   the exact deployed rollback route and original-origin reader, including byte equality,
   reference availability, orphan ownership and restore, without touching real chats.
4. Keep original-origin IDB/localStorage and retained legacy sessionStorage intact. Retain a
   tested artifact import/restore route after rollback; do not claim old bundles automatically
   restore these records. The independent reader supplies it only if actually retained and
   served. It contains no default external-reference resolver: #570 must retain/prove that
   resolver or preserve/download those referenced bytes separately before rollback.
5. Verify #570's actual app send/held-publication/clear/cancel/session-switch ordering,
   current-composer revision checks, attachment UI, command policy and genuine persisted
   authority. This module's unit harness is not that integrated proof. Neither module nor
   reader replaces server persistence, server backups or user confirmation of uncertain
   non-idempotent work.

## Checks and unchanged-baseline/red contract

Fixed synthetic values include Unicode/CRLF opaque strings, multi-megabyte original inline
bytes, file bytes, durable external references, original IDs and cross-await session changes.
Focused unit suite: `scripts/sealed.sh env VITEST_MAX_WORKERS=4 npm test --
tests/unit/pending-recovery-coordinator.test.ts tests/unit/pending-send-storage.test.ts
tests/unit/pending-sends.test.ts`.
Native fixture: `scripts/sealed.sh node tests/pending-recovery-coordinator-test.mjs`;
run existing `tests/pending-send-storage-test.mjs` too. Normal full unit/validation gate remains
`TZ=UTC VITEST_MAX_WORKERS=4 scripts/check.sh --fast` as configured in `wt.yaml` (sealed by
the script); normal `wt land` runs it unchanged, with build performed separately beforehand. Missing Chromium is a blocker, not a skip/pass.

The unit file has an explicit unchanged-baseline mode:
`PENDING_COORDINATOR_BASELINE=1 ... vitest run tests/unit/pending-recovery-coordinator.test.ts
-t 'unchanged-baseline behavioral contract'`. It retains available imports and calls the
unchanged landed #578 API and existing `applyPromptAck` directly: cloned owners can both
write when merely sharing a caller token, and a positive volatile ack removes the pure
optimistic pending list. These are two actual behavioral red assertions, not a missing-import
failure or a claim #578 itself promised coordination. Controls demonstrate unknown ack
retention and legitimate independent owners. The normal coordinator cases assert collision
refusal and volatile-copy retention. Neither establishes #570's integrated production result.

The #581 frozen-source mode is separate: set `PENDING_CARRIER_SOURCE` to the unchanged
`48cec10e` coordinator in an isolated checkout, then run only
`-t 'carrier recognition public API'`. The APIs already exist at that pin. For the isolated
native collision vectors, also set `PENDING_CARRIER_ONLY=1`; it bundles that exact source,
not the repaired module, and fails on actual owner recovery rather than an unavailable API.
Without these variables the normal suites check repaired code and all existing protections.

## Recorded module results

### Prior #579 proof (historical)

- 96 focused unit checks passed: 33 coordinator, 19 unchanged #578 store and 44 unchanged
  pending-send contracts. Baseline mode intentionally produced exactly two behavioral red
  assertions and two passing controls; the other cases were filtered, not passed.
- 15 isolated native-browser coordinator scenario groups passed, including original-origin
  reader export/restore with the app module unavailable, ongoing write-only failure on reload
  with zero readwrite transactions, full raw ambiguity export, and checksum corruption refusal.
  The existing #578 browser fixture also passed all eight scenario groups unchanged.
- Normal build and full package typecheck passed; lint reported zero errors (existing
  warnings remain). Final gate and immutable landed pin belong in the native landing receipt,
  not a prediction in this document. Only the four task-owned new files are changed.
- Self-review found the redundant startup write/raw-conflict-export gap after the first green
  suite; H-PENDING-STARTUP-READ-1 records the bounded repair and additional fixed-input tests.
  An early parser typo was fixed before execution. The native failure-reload oracle was
  corrected to #578's original `createdAt` ordering (42 before 43), not insertion order;
  original byte/ID assertions were retained. No gate, protection, existing tests or limits changed.

### #581 repair proof

- Frozen clean source `48cec10e20ecc3870f0e2422fb990160c00e215d`: the existing public
  owner/artifact APIs produce **10 behavioral assertion failures and three passing controls**
  in the carrier-recognition subset (66 unrelated tests excluded, not passed). Marker-only,
  malformed nested and valid nested-looking literal text become incomplete/missing, rather
  than exact usable work. The isolated native marker-only vector likewise fails on
  `incomplete` versus required `ready`; it loads/bundles the unchanged API successfully.
- Final repaired code: **113 focused checks pass** (79 coordinator, 34 storage). Exact
  legacy literals, ID-prefix collisions, metadata and attachments survive restore/composer,
  export/read/import and reload. Genuine prompt/opaque-command, corrupt/unknown provenance,
  native corruption/release precedence, default parser, incomplete/mixed/duplicate source,
  absent/empty/nonempty attachments, same-key/different-full-content and source-substitution
  controls pass. The latter collisions assert equal underlying #578 body digests before
  refusal, no backend write and exact before/after artifact equality.
- **25 isolated native coordinator groups pass**, including every collision vector, complete
  envelope-only literal+carrier recovery followed by both prepare and import then reload,
  raw unknown/ambiguous export, same-stored-key refusal on both write paths, independent
  reader with the app module unavailable, ownership and commit/failure/lifecycle controls.
  All **eight unchanged #578 native groups pass** too. No real browser profile/chats/IDB used.
- Final build, full package typecheck, lint (zero errors; existing warnings) and full package
  format check pass. Independent read-only six-file review: **no issues found; source merge
  OK**, with parent responsible for final test/landing results. Findings R2–R4 were fixed,
  not hidden by accepting raw retention as recovery or by weakening existing checks.
- Exactly six admitted files change: the original four coordinator source/unit/native/doc
  files plus `web/src/pending-send-storage.ts` and `tests/unit/pending-send-storage.test.ts`
  admitted by Ops' native scope decision. The unchanged normal sealed gate runs through
  ordinary detached `wt land`; its actual result/immutable pin are in that receipt. No
  production migration, deployment, caller workaround or integrated no-data-loss claim.

## Boundaries

Origin-local IDB is not a server backup and cannot survive browser-origin clearance or
reconstruct already-stripped bytes. External references need #578's actual resolver;
an export retains references and reports unresolved data, not imaginary inline bytes.
A reader cannot authenticate client-generated server proof: #570 owns that authority.
No shared caller, protocol, package, server engine, live profile, real chat or deploy edit.
No deletion/expiry, new quota, time-based ownership or uncertain non-idempotent replay.
