# HOME acceptance increment

## Scope

Ops task1132 lead ruling under Rule42 replaces the full279 first-release gate with
ordinary role-message HOME reader, claim, reply, attempts, verified sender-task P0
and passive behavior. No activation or deployment. Every original Task1120
assertion remains byte-identical. Helpers are a later increment.

## Minimal API

Only additive source seam: InboxRuntimePorts.senderTask(file), returning the
existing ownTaskOf binding and taskQueueAll projection. Undefined means a
qualified non-worker; unreadable metadata throws. Tests construct native queue
journals and invoke those existing readers before providing their results.
No new priority parser, policy implementation or fixture branch was added.

## Actual checks

Opt-in runtime: 140 tests, 44 pass, 96 RED; all9 named legacy controls GREEN.
Codec: 329 tests, 261 pass, 68 RED, including232 strict vectors and47 twins.
Typecheck exits0. RED is expected for inert interfaces; not runtime enforcement.
One inherited RET4 abort test fails in its harness: ESM appendFileSync cannot
be spied on. It is preserved, reported, and deferred, not counted as migration proof.
Other RED causes: unbuilt methods, actionable batching, passive overflow/lost
unlanded packet, identity fallback, requester validation, and retention.

## Coverage and deferrals

The three maps account for all279 IDs, not full behavioral coverage. Verified
execution linkage: core24 and delivery7 named adapters. Core54 and delivery62
are deferred or partial; core12 are external. Helper84 deferred,36 external.
Existing P3 tests separately prove current RED at cap20/overflow and unlanded
packet replay; passive alone does not wake (GREEN). Durable cursor and complete
P3 corpus replay remain deferred. Helper replay draft is not an active test and
is not reviewed coverage; its map's behavioral labels are superseded by the
phase verifier's explicit deferral.

Full receipt, per-ID output and immutable hashes:
/home/shinelay/ops-checks/priority-inbox-1132/coverage-verification.json
/home/shinelay/ops-checks/priority-inbox-1132/assertions.sha256

Run tests/inbox-runtime/inbox-replay-check.mjs after the explicit runtime and
codec runs. It fails on missing executed assertions, changed original bytes,
missing corpus IDs, or failing legacy controls. Its complete flag means the
HOME acceptance packet is accounted for, never all279 behavior implemented.

## Later increments

Board/native queue/owner source integration, complete selection/cursor replay,
helper transport/MF1 DNS redirects, recorded-call recovery and guard rotation
remain owed. Builders1121 (HOME) and1125 (helpers later) retain original assertions;
none may relabel a missing boundary as a passing implementation.
