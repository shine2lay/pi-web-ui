# Roles title and status over the graph

Owner request (2026-10-17, m55173): “lets make the header and status be something that hover over the main component instead of having it's own row”. This changes the supplied layout at the owner's request. No new data, actions or permissions.

## H-ROLES-FLOAT-1 — HIT in sealed checks

Wrong / evidence: the installed title and status occupy a separate flex row above the graph. The live screenshot at `roles-no-helper/live/desktop-dark.png` shows that row taking vertical space before the canvas. The owner wants them floating over the main component instead.

One change: group the existing title/status and any freshness warning into an absolutely positioned overlay within the same graph area. Use compact opaque-backed title/status surfaces, not a full-width header strip. Reclaim the former row's height for the graph. Measure this overlay's height and reserve node space inside the canvas so cards, lines, the You node and expanded panels are not covered. Keep the current narrow-screen horizontal pan; keep status meaning, retry, focus, answer and navigation behavior unchanged. The archived reference rendering remains unchanged unless the live-view flag is on.

Expected / measurements: the graph starts at the page's top padding while the title and status sit inside its bounds. No separate row exists, no header/card or header/panel intersection, no outer horizontal overflow at 1440, 1050 and 390 pixels. The live, disconnected and empty/error states remain readable. Role and You panels, closing/focus, Answer controls and Retry continue to work. Freshness state still uses the same model.

Falsifier: the header still pushes the graph down, covers a card or panel control, disappears off the phone viewport, changes status/answer semantics, adds script capability, or breaks the full/component gate. A failed visual check requires a new hypothesis, not a hidden layout tweak.

Verification: add deterministic controller coverage for the measured inset and node/You/panel alignment; use the existing sealed fictional component harness for geometry checks and screenshots across desktop, laptop and phone plus a warning state; run normal `scripts/check.sh` after the completed change. Then normal `wt land`, `pi-web-deploy` and read-only live check when restart-safe. No real ask will be opened or answered.

Undo: revert this isolated layout commit through the normal installer, retaining the already installed helper-row removal and answer filter. The in-progress D1 data slice is not part of this change.

Result: the normal UTC gate passed (412 test files; 6,000 passed, 6 skipped; production build and 74 terminal checks). The actual-component browser proof passed all 13 checks. Six explicit geometry cases passed: desktop, department panel, disconnected, stale, laptop and phone. The overlay is absolute and inside the graph and viewport in all six, without covering cards/panels or creating outer horizontal overflow. The graph starts at the 16px top inset; measured overlay heights were 49px on desktop, 135px with the warning and 91px on phone. Screenshots were inspected. Evidence: `/home/shinelay/kept-from-tmp/2026-10-17/roles-floating-header/checks/full-check.log` and `browser/results.json`.

The historical seven-frame reference comparison is unchanged: five exact matches, plus the already accepted R-P1 border-corner differences (26 pixels disconnected, 20 stale). The strict reference command still exits 1; this is not a claim that all seven are pixel-exact. No golden or tolerance was changed. Evidence: `roles-floating-header/reference/results.json`.

Installation and the actual-app look-only check remain. Before restarting pi-web-ui, confirm the separately requested Temper #97 helper/run is not active. At the pre-land check the helper was inactive, only Ops was busy, and no install was waiting.
