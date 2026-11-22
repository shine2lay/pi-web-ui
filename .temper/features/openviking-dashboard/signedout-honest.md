# Signed-out honesty (#321)

Superseded 2026-11-22 by Ops #1080 (owner Shine, `dr-c54a3286d823`): Memory has no sign-in or signed-out state any more; see [spec-explorer-owner.md](spec-explorer-owner.md). Kept as the record of #321.

## Hypothesis
Problem: refused reads wait for sign-in, so their loads still say Checking/Loading behind the box. Public health plus refused roots is marked degraded and falsely describes a read failure.
Change: use the existing owner access state to replace pending content with sign-in copy and distinguish signed-out health from actual signed-in failures. No server change.
Expected: after OWNER_ONLY, both open and dismissed sign-in show no Checking/Loading or unreadable-place claim; healthy public overview reads “Memory is up · sign in to see everything”. Signed-in genuine failed roots keep the warning.
Falsifier: any acceptance assertion fails, or signed-in recovery/retry loses its existing behavior.

## Checks
- Signed out, sign-in open: no Checking memory… or Loading memory… behind the box.
- Signed out, sign-in dismissed: same.
- Signed out with public healthy overview: no “couldn't be read”; exact sign-in health copy.
- Signed in with genuine root failure: retain “some places couldn't be read”.

## Result
HIT: failing-first run reproduced A and B (2 failed / 13 passed). Dismissed-box and genuine-root-failure controls already passed. After fix, wt check PASS (types/lint + affected tests; 96.7s). ui-check PASS for signed-out-open and signed-out-dismissed, each at 320/390/1440 light/dark, @2x screenshots under /tmp/memory-explorer-321. Existing waiting-read/session recovery behavior is unchanged.

No server change. File claims were attempted but rejected because this worker's tool is scoped to the RollCall project rather than the assigned pi-web-ui worktree.
