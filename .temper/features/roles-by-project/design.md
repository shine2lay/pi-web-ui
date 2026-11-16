# Feature Design: Roles page grouped by project (`roles-by-project`)

## Direction and sources

Owner ask (2026-11-15, Design home): "i typically like to know by project most of the time, but
have ability to group by other things as well, without alot of knobs". Approved v3 (2026-11-15,
Design home): "after this next round of edit, go ahead and considered it approved and start
building it"; on the doc: "Build it".

- Look: the Roles screens' own carbon tokens (`web/src/tasks-roles-v8/styles-tokens.ts`), app
  [DESIGN.md](../../design/DESIGN.md) and [tokens](../../design/tokens.json). No new colours or fonts.
- Reference prototype: `/home/shinelay/design-lab/results/roles-grouping-20261115/prototype.html`
  (hand-off: `HANDOFF.md`, critique: `critique.md`, same folder).
- Element-to-data map, tile and task-map rules: [design-elements.md](design-elements.md).
- Replaces the current Roles overview in `web/src/tasks-roles-v8/`; Architecture lists what to delete.

## First view (top to bottom)

1. Title "Roles"; lede "N things need you." + busiest group "X open, Y held"; "As of" time.
2. One control row, nothing else: **Group by** radiogroup Project (default) · Now · Department
   ("Dept." under 400 px) · Status, arrow keys move, choice remembered; **Search** "Find a task,
   project or role" (title, #id, role, group name, tags, initiative).
3. Fleet bar: total open across N roles, one mark per open task in state colour, legend counts.
   Hidden when nothing is open or a search is on.
4. **Needs you · N**: collapsible, open by default, open/closed remembered. Shows the first row
   only (3 cards at 1440 px, 1 on a phone, measured from layout) then "Show N more". Card =
   question, task ref, link to its group, one gold **Answer** (the only solid primary). Shown in
   the Project and Department views.
5. Body by grouping:
   - **Project**: bento grid of tiles; tasks with no project group under their canonical tag
     (chip "Tag"); neither -> "No project or tag". Then "Nothing open right now · N" compact
     minis, then a "Done lately" fold.
   - **Now**: one lane per role (needs-you first, then most running): Running / Held / "Up next,
     in order" (numbered, queue order).
   - **Department**: the same tiles, one per role.
   - **Status**: Needs you / Blocked or waiting / Working / Queued / Done lately, clustered by group.
6. Opening a tile shows its full dependency map (done tasks green, root blocker marked) and a
   "Done when" fold (met / not met per item); rules in design-elements.md.

Answering uses the existing answer flow; the dialog needs a picked choice before Send.

## Screen States

- **live**: as above; "As of" from the roles watch.
- **loading**: first paint, skeleton tiles, "Loading projects and queues".
- **empty**: nothing open: green calm "All clear" panel, then the quiet minis; fleet bar hidden.
- **error**: coral banner "Couldn't read the queues just now" (tasks are safe), "Try again";
  the last good view stays underneath.
- **no results**: search with no match: Clear + suggestions.
- Light and dark; 320, 390 and 1440 px with 0 horizontal overflow; reduced motion respected
  (one 160 ms opening animation).

## Accessibility

Group by is a radiogroup; tiles are buttons with `aria-expanded`; the answer dialog is a native
dialog (Escape, focus held). Every state pairs colour with its word and icon (waiting lilac and
working blue sit close in small marks). Targets >= 24 px; Answer 44 px tall on phones.

## Show&Tell

Approved doc: /showtell/#/d/d_tv6wgbjl7d (v3, after round-3 notes dr-b13b5a758abb).

## Prototype-only chrome (never ship)

- The `.proto` bar (`data-proto-chrome`): Data picker (busy, tonight, loading, empty, error) and
  Theme switch. Real page: real load/error state and the app theme.
- Local-only answering (flip to working + toast); real page: existing answer flow.
- Retry's fake 600 ms load; real page: the roles watch.
- Fixture snapshots and `make_fixtures.mts`: design inputs, not code.

## Reference Screenshots

All in [shots/](shots/), each at 320, 390, 1440 in light and dark (`<view>-<width>-<theme>@2x.png`),
rendered from the approved prototype; preview journeys passed with 0 violations.

- Default (Project, tonight): `shots/default-1440-dark@2x.png`
- Opened map (openviking-v2 tag tile): `shots/map-open-1440-dark@2x.png`
- Now tab (busy): `shots/now-1440-dark@2x.png`
- Needs you collapsed (busy): `shots/needs-collapsed-390-light@2x.png`
- Loading: `shots/loading-390-dark@2x.png`
- Empty: `shots/empty-390-dark@2x.png`
- Error: `shots/error-1440-light@2x.png`
