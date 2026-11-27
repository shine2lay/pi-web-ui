# Repair host recovery, staged packages and direct questions

## Problem and evidence
The approved incident repair identifies the three #1119 recovery-host commits as the hang source. Question routing currently holds ask_user_question cards when a role message starts the turn or owner input is over 30 minutes old. SDK resource reload reads scoped settings after reload, so applying only effective settings overrides cannot pin local packages.

## Hypothesis
Revert 1fdd45fc, 06f947c0 and e490271b without changing subsequent specialist, deadline or toast fixes. Resolve local project package sources to PI_WEB_ADDONS_DIR at the scoped settings read boundary, failing loudly on missing or unreadable targets without writing settings. Route every question directly while retaining existing dialog, approval and stuck routing.

## Measurement and falsifier
Record failing-first package and question visibility tests, then run the required protocol, type, format, sealed suite, worktree and documentation checks. Missing targets must throw, unset override must preserve behavior, and non-owner/old-owner questions must immediately appear in owner windows and the open asks list. Any fallback to mutable local packages or hidden new question falsifies the change.

## Gate follow-up hypothesis
The full suite found seven obsolete held-question assumptions outside the initially targeted routing tests. Replace only those assumptions with direct-card expectations or explicit legacy fixtures; owner isolation must remain asserted. Three Memory Explorer ancestry assertions failed under the full suite but all ten permalink tests passed in isolation without a code change; timing sensitivity remains a limitation until the full rerun. The existing routing document also fails doc-check at 517 lines/13376 tokens with four dead references. Condense it to the current contract, retaining behavior and removing obsolete history; doc-check must report zero cap/path violations.

## Scope and undo
No deployment, restart, live chat mutation or settings-file edit. Deployment belongs to #1146. Revert the new package/question patch to undo it; recovery-host removal must not be undone casually because it restores the reported hang.

## Result
Package seam: HIT. Before implementation the sealed test failed to import the absent module (exit 1); after implementation all four cases passed (exit 0), including SDK reload and removal of a staged target. Independent static review found no issues in the mapping, scoped getter boundary, settings persistence or factory coverage. The three recovery commits reverted cleanly as 8b69f2d6, 0b3076cc, da9fd3b6; bf49100b remains an ancestor and the recovery-host file is absent. Question routing: HIT. Three real ClientSession visibility regressions failed before the change; after it, 263 focused tests across 15 files passed sealed. Role-started, restarted and 31-minute-old owner turns are immediately unheld, visible in both owner windows, listed in the actual Questions feed and openable through its action. Existing held-record support is exercised through external legacy fixtures. Final checks passed on cdfe5fd6: protocol, typecheck, scoped formatting, full sealed suite with build and PTY checks, wt check and doc-check. The full rerun passed the unchanged Memory Explorer tests; no timing threshold was weakened. Routing notes now pass at 123 lines/1778 tokens with 11 valid paths. Land receipt is recorded separately in the task proof; no deployment in this slice.
