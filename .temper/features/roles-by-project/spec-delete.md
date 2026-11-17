# Roles by project: deletions and prototype-only chrome

Part of [spec.md](spec.md). The list comes from an esbuild reachability diff of `web/src/main.tsx` with and
without `RolesExactView` (353 -> 336 modules; architecture #546), plus files only tests or the removed view use.
Delete each item outright; no wrapper, re-export or "legacy" flag survives to keep an old test green.

Status 2026-11-16: carried out by frontend #294 (written against mine e6f73258, landed as 869a08dc). The
whole-file deletions below no longer exist on purpose; only those blocks carry doc-check's `paths-historical`
marker, so every kept or changed file in this spec is still path-checked.

## Production code to delete (Frontend, in the build task)

<!-- doc-check: paths-historical -->
- `web/src/components/RolesExactView.tsx` (279 lines): the Roles tab's v8 mount, its legacy-fonts switch and the
  `TaskPriorityBadge` re-exports.
- `web/src/components/RolesLegacyFontsFrame.tsx` (259), `web/src/roles-exact-view.ts` (406).
- `web/src/roles-exact/`: every file (`arrows`, `card-layout`, `department`, `host`, `instructions`,
  `owner-asks`, `owner-contacts`, `page-status`, `sent-requests`, `spending`, `view-state`, `work-progress`,
  `you-panel`; 998 lines).
- `web/src/roles-u0/`: `fields.ts`, `layout.ts`, `mount.ts`, `native.ts`, `surface.ts`, `surface.html`.
- `web/src/roles-exact-fonts.ts`, `web/src/roles-design-fonts.d.ts`, `web/roles-design-assets.ts`.

Changed in kept files:

- `PagePanes.tsx` lazy-imports the new view instead of `RolesExactView`, same props
  (`active`, `dialogs`, `onOpen`, `onAbout`).
- The `rolesDesignAssets()` entry in `web/vite.config.ts`.
- `web/src/tasks-roles-v8/role-bento-surface.ts`: `renderRolesBentoView` and `renderSvgDonut` (the old "Roles &
  Queues" tab). `renderWhyModal` stays in that file (the Initiatives prototype uses it). In `surface.ts`: the
  `#tab-roles` button, `?page=roles`, the `"roles"` page patch and the bento branch; `filters.ts` `page` becomes
  `"initiatives"` only. `index.ts` re-exports only what remains.
- `acknowledgeRenderedRolesUsage` in `web/src/roles-state.ts` (its only caller was the legacy frame).
- Exports of `web/src/roles-exact-model.ts` whose only users were the files above (`wt check` lists them).

## Kept (shared, used by Initiatives, the owner-question route or the new page)

`tasks-roles-v8/` (the Initiatives page mounts it), `live-v8-task-answer.ts`, `RoleAnswerDialog.tsx`,
`roles-answer-state.ts`, `roles-answer-model.ts`, `roles-answer-actions.ts`, `roles-useful-model.ts`, `roles-exact-model.ts`,
`roles-state.ts`, `roles-u0/types.ts`, `roles-u0/state-chip.html` (Initiatives' chip), `exact-surface.ts`.
Server: everything; the overview gains fields, nothing is removed.

## Tests to delete

<!-- doc-check: paths-historical -->
- Whole files: `tests/unit/roles-exact.test.ts`, `roles-live.test.ts`, `roles-current-task.test.ts`,
  `roles-evidence.test.ts`, `roles-lanes.test.ts`, `roles-u0.test.ts`,
  `roles-u0-rgba.test.ts`, `roles-exact-assets.test.ts` (all under `tests/unit/`); `tests/roles-exact-harness.tsx`,
  `tests/roles-exact-test.mjs`, and all of `tests/roles-u0/` (U0 reference pixels and fixtures).

- Cases only: `tests/unit/roles-answer-actions.test.ts`'s "the Roles surface and the native dialog use the
  current-action policy" describe (it renders `createExactRolesView`; the first describe, on the kept
  `roles-answer-actions.ts`, stays); `tests/unit/roles-instructions.test.ts`'s "roles-instructions display" describe (it uses the
  deleted `instructionsOf`; the server reader cases stay); in `tests/unit/tasks-roles-v8-live-wiring.test.ts` the two `RolesExactView` cases (mount, and
  inline answer through `roles_ask_open`/`roles_ask_answer`); in `tests/unit/task-priority.test.ts` the
  `RolesExactView` half of the badge case; in `tests/unit/usage-accounting-roles-wiring.test.ts` the cases that
  mount the exact view or call `updateRolesUsageDOM`/`acknowledgeRenderedRolesUsage`; in `tests/tasks-roles-v8.test.ts`
  the `#tab-roles` click case.
- Changed, not deleted: `tests/unit/roles-useful.test.ts`'s `PagePanes` wiring assertion names the new view.
- Release smoke (`tests/release-smoke/`) references none of these: 0 selectors break.
- Docs under `docs/roles-*.md` are dated records and stay as written.

Not in this build, told to Backend: the server's `roles_watch.renderedUsage` acknowledgement
(`server/index.ts`, `rolesWatch.acknowledgeUsage`) loses its last web caller; its owner decides its removal.
Status 2026-11-16: removed by backend #175 with the server state only it read; the page-side `usageRender` /
`usageRenderTimings` reader in `web/src/roles-state.ts` is now never fed and is Frontend's to delete.

## Prototype-Only Chrome

Never in `web/src` or `server`, never hidden with CSS, never behind a flag or URL parameter:

- The `.proto` bar and anything with `[data-proto-chrome]`: the Data picker (busy, tonight, loading, empty,
  error) and the Theme switch. Production reads its state from the roles watch and its theme from the app.
- The local answer: flipping a task to working and the toast. Production uses the existing answer flow
  (spec-page.md §Answering).
- Retry's fake 600 ms load. Production's "Try again" calls `reloadRoles()`.
- Fixture snapshots (`/home/shinelay/design-lab/results/roles-grouping-20261115/shared/fixtures.json`) and
  `make_fixtures.mts`: design inputs only. Test fixtures live in the tests folder (spec-acceptance.md); no
  production file imports them and no production branch checks for them.
