# Roles answers: release existing work before the follow-up restriction

## Owner scope, 2026-10-17

The supplied Roles layout is live, but it still opens the original chat to answer. The separate tested answer implementation `d19f75fa` was not included because generic extension dialogs include permission, budget and deletion prompts, contrary to its original stated exclusion.

After that issue was explained, the owner said: “release it first then fix the issue”. This explicitly requests releasing the current manual-answer behaviour first and narrowing the permission filter afterwards. For the first release, eligible extension permission, budget and deletion dialogs can be answered on Roles. This is not authority for an agent to answer them, automatic approval, preset answers, reduced context, or bypassing the existing owner/session/revision checks. Built-in tool approvals remain outside this surface. The owner supplies the first real answer.

## H-ROLES-ANSWER-RELEASE-1

**Wrong / evidence.** The answer code exists and passed its earlier tests, but the installed exact Roles page has only Open chat. Importing the old useful-list component would also replace the owner's newly installed design.

**One change / reason.** Reuse the reviewed answer protocol, server routing, state and dialog from `d19f75fa`; connect them to the existing exact Roles inbox without replacing the template or its layout. Keep an Open chat route. Update the stated exclusion to accurately describe this explicitly requested first release.

**Expected / measurement.** The exact page offers Answer only for a current answerable item, opens its whole native form, submits only on a deliberate owner action, and retains fail-closed stale/revision/visibility checks. Existing answer tests plus synthetic exact-page integration tests and the normal sealed gate pass. Post-install inspection is look-only and does not answer a real ask.

**Falsifier.** Missing or clipped context; an automatic/default answer; a stale, hidden, paused or wrongly targeted item can be answered; the exact layout is replaced; or Open chat is lost.

**Result.** HIT in the sealed implementation checks: the complete normal gate passed (types, lint, formatting, all unit tests, build and 74 terminal checks), and the native exact-page browser fixture passed 17/17 checks. The existing layout remains mounted. Installation and the first real owner answer are separate checks; the latter is not performed by an agent.

## H-ROLES-ANSWER-FIXTURE-1

**Wrong / evidence.** The first adapted browser fixture reached the exact layout and fetched the complete native question, then timed out finding its Answer button. The static binder wraps pure text interpolations in spans: the locator's one parent was the title paragraph, not the enclosing item. The production template puts the buttons beside that paragraph, not inside it.

**One change / reason.** Select the item's title paragraph before taking its parent. This changes only the test locator, not the page or answer safeguards.

**Expected / measurement.** The fixture opens the same complete question through the exact page and proceeds through the existing manual-answer checks. **Falsifier:** the corrected item locator still cannot find the button, or opens the wrong item. **Result:** HIT — the sealed native-page browser fixture passes 17/17 checks, including question, owner-blocked task and plan answers, close-without-answer, full context, no preset answer, duplicate refusal and desktop/phone accessibility. The first normal gate stopped on formatting only, before unit execution; those formatting differences were corrected without changing behaviour.

## H-ROLES-ANSWER-FIXTURE-2

**Wrong / evidence.** The new controller unit fixture supplied an object for `focus`, but the real feed supplies a string such as `question:q1`. The existing boundary correctly withheld Answer for that malformed value. The real native-page browser fixture passed with the feed's actual format.

**One change / reason.** Correct the unit fixture to the actual feed format and assert that its initial Answer exists before exercising stale callbacks, so a missing callback cannot make those tests pass vacuously.

**Expected / measurement.** The controller tests exercise the new callback, keep the stale checks, and pass. **Falsifier:** a well-formed fixture still cannot answer, or a retained stale callback invokes the handler. **Result:** HIT — 61/61 controller and plugin-DOM tests pass in the required UTC environment. An initial isolated invocation omitted UTC and failed only the existing local-time expectation; no production code was changed for that invocation. The previous full gate's unrelated plugin-DOM worker console teardown error did not recur in isolation or in the final full gate. No production or plugin test change was made for it.

## H-ROLES-ANSWER-FIXTURE-3

**Wrong / evidence.** A repeat for screenshots raced the native decision recorder: the question resumed but the immediate file read found no owner record. `startDecisionRecords` resolves `decisionChatRoles` asynchronously before appending the receipt, independently of model resumption. The earlier run had happened to observe the completed append.

**One change / reason.** Wait up to the fixture's existing 30-second limit for the actual owner record before checking its identity, uniqueness and pi-queue acceptance. No production receipt handling changes, guessed record or relaxed assertion.

**Expected / measurement.** The same 17 checks pass, including the actual persisted browser receipt and matching dialog receipt. **Falsifier:** no receipt within the limit, a duplicate/wrong-origin receipt, or native pi-queue rejection. **Result:** HIT: all 17 checks passed with the actual persisted receipt, and the synthetic desktop/phone screenshots were captured.

## Follow-up, after the first release

Apply the narrower generic-dialog allow-list (first-party queue plan titles only), leaving other extension permission, budget and deletion prompts in their original chats. Preserve ordinary native question forms and answerable owner-blocked tasks. This will be a separate checked change after the first release, as requested, not silently folded into it.
