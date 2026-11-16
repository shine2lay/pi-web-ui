# Roles by project: modules, owners and build order

Part of [spec.md](spec.md). Acceptance cases: [spec-acceptance.md](spec-acceptance.md).

## Modules

<!-- doc-check: paths-planned (created by Frontend #293's seam; built by Backend's build task and Frontend #294) -->
| File | What | Built by |
|---|---|---|
| `server/roles-board-protocol.ts` | `UiTaskBoard`, `UiBoardGroup`, `UiBoardTask`, `UiBoardState`, `UiWorkDoneWhenMark` (spec-data.md) | seam (final) |
| `server/shared/roles-by-project/groups.ts` | `groupKeyOf`, `boardStateOf`, `donePredecessors` | Backend |
| `server/shared/roles-by-project/graph.ts` | `taskMapOf`, `miniMapOf`, `layerWindow`, `heldOnOf` | Frontend |
| `server/roles-by-project.ts` | `buildTaskBoard(input): UiTaskBoard`, pure | Backend |
| `web/src/roles-by-project/` | the page: `RolesByProjectView.tsx` and its parts, each under 500 lines | Frontend |

- `buildTaskBoard({ at, rows, work, roster, problem })`, `rows: { task: UiRoleTask; queueIndex: number | null }[]`
  = every row `RolesOverviewReader.read()` already gathers (active, every ready row past the 20 shown, done,
  dropped). No second read of any queue or registry file.
- `server/shared/` modules import only types and each other: no `node:`, no DOM, so the page imports them.
- Line caps (`WT-SIZE-500`, refused on growth): `server/protocol.ts` (6062) and `server/roles-overview.ts` (998)
  must not end longer than at base. Move `UiRolesOverview` into `roles-board-protocol.ts` (protocol.ts imports
  and re-exports it) to pay for the new fields; Backend moves the row gathering it needs out of
  `roles-overview.ts` into the new producer (table above) rather than adding to it.
- `server/protocol-version.ts` and `web/src/protocol-version.ts` go up by one together (a new page on an old server
  would wait for `taskBoard` forever); `scripts/check-protocol-sync.mjs` checks the pair.
- The page reuses the v8 carbon tokens (`web/src/tasks-roles-v8/styles-tokens.ts`); no new colours or fonts.

## Build order (rule 18)

1. **Task 1, Frontend #293 (seam):** writes `roles-board-protocol.ts` (final types), the version bump, stubs of
   the four other files that throw `roles-by-project: not built (<owner> task)`, the fixtures
   (spec-acceptance.md), and every case there failing on "not built". Lands alone.
2. **Task 2a, Backend build** (after #293): `groups.ts`, `buildTaskBoard`, the `taskBoard` and `doneWhen` fields
   on the live overview. Makes the B-cases pass; never edits another case.
3. **Task 2b, Frontend #294** (after #293, joins Backend's build and QA #172): `graph.ts`, the page, the
   deletions (spec-delete.md), the `PagePanes` swap. Makes the G- and P-cases pass; runs the gates; lands; deploys
   with `pi-web-deploy`.
4. **Task 3, QA #173** (after #294 and QA #172; checkpoint 2 h after deploy): one blind final check from the brief,
   this spec, `ui-check` @2x shots and `git diff`, as an item -> command/screenshot -> observed -> PASS/FAIL table.
   Its first row: the deployed `pi-web-status` commit is mine's head and carries both builds.
5. **Design:** one live @2x look against the approved shots after deploy. No other verify tasks.

Builders may not delete, skip or weaken a Task 1 assertion; a case they think wrong goes to Architecture.

## Gates (QA's testing standard, `docs/testing.md`)

- Before land: `wt check` (size, fixture branches, dead paths) and `scripts/check.sh --fast` (sealed temp HOME).
  `node scripts/select-tests.mjs` with a change to only `server/` and one to only `web/src/tasks-roles-v8/` must
  list the new test files (they import the modules directly, so the import graph finds them).
- Deploy: `pi-web-deploy` with its before and live smoke (F1-F4); none of their selectors touch the deleted files.
- Live look: `ui-check` at 320, 390 and 1440 px, light and dark, @2x, 0 overflow, 0 overlap, 0 console errors,
  `UI-NO-PROTOTYPE-CHROME` reading spec.md's chrome list. Needs QA #172's fix for pages that keep a live roles
  connection open (network-idle never comes).
