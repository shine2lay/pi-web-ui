# H-AUTOCOST-5 — persisted Pi usage reader

Ops #304 · automatic-cost-accounting · accountable lead: Ops.

Wrong, with evidence: Pi SDK 1.0.1 persists assistant usage, standalone usage,
compaction and branch-summary usage in session JSONL, but nothing reads those
records into the #300 collector for automatic budgets. Assistant-only reading
omits paid work; copied histories and parent tool reports can double count it.

One change: a bounded, numbers-only, explicit-file reader producing frozen
`usage-source-batch/1` batches, identity aliases, numeric diagnostics and fixed
fault codes. Read synthetic sessions line by line; retain no content, tool
arguments/results, summaries, details or exception text.

Expected: fixed plain/fork/resume/delegate/cache-warm/compaction/unknown-price/
identity/partial/oversized fixtures produce exactly the expected numeric facts,
aliases and faults, accepted by the unchanged collector where source evidence
is valid. Cursors retain byte offset, line count and the last complete line's
SHA-256; partial/truncated/unreadable sources remain explicitly partial.

Disproof: a duplicate copied-history charge, any content text in any output,
unknown cost certified as zero, lost usage, or silently discarded torn lines.

Result: HIT on fixed synthetic checks (19/19, 2026-10-20), after the pricing
correction below. Exact facts/aliases/faults and collector acceptance pass;
no planted content escapes. The unchanged normal land gate is required and
recorded by the `wt land` receipt. No live-source proof is claimed.

## Pricing correction — H-AUTOCOST-5-PRICE-1

MISS (draft interpretation, before landing): making every recorded positive
cost `basis-unproven` kept the batches valid but defeated the owner's actual
cost goal. Ops lead rejected that mapping in `rm-eb12256f` (relayed directly in
the task chat). No contract change or invented historical table version is
needed: the existing validator accepts the explicitly documented source label
`pi-recorded-1`.

Change: use known list-estimate amounts labelled `pi-recorded-1` for valid
recorded totals with model metadata. Expand the shortest round-trip numeric
form and round half-even to 12 decimal places, counting rounded observations
explicitly. Expect exact known recorded estimates, explicit missing/invalid
prices and unchanged unknown-model handling, accepted by #300. Disproved by
wrong rounding, a missing/zero token-bearing price becoming known zero, a
recorded positive cost becoming universally unpriced, or validator rejection.
Result: HIT on corrected fixed cases (19/19, 2026-10-20). The frozen validator
and collector accept `pi-recorded-1` unchanged; gross $0.41 deduplicates to
$0.19 without test-side price replacement, and all eight rounding adjustments
are explicit. Normal gate evidence belongs to the `wt land` receipt.

## Dependency isolation — H-AUTOCOST-5-INERT-1

MISS (first normal gate, `133-d8ed9d`): 7,048 tests passed, including all 19
reader cases, but #300's deliberate source-tree guard rejected this module's
collector import. The reader only used its bounds and protocol types; loading
the collector at runtime is unnecessary and conflicts with its inert boundary.

Change: remove that dependency entirely, define only structural closed protocol
types and mirror the frozen hard caps locally. Our test must compile the
reader's output against #300's original types, compare every shared cap and
reject any collector import in the reader. No alternate-path import or change
to the collector or its guard. Expect unchanged fixed outputs and a passing
normal gate. Disproved by protocol/cap drift, any new runtime dependency on
the collector or a changed numeric result. Result: HIT in the isolated check:
102/102 sealed cases pass (19 reader + all 83 unchanged collector cases,
including its original import guard). Full typecheck and server build pass;
normal-gate retry is required through the next detached land receipt.

## Scope and safety

This module is inert: no production import, discovery, timer, model/network
call, install, deploy, budget debit, allocation cause or stop-state change.
Only explicitly supplied session files are inputs. Tests use synthetic files
and unique temporary directories only; no real chats or delegate files are read.
The #293 contract and #300 collector remain unchanged. Task binding belongs to
task 5, not this reader. Unknown source identity, price, ancestry and coverage
must not become reassuring headroom.

## Known gaps

- In-memory helpers without a session file.
- Failed calls with no persisted usage record.
- Temper runs: their numeric feed is separate and not read here.
- Deleted temporary ACP delegate files, including `/tmp/acp-delegate/*.jsonl`.
- Historical price-table versions are not recorded by Pi.
- SDK 1.0.1 summary usage lacks provider/model and may aggregate calls. The
  reader uses explicit `unknown` sentinels and `model-unverified`, not model
  changes, current configuration, summary text or extension details.
- The cursor checks the header and the last complete line, not every earlier
  byte. Earlier rewritten history needs a separate full replay/audit.

## API and caller obligations

`new PiSessionUsageReader(limits?).read(request)` is explicit, asynchronous,
read-only and single-flight per instance. The request contains only `file`,
`producer` (`pi` or `acp`), `from`, `through`, `observedAt` and an optional
collector `SourceCursor`. There are no default directories, glob scans, imports
of SDK runtime services, parent-file opens, file writes or background work.
An ACP delegate file is just another explicitly supplied file with producer
`acp`. An assistant in that file remains kind `assistant`, not an aggregate
charge inferred from a parent tool result. All recorded branches are read, not
only the active conversation leaf.

The closed result is `pi-session-read/1`: `status`, `source`, `batch`, `cursor`,
`endOfFile`, numeric/identifier-only `observations`, a `roundedAmounts` count
and fixed-code/line-number `faults`. No OS exception text or raw paths escape. The source stream is
`pi-session:` plus the SHA-256 of the resolved explicit path; incarnation is the
v3 session header id. Each file therefore has its own stream, even a resume
copy with the same header id. The descriptor grants only facts and aliases.
Its retention boundary stays at the first supplied occurrence window; it is
not the fork's later header creation time. A caller still needs #300's explicit
approved inventory, native verifier and durable I/O. Structural batch/source/
cursor types and frozen hard caps are mirrored locally and checked against the
unchanged collector in tests, so there is no production dependency on it.
This reader registers no source authority or causal attribution; the collector's approved verifier
still decides whether the explicit source and its batches are native evidence.

Read originals/parents before copies/children with the same instance. The
bounded index contains projected numeric evidence, never message payloads.
On process restart, replay originals to rebuild that index before resuming
copies, or treat missing ancestry as unverified. Persistence and task binding
are task 5's responsibility. Returned objects are copies: editing them cannot
change subsequent identity decisions. Replaying a collector receipt must use
its exact batch, not a newly stamped observation with the same cursor.

The caller supplies a chronological occurrence window of at most 169 hours and
an observation time no earlier than its end. An out-of-window usage line is
left before the cursor with `window-mismatch`, not dropped. The next read can
use the appropriate window. `complete` means the supplied file's persisted
records reached the observed EOF without a structural gap, not that every Pi
call/helper/file exists. Inventory-wide completeness, failed calls without
records and the known gaps above remain unproven. Supply ordered observation
stamps for successive scans; do not invent cumulative native completeness.

## Numeric projection and pricing

Accepted usage locations are assistant `message.usage`, top-level `usage`
entries (including `cache_warm` and other kinds), `compaction.usage` and
`branch_summary.usage`. Tool-result usage and nested delegate reports are
ignored. Branch summaries use frozen contract kind `compaction`; standalone
non-cache usage uses `assistant`. Missing summary usage means no usage record,
not a zero-cost call. Only nonnegative safe-integer token classes survive;
missing/invalid classes are null with `tokens-invalid`. The assistant message
occurrence timestamp (SDK milliseconds or a canonical ISO timestamp) wins when
present; otherwise the entry timestamp is used. Invalid timestamps are explicit
record faults, not replaced with collection time.

A valid recorded `usage.cost.total` with provider/model metadata becomes
`{ basis: "list-estimate", currency: "USD", status: "known", amount,
rateVersion: "pi-recorded-1" }`, accepted unchanged by frozen #293/#300.
The label **pi-recorded-1** means the amount Pi computed and wrote into the
entry at call time from its bundled model price table. It is not re-priced by
us. The table version is not identified. It may differ from today's list
price. This is neither an invoice nor a new computed model-table quote.
Only the total is used: component costs are not added and `quoteListUsd` is
never called. Ops lead chose this mapping in `rm-eb12256f`; it is a department
technical decision, not a new owner approval or a contract change.

Conversion starts with `String(number)`, JavaScript's shortest round-trip
representation, expands exponents, then rounds half-even to at most 12 fraction
digits using integers. `roundedAmounts` explicitly counts observed totals whose
value changed under rounding, including duplicate observations (it is not a
unique-charge count). For example, `0.30000000000000004` becomes `"0.3"` with
one rounded amount; `1e-7` becomes `"0.0000001"` without rounding. A positive
sub-precision value can become `"0"` only with an explicit rounding count, not
by treating absent usage as free. Non-finite/negative totals and amounts with
more than 18 whole digits stay `unpriced`, amount null, with `price-invalid`.
Missing/null costs and raw total zero with nonzero/unknown tokens stay
`unpriced`, amount null, with `price-missing`; even their diagnostic amount is
null, never a reassuring `$0`. All-zero token classes with raw total zero are
known `"0"`. A nonzero recorded `totalTokens` also prevents known-zero pricing.

If provider/model metadata is absent (as in SDK summaries), the price remains
`unknown-model`, amount null, with `model-unverified`; the valid rounded total
survives only in `observations[].recordedPrice`, whose table version is null.
No selected model, current configuration or summary details fill that gap.
Missing/invalid price handling remains `unpriced` even when model metadata is
also absent. Observations include aliases and unknown identities/models, so
never sum them as extra charges: budget accounting uses deduplicated verified
collector facts, not diagnostic totals.

## Identity, aliases and incomplete sources

A provider response id is matched by provider plus response id, independent of
file/session copies. A local response observation has a stable hashed attempt
including its stream and entry id; duplicate observations are explicit frozen
aliases to the original fact, not additional charges. Conflicting occurrence,
provider/model, token or price evidence gives `identity-unverified` and no new
verified fact. A missing/invalid entry id or invalid response id also gives
`identity-unverified`, never a guessed fallback identity.

Without a response id, the canonical identity is the original session id plus
entry id. A known parent's matching entry id **and entry timestamp** identify
copied history. Fork observations alias the original; same-id resume copies
reuse its immutable fact without an illegal self-alias, and record disposition
`alias` in observations. Unknown/incomplete ancestry produces unresolved facts
and `identity-unverified`, excluded from verified totals. A missing id retains
only the numeric observation plus that fault. Aliases carry projected evidence
references, not content; a real #300 verifier must check their native origin.

The collector cursor's ordinal is the complete-line count. Its opaque token
contains the byte offset, last-line start/length, last-line SHA-256 and header
SHA-256. Every resumed read validates those anchors before seeking. An append
continues after the last complete newline. A partial final line (even valid
JSON without a newline) stays unread with `partial-last-line`. Oversized lines
stop with `line-limit`, not a skip; missing newline bytes remain for retry.
Truncation, changed anchors, invalid headers and unreadable files are explicitly
partial. With no safely advanced complete-line cursor there is no batch: no
fake progress just to make the collector accept a source fault. The caller
must surface that partial result and must not silently keep a previous green
coverage status. Only commit a returned cursor after #300 commits its batch.

Defaults: 65,536 bytes per line, 262,144 input bytes per read and output bytes
per batch/result, 256 fact/alias rows, 10,000 numeric index entries and 64 explicit
sources. Overrides can only lower these caps (output cap minimum 4,096 bytes).
The input cap includes header and cursor-anchor reads. Output/row/index caps
leave the next record before the cursor with an explicit limit fault. Malformed
line diagnostics are bounded too. No partial/oversized line is JSON-parsed;
reads are bounded before allocating and only regular non-symlink files open.

## Fixed checks and undo

Fixtures under `tests/fixtures/usage-accounting-pi-sessions/` are wholly
synthetic. `expected.json` fixes entry sequences, recorded amounts, alias pairs,
kinds and exact fault codes/line numbers. Unit tests additionally compare full
closed facts, timestamps and identity tuples, pass emitted batches to the
unchanged collector, and prove the planted content/arguments/results/summary/
details/note text never appears in reader results or the numeric journal.
The fixed oversized fixture lowers the line cap to 512 bytes to exercise the
same bounded reader without a giant checked-in payload. Additional temporary
synthetic files exercise append, anchor changes, truncation, unreadability,
read/output/row/index/source limits, malformed diagnostics, timestamp precedence,
price conflicts, invalid identities and occurrence-window transitions.
The reader's unchanged `pi-recorded-1` facts measure copied history: gross
$0.41, deduplicated $0.19, with no test-side price promotion. Price fixtures
cover missing/zero/all-zero, exponent form, floating-point noise, half-even
parity/carry, explicit rounded zero, negative/non-finite/overwide totals,
unknown tokens and component-only costs. No production server imports the
module; a source-tree guard checks this.

Verification: assigned sealed unit test passed 19/19 (2026-10-20); full project
typecheck, targeted Oxlint (zero findings) and worktree build passed. The
unchanged normal gate runs through detached `wt land`; the first failed
receipt and isolated fix are recorded above, and a successful successor receipt
is required as the landing proof. No real-session, model, production-import, install or deploy
proof is claimed.
Undo is a revert of this inert module, its unit test, synthetic fixture directory
and this document; there is no runtime importer or deployed state to undo.
