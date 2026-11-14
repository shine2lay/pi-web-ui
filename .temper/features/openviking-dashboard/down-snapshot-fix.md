# Memory outage snapshot fix (#320)

## Hypothesis
Problem/evidence: QA #153's memory-down look item differs from spec-states.md and design.md. The load hook already keeps same-key data, but the health label lacks last-seen age, search stays enabled, and withheld audit is mapped to an empty list. No live recheck occurs after initial load.
Change: preserve loaded data, recheck health/roots/recent on window focus, disable searching and writes when health is not answering, and map withheld audit to the sign-in message.
Expected: after a successful load then a failed recheck, existing recent/results/note and tree remain; health reports last-seen minutes and writes/search disable. First-load failure remains a load error. Withheld never reads as no changes.
Falsifier: any snapshot disappears or a withheld answer appears empty in the fixed acceptance cases.

## Acceptance evidence
Before fix: tests/unit/memory-explorer-down.test.ts: 4 FAIL, 1 PASS (first-load error). Tests cover recent/results/note snapshots, age, search and write disabling, and withheld via the HTTP adapter.
After fix: HIT. The five new regression cases passed. Full typecheck passed. `wt check` PASS (types/lint, affected tests, AST/domain, 500-line cap, no fixtures, single owner, delete/no-shim). `ui-check` PASS on down-after-load and withheld at 320/390/1440 light+dark; reports and @2x images: `/tmp/memory-explorer-320/`. Existing health-label assertions updated to the approved wording. Initial focused suite found one remaining old-label assertion; corrected, then the full affected-test gate passed. `doc-check` PASS.

## Scope
No server changes. No new prototype-only production paths. Browser fixtures remain in the external test harness. Backend owner_events type is present in this branch.
