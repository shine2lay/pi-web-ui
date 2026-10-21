# Bounded numeric ledger source — W2 / Ops #313

Accountable lead: **Ops**. Standalone adapter only. No runtime importer, discovery,
SDK hook change, transcript read, install, policy, funding, budget or stop behavior.

## H-WIRE-2 — before implementation

Wrong/evidence: #306 writes best-effort `usage-ledger/1` observations but has no
importer. Its queue can skip writes; disabled/unreadable settings and missing SDK
attempt events leave no durable completeness witness. Persistent assistant rows
overlap #304's transcripts. Null response IDs and summarizer aggregates cannot
identify leaf attempts. Requested model is not the actual response model. Every
Pi zero class has lost presence provenance, not just the cache classes.

One change/why: an explicit-month, bounded source adapter, using caller-injected
last **committed** anchored cursors and a durable first-response lookup. Return
closed numeric batches, proposed native-index entries, helper metadata and fixed
faults. No candidate cursor/index mutation is committed inside the adapter.
Native provider/response IDs identify attempts; file bytes identify observations
only. Only a separately checked same-call witness can alias a transcript fact.

Expected/measurement: fixed main/helper/app/cache/compaction, native-overlap,
null-ID/requested-model/all-zero-class, torn-line, private-file, rollover,
changed-anchor and crash/replay fixtures produce exact facts and fixed faults.
Planted payload fields never leave the projection. Batch assignability, unchanged
collector acceptance and the normal gate remain green. Positive recorded cost
with proved model retains `pi-recorded-1`, never an exact historical token quote.

Falsifier: a second charge for a repeated response/transcript, an aggregate leaf,
a cursor advanced before durable commit, requested-as-actual model, any proved
Pi zero/free call, content leakage, optimistic completeness or unbounded read.

Result: initial ordinary gate **MISS** (55 ledger tests, 54 passed). A cross-month
cursor was safely refused but mislabeled `source-truncated` before comparing its
stream/incarnation. The independent CLI fixture also requires the ordinary server
build (`dist/server/plugin-updater.js` was absent); no check was bypassed. All
other 7,318 tests passed, six existing skips; the unchanged collector suite passed.
Read-only review before this gate fixed receipt-validator prerequisites, unsafe
prefix-stop rechecks, failed/late alias handling and empty-file resume.

### H-WIRE-2a — scope before size

Evidence: the November fixture's file is shorter than October's committed byte
position, so the size check masks a mismatched source identity. One change:
compare the stream/incarnation before checking truncation or reading an anchor.
Expected: that fixture reports `cursor-changed`, same-file truncation still
reports `source-truncated`, both preserve the prior cursor and emit no batch.
Falsifier: either fixture changes its durable cursor or fails its exact fault
assertion. Validation: build the server in this worktree under the seal, then the
unchanged ordinary gate; detached landing runs its mandatory gate separately.
Result: **HIT**. The unchanged assertions pass after the scope-order fix. The
sealed ordinary gate passed on 2026-10-20 21:58 PDT: 471 files, 7,320 tests,
six existing skips, including all 55 ledger-source fixtures and the unchanged
147-test collector acceptance/resource/crash suite. Typecheck, protocol, patch
contract, formatting and lint passed (47 existing warnings, zero errors). It used
the supported inherited four-worker cap and all 20 CPUs; no thresholds, hooks,
assertions, import guards or runner settings were weakened. Journal receipt:
`ops-313-ledger-check-scope.service`, invocation
`591f9901e20e4bd99bc0d2c4e2ee62fd`. H-WIRE-2 is HIT after this measured correction.

## API and hard bounds

`server/usage-accounting-ledger-source.ts` exports `readUsageLedger(request,
evidenceReaders, clock?)`, `ledgerUtcMonths(from, through)`,
`ledgerMeterFaultCounts(faults)` and the associated numeric interfaces. Importing
it starts nothing. Synchronous filesystem work belongs in the reporting worker,
never the chat/main-thread path. No import of collector/engine/session-reader
implementations; the structurally compatible W0 types preserve their sealed
importer guards. Tests alone use their existing public interfaces.

The request names an absolute normalized `usage-ledger` directory and exactly
one `YYYY-MM.jsonl` file. No readdir, glob, transcript lookup or fallback path.
The directory must be owned by this uid, mode 0700, with no symlink components;
the file must be owned by this uid, mode 0600, regular, single-link and opened
nonblocking/no-follow through the pinned Linux directory fd. Directory/file
identity and privacy are checked again before publication. Missing/unsafe files
produce fixed faults, never an exception reflecting a filename or error body.
Request-validation errors are the fixed strings `ledger-request`/`ledger-window`.

Each call reads at most **262,144 bytes total**, including header/anchor checks,
read-ahead and final verification. Each line is at most 16,384 bytes including its
newline. The read budget reserves 32 KiB for final first-line/tail verification.
A call consumes at most 128 complete records, emits at most 256 numeric rows in
one <=262,144-byte W0 batch, and checks the 100 ms work deadline between records.
A finite request window is <=169 hours. Limits are immutable and cannot be
raised by an option. There is no process-lifetime all-response cache.

A result is always `status: partial`; `batch.status` is also always partial with
`reason: reported-gap`. EOF only means the end of this fd's bounded snapshot,
not that every call was recorded or that the next month is absent. A line after
the occurrence window or observedAt is held, not silently skipped. Advance the
requested window deliberately; do not spin on an unchanged blocked row.

## Durability, cursors and UTC rollover — W1/W3/W6 handoff

The injected cursor is a W0 `MeterNativeCursor` file variant: path-hashed stream,
inode/device-hashed monthly incarnation, first-complete-line hash, byte/line and
ordinal, and the final complete line's start/length/SHA-256. The batch's opaque
source cursor binds the same fields. Byte positions identify observations only.
A changed first/tail anchor, truncation, unsafe replacement or mismatched month
cannot reset a committed cursor. Errors retain the prior cursor; an invalid
cursor emits no replacement. Torn/overlong lines, byte/work limits and record
limits may return a verified complete prefix, never a partial-line position.
First/tail anchors do not claim to authenticate all historical interior bytes;
the recovered journal/index remains the authority for committed evidence.

W1/W3 must supply `first(key)` from their recovered **committed** first-native
index. `null` means a proved absence; missing/undefined/throwing/malformed lookup
means `index-unavailable` and holds the row. The key is SHA-256 of the native
`[provider,responseId]` tuple, not a timestamp/price/byte match. Returned receipts
are closed numeric records tied to the original fact. An in-page map resolves
same-page duplicates but never survives a read or changes external state.

The caller must durably commit the W0 batch **and** its numeric diagnostic,
conversation, native-receipt and fault sidecars in the same proved journal/index
generation before adopting `result.cursor`. The adapter cannot establish that
transaction itself. Saving its cursor early, or rebuilding an empty index while
keeping an advanced cursor, is invalid. Crash/replay before commit is identical;
after commit, reopen using the durable receipt index and exact committed cursor.
No transcript or ledger write is performed by this adapter. W1 native-sidecar
and W5 fault-bearing-fold obligations from #311 remain in force.

`ledgerUtcMonths` returns only UTC month labels for an explicit bounded
**observation-time** interval, including a year rollover. A late observation's
`at` month determines its file; `occurredAt` can precede that month. W6 must pass
each explicit monthly file separately, keeping each committed cursor/source
identity and the same recovered native index across months. Never reuse October's
cursor for November, silently replace an unavailable October cursor, or infer
which old months are retained from a successful current-file read. The source's
`retainedFrom` is the caller's requested occurrence bound, not a production or
retention-completeness witness; inventory remains externally proved and partial.

## Attempts, overlap and price evidence

Only an assistant observation with native provider and responseId can emit a
leaf fact. A null ID/provider remains a numeric observation, not a generated
charge identity. `cache_warm`, `compaction` and `branch_summary` remain aggregate
observations even if someone supplies an ID. Their amounts are never added as
leaf charges. Stop/error/abort labels do not erase recorded numeric usage.

The first receipt preserves its native fact, first observedAt, model evidence,
price, tokens and session link. Exact duplicates emit no new fact. A changed
native numeric fingerprint emits `native-response-conflict`, not an overwrite,
reprice or second charge. A zero in a later observation cannot erase the first
observation's numeric evidence. The caller must retain the conflict fault.

Persistent/session-file observations are unresolved unless `sameCall(provider,
responseId)` returns a separately proved native map to a validated #304 canonical
fact. Its provider, actual model, occurrence, kind and mutually known numeric
fields must agree; its evidence reference is opaque. A label saying "verified"
is not a witness. Requested models, timestamp/amount proximity, matching text and
raw JSON hashes are not native-call proof. The reader itself never opens a
transcript. An invalid/throwing witness never promotes a fileless row into an
additive fact. Fileless, nonpersistent calls with proved response-model and no
conflicting witness can be native originals; their stable native tuple still
deduplicates across replays/files/months.

W3 must make canonical facts available before committing their alias edges.
A newly available witness on a later duplicate can emit an alias and an updated
receipt **without replacing its first fact**. An originally unresolved first fact
is not retroactively upgraded by that metadata; its uncertainty remains visible.
Fully resolving older facts would require a separately approved revision flow.

Positive `costTotal` with an actual response model retains the documented
`list-estimate`, USD, `pi-recorded-1` basis. The diagnostic explicitly says
`exactTokenQuote: false`. Decimal conversion uses the JavaScript number's shortest
round-trip decimal and half-even rounding at twelve fractional digits; rounded
rows have a numeric counter. Absent/zero, overflowing or rounded-to-zero amounts
are unknown, never a known/free zero. A requested/unknown model can retain a
non-additive recorded-price diagnostic, but the fact has `unknown-model`, null
amount and no rateVersion. There is no current-rate repricing.

For **each** of input/output/cacheRead/cacheWrite, a Pi zero becomes `null`,
including SDK value-or-zero defaults and later-zero overwrites. All four known
positive classes and an agreeing recorded total are required to expose a numeric
total. Otherwise total is null. Known positive recorded price may remain a
separately labelled estimate despite unknown token presence; those tokens cannot
be exactly repriced or treated as free. The existing #300 quote function rejects
null token classes. No change to #300 is needed or made.

## Conversation provenance — #305 handoff

`conversations` contains only `usage-ledger/1`, conversationId, sessionId,
sessionFile, persist, origin, parentConversationId, at and occurredAt. It is
structurally assignable to `MembershipConversation`, with occurrence <= observation
and no inferred task/funding. #305 may use time-valid, separately proved registry
and delegate history; this adapter emits no membership/allocation/root/policy.
App-origin calls stay unassigned even with a parent. A fileless helper's direct
parent metadata is retained, but the current #305 mapper requires a session-file
binding: `fileless-helper-membership` marks that missing evidence rather than
inventing a synthetic file or overstating membership coverage.

## Fixed faults and optional O0 counters

Every read reports `production-unprovable` and `skipped-writes-unobservable`:
#306's best-effort queue and absent SDK lifecycle hooks cannot prove production
coverage. `production: disabled|unknown` adds a fixed fault, performs no read,
and keeps the injected committed cursor. No runtime settings are read here.

Other fixed classes cover private-file/I/O/anchor failures, bounded stops, invalid
records and month/window violations; unknown actual model, missing response
identity, aggregate-not-attempt, every legacy zero token class and unknown total;
missing/unrepresentable price; unresolved/conflicting overlap; unavailable native
index; unverified same-call map; and unsupported fileless helper binding.
There are no exception messages, source snippets, dynamic diagnostic strings or
payload copies. A worker-private line number is an observation reference only.

`ledgerMeterFaultCounts` maps these classes into W0's closed fixed vocabulary
(e.g. source-coverage, source-unavailable, unresolved-identity, native-unverified,
unpriced, event-conflict, index-unavailable). It emits one bucket per resulting
code for this source, **not affected rows**. W5/W6 must deduplicate by source
across pages and preserve the faults when a later DTO/fold looks superficially
ready; never sum page buckets into attempt counts or publish optimistic readiness.

`counters` alone supplies numeric affected-row counts for optional O0: records,
facts, aliases, missingResponseIdentity, unknownActualModel, aggregateRecords,
legacyTokenPresence, zeroInput/Output/CacheRead/CacheWrite, totalUnknown and
roundedAmounts. No identifiers, paths, prices, samples or exception values occur
there. The observations/receipts/conversations/cursors are worker-private evidence,
not a main-thread/public DTO; never expose the complete result through O0.

## Verification, ownership and undo

Owned files only: this doc, `server/usage-accounting-ledger-source.ts`, and
`tests/unit/usage-accounting-ledger-source.test.ts`. Sealed synthetic temporary
files are removed after each test. No real chats, live ledgers, models or services
are read or started. Fixtures cover helper/main/app/aggregate, aliases and first
receipts, every zero class, requested model, torn/invalid/long lines, rollover,
private-file failures, anchor replacement/mid-read mutation, crash/replay, W0
assignability and unchanged collector acceptance. Review precedes the final gate.

The independent ordinary gate is green as recorded above. The commit is submitted
through normal detached `wt land`; its durable receipt and final checked commit
are recorded in the task completion (the gate log also appears in
`ops-313-ledger-land.service`). Landing may rebase and repeats the mandatory gate.
Nothing here installs or activates the adapter. Undo is to revert the one W2
commit (three files); there is no data migration, producer change or runtime cursor
to undo.
