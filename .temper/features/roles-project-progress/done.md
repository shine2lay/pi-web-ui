agreed_with_qa: 2026-11-26

# Done list: roles-project-progress

The four original [brief Acceptance Checks](brief.md#acceptance-checks), verbatim, agreed by QA lead in rm-c475f357. Unchecked means the complete criterion is not yet established by the available evidence; it does not mean every part failed. No new owner agreement or acceptance gate.

- [ ] Novega-style data with 1 of 6 milestones met and 19 completed tasks in 14 days shows both distinctly, with actual milestone names; neither 19 tasks nor current work changes the 1/6 completion measure.
- [ ] The closed card makes completed milestones, current work and known next/blocker legible; real parallel tasks remain parallel. Details expose the source milestone/task names and blocker owner without fabricated mappings.
- [ ] Missing milestone data or next-step evidence is labeled honestly; a failed read is not rendered as zero progress or success. Finished, active, blocked, waiting and no-active-task projects remain distinguishable using existing recorded state.
- [ ] At 320/390/1440px in light/dark, no overflow/overlap or console errors; keyboard-accessible detail disclosure retains full labels. Frozen components and existing controls behave unchanged in Live versus Proposed comparison.

## Contract and evidence bounds

- Contract: [spec.md](spec.md), [shared case coverage](spec-acceptance.md), [good cases](good.cases.json), [refused twins](bad.cases.json), and [Changed/Frozen manifest](spec-scope.md). All four original criteria and all shared assertions remain unchanged.
- Builder source/tests: project-card implementation exists; consumer tests are `tests/unit/roles-project-progress.test.ts`. Builder assertions are not independent installed acceptance.
- Existing QA248 evidence: `/home/shinelay/qa-lab/roles-project-progress/PROOF-TABLE.md`, `CASES.md`, `PROVENANCE.md`, `FINDINGS.md`. QA found no reproducible card truth/order/disclosure/keyboard/freshness defect in exercised runtime paths, but explicitly did not accept the whole feature. Installed fault-state and some Frozen paths were unexercised; those bounds remain open.
- QA248 N1 is an existing host restart-notice defect, not a project-card regression. Frontend #373 repairs only that notice and supplies a failing-first component/browser test, `tests/notice-toast-ui-test.mjs`, using synthetic restart text. Its builder proof is not a live service or specialist-runtime proof.
- Ops #1129 owns normal deploy and the same existing QA248 installed native-click addendum. Until that receipt and the outstanding whole-criterion coverage exist, all four boxes remain unchecked. Historical Design approval/look and QA's scoped evidence are not expanded by this document.
