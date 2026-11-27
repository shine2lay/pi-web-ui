# Ordinary HOME inbox delivery

## Scope

Ops1121 builds the first usable HOME increment from the Ops1132 seam.
It does not activate helpers or claim completion of the 279-case contract.
The existing role-message source and guard remain authoritative; no second source store.

- One actionable message per completed turn; passive packets stay bounded at twenty.
- Existing verified sender-task priority and source-time FIFO choose HOME order.
- Delivery is not an answer: unanswered requests retain their durable obligation.
- Each completed dispatch records an attempt. Three unanswered, aborted or crashed failures
  raise one alarm and stop self-generated continuations, without closing the obligation.
  Genuine independent events may retry; an already-running reply is not banned by the alarm.
  Native dispatch receipts distinguish replay from a new event; timestamps are not authority.
- Replies use the current-generation qualified guard operation identity. Accepted outbox
  operations await handoff; unknown history holds the intent instead of guessing absence.
- Definitive nonacceptance records a refusal and permits a new claim. A reused logical
  reply with different content is refused; an accepted reply returns its original receipt.
- Guard rotation stays held while any persisted inbox effect intent is unresolved.
- Source retention preserves unanswered obligations and ledger-pinned records above KEEP.
- The strict canonical rpi/1 codec validates all #607 boundary vectors and valid twins.

## Implementation

`server/inbox-home-host.ts` connects the role-mail boundary to the canonical runtime.
`server/inbox-runtime.ts` owns claim/reply/attempt/recovery coordination.
`server/inbox-coordination.ts` defines the shared keyed mutation port; the synchronous
current-claim query is read-only, never permission to skip the effect's locked fence recheck.
`server/inbox-ledger.ts` appends private metadata with contiguous sequence and fsync.
`server/inbox-native-dispatch.ts` reconciles native SessionManager dispatch intent/receipt
metadata with exact ledger leases. The two stores are not atomic; ambiguous epochs hold.
`server/role-messages-source.ts` is the single source decoder and retention-pin calculation.
`server/role-message-guard-inbox-receipt.ts` qualifies accepted/refused/absent/unknown receipts.
`server/shared/inbox-codec.ts` implements the codec reexported by `server/shared/inbox-wire.ts`.
There is no production fixture branch or helper activation.

## Owned and deferred evidence

Run the frozen replay accounting first, then the HOME evidence gate, with
`INBOX_EVIDENCE_DIR` pointing to the directory containing runtime-results.json and codec.tap:

- `node tests/inbox-runtime/inbox-replay-check.mjs`
- `node tests/inbox-runtime/inbox-home-check.mjs`

The second command writes home-phase-proof.json: an exact 279-row phase map plus every
runtime test's observed result and ownership. Missing evidence or a failing HOME-owned
assertion is an error; an inventory count alone is never a behavioral pass.

The integrated evidence gate measures 27 mapped contract cases and 74 executable
HOME-owned assertions, all passing. The other 252 mapped cases remain deferred/external.
Of 158 runtime assertions, 84 are outside HOME ownership. Twelve added HOME controls cover
Security F1/F2, the shared coordination fence and release projection. No deferred assertion
is claimed PASS for release coverage merely because a partial adapter happens to pass.
The nine preserved legacy controls and 329 codec tests are separate checks.

The four previously execution-linked cases C-DEFF-1, C-DEFF-2, C-DEFF-10 and C-DEFF-14
require actual helper claims/supersession and remain deferred, not weakened.
C-PRI-8's inherited guard-decision fixture omits required guard requestId/generation;
its source is refused by validation. Guard-decision integration is not ordinary HOME proof.
C-DRET-1 closed-row semantic tombstones remain deferred. RET-4 migration administration,
including the inherited ESM spy defect, remains deferred. Full board/owner/native queue
source admission, helper identity/transport/DNS/redirect constraints, full packet cursor
persistence and broader rotation recovery remain later increments.

## Regression controls

Frozen Task1120 assertions and maps are unchanged. Existing non-HOME restart tests now
explicitly select the retained legacy boundary. Obsolete pressure-pruning fixtures were
corrected to valid terminal source rows: open unanswered requests must no longer prune.
File/memory persistence parity and the original first-write golden remain checked; obsolete
post-pruning byte/log goldens were replaced by explicit retained-obligation/restart assertions.

## Release and rollback

This task lands only. Ops1126 owns installation and independent deployment evidence through
pi-web-deploy. No live chat tests, browser interaction or model calls were used here.
Do not enable the helper host with this release. Reverting the HOME wiring/code requires
normal worktree/land controls; keep persisted source and ledger files intact for recovery.
Preland requirements remain typecheck, formatting, sealed standard gate, wt check,
doc-check and Security diff GO. The evidence handoff records their actual outcomes.
