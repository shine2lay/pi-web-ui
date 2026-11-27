# Priority inbox Task 1: runtime acceptance seams

## Hypothesis and result

Before edits: today's real mail boundary drains a batch and consumes pending rows at preparation, not landing. Today's RoleMessages prune may evict delivered unanswered rows. New opt-in assertions should fail on those actual paths, without activation; a failure only in a new stub does not establish the corresponding runtime defect.

Initial observation: 20 tests, 13 RED / 7 GREEN in 2.89 seconds. Continuation at the parent's request added actual requester parity, guard/HOME journal crash-races, helper host/binding/ceiling/close interfaces and alarm projections. Latest whole-suite run: **77 tests, 38 RED / 39 GREEN**, 13.58 seconds, 2026-11-26 18:17:42. Of the 38 RED, 9 reach existing production behavior (7 original plus 2 real web requester rejects); 29 stop at explicitly unbuilt runtime/host seams. These are named contract projections, NOT full replay of all 279 corpus cases.

The later transport/migration ruling, 25-test changed-suite receipt, exact interfaces and remaining-blocker status are in [inbox-migration-contract.md](inbox-migration-contract.md). It supersedes the earlier pending-ruling notes below; no full-suite rerun is claimed.

## Physical test-only placement and dependency order

The suite was moved with editor MV operations into `tests/inbox-runtime/` after the fixture guard rejected `acceptance/` as production scope. No exemption or default-suite expansion was added. Assertion semantics stay unchanged; commands below use the new location (historical runs preceded this path-only relocation).

`inbox-repo-roots.ts` resolves the host repository's canonical common git directory, then canonical siblings `pi-queue` and `pi-identity`. Runtime imports and requester source pin use that resolver; no task worktree dependency or fallback remains. Queue's pure vectors/fixtures must land in canonical pi-queue BEFORE this web suite is run after land. Its earlier task-worktree test results do not prove that installation order has happened. Parent owns final gates; no behavioral suite repeated for this relocation. Read-only root verification resolved `/home/shinelay/projects/pi-web-ui/.git`, hence siblings under `/home/shinelay/projects/`. At this checkpoint canonical queue vectors/fixtures were NOT yet landed; identity's canonical hash primitive was present. The existing explicitly supplied #607 Architecture corpus remains externally pinned at its delivery root; the parent owns final contract-source retention.

## Command and isolation

From the worktree: `./node_modules/.bin/vitest run --config tests/inbox-runtime/inbox.config.ts` (exit 1 expected). Initial 20 tests run once after source edits, 2026-11-26, reported start 18:05:14. Ten workers; inherits the normal temp-directory setup. Default unit suite remains unchanged and excludes this directory. No model invocation, live chat, server startup or request/payload dump; only local fixed fixtures and counts/ids are observed. Standard gates/typecheck are delegated to the parent as requested.

## Pins (read-only Architecture source, not a copied interpreter)

`inbox-corpora.ts` loads the actual files under `/home/shinelay/architecture-dept/tests/role-priority-inbox/`, checks exact bytes, counts and unique IDs, and resolves referenced IDs. This inventory check is not semantic coverage of all cases.

| Corpus | Count | SHA256 |
|---|---:|---|
| role-priority-inbox.cases.json | 90 | a93ee55478be95282bca124e31400e419035fe016e497995b828585e2242d7b1 |
| delivery/delivery.cases.json | 69 | 1aabea2f3198645e613beb47d66053e3085640a15003e71a62c28df037bdd059 |
| helpers/helper.cases.json | 120 | aabc75c5342fe85d6a3efefebb0ebd3546b9ed54ca78c95b3e6e5eec66fab81b |

Parent #602 manifest pin: c8d277d114937642d116f8967852e7a53be66f08e934351774714de102fb004b. #607 strict amendment remains parent-owned. After the initial run, the parent supplied final boundary607 sha f9e68ff62ee5189055c865779fe0ee6dd63ab842b8714835dbcdbd30e19df0a1. Its BOUNDARY.md was read and five line-op negative values added against a claim envelope in the actual ledger file. `vitest run --config tests/inbox-runtime/inbox.config.ts -t '#607'` ran only those new tests at 18:07:34: 5 RED at E_RPI_UNBUILT, 20 excluded by filter, 1.72s. They require UNKNOWN, no claim, no guard send/replyId, unchanged ledger; they do not yet reach those assertions. Aggregate evidence: 25 tests, 18 RED (7 actual boundaries + 11 pending seam), 7 GREEN across these two runs. Security delta pending, not GO.

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

- Parent: canonical `server/shared/inbox-wire.ts`, `tests/inbox-wire/`, strict #607 codec, standard gates. This slice never edits those paths.
- Delivery builder: real reader/ledger/coordinator, production boundary connection, durable packet/cursor/recovery, whole-source UNKNOWN, attempts/alarm projection, source retention integration. Replace inert methods, not the assertions.
- Helper-host builder: `server/inbox-helper-host.ts` now exports `inboxHelperBinding(sessionId): InboxHelperBinding | undefined` (inert global accessor returns undefined), `InboxHelperHost` (inert instance methods), and typed allocation/seal/decision/launch/journal/working/close/archive ports. H1's exact nested binding uses role/msgId/leaseId/epoch/homeChat, matching queue's contract. Identity and OpenViking consume this accessor; absence must fail closed for helper entries. No live registry is installed. `inbox-host.test.ts` asserts claim-before-launch and three first entries, K=3 concurrent admission, idle no-spawn, spawn failure release+attempt, canonical ceiling decisions before dispatch, working-chat no-close, failed close retry+archive, release to HOME. The close port calls real `runQueueCloseChat`; only clients/chats are fixtures. Runtime lookup/admission is still RED, not proved.
- pi-identity owner: real ceiling/schema dispatch tests including retained narrowing; no duplicated policy in this repo.
- pi-queue owner: ordinary HOME command/journal acceptance remains canonical. Web now uses queue's existing `tests/inbox-helper-fixture.ts`, real extension command and real queue replay through `InboxQueuePort.accept/find`; no journal or policy simulator. `inbox-races.test.ts` asserts 3 reply/HOME orderings, task-then-reply, before/after-append crashes, idempotent restart, concurrent task calls, changed-payload conflict and later-lease conflict with exactly one disk add/outbox reply. They stop at unbuilt claims; the ordinary HOME add control reaches the actual queue and passes. `inbox-requester.test.ts` imports queue's pure `tests/inbox-requester-vectors.ts` (queue commit 427c089), pinned SHA256 69100f10ba641e89da39edc7cd6e189f8b182e791062e562cfd770bf0c18430a. No node:test import or mock remains. It invokes both actual requester validators and envelopes with all 32 unchanged vectors: 2 RED valid helper forms, 30 GREEN. No copied requester parser or vector list. Focused rerun 2026-11-26 18:45:06: 32 tests, 2 RED/30 GREEN, 396ms; Prettier check PASS after whitespace-only formatting.
- Migration ruling received: `migration-administration.md`, sha751f1416ffbcec7b1cd9e6e37b351f2d283e648e76a73432b230567c8c3ef0e0, Architecture rm-05a1d9bf. `server/inbox-migration.ts` now pins the separate rpi-migration/1 administrative plan/progress contract; migrate:<id> is a progress key, never an inbox opcode. Inert `InboxMigration.run(signal?)` uses the existing runtime reader and host-selected trusted state root; no activation or second hash formula.
- `InboxRuntime` now additionally exposes task acceptance and metadata alarm projection; `InboxTaskIntent/Result` match the queue grant/result shapes. Tests pass the actual HOME journal adapter, not a fake acceptance function. `inbox-alarm.test.ts` asserts department/owner visibility, metadata-only fields, repeated-view/recovery stability, accepted-reply clearing and UNKNOWN projection. UI DOM implementation remains outside this slice.
- Architecture-only blockers: none remain for this seam. RET-4 is clarified, and the parent reports #607 Security GO rm-1ab7b1d6 is reference-only, not runtime or activation approval.
- Evidence limits: full per-ID replay of the 279 cases, all native queue-card/P0 combinations and guard rotation schedules are not claimed. Ceiling tests here prove the host delegation interface, not the pi-identity resolver itself (owned/tested there). All unbuilt-method failures are expected Task 1 RED, not successful runtime proofs. Production remains unchanged.

## Assertion file hashes

| File | SHA256 |
|---|---|
| inbox-boundary.test.ts | 42e19dce2de91f04c98d59c4fdd87e773072f93180ce885f72a07fe93ddbfa7b |
| inbox-helper.test.ts | bc4bcc6a094bdfa276b98cdebf1c7ceb32b8fb43a2b1c094bc446309de80d0d7 |
| inbox-ledger.test.ts | cea61906aac8b235bb7f54b50a5f038eff19f1e5d1832dbd507a8d2c6163f93d |
| inbox-retention.test.ts | ff1b5b297379dd97cfb13cc20c270785651e010d920c58c317ec64431ad26e59 |
| inbox-corpora.ts | 678452aa88c50d15f4f5060e6c9397fff3995b5d6d6c23546ed8c218475193ea |
| inbox.config.ts | ac8243eb5841d3a678a6b781b4ed0f4af917b0247b2ce93496d271e4c9192443 |
| inbox-repo-roots.ts | f9bfd9f428683d1add90ff43c4384af43c3f9fd5ad7ab93209ef93ad4ea85dda |
| inbox-queue-fixture.ts | c7d663278695c35810192178ac6d384128163104b261c8e83ae85d9de9acadbf |
| inbox-world.ts | 76f92b4554bdd60d51502545f965f66c7126480e249862b937bb262ffdf0d532 |
| inbox-alarm.test.ts | 80bc96eec77d4f206f3d74f885282940e4b71f01b35fe6de15042f5958086882 |
| inbox-host.test.ts | e05158d86efec683ad2317233a51eaa304c8caec8362dfcf31a005b444a67d7c |
| inbox-migration.test.ts | e9e9ac4ed2c2a5d8eff15e138b2b90822ad721ea2de8d5478cd92ce4ace9cd0f |
| inbox-races.test.ts | 2367b7fa4c083e94948f66a84678ae9153f3e93ade01333474403aa499aa7ae3 |
| inbox-requester.test.ts | d662d76b1812d21b8da7b92b108a65f560591c476a5eaa6e7d74cdd4952c8c00 |
| ../../server/inbox-runtime.ts | 7cdfece34d0e581142210d967e7997c2dd631f67417fa154638023c48c3d9764 |
| ../../server/inbox-helper-host.ts | 93bf93a6b25752429565f5d1a66e6cea57feb9a3c686eab38b2c105feef653c7 |
| ../../server/inbox-migration.ts | 2d514c2fa43ce67c8059630cea055a44698011249d53d67f9f3c48dd6e3c19d6 |

Production seam formatting: `prettier --check server/inbox-runtime.ts server/inbox-helper-host.ts` PASS. `git diff --check` PASS. Parent owns remaining standard gates/typecheck. Only explicit paths staged/committed; no deploy/land.
