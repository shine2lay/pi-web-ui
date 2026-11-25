# Ops #1086: ask_user_question never holds its chat's turn

Owner Shine, 2026-11-24 (decision `dr-36efc6499afe`, Ops home chat m104294 + m104310): picked "Non-blocking
everywhere (Recommended)", so an unanswered pop-up never keeps a chat's turn running or blocks other owners and
departments. Rule 18 Task 1 of 2: the seam, the durable store and the failing-first acceptance cases. Task 2 wires
`ClientSession`, migrates the old tests and deploys.

## Hypothesis (rule 14)

- **Problem and evidence:** `ask_user_question` waits inside the tool call until someone answers. COO's chat sat
  13+ hours on a "For Wai" card Wai never answered: the turn stayed running, so Shine's messages and every
  department's role messages to COO queued behind it (`dr-36efc6499afe`; Ops #1085 made Stop end it, but nothing
  ends it without Stop). With no Telegram listening, closing the last browser window, or 30 s with no window, ends
  the card as cancelled (`ASK_USER_NO_CLIENT_ERROR`); a restart loses every waiting card.
- **One change:** the tool posts one card per owner, keeps each as `waiting` in `<dataDir>/pending-questions.json`
  (`server/pending-questions-store.ts`) and returns at once with `formatPostedQuestionsResult` (no
  `details.answers`, so no early decision record). An answer, a cancel in the browser or COO's hand-back settles
  the card (`delivering`, recorded before anything is sent), and its wake (`questionWakeOf`) goes into the asking
  chat as a new message from the card's owner (`[From: <owner>]`, turn owners `[owner]`); the card leaves the file
  only once the chat admitted it. A restart puts `waiting` cards back on every surface and replays `delivering`
  ones once.
- **Expected result + measurement:** the acceptance suite (now `tests/unit/nonblocking-ask-question.test.ts`; at
  first run with its own config, both moved by Task 2) NB-1..NB-6, 10 tests, red on `6cece0d5` and green after
  Task 2; `tests/unit/pending-questions-store.test.ts` 13/13 green now.
- **What proves it wrong:** any NB case still red after Task 2 or weakened to pass; a live COO turn still running
  while a card waits; a card lost or answered twice across a `pi-web-deploy` restart; an answer that reaches the
  chat without its owner's name.

## Design (the seam)

- Store: atomic JSON (0600 temp file, fsync, rename). Key = the card's tool call id (`toolu_1`, or `toolu_1#Wai`
  for one owner of a split call) + a content hash. Same id and hash: no-op, the kept card handed back. Same id,
  other hash: `PendingQuestionConflictError`, nothing written. An unreadable file is refused loudly, never
  overwritten.
- Life: `post` (waiting) -> `settle` (delivering, with the resolution) -> `admitted` (gone). `drop` ends a waiting
  card with no wake (chat closed or force-reset, `cancelChatAsks`). First settle wins.
- `ClientSession` gets `static pendingQuestionsHost` (`{ store, deliver }`, set by `AgentService` with delivery
  through `sendRoleMessage`: runs now when idle, queues behind a busy turn, opens a closed chat) and
  `static restorePendingQuestions()` (start-up; idempotent).
- Closing the last window (`cancelPendingQuestions`) no longer cancels a durable card; no 30 s no-browser refusal.

## Falsifiers in the acceptance cases

| Case                                                            | Red on 6cece0d5 because                 |
| --------------------------------------------------------------- | --------------------------------------- |
| NB-1 return at once, card kept as waiting, no answers           | the call is still waiting for an answer |
| NB-2 Wai's card waits, Shine's next turn posts at once          | same                                    |
| NB-3 browser and Telegram answers wake the chat as the owner    | same                                    |
| NB-4 no browser, last window closing, restart                   | same; `restorePendingQuestions` missing |
| NB-5 browser cancel wakes, chat close doesn't, COO return wakes | same                                    |
| NB-6 Shine + Wai cards end on their own                         | same                                    |

The harness was checked against the real code with the wait bypassed: windows, owners, Telegram set, retraction
and decision records hold today; only the store, wake and restore assertions fail, as they should.

## Obsolete in Task 2 (rule 23: delete, no shims)

- `singleOwnerResult` / `splitResult` answer texts in `server/ask-question-owners.ts` (the call no longer returns
  answers) and the no-browser grace timer in `ClientSession.askUser`.
- `tests/unit/stop-ask-question.test.ts` cases that expect Stop to end a waiting call (no call waits now): retarget
  or delete; the force-reset case becomes NB-5's "chat closing" case.

## Result

Pending Task 2. Red log: `~/ops-checks/nonblocking-ask-question-1086/red-6cece0d5.log` (10 failed of 10).

**HIT (Ops #1087, Task 2), before the live install.** The cases moved into the unit run
(NB-1..NB-6 unchanged; their own config deleted, the unit run picks them up) with NB-7 added for Keep for later
(Shine m104353), red first (`~/ops-checks/nonblocking-ask-question-1087/`): NB-1..NB-7 green, plus the dialog/bar
tests and the migrated question unit and sealed browser suites (`question-bridge`, `telegram-answers`, `takeover`,
`remote-answer`, `questionnaire`, `roles-answer`, `carry-on-restart`). The live half (COO's chat free while a card
waits; a card kept across the `pi-web-deploy` restart) is recorded in Ops #1087's proof file, next to its red log.
