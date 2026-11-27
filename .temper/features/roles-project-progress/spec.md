# Roles project progress: Architecture contract

Owner: Architecture. Accountable integration lead: Ops. UI builder: Frontend.
Status: approved direction, implementation pending; documentation/reference only.

## Sources and hypothesis

- [Product brief](brief.md): original `5e4ba2e8bbedf2ac28faae89819e6f4af2cc69cf`.
- [Design](design.md): original `3bcb90b554b7a4e736e040ff231d40b5d42d75ee`.
- Shine: “Approved”, 2026-11-26 18:21, `dr-cce785524b2c`, Show&Tell `d_is5vg33do7` v1.
- Design state-map/handoff at design-lab `bff78a4c3be5e4d4ce145eea76b7d01f41669f43`;
  host evidence root `/home/shinelay/design-lab-design-task-350/results/roles-project-progress-20261126`.
- Code inspected at pi-web-ui `ad005934` before joining the two exact documentation commits.

Hypothesis (before owned writes): the count-only prototype can invent which criteria are met and
cross-role queue position can suggest a global next step. One canonical truth map plus paired
allowed/refused cases should prevent both without new backend fields. Measure exact case/source
coverage, contract checks and Frozen boundaries, not inherited screenshots. Falsified by any
unowned case, untraceable displayed datum, first-N marks, invented next order or failed-read zero.
Outcome of documentation checks is recorded in the queue land receipt; runtime remains NOT PROVEN.

## API and State Contract

No HTTP endpoint, field, server task or persistent format is added. Use existing WS
`roles_watch {full:true}` / `roles_unwatch` and `roles` payload via `useRoles("full")`.
Do not confuse `overview.board` (messages) with `overview.taskBoard` (tasks).

- [Truth table and existing types](spec-data.md): producer → consumer bindings, status and counts.
- [State, caching, actions](spec-states.md): absence, null, partial, stale, errors and reload.
- [Cases and build handoff](spec-acceptance.md): shared literal oracles and production proof owed.
- [Changed/Frozen manifest](spec-scope.md): exact replacement/exclusion boundary.

Source `doneWhen[].item`/`.met` supplies the criterion sentences and individual marks, in registry
order. `items` and `met` alone can supply a labeled fraction but NEVER criterion identities or
per-item strip marks. Recent `group.done14d` is a separate activity metric, not delivery progress.
`projectStatus` is lifecycle truth, even when all criteria are met or no work is open.
No percentage, current stage, stage/task mapping, short authored stage label, delivery date,
completion timestamp, structured blocker owner or project-wide next step exists in this frame.
Those facts remain not recorded. No second data store/read/parser or frontend business formula.

## Canonical State and Formula Owners

- pi-queue `readWork` is registry authority. Roles uses existing `WorkRecordsFile.get`,
  `workRecordsFromState` and existing fallback `workRecordsFrom` in `server/work-records.ts`.
  Reuse that producer; do not add another fallback. The watch-only `WorkRegistryReader` in
  `server/work-registry-reader.ts` is NOT the Roles page reader and has different missing-file rules.
- `server/roles-by-project.ts`: `taskBoardOf`, `taskBoardRowsOf`, `buildTaskBoard` own aggregate counts,
  14-day window, retained rows and role-local queue positions. Existing producer tests stay.
- `server/shared/roles-by-project/groups.ts`: `groupKeyOf`, `boardStateOf`, `donePredecessors`;
  graph calculations remain in `server/shared/roles-by-project/graph.ts`.
- `web/src/roles-by-project/model.ts`: reuse `contextOf`, `goalsOf`, `rankOf`, `projectTiles`,
  `shownRows`, `refLabel`; `goalsOf` is the sole existing display projection for criterion counts.
  Add presence/error classification around it in one focused card-domain module, not a duplicate
  count/mapping implementation. Never use its empty fallback as evidence of a successful read.
- `server/protocol.ts` re-exports `server/roles-board-protocol.ts`; `web/src/types.ts` re-exports
  protocol types. Import those, not local copies. Same-language boundaries import canonical code;
  any unavoidable cross-process copy must share replay parity tests rather than diverging math.

## Obsolete Code and Tests to Delete

In `web/src/roles-by-project/tile.tsx`, replace ONLY the Project-view project branch's old
`.rbp-fig` ring/count summary, `.rbp-draw` placement and `.rbp-counts` body placement with the new
body; move/reuse the thumbnail. Its old repeated `DoneWhen` fold is replaced by full criterion
text in the opened progress body. Keep `Figure`, `CountsParts`, ring/icons and old fold behaviour
where still used by Frozen non-project/Department tiles; split the branch, not their semantics.
Delete only project-progress assertions that require the superseded ring/count layout; replace
with shared-case assertions before wiring. Existing map, disclosure, non-project and page-state
assertions are NOT obsolete. No exact test is pre-authorized for deletion wholesale.
Prototype source was removed by Design; do not restore it or add compatibility wrappers for it.
This documentation land deletes no source or test and weakens no existing acceptance assertion.

## Prototype-Only Chrome Excluded from Production

Never ship: review state/theme/width selectors; Live/Proposed toggle, labels or comparison panes;
Show&Tell review shell; snapshot-swapping/replay iframes; captured page snapshots; replay harness;
external missing-data fixtures; frozen-region measurement markers; screenshot/crop widgets;
fixture flags/mock branches; literal Novega counts, task refs or capture timestamps. Archived
`prototype-progress.tsx.txt`, generated review HTML and CSS are visual evidence, not code to copy.
No owner/prototype re-approval is required. The prior 42 Frozen comparisons and ui-check images
prove the Design prototype only, never a new runtime or this documentation land.
