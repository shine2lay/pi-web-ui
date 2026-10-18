# Initiatives: the supplied design as an inert, data-driven view

Owner, Oct 18 (Ops home chat): "now lets plan for initiatives page to show all the planning work"; dialog answer "Your design, 1:1". Ops #224, project initiatives-page. Accountable lead: Ops. This change lands inert: nothing mounts it. The wiring task fills it with real data and ships it.

## H-INITIATIVES-EXACT-1: hit (see Results below)

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

**H-INITIATIVES-EXACT-1: HIT** (2026-10-18). Landed on mine as `bced3635` (wt land request 29-3c4e9f), inert: nothing mounts it.

- Design files: both sha256 matched before extraction. `node scripts/extract-initiatives-template.mjs --check` confirms `surface.html` is what the script writes.
- Focused tests, 22:13 UTC (`TZ=UTC scripts/sealed.sh npx vitest run tests/unit/initiatives-exact.test.ts tests/unit/roles-exact.test.ts tests/unit/roles-exact-assets.test.ts tests/unit/roles-u0.test.ts tests/unit/roles-u0-rgba.test.ts`): 5 files, 122 tests passed.
  - `initiatives-exact.test.ts`, 14 of 14: the sample's key strings, selection, tabs and filters, child rows indented 16 px, the empty state, the 7 other drawn states, hidden controls, no sample text in shipped files, and a missing or changed font failing the build.
  - The Roles exact tests, 108 of 108 (roles-exact 87, roles-u0 15, roles-exact-assets 3, roles-u0-rgba 3), passed unchanged. The commit changes no Roles test and no Roles template.
  - Two earlier tries of this run failed in the new test file itself: jsdom gives `import.meta.url` no file URL, and one matcher expected spaces the binder doesn't keep. Only the test file changed for them.
- Typecheck (server, web, tests) clean; oxlint found nothing in the new files; prettier clean.
- Roles unchanged: `bindSurface` is Roles' old binder, moved. The only differences are the options each page passes (its name in error messages, its template, chip and frame style), and `bindRolesSurface` passes Roles' own.
- Look (`scripts/initiatives-exact-shot.mjs`, sealed, fixture input): `~/kept-from-tmp/2026-10-18/initiatives-exact/desktop.png` (1440 × 1900), `phone.png` (390 × 844) and `phone-full.png` (390 wide, the whole 4209-px page).
  - By eye, `desktop.png` is the design's `desktop-initial.png` and `phone.png` its `narrow-390x844.png` (both in `~/company-lab/shared/initiatives-reference-audit-2026-10-11/`). For the record, not a gate: 0 of 2,736,000 and 0 of 329,160 pixels differ.
  - The frame has `sandbox="allow-same-origin"`, no scripts, and the design's 32 font faces; Geist 600 and Geist Mono 500 load.
- Landing gate (`scripts/check.sh --fast`): the second land passed, 431 files, 6181 tests passed, 6 skipped.
  - The first land (26-5d10c0, 15:42) failed on one Roles test, "omits the helper row through updates without hiding real ON YOU markers or panels". It ran past vitest's 5-second limit (5848 ms) while the machine was busy: 5-minute load average near 16 on 20 cores, with another full run of the suite beside it. None of its checks failed.
  - The same test took 939 to 1072 ms in four other gates that day without this change, 586 ms run alone on this branch, and 859 ms in the second land. So it was load, not a Roles change.

Findings for the wiring task:
- Chrome logs "Blocked script execution in '…' because the document's frame is sandboxed and the 'allow-scripts' permission is not set." once for each event attribute in the template (17) when the binder parses the template inside the frame. Nothing runs: the binder attaches its own listeners from the host. The live Roles page already logs the same line 29 times, through the same code. Left as is, because the binder is shared and Roles must not change. The fix would be to parse the template in an inert document outside the frame. The look script expects exactly 17 and fails on any other console error.
- One step differs from the plan: `InitiativesExactView.tsx` has no ResizeObserver. Nothing in this design depends on the frame's size: its narrow layout is the design's own CSS, and the 390-px look matches. Roles needs one for its ring.
- Every build needs the 11 fonts in `~/company-lab/shared/initiatives-reference-audit-2026-10-11/embedded-fonts/`, or wherever `PI_INITIATIVES_DESIGN_ASSETS` points.
