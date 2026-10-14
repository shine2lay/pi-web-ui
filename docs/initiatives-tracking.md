# Initiatives tracking — inert IB1 / I1

This is the producer contract for Team in Temper, not an enabled page or a live source. `INITIATIVES_ENABLED` is literally false. All five native seams are false. Nothing outside tests imports `initiatives-registry.ts`; importing it performs no I/O. It does not read or modify an identity, queue, chat, lead setting, progress feed, model setting, budget, hold, pause, wake, stall or Project. No installation or migration accompanies this unit.

## Shared transport, unchanged Roles

IB1 consumes #136 commit `370f92e5` after its source-pin requalification. SPEC v2 SHA256 `225b47033e29c8f32a0be9f3c930672a830c333707f7e97411c33360366aa142` and its seven root definitions are unchanged. `RTPI_SCHEMA` still canonically encodes to 17020 bytes, SHA256 `ae8cd3793ec28d72586f45285e04eb65aea1a6902a89381a3b0b7ba68f6451ef`. Its canonicalizer, hash/dedup domains, validators, byte caps and Roles behavior remain on the old path. No Roles gate waits for I1.

Ops's rule-21 technical decision for #165 authorizes **inert extension dispatch**, not owner consent or activation. The file list widened only by `server/rtpi-core.ts`, `server/rtpi-journal.ts` and their tests. Link-only sidecars were refused because they would not store the immutable records. There is no second journal or runtime root/issuer registration.

`INITIATIVES_ROOTS` is a frozen compile-time table containing only:

| Wire schema                   | Type                    | Validator                                                                                    |
| ----------------------------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| `rtpi/initiative-execution/1` | `InitiativeExecutionV1` | closed `initiativeExecution` definition, semantic ref table, source binding                  |
| `rtpi/outcome-contract/1`     | `OutcomeContractV1`     | closed `outcomeContract` definition, semantic ref table, per-kind required set, exact target |

Unknown versions, arbitrary roots, malformed fields, extra fields, incorrect kinds and mixed namespaces fail closed. The common canonical transport counts **every nested ref**, not just an outer evidence array. Each whole canonical record including its envelope is at most 8192 bytes and 64 refs. A 65th ref or 8193rd byte rejects the entire record, never truncates it. The existing journal frame and segment limits still apply independently.

## Native facts, prospective only

Future native seeding may use only `decision_log add_initiative` and #85's owner `initiative_lead` action. The initiative ID is `team-in-temper`; the original registry ID, name and markers are referenced, not rewritten. Registry creation is not a start event. Descriptive filing text is not an approved goal. Unknown goal, lead, part, origin, start, finish commitment or coverage stays explicitly null/unknown. Membership and contributions need named native publication/assignment authority; no role-name or prose inference. Origin refs reuse Roles' independently versioned native facts. Lead changes are metadata only, never changes to a started plan, queue or gate.

The only constructor in IB1 is `createInitiativesFixtureIssuer`: an in-process, nonserializable **rtpi-fixture** logical capability. It snapshots a fixed registry seed, #85 lead action and exact hashes of named goal/member/contribution/start/finish/cause/outcome publications. A copied token, foreign publisher, wrong target, unnamed publication, forged completeness/outcome membership or native namespace is refused. It is not a native registry or an owner primitive. Every source append requires atomic source/outbox evidence; an absent source/outbox leaves the capture gap unknown. The tracking layer never repairs, retries, resends or controls the source.

## Closed reference table

`INITIATIVES_REF_KINDS` is the machine-readable closed table in `server/rtpi-schema.ts`. Both roots bind source→source, issuer→issuer, subject→subject, lineage→lineage and initiative→initiative. Whole references (namespace, kind, ID, revision) are compared; generic IDs do not qualify.

Execution binds registry/goal/lead/member/contribution/finish authority to operation refs; the owner's lead action also requires its receipt; members and contributions use role and origin refs; contributions use operation/run work and contract outcome refs; start uses a receipt. P03 uses typed subjects and receipts. Outcome contracts bind authority→operation, accepting issuer/verifiers→issuer, responsible/recipient/verifier actor→role or owner, artifact→artifact, handoffs→handoff, contribution→operation and immutable acceptance rules→contract. Null fields are unknown, not universal matches. Generic evidence refs contain no owner, issuer, client, challenge or policy authority.

### P03 causes (#87 stores, #89 reports)

These are native **reported causes**, not a new stall calculator or controller:

| Kind                            | Subject    | Additional required data                                      |
| ------------------------------- | ---------- | ------------------------------------------------------------- |
| `finished-task-not-acted-on`    | operation  | source receipt                                                |
| `blocked-only-on-done-tasks`    | operation  | source receipt, non-empty operation dependency refs           |
| `no-activity-for-n-hours`       | initiative | source receipt, known `since`, positive safe `thresholdHours` |
| `request-unanswered`            | request    | source receipt                                                |
| `chat-stopped-by-account-fault` | session    | source receipt                                                |
| `pause-reason-passed`           | operation  | source receipt                                                |
| `only-owner-can-unblock`        | operation  | source receipt                                                |
| `stall-check-silent`            | initiative | source receipt, known `since`, positive safe `thresholdHours` |

Unknown cause kinds are rejected. IB1 computes none of these from age, prose or an account check and sends no poke.

## Required contracts and acceptance

One issuer identity (`initiatives-required-contract-issuer`, revision `i1-v1`, source `initiatives-registry`) issues **Initiatives C7 only**. Its accepting issuer must be that exact whole ref. A second issuer, observer, model, role tool, client flag, design publication, delivery, reply or settlement is not contract acceptance.

Closed per-kind policies:

- software-delivery: built → independently checked → installed → live;
- artifact-acceptance: one independently checked business artifact, under its designated immutable rule;
- owner-confirmation: one explicit client-native artifact confirmation by the designated owner.

Every required slot is applicable, required and uniquely ordered; optional-only, empty, all-NA, duplicated and cyclic sets cannot complete. Required designations carry an immutable acceptance-rule ref/version, designated verifier issuer and actor, dependencies and independence relation. A check's verifier actor must differ from the responsible actor. The contract binds exact recipient, artifact ref and ArtifactKey (gitHead, assetsSha256, version, manifestRevision, targetEnvironment, environmentEpoch). The artifact ref ID is SHA256 of the canonical full ArtifactKey. No mutable `latest` rule is eligible.

`initiativesContractRef` is content-addressed: contract kind, SHA256 of the **whole immutable outcome record**, and its publication revision. A C7 gate receipt must carry that exact ref and exact artifact/recipient/verifier. An owner-confirmation receipt must also bind the full contract digest/revision in the action ref, exact rule/version in the policy ref and designated owner principal. A receipt cannot be rebound to another contract revision or hash. Accepted proofs are in-process immutable readbacks over authentic qualified RTPI receipts; the fixture-only constructor cannot issue native owner confirmation.

`initiativesOutcomeCompletion` resolves explicit immutable acceptance refs, not mutable latest. A copied/forged proof, missing resolver result, stale/expired receipt, mismatched contract/rule/recipient/artifact/verifier, conflict or missing required slot is never Done. Completed time is the maximum required acceptance time. A failed required gate is incomplete. Missing or conflicting coverage is unknown. Lead/member/report changes alone do not invalidate gates; contract, rule, recipient or artifact changes do.

## Publication CAS and recovery

`publicationRevision` and `revision` are equal positive safe integers; expectedRevision is a nonnegative safe integer and next revision is expected + 1. Zero, negative, fractional, string or 2^53 revisions reject. The existing journal serializes the expected-revision comparison with the append and fsyncs before acknowledgement. Conflicting same-key records reject; identical replay returns its first sequence. A stable Initiatives-only publication key (schema, namespace, initiative ID, object ID) preserves the high-water mark across lineage/source revision/incarnation rebinds. Recovery rebuilds these heads from the immutable journal before new writes; a gap or reused revision quarantines the journal. The old seven roots do not use this map or CAS path.

There is no recovery waiver or generic native authority in this unit. Native source/outbox reconciliation remains necessary before activation. Complete deletion/forgery by another same-UID process remains the accepted C01 display-only residual, not cryptographic protection or native proof.

## Retention

Execution and outcome retention policies are independent; there is no forced common expiry. Null policy means no deletion. Missing dates/invalid clocks show unknown, expired refs remain expired/unknown and cannot complete a gate. IB1 ships **no pruner**: even a durable checkpoint is not authority to delete revision heads or held/acknowledged/dedupe/live reference/source-outbox boundaries. Missing/unverifiable checkpoints block pruning under the shared predicate. Any later pruner requires its own approved domain policy and checkpoint/recovery proof. No automatic deletion or backfill.

## Verification and undo

Fixed schema/authority, gate and CAS/ceiling stages run on known cases, twice, before the full repo gate. Existing RTPI core/journal tests are unchanged old-code controls. A pinned #136-code comparison checks identical canonical bytes, hashes and validation on the old seven-root inputs. The unchanged #136 `CHECKS/check.py` must pass after source requalification, and Architecture reads back the additive diff against SPEC v2 plus the ref-kind table and issuer scope before landing. No native-live claim is made.

Undo: revert this additive commit with `wt`; no migration or live data to undo. No install is part of #165.
