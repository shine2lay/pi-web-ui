# Ops #1085: Stop ends a waiting question at once; a force-reset leaves no question behind

Owner Shine, 2026-11-24 (Ops home chat m104239): "why cant i stop coo lead's chat, it seems to be stuck for the
past 13 hours".

## Hypothesis (rule 14)

- **Problem and evidence:** COO's chat sat in `ask_user_question` on a "For Wai" dialog that Shine's windows never
  show. Stop (`session.abort()`) fired the tool's abort signal, but the tool handed `askUser` only a snapshot
  (`{ aborted: signal?.aborted }`), so the wait never heard it; Stop then waited `HARD_ABORT_TIMEOUT_MS` and
  force-reset the chat (journal 16:34:03 / 16:34:11). The force-reset closed the chat's extension dialogs only
  (`conv.dialogs.cancelAll()`), so the question stayed in the shared question list and the list of asks: the
  Roles page kept "Waiting on the owner: since 03:19 (14 h ago)".
- **One change:** the tool passes its abort signal into `askUser`; an abort while the question waits ends it at
  once (taken off the list, settled `gone` in the list of asks, `question_retracted` to every window, chat list
  pushed, the call fails `ask_user_question aborted`), and the listener is dropped whenever the wait ends. A split
  call (one dialog per owner, #1079) aborted mid-wait fails as a whole and closes every owner's open dialog.
  `forceResetConversation` also cancels the chat's waiting questions and permission prompts.
- **Expected result + measurement:** `tests/unit/stop-ask-question.test.ts`: an aborted single-owner call
  rejects within one tick with 0 entries left in the question list and the list of asks, one
  `question_retracted` per window; a Shine + Wai split call aborted after Shine answered rejects with
  `ask_user_question aborted` and leaves 0 open dialogs; a force-reset leaves 0 waiting questions, approvals and
  asks for that chat; the signal keeps 0 abort listeners after each wait ends. Red on `4db97131`, green after.
- **What proves it wrong:** any of those tests still red after the change, any existing ask/answer/cancel test
  (`ask-question-owners`, `owner-question-*`, `ask-user-question-tool`) going red, or a live Stop on a chat
  waiting on a question still taking the force-reset path.

## Result

HIT (pre-land; deploy receipt in `~/ops-checks/stop-cancels-ask-question-1085/proof.md`).

- Red before: on `4db97131`, 5 of the 6 new tests fail (Stop leaves the call "still waiting"; the force-reset
  leaves the question waiting); the browser-cancel test passes on both, as it should.
- Green after: 6/6, and `ask-question-owners` 10/10 unchanged.
- Bites: without the force-reset cancel, without the split-stop throw, and without the listener drop, each one's
  tests go red again.
