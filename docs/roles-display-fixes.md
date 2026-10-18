# Roles: restore normal contrast and show the content's receipt time

Owner direction, 2026-10-17: fix the two known display bugs first, then connect task requesters/next actions and the question-delivery tracker. Ops owns the work in the home chat. This change is only the first, display-fix step; it does not activate old tracking modules or add data producers.

## H-ROLES-FOCUS-1

**Wrong and evidence.** Design's review `rm-cc0eb8fa` found that closing a panel with the mouse returns focus to its opener, whose `onFocus` starts the same spotlight as pointer hover. Other role cards stay at 0.38 opacity. The installed controller clears hover before calling `origin.focus()`, so that call immediately reinstates it. This also dims last-known cards in the disconnected/stale screenshots.

**One change and reason.** Keep focus restoration and pointer hover. Start a focus-triggered spotlight only when the opener matches `:focus-visible`; ordinary mouse-returned focus should not spotlight the graph. Keyboard focus must retain its visible cue, and touch must not gain synthetic hover.

**Expected and measurement.** Fixed controller tests distinguish pointer, keyboard-visible focus and ordinary focus. The actual sandboxed component is exercised with mouse close and Escape, on both role and You panels; disconnected/stale screenshots are retaken with no pointer over a node. Ordinary cards return to their baseline contrast and last-known cards to their existing 0.8 opacity. Focus still returns to the opener and keyboard trapping still works.

**Falsifier.** Mouse close leaves unrelated cards at 0.38, keyboard focus loses its spotlight/focus, touch begins dimming cards, or a solution needs frame scripts or altered reference images.

**Result: MISS in the real browser.** The full initial gate passed, but the mouse-close browser case still left 14 cards at 0.38. The diagnostic showed no hovered card and the restored Ops button matching `:focus-visible`. Chrome can carry keyboard-style focus into a later mouse-close sequence, so that pseudo-class alone does not identify the close action. Initial and diagnostic evidence are retained separately under `roles-display-fixes/browser` and `roles-display-fixes/focus-diag/browser`.

## H-ROLES-FOCUS-2

**Wrong and evidence.** The H1 diagnostic distinguishes this from an actual pointer hover: only the restored opener has focus-visible, all hover flags are false, and the feed is Live.

**One change and reason.** Preserve the focus-visible check for normal focus, but explicitly distinguish keyboard panel closure from pointer/programmatic closure. While restoring focus after the latter, suppress only spotlight activation; keep focus restoration itself. Escape and a keyboard-generated close-button click retain keyboard spotlighting. No input listeners, layout changes or sandbox permissions are added.

**Expected and measurement.** Fixed tests force focus-visible to remain true during restoration and verify pointer versus keyboard closure separately. The actual browser repeats the keyboard-open/close then mouse-open/close sequence, including the You panel and unhovered warning-state captures.

**Falsifier.** A mouse-close still dims other cards, focus no longer returns, or a keyboard close loses its spotlight.

**Result: HIT.** The corrected actual-component proof passes all 13 checks. Mouse-close returns focus without dimming other cards, including after a keyboard-focused opening and for the You panel. Keyboard closure retains spotlighting; touch remains undimmed. Disconnected and stale captures retain the existing 0.8 last-known contrast. Evidence: `/home/shinelay/kept-from-tmp/2026-10-17/roles-display-fixes/final/browser/`.

## H-ROLES-RECEIPT-1

**Wrong and evidence.** The chip reads `heardAt`, but `receiveRoles` updates that value for errors and count-only/heartbeat payloads as well as full overviews. Consequently a failed first load displays a receipt time without any overview, and a later error makes older content look newly received.

**One change and reason.** Record a separate local `overviewReceivedAt` only when a full overview replaces the displayed content. Preserve it across counts, heartbeats and errors. The exact-page projection uses only this receipt, and displays “nothing loaded yet” when no overview exists or “receipt time unknown” when content exists without a usable receipt. Keep `heardAt`, server `checkedAt`, `appliedAt`, staleness and answer admission unchanged.

**Expected and measurement.** Fixed store/projection tests cover first error, full overview, later error/count/heartbeat, replacement overview, invalid/missing/future receipt and reset. Actual component checks show no fake receipt on first failure, preserve the chip through later non-overview updates, and keep normal supported answers and read-only retry behavior intact.

**Falsifier.** An error/count/heartbeat advances the content receipt, no overview gets a receipt, a bad receipt is accepted, or freshness/answer policy changes.

**Result: HIT after the test-oracle correction below.** Store/model and actual-component checks prove that errors, counts and heartbeats retain the overview receipt, replacement overviews advance it, and the first failed load says nothing loaded yet. The normal full gate passes 412 files: 5,996 tests passed, 6 skipped, build and 74 PTY checks. The browser proof passes all 13 checks. The earlier browser oracle incorrectly required the error-only `last received` wording after a valid heartbeat restores Live; that failed run remains recorded and did not require another runtime change.

## H-ROLES-RECEIPT-TEST-1

**Wrong and evidence.** The transport case always waited for an error banner and asserted `last received`. Existing `receiveRoles` intentionally clears the error and restores confirmation on a valid later heartbeat, and `freshText` then uses `Live · updated`.

**One change and reason.** Wait for the expected complete chip text: retained receipt with `Update failed` after error/count, and the same retained receipt with `Live · updated` after heartbeat. This tests the timestamp invariant without incorrectly demanding a persistent error state.

**Expected and falsifier.** All three chips retain the original overview time; any newer transport time or wrong state label fails.

**Result: HIT.** The corrected browser check observes the same overview receipt in all three cases, with the expected error/count and heartbeat labels. Full gate log: `/home/shinelay/kept-from-tmp/2026-10-17/roles-display-fixes/final/checks/full.log`.

## Verification and undo

Run the normal sealed full gate after the code/tests are complete and the affected sandboxed browser component check. Retain its warning-state screenshots and targeted mouse/keyboard evidence. No real chats, model payloads, real questions or answers are test inputs. Install through normal `wt land` and `pi-web-deploy` checks, then perform a look-only check. Undo is the previous installed `30c8017a` release; no persisted data changes require migration.
