# Architecture Spec: Roles page grouped by project (`roles-by-project`)

Follows [brief.md](brief.md), [design.md](design.md) and [design-elements.md](design-elements.md) (owner-approved v3,
Show&Tell d_tv6wgbjl7d "Build it"). Architecture #546. Parts: [spec-data.md](spec-data.md) (G1/G2 fields, groups,
states, done rows), [spec-graph.md](spec-graph.md) (task maps), [spec-page.md](spec-page.md) (states, controls,
answer flow, live updates), [spec-build.md](spec-build.md) (modules, owners, acceptance seam),
[spec-acceptance.md](spec-acceptance.md) (the failing-first cases), [spec-delete.md](spec-delete.md) (deletions).
Tiny tweaks after this land go straight to the builder (rule 32); contract changes come back to Architecture.

## Hypothesis (rule 14)

- Problem: the live Roles page is a flat task list (the v8 "All Department Tasks" panel); the owner thinks project
  by project (brief, 2026-11-15). The overview lacks done-when texts (G1) and done work per group (G2), so the
  approved tiles cannot be drawn truthfully from today's payload.
- One change: add three optional, server-computed fields to the existing roles watch payload (no new message or
  endpoint) plus one shared pure module for grouping, states and maps, used by server and page alike.
- Expected: every tile number equals the server's count on the 260-task fixture; mini maps show at most 5 layers
  from the earliest unfinished one; exactly 2 controls. Measured by the acceptance tests in spec-build.md and
  QA's blind final table.
- Wrong if: any count differs from a recount over all queue tasks, a map draws a node or edge not in the data, a
  done predecessor 5 steps back is sent, or the page shows a third control.

## Decisions

- **G1 (done-when):** `UiWorkRecord.doneWhen?: { item: string; met: boolean }[]` from the same work-registry read that already
  gives `items`/`met` (`server/work-records.ts`). Sent eagerly; no lazy fetch, no proof text (the tile needs none).
- **G2 (done work):** `UiRolesOverview.taskBoard?: UiTaskBoard`: exact per-group counts over every queue task,
  every open task, and the done rows (last 6 per group within 14 days, plus every done task up to 4 steps behind
  an open task). Computed from the queue rows the overview already reads; no second reader.
- **Group key:** computed once on the server and stamped on every row as `groupKey`; the page never re-derives it.
- **G3:** no priority field; Now uses queue order.
- Rejected: lazy per-tile fetch (closed tiles need the counts and the window anyway; adds a request type and a
  loading state per tile); reusing `tagGroups` (it puts a task in every one of its tags, so totals double count).

## API and State Contract

Transport is unchanged: `roles_watch {full:true}` -> `roles {overview, checkedAt, error?}`;
answering stays `roles_ask_open` / `roles_ask_answer` -> `roles_ask` / `roles_ask_result`. New fields, their exact
types, meanings of absent/empty/partial, the clock and ordering: [spec-data.md](spec-data.md). Map semantics:
[spec-graph.md](spec-graph.md). Page states and actions: [spec-page.md](spec-page.md).

## Canonical State and Formula Owners

<!-- doc-check: paths-planned (new files: stubs by Frontend #293's seam, built per spec-build.md) -->
| Figure | One implementation | Used by |
|---|---|---|
| Group key of a task | `groupKeyOf` in `server/shared/roles-by-project/groups.ts` | server producer only (stamps `groupKey`) |
| Board state of a task (needs you / blocked / waiting / working / queued / done) | `boardStateOf`, same file | server counts; page pills, marks, search-filtered counts |
| Group counts, `done14d` | `server/roles-by-project.ts` (producer) | page shows them as sent |
| Done-row selection (last 6, 4-step predecessors) | `donePredecessors` in `server/shared/roles-by-project/groups.ts` + producer | server |
| Map edges, layers, 5-layer window, holds, root blocker | `server/shared/roles-by-project/graph.ts` | page (mini and full maps) |
| Needs-you items | `projectExactRoles(...).needs` (`web/src/roles-exact-model.ts`) | page |
| Done-when marks | `server/work-records.ts` | page |

The page formats; it never recounts totals the server sent (search-filtered counts use `boardStateOf` over the
matched rows only).

## Obsolete Code and Tests to Delete

The full per-file list, with the shared pieces that stay: [spec-delete.md](spec-delete.md).

## Prototype-Only Chrome Excluded from Production

`ui-check`'s `UI-NO-PROTOTYPE-CHROME` reads this list. None of it may be rendered, CSS-hidden, flagged or
reached by a URL parameter in production; the reasons are in [spec-delete.md](spec-delete.md) §Prototype-Only Chrome.

- **`.proto`, `[data-proto-chrome]`, `[aria-label="Prototype controls"]`:** the prototype bar with its Data
  picker (busy, tonight, loading, empty, error) and Theme switch. Production: the roles watch's real state, the
  app's theme.
- **"Theme: system":** the prototype's theme button label.
- **"Busy afternoon, before tags":** the Data picker's fixture label.
- **Local answer and toast:** the prototype flips a task to working and shows a toast; production uses the
  existing answer flow (no DOM check: the app has its own "it carries on" copy).
- **Fake 600 ms retry, fixture snapshots, the fixture maker:** "Try again" calls `reloadRoles()`; test fixtures
  live only under the tests folder; no production import of them.
