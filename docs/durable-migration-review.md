# Durable migrator review repair (Ops #573)

Accountable lead: Ops. Scope: the offline migrator and synthetic tests only. No real conversion, runtime activation, deployment or source-file edits.

## Hypothesis H-MIGRATION-PARITY-1

Independent review of `8ab1aa1e` found that `projectContext` feeds ACP transport-fold compactions to the native projector, `loadSnapshot` never inherits parent ACP, UUID checking only searches the incoming workspace database, and title lookup walks only the selected branch. Legacy ACP unfolds transport folds while preserving genuine native compactions; `SessionStateStore.load` inherits nonempty parent-sidecar state when a child's blocks are absent/empty; `SessionManager.getSessionName` reads the latest file-wide session-info entry, trims it, and treats an empty/missing name as clearing.

Change: normalize only the active projection (never the raw archive), resolve inherited state solely from the declared offline source snapshot, and preflight global manifest/database identity and every source before publishing any session. Read titles with the legacy file-wide rule.

Expected measurement: independently authored tiny fixture regressions assert exact active message order, raw entry identity, inherited blocks/refs, title clearing, global UUID/workspace/conversation identity, append/restart behavior and recovery after a DB commit but before manifest publication. The same suite must expose the reviewed defects against a pinned old implementation. Missing necessary parent data and conflicting identities must leave mappings and conversations unchanged. Native compaction and legitimate empty parent state must still work.

Falsification: any reviewed old-code case that does not reproduce is reported rather than patched speculatively; any new context/ref loss, altered raw input, ambiguous parent resolution, accepted identity collision, partial publication on a preflight refusal, or broken idempotence/recovery disproves the repair.

Result: HIT in sealed synthetic checks: all 32 independent cases pass; the identical suite against the pinned `8ab1aa1e` migrator has 25 expected failures and 7 positive-control passes. All three P1 findings and the file-wide title P2 reproduce. The original suite also passes (20 cases, 1 optional real-copy case intentionally skipped). Build, all typechecks and lint pass. Final normal detached full-gate/landing evidence is returned in the task receipt; these offline results authorize no real conversion or deployment.

### H-MIGRATION-FORK-PRESENCE-2

Follow-up independent source review found that an inherited active parent block covering only history beyond the child's fork point is inserted at position zero, although legacy `syncBlocks` disables absent, consumed and expanded blocks before pruning. The same stale observation can survive a genuine native compaction that removes all its coverage.

Change: apply those logical block-presence/consumption/expansion rules to active-context selection only. Keep original sidecar blocks/flags/refs archival and unchanged; `activeBlocks` counts observations actually materialized in the active window. Older embedded range-only records retain their explicit inactive flag without attempting to resolve now-absent historical boundaries. Expected: a fork excludes parent-only observations, native compaction excludes fully summarized ACP coverage, and legitimate present observations remain. Falsified by any injected absent observation, lost present observation, changed raw state or legacy refs. Independent old-code controls are required; source-only evidence is not claimed as executed proof.

Result: HIT. The native-compaction absence case fails against old code (`activeBlocks: 1` instead of `0`) and passes with preserved raw blocks/refs after repair. The inherited beyond-fork case passes after repair; against old code it fails earlier because parent blocks were never inherited, so it is not claimed as an old-code fork-injection reproduction. The inactive historical-range positive control passes both implementations.

### H-MIGRATION-RAW-PREFLIGHT-3

The same review identified an off-branch message missing its `message` payload: active projection never touches it, but archival conversion throws after an earlier session may already have committed.

Change: run the same archival message conversion for every raw entry in the preflight snapshot pass, with an explicit malformed-message refusal. Expected: the authored off-branch case refuses before any target conversation, entry, document or manifest changes. Falsified by partial publication, source mutation, or rejection of legitimate supported archived messages.

Result: HIT. Old code rejects the malformed message only after creating a database/conversation for the earlier valid source. Repaired code rejects it in preflight with byte-identical inputs and no change to the target publication snapshot.

### Independent oracle audit

The first independent test draft incorrectly expected an empty terminal parent's refs to be inherited. Legacy `loadParentState` inherits only when a parent has nonempty blocks, otherwise the child's own/default state remains. That assertion was corrected from legacy source before test execution; no production change was made to satisfy it. Empty-parent cases are positive controls, not claimed old-code defects. The title cases also cover a latest file-wide session-info entry with its name missing.

## Offline parent contract

The migrator never follows a `parentSession` reference into live storage. Exact paths already in `sourceDir` and relative paths resolving to a listed offline JSONL file are eligible. For a copied snapshot retaining original absolute parent references, callers can explicitly supply `MigrationOptions.parentSessionMap`, mapping the original header reference to an offline file (absolute or relative to `sourceDir`). Values must name files already in the enumerated snapshot. No filename-only guessing and no rewriting of source headers/legacy refs.

A missing child's sidecar, or one with no blocks, may inherit a nonempty ancestor sidecar. Empty intermediate sidecars continue the chain. Cycles, missing/ambiguous parent mappings, malformed sidecars and an unresolved terminal parent sidecar are explicit refusals. An explicitly empty terminal parent is valid proof of an uncompressed lineage; child state remains empty. Child-owned nonempty state takes precedence. Embedded `acp-state` compatibility remains when no child sidecar exists.

## Shared integration boundaries

Existing `MigrationMapping` and `acp.state.migration` field names stay unchanged. `entryIds` always addresses immutable raw archive rows; `contextEntryIds`/`contextOrder` address the separate materialized active window. Neither numeric map replaces legacy ACP raw IDs or reference maps. Wave 2 (#570) and the independent driver repair must retain that distinction.

`parentSessionMap` is an optional module API addition; the CLI is unchanged. Before a real conversion, #570 must supply an explicit original-reference-to-offline-file map where the copied sources retain original parent paths. Missing state is a refusal, never permission for an empty-state fallback.

## Recovery and undo

Preflight reads the manifest and all existing workspace migration documents through read-only SQLite snapshots, checks UUID/workspace/database/conversation identity globally, and validates all incoming sources before any conversation write. The committed database metadata is authoritative when a crash leaves the manifest absent or on a proven older migration head for the same identity. A missing/mismatched database or conflicting identity is refused instead of overwritten. Publication remains atomic per session, not one transaction across all workspaces; sources and target Harness must remain offline throughout.

Undo: revert this repair before conversion. No live database or service is changed by this task; original authored/source files remain untouched.
