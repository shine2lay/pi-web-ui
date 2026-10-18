# Roles: remove the introductory helper row

The owner asked to remove the row containing “ON YOU / the next step is yours”, the hover/click instructions and the Legend button. This supersedes the supplied design for that row only. It does not remove actual ON YOU markers on department cards, warnings, the You panel or any answering controls.

## H-ROLES-HELP-1 — HIT

**Wrong and evidence.** The owner says the introductory row is not useful. It repeats how to use the page and takes space above the graph.

**One change.** Stop rendering the helper/legend row in the actual Roles view. In the supplied reference template, `ready` gates only this row; the actual view will leave that gate off. Loading, graph data, actual owner-ask markers and the panels have separate bindings and remain unchanged. Keep the historical template and reference fixtures intact rather than changing the original drawings or their pixel baseline.

**Expected and measurement.** In loaded desktop and phone views, neither instruction phrase nor the Legend button is present in the rendered DOM. The graph still has all departments, actual owner-ask markers remain, and Ops/You panels still open. Unit checks cover loaded, disconnected and refreshed states. The actual-component browser proof covers desktop and touch, with screenshots after the row is removed.

**Falsifiers.** Any instruction/Legend control remains; removing it hides a card, warning, real ON YOU marker or panel; it returns after an update; or the implementation changes data, routing or answer permissions.

## Proof correction — badge boundary

The first browser check reached the new absence assertions, then failed the retained-marker assertion. Inspection showed that the real ON YOU badge is a sibling of the card button inside its positioning container, not text inside the button. The unit check also assumed an explicit aria-label, while the real button is named by its visible text. Select the actual Ops button by that text and inspect its card container in both proofs; do not change the rendered badge. Expected: the helper is absent and the existing marker is present. Removing the marker or restoring the helper must still fail the proof.

## Current check result

The independent release branch contains only the helper-row removal, not the pending next-action feature. Its full normal UTC gate passed: 412 test files, 5,997 tests passed and 6 skipped, production build and 74 terminal checks. Its actual-component browser proof passed all 13 checks, including no helper row on desktop/phone, retained ON YOU markers and working Ops/You panels. Screenshots were inspected. The installed look-only check remains after deployment.

Earlier attempts are retained: the first full gate caught the test's incorrect badge selector, not a production defect; a subsequent focused invocation omitted the suite's required UTC timezone and failed two existing time-label assertions. The corrected combined-development proof passed 14 checks; the independent proof has 13 because it excludes the new next-action case. Evidence: `/home/shinelay/kept-from-tmp/2026-10-17/roles-no-helper/checks/{independent-full-check,independent-browser}.log` and `roles-no-helper/independent-browser/`.

## Rollback

Revert this presentation-only commit, or use the normal `pi-web-deploy rollback` for an installed release. No data is written or migrated.
