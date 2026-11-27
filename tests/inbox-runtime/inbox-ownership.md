# Priority inbox Task 1: ownership

## Scope and hypothesis

The real mail boundary batches actionable messages and removes pending rows before landing; RoleMessages can prune delivered unanswered requests. Opt-in assertions expose those defects without activating a new runtime. Failure at an unbuilt seam is not evidence of runtime enforcement.

This deliverable contains inactive typed seams and named contract projections, not full replay of all 279 corpus cases. No model calls, live chats, payload inspection, deployment or activation occurred.

## Evidence

- [Historical runs and coverage](inbox-evidence.md)
- [Immutable corpus and assertion hashes](inbox-hashes.md)
- [Helper transport and migration contract](inbox-migration-contract.md)

Latest whole-suite receipt: 77 tests, 38 RED / 39 GREEN. Nine failures reach existing production behavior; 29 stop at unbuilt seams. Later focused receipts are recorded separately, not presented as another full-suite run.

## Placement and dependencies

Tests live physically in `tests/inbox-runtime/`; default Vitest still includes only `tests/unit`. No fixture-guard exemption was added. Run explicitly:

`./node_modules/.bin/vitest run --config tests/inbox-runtime/inbox.config.ts`

The test-only root resolver uses the host repository's common Git directory to locate canonical sibling repositories. It has no task-worktree fallback. Queue commit 427c089 is landed and its worktree removed. Canonical queue imports were subsequently verified.

Shared queue assets:

- `/home/shinelay/projects/pi-queue/tests/inbox-helper-fixture.ts`
- `/home/shinelay/projects/pi-queue/tests/inbox-requester-vectors.ts`

Identity hash primitives: `/home/shinelay/projects/pi-identity/specialists/canon.ts`.

Architecture corpora remain externally pinned at their supplied delivery roots. The parent owns final contract-source retention.

## Ownership map

| Owner | Deliverable and boundary |
|---|---|
| Parent | Canonical `server/shared/inbox-wire.ts`, `tests/inbox-wire/`, strict #607 codec and final standard gates; untouched by this slice |
| Delivery builder | `server/inbox-runtime.ts`: single source reader, ledger, coordinator, claims, reply/task acceptance, recovery and metadata alarm projection |
| Helper-host builder | `server/inbox-helper-host.ts`: binding, seal, admission, launch, per-call decisions, release, close/archive |
| Migration builder | `server/inbox-migration.ts`: separate administrative frozen plan and append-only progress; never inbox authority |
| pi-identity | Canonical ceiling/schema decisions and retained narrowing; no duplicated resolver here |
| pi-queue | Ordinary HOME command/journal acceptance and requester validators; web tests reuse the actual queue fixture, replay and pure vectors |
| Identity/OpenViking consumers | Exact host binding transport and fail-closed helper identity handling |

## Export contracts

InboxRuntime captures real message-store, guard, file and clock ports. Its read/claim/end/recover/reply/task/run/audit/alarm methods are explicitly unbuilt. The same key coordinator must protect both claims and local acceptance; no alternate test lock.

InboxQueuePort supplies actual HOME acceptance and qualified journal lookup. InboxTaskIntent/Result match queue's grant/result shape. A task is progress, never a semantic answer.

InboxHelperHost supplies allocation/seal/decision/launch/journal/working/close/archive ports. The global binding accessor remains inert. Future discovery uses the existing queue-host symbol, preserving distinct absent/stale/UNKNOWN outcomes. Exact details are in the linked contract.

InboxMigration supplies the host-selected state root, existing runtime reader and role. Its runner is inert. RET-4 uses separate rpi-migration/1 metadata; migrate:id is a progress key, never a new inbox opcode or hash formula.

## Acceptance coverage

- Existing boundaries: actionable batch, passive cap and landing, identity fallback, actual prune/tombstones, guard handoff/restart and requester validation.
- Pending seams: UNKNOWN aggregation, receipts, key-lock skip, stale fencing, exactly-one task/reply races, alarm projection and privacy.
- Helper interfaces: claim and entries before launch, concurrent K=3 admission, idle no-spawn, spawn failure, canonical decision delegation, working-chat no-close and close retry/archive.
- Migration interfaces: frozen-plan growth/replay, changed hash, crash prefix, partial abort, unreadable sources/progress, permissions, symlink refusal, metadata-only storage and unchanged reply authority.

The close adapter calls the actual queue close lane; the task adapter calls the actual HOME command and journal. Fake clocks/chats are external fixtures. Ceiling tests here check host delegation, not the separately owned resolver. UI DOM implementation is outside this slice.

## Limits and handoff

No Architecture question remains. Security #607 GO rm-1ab7b1d6 is reference-only, never runtime/activation approval. Full per-ID replay, every P0/native-card combination and every guard-rotation schedule are not claimed. Builders must implement seams without weakening assertions.

Parent reports standard types/lint/affected tests, typecheck, Prettier and fast worktree checks passing. This final cleanup changes documentation only; source/test hashes remain unchanged. Parent owns final checks and landing.
