# Project progress: Changed / Frozen manifest

Part of [spec.md](spec.md). Owner: Architecture. Mirrors approved [Design](design.md).

## Changed / Added

Only the summary body of a project card in Project grouping, including that body's open state:
Milestones → Now / Queued work → Recent activity. Replace the ring/unexplained count block;
keep map thumbnail/full map and real task access, without duplicating the old milestone fold.
No fixed blank panel, new colour/font set, grid sizing rule or page-wide visual rewrite.

Current integration points: `web/src/roles-by-project/tile.tsx` (`Tile`, `Figure`, `DoneWhen`),
`model.ts` projections and `styles.ts` scoped selectors. Implementation should extract a focused
card-progress module in the same domain, keeping modified production files below 500 lines.
Do not copy the archived throwaway component or expand unrelated shared selectors.

Approved dimensions: reuse tile spans; internal padding/gap 16 px, strip 6 px, criterion count
20 px, recent count 16 px, previews 13 px and secondary labels 12 px. Narrow previews are one
line; already-wide cards may use two. Only existing large tiles may place sections side-by-side
above 640 px. Full labels on open, not invented “short stage” names.

## Frozen (untouched)

| Boundary | Concrete preserved surface |
| --- | --- |
| Project header | `.rbp-th` title/chip/lead/chevron appearance, focus and disclosure behaviour; body content moves outside header button, no restyle of header children |
| Grid and shell | `.rbp-grid`, tile width/span rules (`is-l` existing threshold), breakpoints, spacing, theme/navigation/sidebar/topbar/footer |
| Other tiles | Tag/none/department cards, avatars/rings/counts/mini maps; Now, Department and Status grouping rendering |
| Project minis | Quiet groups and Done lately closed mini layout/placement; opening a project can show new body |
| Controls | Group by/search/remembered value, filter matching, fleet, needs-you collapse/answers |
| Maps/details | `Thumb`/`OpenedMap`, task graph calculations/layers/dependency styling/root blocker/task links/details |
| Data | Registry status/marks, role-local queue order, aliases/project routing, answers/actions, watches/error recovery |

New card height may shift following content vertically; that is not permission to resize,
re-space, recolour or change their DOM. Compare Frozen crops at common origin, while retaining
whole-page actual-position screenshots. No pixel tolerance or DOM-only fallback as proof.
If a shared selector changes a Frozen component, narrow it rather than redefining Frozen.

## Independent approved priority-inbox work

Ops tasks 1120–1126 may independently add approved RoleRow alarm slots. This contract owns
only `.rbp-tile` project-body content, not RoleRow alarms or the page's needs-you/inbox region.
Ops owns a shared integration plan: preserve that independent approved diff, name changed
slots before merging overlapping files, and bind Frozen comparisons to the same deployed
baseline. Neither branch may erase the other or treat unrelated alarm changes as permission
to redesign cards. No new owner gate or per-department verification chain.

## Prototype exclusions

The exhaustive no-ship list is in [spec.md](spec.md). In particular, archived CSS and component
text are not a source-code baseline: its count-only first-N strip and cross-role queue sorting
are explicitly NOT approved semantics. Only source-backed individual marks and unlabeled
role-local queued previews may ship. Design's original pixels do not override these truth rules.

## Validation owed after build

Use the real installed app/DOM on its existing staging copy where available, never a scratch
HTML imitation or fresh seeded environment for every check. Compare Live Staging vs Proposed
at 320/390/1440 px, light/dark, using `ui-check` @2x captures and Frozen DOM/style/pixel checks.
Require zero errors/overflow/overlap/prototype chrome; inspect full labels, keyboard/focus,
open/reload/errors and map/answer preservation, not just colours. Approved reference root is
recorded in [spec.md](spec.md); Design handoff indexes the original pairs.

This land changes documents/reference cases only. No installed build, screenshot, staging
behaviour, healthy deploy or visual acceptance is asserted. Ops owes the terminal build task
and checkpoint, healthy deployment receipt, then the one QA blind final and one Design look.
