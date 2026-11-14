# QA #153 bounded fixes (Design #319)

## Hypothesis
Problem/evidence: ChangesYouMade loads unconditionally; audit can answer while owner reads fail. Scope uses asked.query instead of the current input. The tree omits the server's notes_total summary.
Change: gate the audit load and panel on the canonical owner-access state; only protected successful reads establish that state. Use current query and mode on scope changes. Pass health.totalNotes (from tree/roots.notes_total) into the tree.
Expected: no audit or panel while unknown/signed-out; accepted owner reads unlock all-session changes; scope preserves draft words and searches only after a previous search; tree shows the supplied total, hides null.
Falsifier: any of those assertions fails in memory-explorer-qa153.test.ts.

## Failing-first evidence
2026-11-14: 7 assertions run; 4 failed (signed-out audit, Checking audit, scope draft overwritten, absent summary); 3 controls passed. Fixture has four roots, so expected place count corrected to 4 before implementation.

## Result
Hit: all 7 acceptance tests green after implementation; all 91 memory-explorer unit tests and full typecheck passed. ui-check signed-out/checking/signed-in/live passed at 320/390/1440 in light and dark (24 renders), reports /tmp/design-319-ui. Awaiting land/deploy and QA's final re-check.

## Scope
No /audit route change. Triangles, no magnifier/In label, monospace paths, and memory-down Couldn't load remain accepted as-is. 16c is covered by #317 (52e853d8). QA #153 owns final independent re-check.
