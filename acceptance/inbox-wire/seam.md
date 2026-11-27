# Priority inbox — Task 1 ownership seam

## Status

Inert groundwork only; no install, runtime caller, model call or live inbox effect.
U602.1 is canonical. Architecture #607 strict-codec source/corpus pins consumed
from architecture-dept-inbox-boundary-607 (not the historical #602 root), per rm-20f54517.
Exact hashes are in pins.json. Security delta GO rm-1ab7b1d6 is reference-only;
implementation gates remain required. Successor 7/7 and historical 31/31 manifests verified.
The #602 baseline manifest is c8d277d114937642d116f8967852e7a53be66f08e934351774714de102fb004b.
No assertion may be weakened by a builder; coverage gaps are not runtime passes.

## Shared wire

`server/shared/inbox-wire.ts` is the only TypeScript item/ledger codec owner.
Exports: `decodeInboxView`, `decodeInboxLine`, `inboxClaimable`, `inboxNextDispatch`.
Decode inputs are unknown; success preserves the wire, failure returns E_RPI_SCHEMA.
Task 1 stubs fail closed and have no active callers. Delivery implements these exports.
Claimability and next-dispatch must also validate malformed inputs: false/null, never throw.
The reader propagates schema failure as UNKNOWN; it never guesses absent or terminal.
Types include InboxView, InboxLine, InboxEffect, InboxFence, InboxOutcome and InboxNeed.
No consumer may clone a priority reader, ledger replay or schema decoder.

## Disjoint source ownership

| Slice | Owns | Imports or calls; never copies |
|---|---|---|
| delivery (web) | canonical codec, inbox reader/ledger/coordinator, selection, passive cursor, completion, retention, migration, alarm projection; mail-boundary call sites | RoleMessages, board, ownTaskOf, queue card parser, guard receipts |
| helperhost (web) | inbox helper spawn/binding registry/seal launch/close, effect orchestration and queue ticket mint; helper identity host integration | delivery reader/ledger/coordinator/codec; guard host; queue ticket consumer |
| identity | helper first-entry binding and per-call seal/arguments, env/subagent ordering | existing canon/decide/narrowing/schema and tool-limit primitives; host binding |
| OV | helper identity and read-only department scope | existing entryIdentityFromCtx and zone resolver; host binding |
| queue | helper tool-add handoff, HOME ticket consume, journal opKey dedup and requester validator | ordinary HOME task creation path; host ticket; existing requester parser |

Delivery owns ledger writes. Helperhost may request effects only through that owner.
Queue owns task journal writes; helperhost never writes a task card itself.
RoleMessages owns message words and replyId; ledger owns metadata only.
Identity/OV/web exact helper-entry assertions must agree; queue/web requester assertions must agree.
Host discovery reuses Symbol.for('pi-web-ui.queue-host'); inboxHelperBinding(sessionId)
returns binding or undefined, or throws Error.code E_RPI_STALE_LEASE/E_RPI_UNKNOWN.
A helper-marked entry with no binding refuses E_RPI_HELPER_ENTRY, never falls back.
Seal keys: tools, toolSetSha, ceilingPolicySha, rolesConfigSha; existing hash primitives.
Existing specialist Phase 2 files remain separate: new source modules use inbox-* names.
Any shared existing call site must have one builder; agree its owner before parallel edits.

## Acceptance ownership

| Suite | Owner | Boundary |
|---|---|---|
| acceptance/inbox-wire/codec.acceptance.ts | delivery | canonical TypeScript codec; unchanged core views plus amended successor cases |
| acceptance/inbox-runtime/ | delivery + helperhost, disjoint test files | actual host/boundary/guard/ledger/RoleMessages observations |
| identity inbox acceptance | identity | actual resolveIdentity/tool_call path |
| OV inbox acceptance | OV | actual identity/scope boundary |
| queue inbox acceptance | queue | actual tool-add/requester/journal boundary |

Explicit RED suites remain outside standard defaults until builders wire them in.
RED counts are evidence of missing implementation, not a substitute for real-boundary coverage.
Test clocks, synthetic records and crash hooks belong only in external harnesses.
No model input or tool-result bodies are printed; evidence is ids/counts/hashes only.

## Frozen baseline and authorized removals

Core 90 is unchanged. Delivery 69/helper 120 include only U602.1 authorized changes.
The complete obsolete list is Architecture's unified-602-obsolete.md, not a local ruling.
Build deletes actionable batching expectations in role-mail-boundary and role-mail-restart;
Task 1 leaves current production and standard legacy tests untouched.
All unmentioned specialist, queue, identity and OV behavior stays frozen.

## Checks and handoff

Run the explicit acceptance commands recorded with each slice, then standard gates.
Hash assertions after all edits; builders retain those hashes and add tests separately.
Report exact land SHAs, exports, commands, RED results, GREEN controls and coverage gaps.
Install is a later joined cohort, never part of Task 1.
