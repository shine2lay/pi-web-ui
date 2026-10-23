# Roles question actions (Ops #457)

Accountable lead: Ops. Standalone follow-up, not a reopening of the completed Roles-page project.

## H-ROLES-ANSWER-ACTION-1

**Wrong / evidence.** The exact view and shared question row show Answer only when the overview carries an inline AskHub target. The deliberate generic-dialog filter removes that target for permission, trust, budget and deletion dialogs, leaving only Open chat even when their exact original question route exists.

**One change / why.** Separate inline submission capability from a verified original-chat route. Keep the existing Answer form for supported current asks; label a verified native-chat handoff Answer in chat. Reuse UsefulOpenTarget and the existing chat-focus consumer. Re-resolve identity against the current projection on click, never against a row index or its text. Do not expand the dialog allow-list, submit on navigation, or add a backend answer path.

**Expected / measurement.** Fixed projection/controller/DOM cases and the sealed browser fixture must show the correct action on the page and department question surface, preserve complete ordinary/task/plan forms, and focus the exact native question when several share a chat. Missing, duplicate, changed, disappeared, paused, closed, lead-held or unconfirmed items must not acquire an owner-answer action. Offline/incomplete feeds keep truthful navigation only. Keyboard/phone checks and the unchanged sealed repository gate must pass. No real pending prompt is opened or answered.

**Falsifiers.** Wrong/missing focus, an action on an ambiguous identity, auto-submit, lost context, stale/wrong-question submission, or any weakened permission/visibility/revision/owner guard.

### Exact native-dialog limit

The existing native chat renders the oldest pending dialog; its ordinary question-focus consumer does not select a later generic dialog. A canonical `role:question:dlg-N` route therefore becomes Answer in chat only while the existing conversation summary identifies that exact `sessionFile` and oldest `dialogId`. A later dialog is not falsely labelled actionable: it explains that another question may come first and keeps Open chat. Once it is the oldest, the next summary makes its exact route actionable. Missing/duplicate summaries do not establish a route.

On arrival, the selected chat file and actually rendered native dialog id must both match; a window-owned dialog masking the chat also fails this check. Focus goes to the non-submitting container, never a choice. If the question changed in transit, a warning says that a different question may be shown. Disconnect drops the process-local focus request. No text/title/index matching, new endpoint, hidden choice or consent expansion is used. Generic permission/trust/sampling/budget/deletion dialogs remain excluded from inline Roles opening and submission.

Result: 251 focused regressions passed; the unchanged full gate passed (7,781 tests, build and PTY). The sealed synthetic browser passed 28/28 checks; the isolated native stage passed 13/13. Independent bounded routing/permission review found no issues. Counterfactual checks fail without the repair. Installed live look-only check pending.

### Browser fixture diagnosis (H-457-FIXTURE-2)

The first full browser run passed 26 checks, including permission rejection, exact first handoff, context, keyboard and phone fit, then timed out clicking the second native action. Unlike the existing answer helper, that step did not wait for the phone sheet to settle. Add the same recorded overflow/settlement wait (no timeout/assertion relaxation), plus a native-only fixed-input stage and bounded geometry diagnostics. Expected: the second pointer handoff and exact budget context pass; a remaining timeout falsifies this explanation and requires diagnosis from the measured geometry. No production change follows from this hypothesis alone. HIT: the corrected full fixture passed 28/28, including the second handoff; the isolated native stage passed 13/13. The wait matches the existing phone-sheet helper and changes no production behavior or time/assertion limits.

## Rollback

The rollback is the inverse of this frontend/documentation patch, applied to the then-current branch, landed normally with the unchanged checks, and installed with pi-web-deploy. Verify inverse application and restoration before landing. Do not install an old snapshot over newer unrelated work. No setting, queue, decision, chat file, server policy or schema migration changes.
