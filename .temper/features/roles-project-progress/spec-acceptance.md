# Project progress: shared cases and handoff

Part of [spec.md](spec.md). Contract owner: Architecture; accountable join/build lead: Ops.

## Shared case contract

[good.cases.json](good.cases.json) holds literal allowed view assertions; [bad.cases.json](bad.cases.json)
holds counterexamples referencing the SAME input via `twin`. File-level builders are Frontend and Ops
(actual owners, not invented identities). `source` identifies an existing repo file/export or binding.
Input objects are minimal external harness scenario fragments, NOT a new wire schema. `variants`
means expand every variant, not pick the first. Complete unrelated wire fields in the test wrapper;
never add fixture modes to production. `workProblem:null` in a scenario means no work problem.
Expected fields describe observable card semantics, not new API fields or a required app state store.

Run `node .temper/features/roles-project-progress/check-cases.mjs` from the repo. It validates
strict keys/types, unique IDs, source path/symbol bindings, ownership, resolvable twins and that
allowed literal views pass while every bad mutation actually fails. Exported `assertView` checks
the oracle's selected fields against a builder's normalized observation; it replays NO registry,
counts NO tasks and makes NO runtime/UI claim. It is not the implementation under test.

Task 2 imports the shared JSON into its own failing-first unit/integration assertions BEFORE
wiring the new body. Both canonical producer conformance tests (Ops) and consumer/render tests
(Frontend) consume these same cases as applicable, not retyped private twins. Existing producer
semantics already exist: if no producer code changes, Ops proves reuse/parity, not gratuitous
backend work. Do not delete/weaken these assertions to land implementation.

## Case/control coverage

Every entry below resolves in the shared files. Good cases RPP-01..31; bad cases RPP-101..133.

| Allowed case | Refused twin | Boundary |
| --- | --- | --- |
| RPP-01-named-progress | RPP-101-first-n-fill | Actual non-prefix met mark, source sentences/order |
| RPP-02-count-only | RPP-102-count-only-marks | Old server count ≠ individual marks |
| RPP-03-empty-plan | RPP-103-empty-ratio | Authorized empty ≠ ratio |
| RPP-04-known-zero | RPP-104-zero-is-unknown | Known 0 distinct from unknown |
| RPP-05-read-failed | RPP-105-error-is-zero | Error ≠ empty |
| RPP-06-work-absent | RPP-106-absent-is-empty | Work not sent |
| RPP-07-project-missing | RPP-107-join-guess | Exact id join |
| RPP-08-partial-registry | RPP-108-partial-success | Both too-big/unknown-change variants |
| RPP-09-partial-queues | RPP-109-partial-next | No false no-work assurance |
| RPP-10-loading | RPP-110-loading-zero | Loading ≠ zero |
| RPP-11-board-absent-after-good | RPP-111-mixed-generation | Keep last-known, no fresh mixed binding |
| RPP-12-stale-replay | RPP-112-replay-is-fresh | Replay ≠ confirmation |
| RPP-13-error-with-ready | RPP-113-ready-hides-error | Last good plus visible error |
| RPP-14-heartbeat-not-items | RPP-114-heartbeat-repairs | Heartbeat cannot repair registry |
| RPP-15-malformed | RPP-115-coerce-null | All null/scalar/range variants |
| RPP-16-inconsistent-list | RPP-116-empty-names-old | Empty sent list ≠ missing list |
| RPP-17-parallel-now | RPP-117-guess-owner | Parallel work, source reason, no owner inference |
| RPP-18-held-missing-reason | RPP-118-dependency-owner | Waiting ≠ blocked; dependency ≠ owner |
| RPP-19-role-local-queued | RPP-119-global-next-sort | No cross-role rank/global plan |
| RPP-20-idle-not-done | RPP-120-idle-is-done | No work ≠ completion |
| RPP-21-lifecycle-explicit | RPP-121-drop-is-done | Canonical dropped + mismatch warning |
| RPP-22-all-met-active | RPP-122-all-met-is-done | Marks ≠ lifecycle |
| RPP-23-filter-not-idle | RPP-123-filter-is-idle | Search ≠ project-wide emptiness |
| RPP-24-live-focus | RPP-124-refresh-resets-focus | Stable live interaction |
| RPP-25-body-only | RPP-125-header-redesign | Changed slot / Frozen / prototype exclusion |
| RPP-26-disclosure-access | RPP-126-hover-only | Full labels, extra rows, no nested controls |
| RPP-27-complete-empty-registry | RPP-127-empty-is-finished | No recorded projects ≠ finished |
| RPP-28-done-not-derived | RPP-128-done-marks-guessed | Explicit done with count-only plan |
| RPP-29-status-absent | RPP-129-status-guessed | Unknown lifecycle stays unknown |
| RPP-30-canonical-state-priority | RPP-130-paused-before-done | Exact canonical precedence |
| RPP-31-links-not-inferred | RPP-131-linkify-prose | Plain text / canonical actions only |
| RPP-01-named-progress | RPP-132-recount-sent-rows | Aggregate activity ≠ retained rows |
| RPP-17-parallel-now | RPP-133-invent-milestone-link | No task-to-criterion mapping |

Design's real Novega 1/6 + 19 done, roles-page done 6/6 and faster-landing dropped 6/7 are
source evidence, not production constants. The first good case deliberately marks the SECOND
criterion only: an apparently reasonable first-N implementation must fail.

## Land and next owner

This repo's normal land mode is push to `mine`, configured centrally in agent-tools `wt.yaml`:
`scripts/check.sh --fast`, 10 local test workers. `.temper` changes are not notes-only. Commit
all owned files; use `WT_LAND_WAIT_MINUTES=0 wt land` in this worktree, detached via systemd-run.
`wt land-status <id> --json` is the receipt. No direct push, test bypass or altered gate.
Run standard `doc-check` scoped to this feature plus explicit JSON files, `kb_check` where
available (otherwise the registered dead-path gate), and `wt check` before normal landing.

Ops owns follow-through: provide Frontend's terminal build task id/checkpoint, integrate the
approved priority-inbox slot independently, land, then obtain the actual healthy `pi-web-deploy`
receipt (only Ops deploys). No deploy/restart belongs to this documentation task. After healthy
deploy: ONE existing joined QA blind final and ONE Design look, not per-department verifies.
QA inspects brief/spec, living `found-below-par.md`, real @2x `ui-check` output and git diff;
reports item → command/screenshot → observed → PASS/FAIL. Design compares approved look and
Frozen DOM/styles/pixels. Build failures get bounded failing-first fixes in that same chain.
No approval/prototype re-gate; no runtime or visual acceptance until that actual proof exists.
