# Task 1 transport and migration addendum

## Parent technical ruling: helper host discovery

Use the existing `Symbol.for("pi-web-ui.queue-host")` host, never a new global registry. `server/inbox-helper-host.ts` exports that symbol as `INBOX_HELPER_HOST_KEY`, the `InboxHelperRegistryHost` interface and `inboxHelperBinding(sessionId)`.

The contract is:

- Binding result: `{role,msgId,leaseId,epoch,homeChat}` from the host's live ledger authority, not an entry's claims.
- Undefined: no binding. A helper-marked entry then refuses `E_RPI_HELPER_ENTRY`; never ordinary-role fallback.
- Ended/superseded lease: throw an Error with `code: "E_RPI_STALE_LEASE"`.
- Unreadable authority: throw an Error with `code: "E_RPI_UNKNOWN"`.
- Seal has exactly `tools`, `toolSetSha`, `ceilingPolicySha`, `rolesConfigSha`. Tests use the existing pi-identity `specialists/canon.ts` primitives; no second hash formula or ceiling resolver.

The exported accessor is still inert (undefined); host instance methods explicitly throw unbuilt. No install/discovery side effect was added. New RED transport tests place a fixture on the existing symbol and require live binding/code propagation. Identity/OpenViking peer sa-48963350 received this exact contract. Their no-host tests remain independent and unchanged.

## Architecture ruling: RET-4 administration

Source: `/home/shinelay/architecture-dept/conventions/role-priority-inbox/migration-administration.md`, SHA256 `751f1416ffbcec7b1cd9e6e37b351f2d283e648e76a73432b230567c8c3ef0e0`. Tests verify this pin.

The new `server/inbox-migration.ts` is a type/entrypoint seam only:

- `InboxMigrationPlan` and `InboxMigrationProgress`: the exact separate `rpi-migration/1` plan, item and attempt shapes.
- `InboxMigrationPorts`: host-selected state root, the one `InboxRuntime`, role.
- `InboxMigration.run(signal?)`: explicit unbuilt error; an abort is specified as partial progress, never a reset or runtime quota.

Future files are `<stateRoot>/role-inbox-migration-v1/plan.json` and `progress.jsonl`, directory0700/files0600, trusted-root/no-follow handling. Plan frozen once, progress append-only, cursor from contiguous classified/refused prefix. Migration never changes message/lease/effect authority. No changes to the canonical inbox codec or its op enum.

## Assertions and evidence

`inbox-migration.test.ts` uses real RoleMessages/guard fixture storage and the new inert migration entrypoint, not a reference simulator. It pins:

1. Frozen plan excludes later arrivals; repeated calls append attempts but no duplicate item receipt.
2. Source content change appends a refusal without rewriting prior progress or replying.
3. Restart from the actual writer's durable item prefix (external crash-image truncation before attempt) resumes cursor1, with no duplicate classification.
4. External file-append abort injection yields partial progress; resume keeps the plan/prefix and finishes.
5. Unreadable actual message store produces UNKNOWN and no plan.
6. Unreadable administrative progress produces UNKNOWN, never absence-as-success.
7. Permissions, no message text in metadata, migration cannot answer a request; later canonical reply remains authoritative and does not change content hash.
8. Symlink administrative directory is refused without touching its target.
9. Unknown fields, numeric hash and boolean index fail closed without rewriting files.
10. Administrative rows are refused by the actual unchanged inbox decoder without throwing.

Command (only changed suites, after edits):

`./node_modules/.bin/vitest run --config acceptance/inbox-runtime/inbox.config.ts acceptance/inbox-runtime/inbox-host.test.ts acceptance/inbox-runtime/inbox-migration.test.ts`

2026-11-26 18:37:24: **25 tests, 23 RED / 2 GREEN**, 3.88s. Host: 12 RED (9 unbuilt host + 3 unimplemented transport forwarding), 1 GREEN no-host accessor. Migration: 11 RED at the unbuilt administration seam, 1 GREEN actual inbox-codec rejection. The runtime assertions after unbuilt calls are not claimed as enforced. Previous whole-suite receipt remains 77 tests, 38 RED /39 GREEN; adding these 15 cases yields an inventory of 92 cases, but no new full-suite execution is claimed.

`prettier --check server/inbox-runtime.ts server/inbox-helper-host.ts server/inbox-migration.ts`: PASS. `git diff --check`: PASS. Parent owns standard gates/typecheck. Source changes remain inactive, no live chat/model/payload inspection, no deploy/land.

## Blockers

No Architecture question remains for this seam. Parent reports Security #607 `rm-1ab7b1d6` as reference-only GO, never runtime/activation GO. Implementation and joined runtime proofs belong to the subsequent build/final-check tasks.
