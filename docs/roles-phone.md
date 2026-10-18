# Roles: one column on phones

Owner, Oct 18 (Ops #210): "Stack the cards myself", with no new drawing first; Design looks it over afterwards. Accountable lead: Ops.

## H-ROLES-PHONE-1: HIT (sealed check and live look below)

**Wrong, and the evidence.** The ring sits on a fixed canvas (`min-width: 1000px`, `web/src/roles-u0/surface.html`). The sealed check was run at 390 px on the commit before this change (0e7b99c3), with the same check file:
- the canvas scrolls 636 px sideways inside its own box;
- 11 of the 16 items (You and 15 cards) lie partly or fully outside the screen;
- items overlap (smallest vertical gap −354 px);
- cards are 150 px wide, and the arrows are drawn across them.

The document itself reports no overflow, because the canvas scrolls inside its own box. That's why the check also measures the canvas and every card.

**One change.** Below 1024 px of the app's viewport (`matchMedia("(max-width: 1023.98px)")` in `RolesExactView.tsx`, re-planned when it flips), the live adapter stacks:
- `stackLayout` (`web/src/roles-u0/layout.ts`) puts You first, then every department in the feed's (roster) order, in one column at their measured heights, 16 px apart, with 12 px side margins.
- The graph drops its 1000 px minimum width and takes the column's height.
- No arrows are drawn.
- A tapped card's panel opens as a sheet over the whole screen.

Same template, cards, colours and fonts: only positions and sizes change. At 1024 px and wider `narrow()` is false, and the ring code path is the one from before.

**Expected, and how it's measured.**
- At 390 px: no sideways scroll in the document, the frame or the canvas; every card's box lies within the screen's width; the header clearance is ≥ 8 px; You comes first, and each card sits below the one before it.
- At 1440 px: the 15 card centres are where they were before the change.

The sealed geometry check (`tests/roles-exact-test.mjs`) measures this, run on this change and on the commit before it.

**What would prove it wrong.** Any sideways scroll at 390 px; a card outside the screen; a clearance under 8 px; cards out of order or overlapping; or any card centre at 1440 px that moved.

## Results

Isolated sealed check (fictional data, 390 × 844 unless noted):

| | before (0e7b99c3) | after |
| --- | --- | --- |
| sideways scroll: page / frame / canvas | 0 / 0 / 636 px | 0 / 0 / 0 |
| items outside the screen | 11 of 16 | 0 of 16 |
| smallest gap between items | −354 px (overlap) | 16.36 px |
| header clearance | 30.41 px | 17.48 px (also with the stale pill, and back to live) |
| card width | 150 px | 340 px |
| arrows drawn | yes | none |
| tapped panel (Ops, You) | inside the scrolling canvas | fixed sheet 0,0,390 × 844, nothing cut off sideways |
| card centres at 1440 × 1300 and 1050 × 900 | | 15 of 15 identical to before |

The check fails on the commit before (so it catches the problem) and passes on this change. Unit tests (`tests/unit/roles-exact.test.ts`) cover:
- the column's positions;
- the defaults used before a first measurement;
- roster order, no arrows and full-width sheets in narrow mode;
- the same feed still drawing its arrow when wide.

Live look: see "Live" below.

**The key.** The page's key (legend) row was removed at the owner's request (H-ROLES-HELP-1, `docs/roles-help-row.md`) and stays off at every width. In narrow mode the key's text starts "Arrows are hidden on narrow screens and show on wider screens." (unit-tested), but it isn't visible live. No new element was added for it, because the plan allows no new visual elements.

**Rebased onto roles-retry-pill (6901c168).** That change took the banner away, so the sealed check's tall-header step became a stale-pill step. The column checks run there as well, and the old step that panned the wide canvas is gone (a column has nothing to pan). After the rebase all 14 component checks pass. The card centres at 1440 and 1050 px are still identical to 0e7b99c3.

**Already there before this change, and not touched here.** The same-input reference comparison differs by 26 pixels (phone-disconnected) and 20 pixels (phone-stale) on the commit before as well.

## Live

Installed at 13:34 on Oct 18 as 8f451d85 (`pi-web-deploy --landed 13-60d2e5`). Its own checks all passed: server, page, reply, big-chat copy and log.

Look-only check at 13:41 on live data (`~/kept-from-tmp/2026-10-18/roles-phone-live/look.mjs`). It used its own carry-on client and only GET/HEAD requests, and its socket sent only hello and roles_watch.

| 390 × 844 (phone, touch) | measured |
| --- | --- |
| sideways scroll: page / frame / root / canvas | 0 / 0 / 0 / 0 |
| order | You first, then 15 cards for the 15 roles the feed sent, each below the one before |
| items outside the screen | 0 of 16 |
| smallest gap between items | 16.36 px |
| header clearance | 17.48 px settled, and the smallest in 240 painted frames over 4 s (the header shrank from 106 to 91 px while loading) |
| cards | 340 px wide, nothing cut off inside any card |
| arrows | none (0 lines, 0 labels) |
| tapped Ops card | fixed sheet at 0,0, 390 × 746 (the frame's whole screen), nothing cut off sideways and no text past the right edge; heading 22 px, smallest text 11 px over 259 text elements; closing it leaves no card dimmed |

| wider | measured |
| --- | --- |
| 1440 × 1000 | the ring as before: not stacked, canvas min-width 1000 px, 12 arrow lines, header clearance 16.27 px (also the smallest in 240 frames) |
| 1024 × 900 | ring: not stacked, 1000 px canvas, arrows drawn |
| 1023 × 900 | column: stacked, no arrows, nothing outside the screen |

Screenshots, sent to Design as an FYI (rm-7a9188ed), in `~/kept-from-tmp/2026-10-18/roles-phone-live/out/`:
- `phone-390.png`: the top of the column;
- `phone-390-column.png`: the whole column at 390 px;
- `desktop-1440.png`: the unchanged ring.

The sheet's screenshot was deleted without being viewed, because its first section quotes the owner's messages.

The look's first run timed out tapping "Ops". The live card is named "ops/tooling", not the fixture's "Ops …". After the script was fixed, the second run had no problems.

At 1440 px the ring's canvas box scrolls 2 px sideways. This patch leaves the wide styles alone (its new CSS applies only under `data-roles-stacked="true"`), so that was there before and stays as it is.

**Verdict: H-ROLES-PHONE-1 is a HIT.** Every expected measurement held, both in the sealed check and live:
- at 390 px, no sideways scroll and every card inside the width;
- header clearance at least 8 px (17.48);
- You first, and the cards in order;
- the 1440 px card centres identical to before (sealed check), with the ring unchanged live at 1440 and 1024 px.

One done-when line is met in code only. The key's "show on wider screens" sentence isn't visible live, because the key row has been off at every width since 10-17 (see "The key" above).

## Undo

`pi-web-deploy rollback`, or revert the commit and deploy.
