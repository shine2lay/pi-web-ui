# Ops #1091: the waiting-questions bell, QA #244's findings fixed

QA #244 (`rm-c5af76b5`) checked the bell built in Ops #1089/#1090 (`a7a716b6`) and found F1-F3, F5, F6 (F4 is
behaviour from before #1087, unchanged). This task fixes them, each with its own failing-first test (rule 33).

## Hypotheses (rule 14)

### F1: a window may answer, cancel or keep for later only a question it was shown

- **Problem and evidence:** QA's `qa_bell_ws.mjs` T1.9-T1.11b: from Wai's socket, `question_answer` (answer or
  `cancelled: true`, here or with `owner` for another window) and `question_later` with Shine's or a COO-held ask id
  went through: the card ended or was tucked away and the chat woke. `ClientSession.resolveQuestion` and
  `questionLater` never looked at the window's owner; the bell's own `owner_ask_*` commands do (`askHiddenFrom`).
- **One change:** one check, `windowMayAct(cardId, card, windowChat, viewer)` in
  `server/owner-question-surfaces.ts`: the card's ask still waits and `askShownToViewer` (the viewer's; one held for
  COO only in its own chat's window, as #685 shows it there). Used by `resolveQuestion` (the window's own
  `question_answer`), by `answerElsewhereQuestion` (checked as the window that sent it, not the window holding the
  card) and by `questionLater`. Plain `askHiddenFrom` would have refused the owner answering a held card on its own
  chat's page, which #685 allows. Who answered is already recorded
  from the socket's verified login (`asAnswerer` around every page message, Ops #973), so `from` stays `browser`.
- **Expected + measurement:** `tests/unit/waiting-questions-bell-guard.test.ts` T1.9-T1.11b: each forged command is
  refused with 0 cards changed, 0 wakes, 0 `answered` events (so 0 decision records); the owner's own still works.
  Red on `a7a716b6`, green after.
- **Wrong if:** any forged command ends or tucks a card; the owner's own window, Telegram, the Roles page or the bell
  can no longer answer.

### F2: Open chat on a saved question shows that question

- **Problem and evidence:** QA B7 (both engines): with `long1` saved for later in chat A and a live `m1` in chat B,
  Open chat on `long1` switches to chat A but the card shows `m1`. `ChatOwnerQuestion` returned the live question
  before it looked at the opened saved one.
- **One change:** `ChatOwnerQuestion` shows the opened saved question first; another chat's live question no longer
  covers this chat's saved-for-later bar; the snapshot's pop-up prefers the window's own chat's live question
  (`pickPendingQuestionForSnapshot(entries, activeId)`).
- **Expected + measurement:** unit (`nonblocking-ask-question-later-ui.test.ts`, F2 cases) and the sealed
  `waiting-questions-bell-ui-test.mjs` B7 in Chromium and WebKit: Open chat shows the saved question; Later shows its
  bar. Red on `a7a716b6`.
- **Wrong if:** a chat's own live question no longer pops up over its saved bar (NB-7), or B7 still shows `m1`.

### F3: the bell stays on the bar at 320 px in WebKit

- **Problem and evidence:** QA B10: at 320 px WebKit folds the bell into ⋯ (its chip is 117 px there, 111 in
  Chromium); Chromium keeps it. `fitTopbar` charges every item `width + gap`, so one gap more than the bar has.
- **One change:** measured first (below), then the gap accounting in `fitTopbar` fixed so items are charged only the
  gaps between them.
- **Expected + measurement:** `tests/unit/topbar-fit.test.ts` (the bell fits exactly when the bar's width equals
  the items plus the gaps between them; still monotonic) and the sealed ui-test's WebKit + Chromium 320x568,
  390x844, 1440x900 light + dark bar checks. Red on `a7a716b6` in WebKit 320.
- **Wrong if:** any width shows the bar wrapping or overflowing, or a narrower bar shows more items.

### F5 + F6: the fixed Answer case renders the real form; PATCHES.md paths resolve

- **Problem and evidence:** the harness's view had `revision: "r1"`; `projectRoleAsk` needs 64 hex characters, so the
  ui-check "answer" case measured "cannot be shown safely". PATCHES.md named the old acceptance file path.
- **One change:** `revision: "a".repeat(64)` and a check that the case shows the form's options and not that line;
  the old path dropped from the PATCHES entry.
- **Wrong if:** the answer case still shows the refusal, or doc-check counts a broken path in the #1090/#1091 entries.

## Results

- F1 HIT: T1.9-T1.11b red on `a7a716b6` (4 of 5 failing: forged later/cancel/answer went through), green after.
  One older check changed with it: #1051's "either owner's answer still counts" (Shine's window answering Wai's
  card) now asserts the refusal, per QA F1 and the plan (cross-owner refused both ways); Telegram unchanged.
- F2 HIT: unit F2 cases + `pickPendingQuestionForSnapshot` red on `a7a716b6`, green after; B7 red in Chromium on
  `a7a716b6` (card showed chat B's port question), green in Chromium and WebKit after.
- F3 HIT: a fresh WebKit load at 320 kept the bell on `a7a716b6` too (bar 172, ☰ 44 + gap 6 + bell 117 = 167);
  QA's path (narrow to 256, back to 320) is what folds it. Unit boundary test (167 fits, 166 folds) red on
  `a7a716b6`; narrow-and-back check added for both engines; see proof.md for its red/green.
- F5 HIT: "fixed case answer shows the real Answer form" red on `a7a716b6` (0 options, refusal shown), green after.
- F6 HIT: old path dropped from the #1090 entry.
