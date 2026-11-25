# Ops #1088: an owner's answer to a question survives a restart, says who sent it, and fits a small phone

QA's final check of non-blocking questions (QA #243, `rm-49dc1076`, 2026-11-25) found three defects on `374a3a30`.

## Hypothesis (rule 14)

- **Problem and evidence:**
  - D1: when the asking chat is busy in a turn, the wake (the owner's answer as a message) goes into pi's in-memory
    follow-up queue and `deliverRoleMessage` returns `{ ok: true }` at once; `deliverWake` then dropped the card
    from `pending-questions.json`. A restart or crash before the busy turn ended lost the answer: QA's
    `qa_busy_restart.mjs` gave `wakeLines: 0` on "restart" and "crash".
  - D2: the wake reached the model without `[From: <owner>]` and the transcript without `sentBy` (rule 37).
  - D3: at 320x568 the two-row footer (Later + Cancel question, Previous + Submit answer) sat over the answers:
    first option at 363-399 px, footer top at 290 px (QA's screenshot).
- **One change per defect:**
  - D1: the card stays `delivering` on disk until its wake is in the chat's transcript (the wake's user
    `message_end`, watched by `server/question-wake-admission.ts`); at start-up a `delivering` card whose wake is
    already in the transcript (stopped between the write and the file update) ends with no second send, any other
    one is replayed once behind the chat's resumed turn.
  - D2: answered and cancelled cards keep their answerer's `sentBy` (the web window's person, else the card's
    owner, from `people.json`); the wake goes in through `prompt`'s existing `sentBy` path (`sent-by-message.ts`:
    transcript `sentBy` + `[From: <name>]` first for the model). COO's hand-back carries none.
  - D3: one-question cards show no disabled Previous button, and phones up to 420 px wide get a tighter card and
    footer, so the footer fits one row; on a short phone screen the collapsed goal pill steps aside while a
    question is open. (The planned `max-height` raise was not the limit: in the real app the card is squeezed
    between the goal pill and the composer, never reaching its 45vh cap.)
- **Expected result + measurement:**
  - `tests/question-busy-restart-test.mjs` (sealed server, mock model): restart, crash, restart-after-turn-ends,
    Wai's own card and Shine's cancel each give 1 wake line, 1 woken reply, `from` = the owner, transcript
    `sentBy.name` = the owner, card gone; restart and crash show `delivering` on disk while the turn runs.
  - `tests/unit/question-wake-durability.test.ts` (13): the card stays on disk until admitted, start-up replays
    once and never when the transcript holds the wake, `sentBy` kept and checked, none on COO's hand-back.
  - `tests/question-phone-fit-test.mjs` (real app, 320x568 @2x, dialog + reopened, light + dark): first option
    bottom <= footer top, question view >= 120 px; ui-check 320/390/1440 light + dark exits 0.
- **What proves it wrong:** any of those red after the change; any NB-1..NB-7 or sealed question suite red; a
  live answer to a busy chat still missing after a restart.

## Result

HIT (pre-land; deploy receipt in `~/ops-checks/nonblocking-ask-question-1088/proof.md`).

- Red before (`374a3a30`): busy-restart 18 checks fail (restart + crash: 0 wakes, card gone while busy; every case
  `from=none`, `sentBy` null); unit 7 of 13 fail; phone-fit 4 of 4 fail (option under the footer).
- Green after: busy-restart all pass; unit 13/13; phone-fit dialog option 265-301 vs footer 330 (view 250 px),
  reopened 238-274 vs 330 (view 235 px).
- Deviation from the plan, on purpose: closing a chat or a force-stop does not drop a `delivering` card. The answer
  was already given; dropping it would lose it. The chat keeps its transcript, so the wake still goes in once.
