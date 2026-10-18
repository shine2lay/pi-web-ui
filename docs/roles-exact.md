# The supplied Roles design, implemented first

Owner direction, 2026-10-17: implement the supplied Roles design 1:1 as the actual Roles page, before adding the missing data. No new design or separate prototype. Ops is accountable. This work continues in the owner's chat, in the isolated `roles-exact` worktree.

## H-ROLES-EXACT-1 — the existing template can become the real page without waiting for new tracking

**Problem and evidence.** The live page mounts `RolesUsefulView`, a useful list rather than the owner's supplied graph and expanding panels. The original markup and rendering machinery already exist in `web/src/roles-u0/`, but their old entry point requires a new, fully qualified tracking pipeline. Making that pipeline a prerequisite has kept the supplied interface unmounted. The approved reference set contains the seven original scenes and 31 additional states; the latter are listed in `roles-missing-screens-2026-10-13/SCREENS.md` in the shared design handoff.

**One change.** Reuse the supplied static template and its non-evaluating renderer, with a new presentation-only controller over the existing, checked `projectUsefulRoles` and `projectRolePanel` projections. Keep the old native-tracking contracts inert and unchanged. The new controller does not mint tracking receipts or pretend that the old feed is a new tracking producer. Mount the completed surface in the existing Roles tab, not a separate preview.

**Expected result and measurement.** The graph, typography, colours, spacing, expanding department and owner panels, legend, report toggle, activity tabs and phone panning match the supplied design with identical reference inputs. On real inputs, available information remains available, missing information is visibly unrecorded, and only existing safe navigation works. Check the reference template/geometry and screenshots at the supplied viewport sizes; test loading, stale, disconnected, failed and partial inputs, the complete owner-ask count, unsafe strings, missing values, selection removal, and keyboard/resize/unmount cleanup. No default zero or all-clear on an unconfirmed snapshot.

**Falsification.** A different layout, fabricated lane/message/progress data, a permission action escaping its chat, a false all-clear, a hidden existing ask, leaked chat path, lost navigation, or a reference screenshot mismatch is a miss. Record mismatches as such, never relax or mask them to claim a match.

**Status.** The app now mounts `RolesExactView` in this worktree, with the supplied static template, exact pinned fonts, and closed existing-data projections. It is not yet accepted, landed or installed. Unit cases and an isolated browser/reference harness are written; final checks follow the completed integration. No old tracking gate was enabled and no live service changed.

## H-ROLES-EXACT-2 — host-owned animation timers

**Wrong / evidence.** The first real-browser check mounts all 15 cards, but expanding Ops never enables panel scrolling. The isolated check-3 diagnostic records `overflow: hidden` after two seconds and Chrome reports blocked script execution in the sandboxed frame. Unit clocks did not reproduce this browser restriction.

**One change / reason.** Keep the iframe script-disabled and schedule its presentation callbacks on the host window instead of the sandboxed frame. The host already owns the controller; the frame does not need script permission to finish an animation.

**Expected / measurement.** The panel reaches its scrollable settled state within two seconds, then real pointer and keyboard checks complete. Closing/unmounting cancels the host callbacks. The sandbox stays `allow-same-origin` only.

**Falsifier.** The panel remains unsettled, navigation still cannot be clicked, or any check requires enabling frame scripts.

**Result: HIT.** The isolated browser completed all nine component checks with the script-disabled sandbox intact: settled panels, real pointer navigation, keyboard containment/Escape, safe inbox links, non-current states, overflow, structural accessibility, phone panning and teardown. The structural axe snapshot does not claim a live contrast audit.

## H-ROLES-EXACT-3 — compare the same empty-inbox input

**Wrong / evidence.** The first reference pass matched the main desktop, phone, loading and state-chip scenes exactly, but the empty-inbox scene differed at 112,551 pixels. The comparison harness passed `quiet`, which does not exist in the source model; the source's scenario is `empty`. This also removed the native status text and left source-only asks on cards, so the compared inputs were not equivalent.

**One change / reason.** Pass the source model's `empty` scenario for the empty-inbox frame. No application markup, pixel thresholds or reference images change.

**Expected / measurement.** The empty-inbox pair has zero differing pixels. The existing stale/disconnected corner-paint mismatches (20/26 pixels) stay reported separately, not hidden or converted to passes.

**Falsifier.** The corrected empty-inbox pair still differs.

**Result: HIT.** After correcting the input, the empty-inbox pair differs by zero pixels. Across the seven supplied original frames, five match exactly. The two remaining differences are the same 26-pixel disconnected and 20-pixel stale border-corner differences documented in `roles-renderer-u0-2026-10-13/DEVIATION-REGISTER.md` as R-P1. The owner previously chose to keep those pictures and accept the mismatch. The strict reference command still exits 1; this is not reported as a seven-frame pixel pass.

## H-ROLES-EXACT-4 — preserve the design’s status and existing-data details

**Wrong / evidence.** Design’s source review confirms the layout is complete, but failed/disconnected/stale states all use a neutral banner and lilac chip, disconnected lacks Retry, and timestamps/date are absent. Existing owner asks and role spending are also omitted from the graph and spending rows. These are existing-data presentation gaps, not missing producers.

**One change / reason.** Complete the presentation mapping: the source’s red failure/disconnection and amber stale palettes, read-only Retry/Refresh actions, honest last-received times and date, owner-ask lines only where a current ask is known, the source’s labels, and bounded validated own-work spending. Keep inter-role traffic and unrecorded fields absent. Show a fixed uncertainty reason when asks cannot be confirmed.

**Expected / measurement.** Fixed-input tests cover every status palette/action and time, safe existing-spend values and missing cases, current versus stale ask lines, copy and task omission counts. Browser checks include phone Ops/You/legend and real touch: opening/closing a card must not leave hover dimming behind. No inline answers or new data producers.

**Falsifier.** Failure/staleness still looks healthy, any new content overstates confirmation or fabricates data, a route changes, or touch leaves unrelated cards dimmed.

**Check in progress.** `check-8` passes all 11 real-component browser checks, including red disconnected/amber stale states, original-chat navigation, and actual touch Ops/You/legend checks. The seven reference pairs are unchanged (five exact, two accepted R-P1 corners). One new unit assertion selected every “Not recorded” span, including unrelated lane labels. Scoping to queue rows then counted 40 nodes: the 20 styled labels plus the renderer’s 20 nested `sc-interp` text spans (`surface.ts` preserves these from the source). The correction selects only direct queue-row spans and must verify all 20 requester labels are grey. Both failed runs are retained; this is an assertion correction, not a production change. The corrected focused unit set passes 35/35, including all 20 direct requester labels. H-ROLES-EXACT-4 is a presentation HIT on these fixed cases; the final gate and review remain separate. The supplied fixed-width phone layout still pans; the new phone screenshots make this visible rather than implying responsive panels.

## H-ROLES-EXACT-5 — bounded report lines keep the page available

**Wrong / evidence.** Security’s source-only GO notes that an otherwise valid 12,000-character report can contain over 1,000 lines, exceeding the renderer’s list bound and replacing the whole page with its failure state.

**One change / reason.** Bound displayed report lines before binding and include an explicit omitted-lines row. Preserve the renderer’s existing limit and plain-text handling.

**Expected / measurement.** A fixed report with more than 1,000 lines can be expanded without throwing, and its omission is visible. Ordinary reports remain unchanged.

**Falsifier.** The report still breaks binding, hides the omission, or changes normal report content.

**Result: HIT.** The unit case and actual script-disabled component both expand a 1,100-line report without failing; the first 200 lines and an explicit “900 more lines” row are shown. Ordinary reports retain their prior content.

## Check receipts

- Original candidate `ede451df`: final `TZ=UTC scripts/check.sh` passed (409 files, 5,871 tests, 6 skipped, build and 74 terminal checks). Evidence: `/home/shinelay/kept-from-tmp/2026-10-17/roles-exact/checks/final-check.log`. The first three stale `roleId` expectations and their correction are retained in the earlier receipts.
- Review corrections: the new full gate and requester-assertion correction are pending. Evidence: `/home/shinelay/kept-from-tmp/2026-10-17/roles-exact/checks/review-check.log`.
- Real component: 11/11 isolated browser checks pass after review corrections, with fictional inputs and no real chats. Evidence: `/home/shinelay/kept-from-tmp/2026-10-17/roles-exact/check-8/`, including phone Ops/You/legend, stale and disconnected images. Prior candidate evidence remains in `check-7/`.
- Corrected reference comparison: five of seven exact matches, with the two accepted R-P1 mismatches retained. Evidence: `/home/shinelay/kept-from-tmp/2026-10-17/roles-exact/reference-2/`. No replacement golden images or pixel tolerance.
- H-ROLES-EXACT-1 remains qualified: functional evidence is positive, but the strict pixel bar is a MISS at those two known corners. The 31 additional states are the design's coverage reference, not 31 claimed pixel passes. Full integration/design review and live look-only checks remain outstanding.

## Scope and boundaries

- Frontend first. No new producers, event stores, SDK hooks, model calls, workflow runs or changed queue semantics.
- Preserve the supplied layout. Missing data changes content, not the design's information architecture. Use fixed, honest missing/unavailable wording rather than invented sample data in the app.
- The older answer/spend candidate stays separate. This page initially opens the original chat to answer; no permission, budget, destructive or other inline approval is added here.
- Use checked presentation models. Chat targets stay in closures and go only through the app's existing navigation; they are never attributes or template text. No runtime HTML or script from data.
- No tests against real chats. Fixed synthetic inputs only for automation, normal sealed gate after implementation, and a look-only live check only after an authorised install.
- Owner, 2026-10-17, in the “Keep the exact Roles design” dialog: “you can build and ship it, dont need permissions for it”. This explicitly removes the owner's earlier permission-record prerequisite for this supplied design and authorises building/shipping it. It is not a claim that third-party licences were independently verified. Design confirmed the original source and 31 added states remain authoritative. Preserve exact font hashes; no silent font replacement.
- Font build inputs are the two hash-checked, already-extracted original files in the private design handoff, not a CDN or new font download. The build includes those bytes in the lazy Roles bundle. `PI_ROLES_DESIGN_ASSETS` may relocate that immutable input directory; missing or changed bytes fail the build. Nothing reads that directory at application runtime.
- Existing native/tracking modules stay inert. Do not switch on the old blocked integration package or inherit its permission claims.
- Installation requires the ordinary review, worktree landing and `pi-web-deploy` checks. Undo is the previous installed revision; the useful list remains in source while the exact surface is verified.

## Missing-data follow-up, not a dependency for the layout

Record gaps explicitly: task-lane occupancy, message directions and send/receive/processed receipts, task requester, completion stages, contacts/replies, loaded model/resources, configuration history, and requested-work spending. Existing reported role status, tasks, blockers, owner asks, reports, goals, progress and each department’s own-work tally may be displayed through their current checked projections; none is stronger evidence merely because the new design displays it.
