# Priority inbox Task 1: runtime acceptance slice (partial)

## Hypothesis and result

Before edits: today's real mail boundary drains a batch and consumes pending rows at preparation, not landing. Today's RoleMessages prune may evict delivered unanswered rows. New opt-in assertions should fail on those actual paths, without activation; a failure only in a new stub does not establish the corresponding runtime defect.

Observed: 20 tests, 13 RED / 7 GREEN in 2.89 seconds. Seven RED tests reach existing production boundaries; six stop at the explicitly unbuilt runtime seam. This is NOT full core90/delivery69/helper120 coverage or a Task 1 completion receipt.

## Command and isolation

From the worktree: `./node_modules/.bin/vitest run --config acceptance/inbox-runtime/inbox.config.ts` (exit 1 expected). Initial 20 tests run once after source edits, 2026-11-26, reported start 18:05:14. Ten workers; inherits the normal temp-directory setup. Default unit suite remains unchanged and excludes this directory. No model invocation, live chat, server startup or request/payload dump; only local fixed fixtures and counts/ids are observed. Standard gates/typecheck are delegated to the parent as requested.

## Pins (read-only Architecture source, not a copied interpreter)

`inbox-corpora.ts` loads the actual files under `/home/shinelay/architecture-dept/tests/role-priority-inbox/`, checks exact bytes, counts and unique IDs, and resolves referenced IDs. This inventory check is not semantic coverage of all cases.

| Corpus | Count | SHA256 |
|---|---:|---|
| role-priority-inbox.cases.json | 90 | a93ee55478be95282bca124e31400e419035fe016e497995b828585e2242d7b1 |
| delivery/delivery.cases.json | 69 | 1aabea2f3198645e613beb47d66053e3085640a15003e71a62c28df037bdd059 |
| helpers/helper.cases.json | 120 | aabc75c5342fe85d6a3efefebb0ebd3546b9ed54ca78c95b3e6e5eec66fab81b |

Parent #602 manifest pin: c8d277d114937642d116f8967852e7a53be66f08e934351774714de102fb004b. #607 strict amendment remains parent-owned. After the initial run, the parent supplied final boundary607 sha f9e68ff62ee5189055c865779fe0ee6dd63ab842b8714835dbcdbd30e19df0a1. Its BOUNDARY.md was read and five line-op negative values added against a claim envelope in the actual ledger file. `vitest run --config acceptance/inbox-runtime/inbox.config.ts -t '#607'` ran only those new tests at 18:07:34: 5 RED at E_RPI_UNBUILT, 20 excluded by filter, 1.72s. They require UNKNOWN, no claim, no guard send/replyId, unchanged ledger; they do not yet reach those assertions. Aggregate evidence: 25 tests, 18 RED (7 actual boundaries + 11 pending seam), 7 GREEN across these two runs. Security delta pending, not GO.

## Direct existing-boundary observations

These are named contract projections/negative variants, NOT complete replay of each corpus object's input or all its expected fields.

| Case anchor / assertion | Actual boundary | Result |
|---|---|---|
| C-DSEL-1 one actionable projection | installRoleMailBoundary / real Agent hooks | RED: 2 rather than 1; priority/board ordering not covered |
| C-DP3-2 twenty-notice projection | noteAtRoleMailBoundary + prepare hook | RED: 23 rather than 20; board cut/overflow text and durable cursor not covered |
| U12 interrupted preparation, C-DP3-2 anchor | prepare hook called without message_start | RED: next preparation has 0 rather than same 2 IDs; not a process-restart/durable packet-id proof |
| C-DP3-1 passive no-wake projection | real mail hook | GREEN |
| C-HID-1 unbound valid-shape negative variant | identityOfEntry | RED: helper degrades to role; full registry binding absent |
| C-HID-3 malformed-flat-entry negative variant | identityOfEntry | RED: helper degrades to role; second-entry sticky rule not tested |
| C-DRET-2 open-row retention projection | actual RoleMessages.save with 1001 old delivered unanswered rows | RED: only 1000 retained; corpus's 1600-row mixture not replayed |
| C-DRET-1 semantic tombstone projection | actual save + chain-memory file | RED: closedBy undefined; tombstone fields and privacy assertions remain after that failure |
| C-DEFF-16 guard/handoff/restart projection | actual RoleMessageGuardHost + GuardFileStore + RoleMessages | GREEN: one accepted outbox reply, original replyId absent before handoff, same replyId after two restarts, one outbox reply; ledger recovery/claimability not yet tested |
| No-helper repeat reply control | actual guard + RoleMessages validator | GREEN: first accepted, second refused, replyId unchanged |
| No-helper ordinary follow-up control | real Agent native queue | GREEN |
| No-helper/no-specialist identity control | identityOfEntry + identityCommandRefusal | GREEN |
| Legacy launch primitive control | real startTaskChat preflight hooks | GREEN; not helper spawn proof |
| Corpus inventory | pinned files | GREEN; not behavioral coverage |

## Pending seam assertions (RED at E_RPI_UNBUILT)

`server/inbox-runtime.ts` exports `InboxRuntime`, `InboxRuntimePorts`, `InboxRead`, `InboxClaim`, `InboxClaimResult`. The constructor captures real message-store/guard/file/clock ports only. Methods `read`, `claim`, `end`, `recover`, `reply`, `run`, `audit` explicitly throw; no running host imports this module. Wire types are imported from the parent's canonical codec, never copied. `run` must be the SAME key coordinator used by acceptance/claim, not an alternate test lock.

| Anchor | Intended assertion | Current reach |
|---|---|---|
| C-DDONE-2 | delivered and turn-ended remains open, semantic receipt null | real delivered/no-reply facts observed; stops at claim |
| C-READ-2 | torn ledger is UNKNOWN, no new claim | actual file torn; stops at read |
| #607 line-op/0..4 | schema refusal propagates UNKNOWN, no claim/effect or ledger mutation | five pinned malformed operation values in real ledger file; stops at read |
| U11 / C-DEFF-16 | HOME skips held local acceptance lock | stops at run |
| C-HRACE-1 | HOME supersede fences helper before guard writes | stops at claim |
| C-DALM-1 | 3 attempts => one metadata alarm, next event still claimable | stops at claim; no UI assertion |
| IH6 / IH10 | contiguous seq, 0600, no payload, department privacy | stops at claim; fixture creates 0600, so production creation mode is NOT proved |

## Ownership and outstanding work

- Parent: canonical `server/shared/inbox-wire.ts`, `acceptance/inbox-wire/`, strict #607 codec, standard gates. This slice never edits those paths.
- Delivery builder: real reader/ledger/coordinator, production boundary connection, durable packet/cursor/recovery, whole-source UNKNOWN, attempts/alarm projection, source retention integration. Replace inert methods, not the assertions.
- Helper-host builder: actual launch registry/seal, shared admission slot counter, spawn-before-prompt and close/archive host paths; no implementation or complete host acceptance seam supplied here.
- pi-identity owner: real ceiling/schema dispatch tests including retained narrowing; no duplicated policy in this repo.
- pi-queue owner: actual HOME ticket/journal acceptance and exactly-one task/reply crash-race tests. This slice has no task acceptance test; a fake journal simulator would not satisfy that boundary.
- Migration: pending Architecture ruling requested by parent as rm-7c12cf78. D4 RET-4's migrate:<id>/cursor does not have a specified U602.1 opcode. No opcode invented, no migration pass claimed.
- Still missing: full per-ID adapters for the 279 cases, P0/native queue-card suppression, all crash points, task/reply concurrency races, guard generation rotation with pending inbox intents, helper ceiling/spawn/close, migration, UI alarm privacy/clearing, full retention/history reconciliation. These are coverage gaps, not successes or inferred GREENs.

## Assertion file hashes

| File | SHA256 |
|---|---|
| inbox-boundary.test.ts | 42e19dce2de91f04c98d59c4fdd87e773072f93180ce885f72a07fe93ddbfa7b |
| inbox-helper.test.ts | bc4bcc6a094bdfa276b98cdebf1c7ceb32b8fb43a2b1c094bc446309de80d0d7 |
| inbox-ledger.test.ts | 47a3a9c897720ab5db1c33d026fc15ac635ff80c5062dbc7b2232cc46b758bcc |
| inbox-retention.test.ts | ff1b5b297379dd97cfb13cc20c270785651e010d920c58c317ec64431ad26e59 |
| inbox-corpora.ts | 678452aa88c50d15f4f5060e6c9397fff3995b5d6d6c23546ed8c218475193ea |
| ../../server/inbox-runtime.ts | 87d8be22d074985999779b57e1867eba037f88ac775ec12bf6cd92c1707cd36d |
