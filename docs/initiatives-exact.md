# Initiatives: the supplied design as an inert, data-driven view

Owner, Oct 18 (Ops home chat): "now lets plan for initiatives page to show all the planning work"; dialog answer "Your design, 1:1". Ops #224, project initiatives-page. Accountable lead: Ops. This change lands inert: nothing mounts it. The wiring task fills it with real data and ships it.

## H-INITIATIVES-EXACT-1: pending

**Wrong, and the evidence.**
- The owner's Initiatives design exists only as a design-tool bundle. Its page is drawn by its own component script, with four sample initiatives written into that script (`data()`).
- The app can't show it. The current page (`web/src/components/InitiativesView.tsx`) is our own layout. The app has no template for the design, none of its 11 embedded fonts, no typed input for it, and nothing that draws its 8 extra states from data.
- Showing the bundle as it is would run the design's JavaScript and show its sample data.

**One change.** The Roles approach, applied to Initiatives:
- The design's markup, extracted unchanged into `web/src/initiatives-u0/surface.html` by `scripts/extract-initiatives-template.mjs`. The script checks both design files' hashes, and `--check` reruns it against the file.
- It is bound by the same binder as Roles: Roles' binder becomes `bindSurface` in `web/src/exact-surface.ts`, and `bindRolesSurface` is a thin wrapper around it.
- It renders in a script-free, same-origin frame, with the design's 11 fonts pinned by sha256 and size.
- The component's own `renderVals()` and state logic, ported to TypeScript (`web/src/initiatives-exact-view.ts`). It reads only a typed input (`InitiativesExactInput`, `web/src/initiatives-exact-model.ts`), and every field is optional.

Design source: Design #76's extended copy, `~/company-lab/shared/initiatives-missing-states-2026-10-13/design/initiatives-desktop-interactive-extended.html` (sha256 `497c180eb2888b4d68c8584b5a5b9290166d267bc5acc85a0447cb6e0471058a`). It was built from the owner's upload, `~/company-lab/shared/initiatives-reference-2026-10-11/incoming/initiatives-desktop-interactive.html` (sha256 `0a1587f48083ef562b6b76fb6b1d4b9144537a28fbf402b0c5732184b88b7c9e`), and adds the 8 states the owner accepted on Oct 16 (dr-042fcf719eb0): empty, loading, server error, out of date, no access, old data, missing evidence, button failed.

Additions, in the design's own markup and style:
1. The "Roles in no initiative" box takes its heading and items from input (`loose.heading`, `loose.items`). The wiring task fills it as "Projects in no initiative · N".
2. A "Who's doing what" row can carry child task rows: the same row markup, indented 16 px.
3. A control whose callback is absent isn't shown: New initiative, Mark as read, Ask … to write it, Resume own work, Change lead, Message ….

**Expected, and how it's measured.** Unit tests in `tests/unit/initiatives-exact.test.ts`, run once with the Roles exact tests:
- A test-only fixture, converted from the design's 4 sample initiatives, renders the key strings: names, counts, filter pills, chips and tabs.
- An empty input renders the empty state.
- Loading, server error, out of date and button failed render their own words.
- A control without a callback is hidden.
- A missing or changed font fails the build.
- No design sample text is in the shipped files.

Beyond the unit tests:
- Roles: the Roles exact tests pass unchanged.
- One sealed screenshot of the fixture at 1440 × 1900 and 390 × 844, checked by eye against the audit's `desktop-initial.png` (no pixel gate).

**What would prove it wrong.** A Roles exact test fails, or had to change. A section of the design is missing or different in the screenshot. A drawn state can't be reached from input. Design sample data is reachable from shipped code. A control shows without its callback.

## Results

To be recorded after the checks.
