# Roles: recorded next action

Owner approved this sequence in Ops home chat: fix the two display bugs, then task requester/next-action data, then question-delivery tracking. Display fixes shipped in 395e0191. Ops is accountable. This change is D1 only: use existing structured queue records; requester and contact recording are later changes.

## H-ROLES-NEXT-1 — HIT for recorded data; initial labels corrected below

**Wrong and evidence.** The actual Roles layout still renders `nextShort` as “Not recorded” even for a task whose native queue record says it is waiting for a check, another task, a named department or an answer. New task chats no longer write TL;DR lines, so their progress line can also be blank or inherit the role home's unrelated latest line. Architecture's source review (rm-9d2a6096; `/home/shinelay/architecture-dept/reviews/roles-data-steps-2026-10-17.md`) identifies the existing typed sources.

**One change.** Project a closed, optional next-action value from the existing queue state into Roles and render it as plain text. Where a task lacks its own TL;DR, show a labelled recorded queue milestone and its recorded time, never an inferred work claim. This is the existing add/start/wait/block/pause milestone, not a claim to know the latest arbitrary queue edit; asking has no retained timestamp and does not invent one. Preserve the native task's current status, pause, dependency and question routing. Do not parse plans, assistant prose, question marks or approval records to invent a requester or next step.

**Expected and measurement.** Fixed cases cover ready dependencies, waits, department blocks, generic blocks, lead/main/owner questions, pauses, working, done/dropped, missing/invalid fields and old records. Render the supplied role words only through the existing bounded plain-text projection; reject unsafe controls as the existing view does. Chat paths and check commands are not copied into these fields. Working tasks without an explicit next step say it is not recorded. Paused work says it awaits the owner's resume, not that the role should bypass the pause. No new tool, model call, producer, watcher, permission, task mutation, resume or routing change. Normal full gate once after implementation, a sealed actual-page proof and a final look-only check after installation.

**Falsifiers.** A claimed action or actor absent from recorded state; an unrelated home line presented as task progress; changed queue semantics; unsafe text rendered; an old/partial record crashing or becoming an invented action; or a real chat/task action during checks.

## H-ROLES-NEXT-2 — HIT: keep next actions distinct from dependencies

**Wrong and evidence.** The first full gate passed (413 files, 6,028 tests; 6 skipped) and the sealed component proof passed 14 checks. Manual review of `roles-next-action/browser/next-action.png` nevertheless found rows labelled “Depends on: Next: Recorded wait…”. The controller reused a dependency-only template row for every next-action kind. The values were recorded, but their visible label was misleading.

**One change.** Add a conditional next-action text row beside the existing dependency fallback. Populate exactly one of those rows: validated next-action data uses “Next:”; older records with only a wait reason keep “Depends on:”. No new data, actions or layout styles.

**Expected and measurement.** Add negative assertions that neither a wait nor any other next-action row is prefixed with “Depends on: Next:”. Check the old-record dependency fallback, and rerun the changed unit and sealed component checks. A next action still labelled as a dependency, a lost legacy wait reason, or any invented action disproves this correction.

## Boundaries

- No requester recording or backfill in D1. Approval is not a requester.
- No owner-contact tracker or transcript scan in D1.
- Existing source-origin/contact machinery stays inert.
- No extra model steps. A working task's unrecorded next action stays unknown.
- Original layout and direct-answer safety checks stay unchanged.
- Old clients and old queue entries remain compatible through optional fields.

## Validation

After the label correction, the final normal gate passed: 413 test files, 6,028 tests passed and 6 skipped, production build and 74 terminal checks. The sealed actual-component proof passed, including the negative dependency-label assertion and the old-record fallback. Evidence: `/home/shinelay/kept-from-tmp/2026-10-17/roles-next-action/checks/final-check.log` and the same evidence directory's browser captures. Security's source review and the installed look-only check remain pending at this commit.

## Release on the current layout

This is the existing D1 change applied to `db847d3d`, which already includes the owner's helper-row removal and floating header. The only merge conflict was the patch ledger: retain both existing layout entries and this data entry. The next-action producer and closed projection are unchanged.

Security passed the original D1 producer/projection in `rm-fb4bb7d9` (tree `06a8b36d`). The subsequent H2 text-row correction above fixes its optional misleading dependency-label finding. The final delta is sent for a focused review; the source-only verdict does not replace release checks.

The owner then asked for minimal checks and small releases, fixing further issues as they appear or in a follow-up pass. For this integration: build, the mandatory landing gate, and one installed smoke check. Do not repeat the prior full-browser/reference rounds. Expected result and falsifier remain H1/H2 above; no extra feature or data recording is introduced.

## Rollback

Use `pi-web-deploy rollback` to return to the previous installed build. This change only reads existing records and adds optional display fields; it performs no data migration.
