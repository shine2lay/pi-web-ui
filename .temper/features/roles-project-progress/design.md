# Feature Design: Roles project-card progress

## Direction and sources

Accountable lead: Ops. Product owns meaning; Architecture the state contract; Frontend implementation.
Shine chose **“Stages + completed tasks”** on 2026-11-26. Product brief: `5e4ba2e8`, branch `product-roles-project-progress` (join that existing brief, do not rewrite it).

Shine approved [Show&Tell v1](/showtell/#/d/d_is5vg33do7) at 2026-11-26 18:21, decision `dr-cce785524b2c`. Exact answer: **“Approved”**; no changes or reason supplied. Do not reopen the gate.

Extends the [Roles design](../roles-by-project/design.md) and [contract](../roles-by-project/spec.md). Prototype used real Roles components/DOM and recorded data, not a scratch page. Reuse existing carbon tokens, font, icons and state pills from [DESIGN.md](../../design/DESIGN.md) and [tokens](../../design/tokens.json).

## Changed

Only the **project-summary card body**, in Project grouping:

1. Replace the unexplained ring/summary block with **Milestones → Now → Recent activity**. No new palette, font, grid span or fixed empty panel.
2. **Milestones:** actual registry criteria in source order, segmented strip, **“1 of 6 met”**, check/unmet icons and textual status. A segment is one criterion, never a task, percentage, duration or inferred delivery stage. Narrow closed previews use one line; already-wide cards may use two. Full source sentences appear on open, also on desktop hover. Do not invent short stage names.
3. **Now:** up to three non-queued open tasks, existing state pill, role/task ref and source title. Held work shows recorded unblock wording; missing reason says “How it unblocks: not recorded.” Needs you points to the existing answer area. Extra rows remain reachable on open.
4. **Queued work:** up to two previews plus additional-count text; label “Queued work · no project-wide order recorded”. None → **“Next: not recorded · nothing queued.”** Do not call the next unmet criterion the current/next stage.
5. **Recent activity:** **“19 tasks completed · last 14 days”** plus existing task-map thumbnail, secondary to milestones. The existing full map/details remain available on open.

## Frozen

- Header title, Project chip, lead, chevron, disclosure/focus behaviour.
- Grid columns, widths/spans, spacing, breakpoints, theme and navigation. The taller changed card may move later content vertically; it does not restyle or resize it.
- All non-project/tag/department cards; other grouping modes; search/Group by; fleet; Needs you and answer flow; quiet groups; Done lately.
- Maps, dependencies, task links/details, registry status/completion semantics, queue ordering, live refresh/error recovery. No specialist or priority-inbox changes.

## Data and missing state

| Display | Existing source | Meaning |
|---|---|---|
| Criteria and marks | `overview.work.projects[].doneWhen[].item` / `.met`; project `met` / `items` | Completion criteria, never task ratio |
| Lifecycle | `projectStatus` | Explicit done / active / dropped, not inferred from activity |
| Now | Board `state`, `ref`, `title` | Parallel work stays parallel; existing state precedence |
| Held reason | `howToUnblock` | Recorded wording; no invented owner chip |
| Queued preview | `state = queued`, `queueIndex` | Role-local queues, not a global next step |
| Activity | Group `done14d` | Server count; never recount truncated `doneShown` |

Recorded 2026-11-27 01:23 UTC: Novega active, **1/6 met; 19 done in 14 days; Blocked Design #347; Working QA #245; no queued tasks**. Evidence, not production constants.

No task-to-milestone link, short criterion name, structured blocker owner or project-wide next step exists. Keep these unknown; Architecture has the state map (`rm-ea1bae8f`). The open card explains that tasks are not linked to milestones. Richer fields need Architecture's contract.

## Screen States

- **live:** the sections above; true parallel work and additional-count lines.
- **loading:** existing skeleton and “Loading projects and queues”; never zero progress before data.
- **empty plan:** “No milestones recorded for this project.” No fraction or invented stages; activity/work may still exist.
- **empty current work:** “Nothing running right now.” Queued work, if known, remains separate. This is not project completion.
- **error:** “Milestones couldn't be read just now (not zero: unknown).” Preserve existing page retry/last-good-state rules.
- **partial:** known count but missing names → “Milestone names weren't sent by this server.” Do not invent per-item names/marks or fill the first N segments. Missing next/reason stays not recorded.
- **finished / dropped:** retain recorded lifecycle; no forced completion percentage.
- **open:** full milestone sentences and existing map/task details; close returns to the preview. Full unblock reasons remain accessible in task details.
- Light/dark; 320/390/1440 px; existing reduced-motion behaviour.

## Layout and accessibility

Reuse tile width/span choice. Narrow cards stack all three sections; already-wide cards may place milestones alongside Now/activity above 640 px. Internal padding/gap 16 px; strip 6 px; count 20 px; recent count 16 px; preview text 13 px and secondary labels 12 px (existing compact Roles scale).

Header remains a keyboard disclosure with `aria-expanded`; lists sit outside its button. Preserve focus and task-link clicks. Full labels must not require hover. Decorative strip is hidden from assistive technology; criteria expose Met / Not met text as well as icons/colour. No nested interactive buttons or new motion.

## Show&Tell

Approved [review v1](/showtell/#/d/d_is5vg33do7): real-DOM disclosure, loading/empty examples and Live vs Proposed in all widths/themes. Accepted trade-off: taller card, compact labels until opened. Not a production sign-off.

## Reference Screenshots

Host bundle: `/home/shinelay/design-lab-design-task-350/results/roles-project-progress-20261126`. Text sources/reports are versioned in design-lab branch `design-task-350`; raw @2x PNGs, snapshots and generated review remain on host per repository policy. The approved owner copy is retained in Show&Tell, using smaller JPEG previews.

Example: [Proposed @2x](/home/shinelay/design-lab-design-task-350/results/roles-project-progress-20261126/shots/proposed/live-1440-dark@2x.png). The bundle's handoff indexes every comparison/state.

## Checks and hypothesis

Hypothesis: separate milestone delivery from task activity. Wrong if confused or invented. Deterministic checks hit; owner approved; five-second comprehension was not timed.

- Live and Proposed `ui-check`: each 6 width/theme runs, zero errors/overflow/overlap, 12/12 @2x captures.
- Review document: 18 state/width/theme runs; zero errors/overflow/overlap; 36/36 @2x captures.
- Frozen: 42 original markup/style/relative-layout records identical; 42 rasters, zero changed pixels at a common origin. Whole-page shots retain actual positions; no tolerance or DOM-only fallback.

No production code, restart or deployment in this task.

## Prototype-only chrome excluded from production

Never ship review state/theme/comparison controls, replay harness, snapshot-swapping iframes, captured numbers/timestamps or external missing-data fixtures. Archived throwaway component text is visual reference, not approved production code. No fixture flags or mock branches in the app.
