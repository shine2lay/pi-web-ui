# Roles by project: failing-first acceptance cases

Part of [spec.md](spec.md). Frontend #293 (Task 1) writes every case below so it fails with "not built", and
lands them with the stubs. Builders make them pass and never delete or weaken one (spec-build.md).

<!-- doc-check: paths-planned (written by Frontend #293) -->
Files: `tests/unit/roles-by-project-board.test.ts` (B), `tests/unit/roles-by-project-graph.test.ts` (G),
`tests/unit/roles-by-project-page.test.ts` (P, jsdom), `tests/roles-by-project-test.mjs` (L, sealed browser,
Chromium and WebKit). Fixtures in `tests/fixtures/roles-by-project/`: `busy.json` and `tonight.json` (the design's
two real snapshots, converted once to `UiRoleTask` rows through the real `taskOf`, committed with the script that
made them), and small hand-made cases. Each count is checked against a plain recount loop inside the test.

## B: board producer (`buildTaskBoard`, `groupKeyOf`, `boardStateOf`, `donePredecessors`)

- B1 Group key: project field in registry; project-less with a project-id tag; tag only; nothing -> `none`.
  A task with two tags is in one group only; group `open` sums equal the role queues' open counts.
- B2 Aliased tags already folded by `normTags` land in one group (no twin groups).
- B3 `counts` per state sum to `open`; dropped tasks are in no count; paused open task -> waiting.
- B4 A group with 40 done in 14 days: `done14d` 40, 6 rows sent, the 6 newest (tie: higher id).
- B5 Done 15 days before `asOf` is not counted; exactly 14 days is; no `finishedAt` -> not counted.
- B6 Chain open <- d1 <- d2 <- d3 <- d4 <- d5 (all done, 30 days old): d1-d4 sent, d5 not.
- B7 Cycle A -> B -> A among done predecessors ends; no duplicate rows; every ref in `tasks` once.
- B8 Ordering: same input twice -> byte-identical JSON; group tiers and ties as spec-data.md §Order.
- B9 Every `work.projects` record has a group, a 0-task active one included; tags with only old done work do not.
- B10 One unreadable queue: `problem` set, other groups intact, no guessed counts.
- B11 `doneWhen` marks: `met` follows `itemKey` (case and outer spaces), `items`/`met` agree with the list.
- B12 `busy.json` and `tonight.json`: open rows 61 and 13; every group count equals the recount; no task
  appears in two groups.

## G: maps (`taskMapOf`, `miniMapOf`, `layerWindow`, `heldOnOf`)

<!-- Lead clarification hypothesis: G1's queue wording could hide valid edges; a same-group cross-queue
     twin must draw its edge. A missing edge falsifies the contract; G6 also pins qualifying ties. -->
- G1 Links only from `dependsOnRefs` inside the group, including resolved cross-queue refs: same-group rows
  get a node and edge regardless of queue. A missing or other-group row gets neither; duplicate ref one edge;
  self-ref none.
- G2 Cycle A -> B -> A: one layer, both kept, listed in `cycles`.
- G3 `layerWindow(8, 5)` -> start 5, end 8, earlier 5, later 0; `layerWindow(8, 0)` -> 0, 5, 0, 3;
  `layerWindow(8, null)` -> 5, 8, 5, 0; `layerWindow(2, 0)` -> 0, 2, 0, 0 (layers 0-based).
- G4 A layer of 7 shows 5 and "+2"; 45 loose open tasks show 40 and "+5".
- G5 Root blocker: open with no open predecessor and 3 open tasks after it -> `waiting` 3, edges from it `root`.
- G6 Held on: 3 blocked on Backend, 1 on QA -> Backend 3; 1 and 1 -> `null`; 2 and 2 -> the role id first in
  lexical order with count 2 (spec-graph.md §Held on).
- G7 Opened map holds every row of the group, done rows green, none windowed.

## P: page (jsdom, the real `useRoles` store fed payloads)

- P1 Exactly 2 controls: the Group by radiogroup and the search box. Default Project; choosing Now, reloading
  -> Now; a stored `"bogus"` -> Project.
- P2 Search `#546`, a role name, a tag, a project name: the right rows; no match -> "Clear search".
- P3 Needs you: 5 asks at 1440 px -> 3 cards and "Show 2 more"; at 390 px -> 1 and "Show 4 more"; closed
  state survives reload.
- P4 Answer: Send disabled before a choice; picking one and Send emits `roles_ask_open` then `roles_ask_answer`
  with the ask's key, id and revision; no local task flip; a refused answer shows the error and sends nothing more.
- P5 Error: a failed look after a good one shows "Couldn't read the queues just now" and "Try again" above the
  unchanged last view; Try again calls `reloadRoles()` once.
- P6 Loading before the first board; empty board -> "All clear" and no fleet bar.
- P7 Now: Up next numbered in queue order, 20 then "+N more".
- P8 No `.proto` or `[data-proto-chrome]` element in any state.

## L: live updates (sealed browser, fails first)

- L1 A roles payload arriving while the owner has scrolled, focused a tile, typed in search (caret mid-word),
  opened two tiles and opened the answer dialog with a choice picked: afterwards the same scroll offset, focus,
  search text and caret, both tiles `aria-expanded="true"`, the dialog open with the same choice.
- L2 A payload arriving between mousedown and mouseup on a tile still opens it (Chromium and WebKit).
- L3 320, 390, 1440 px, light and dark: 0 horizontal overflow, 0 overlapping text, 0 console errors.

Measurement note (Architecture rm-b04e515c, ruling A; no assertion removed, no threshold relaxed). Hypothesis:
document-scoped feature a11y/target queries pick up older shell defects, and un-clipped boxes count text scrolled
out of view; scoping to the feature and clipping to visible geometry keeps every real defect failing. Wrong if a
visible overlap or a feature-owned defect disappears under the amended measure.
- Journey axe and 24 px targets cover the page root `.rbp` (a missing root fails) plus any dialog the page opens
  outside it; both run on the page and again with the answer dialog open and a choice picked.
- L3 overlap stays document-wide; each text box is clipped per axis by its overflow ancestors (ui-check's
  browser-collect.py rule). A parity case on fixed geometry proves a scrolled-out pair passes and a visible
  overlap fails.
