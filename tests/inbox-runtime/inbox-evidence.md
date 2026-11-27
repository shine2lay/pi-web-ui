# Inbox Task 1 evidence history

## Run receipts

All dates are 2026-11-26. Commands below use the current test-only location; earlier runs preceded the physical move. No full-suite rerun is implied by a focused result.

| Time | Selection | Observed result |
|---|---|---|
| 18:05:14 | Initial runtime suite | 20 tests: 13 RED / 7 GREEN; 2.89s |
| 18:07:34 | Newly added #607 line-op cases only | 5 RED at unbuilt reader; 20 excluded; 1.72s |
| 18:17:42 | Expanded whole runtime suite | 77 tests: 38 RED / 39 GREEN; 13.58s |
| 18:37:24 | Changed host and migration suites | 25 tests: 23 RED / 2 GREEN; 3.88s |
| 18:45:06 | Pure requester-vector transport | 32 tests: 2 RED / 30 GREEN; 396ms |
| 19:08:28 | Canonical queue imports after queue worktree deletion | 2 expected RED / 31 GREEN; 7 excluded; 1.78s |

The later host/migration addition gives an inventory of 92 cases, not a new full-suite execution. The 25-test receipt comprises 12 host RED, 11 migration RED, a GREEN no-host accessor and GREEN administrative-row rejection by the actual inbox codec.

## Commands

Whole suite:

`./node_modules/.bin/vitest run --config tests/inbox-runtime/inbox.config.ts`

#607 selection adds `-t '#607'`.

Host/migration selection adds the two files:

`tests/inbox-runtime/inbox-host.test.ts`

`tests/inbox-runtime/inbox-migration.test.ts`

Requester-only selection adds `tests/inbox-runtime/inbox-requester.test.ts`.

Canonical transport selection adds requester and race files, then `-t 'U4 real|GREEN actual'`. The race file is `tests/inbox-runtime/inbox-races.test.ts`.

## Direct production-boundary evidence

These are contract projections or negative variants, not complete corpus-object replay.

| Anchor | Actual observation |
|---|---|
| C-DSEL-1 | Real Agent/mail hooks hand off 2 actionable rows rather than 1; RED |
| C-DP3-2 | Real note/boundary hooks hand off 23 passive rows rather than 20; RED |
| U12 | Preparing again without message_start returns no rows instead of the same two IDs; RED; not a durable process-restart proof |
| C-DP3-1 | Passive alone starts no turn; GREEN |
| C-HID-1/-3 variants | Web identity reader downgrades unbound or malformed helper entries to plain role; RED |
| C-DRET-2 projection | Actual save retains only 1000 of 1001 old delivered unanswered rows; RED |
| C-DRET-1 projection | Actual chain tombstone lacks closedBy; RED |
| C-DEFF-16 projection | Real guard outbox contains one accepted reply; original replyId is absent before handoff, then stable across two restarts; GREEN |
| Legacy repeat reply | Real guard/RoleMessages accept first reply and refuse the second; replyId unchanged; GREEN |
| Legacy native queue | Ordinary SDK follow-up keeps its native queue; GREEN |
| Legacy identity | Plain department/no-specialist identity and command permission unchanged; GREEN |
| Legacy launch | Actual startTaskChat preflight primitive accepts once without model call; GREEN |
| U4 | Both actual requester parsers consume the same 32 pure vectors: 2 valid helper forms RED, 30 GREEN |
| Canonical HOME queue control | Actual queue extension appends one ordinary journal task and replay sees it; GREEN |
| Administrative rejection | Actual unchanged inbox codec refuses separate migration rows without throwing; GREEN |

No captured model input or message payload was printed. Observations are metadata, IDs and counts.

## Pending-seam evidence

The following stop at explicit E_RPI_UNBUILT unless noted. Their later assertions are requirements, not proof of enforcement.

- C-DDONE-2: real delivered/no-reply facts are observed before claim fails; intended final state is open with null semantic receipt.
- C-READ-2 and #607 line-op/0..4: actual temporary ledger is malformed; intended result is UNKNOWN, no new claim, no guard send/replyId or ledger mutation.
- U11: HOME must skip a held acceptance lock rather than wait.
- C-HRACE-1 and three reply orderings: HOME supersede fences helper; actual guard must accept exactly one reply.
- C-HRACE-6, C-HRST-3, C-DDONE-10 and task concurrency: actual HOME command/journal must append once across retries/crashes; task still owes a reply; changed payload and later-lease task attempts conflict.
- C-DALM-1: three unanswered attempts yield one private metadata alarm without a retry ban. Viewing/recovery cannot clear it; accepted reply can.
- Audit: contiguous seq, private role access, no payload. The fixture creates 0600, so that particular audit test does not prove production creation mode.
- Helper host: admission/launch/ceiling/close interfaces remain unbuilt. Three transport tests additionally fail because the inert accessor does not yet forward installed live/stale/UNKNOWN host results.
- Migration: actual storage fixtures and crash-image wrapper are ready, but the administrative runner remains unbuilt.

## Cohort and standard checks

Queue 427c089 landed via request104-71dfda and its task worktree was removed. The 19:08:28 result verifies canonical sibling imports and actual HOME journal append after removal. It is not inbox implementation evidence.

Tests were moved physically into the recognized test tree after the fixture guard rejected their former location. No exemption, assertion weakening or default-suite expansion was added. Path resolution uses the host's common Git directory; the fixed queue vector pin is unchanged.

Production seam formatting and diff checks passed. Parent subsequently reported types/lint/affected tests, typecheck, Prettier and fast worktree checks passing. Final documentation cleanup does not rerun behavioral tests or change source/test bytes.

See [ownership](inbox-ownership.md), [hashes](inbox-hashes.md) and [migration/transport contract](inbox-migration-contract.md).
