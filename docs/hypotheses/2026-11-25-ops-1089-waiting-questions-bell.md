# Ops #1089: a top-bar bell for the questions waiting on you

Owner Shine, 2026-11-25 (Ops home chat m104486: "We need a way to see questions waiting for us tho", m104524: "Top
bar maybe a notification icon ?"). Rule 18 Task 1 of 2: the protocol seam, the one projection module and the
failing-first acceptance cases. Task 2 wires the server push, the bell, its Answer dialog and the "?" on saved
chats, moves the cases into the unit run and deploys.

## Hypothesis (rule 14)

- **Problem and evidence:** since Ops #1087 a question never holds its chat, and "Later" tucks it away. A tucked
  question, or one from a chat that isn't open, is only findable on the Roles page (role chats only; a regular
  chat's question isn't there), in its own chat's one-line bar, or on Telegram. The chat list's "?" shows only for
  open chats. So a question can wait for hours with no place in the window that lists it.
- **One change:** one list per owner: every window gets `owner_asks` (that owner's waiting asks from any chat:
  role or not, open or closed, kept for later), shown behind a bell on the top bar with a count; an Answer dialog
  answers in place (`owner_ask_open` / `owner_ask_answer`) through the same form checks as the Roles page; saved
  chats with a question waiting get the "?" too (`SessionSummary.hasQuestion`).
- **Expected result + measurement:** `tests/waiting-questions-bell-acceptance.test.ts` WQ-1..WQ-6 (7 tests) red on
  `8629275e` and green after Task 2 with no assertion weakened; `tests/unit/owner-asks-feed.test.ts` 9/9 green now.
- **What proves it wrong:** any WQ case still red after Task 2 or weakened to pass; one owner's bell showing, opening
  or answering the other owner's ask, or an ask held for COO; a bell count that differs from the asks waiting (an
  ask ended elsewhere still listed); an answer from the bell that reaches its chat without the owner's name.

## Design (the seam)

- Protocol (in `server/owner-question-protocol.ts`, re-exported by `server/protocol.ts`, which keeps its size):
  `UiOwnerAskItem`, the server messages `owner_asks`, `owner_ask`, `owner_ask_result`, the commands
  `owner_ask_open`, `owner_ask_answer`, and `hasQuestion` on `SessionSummary`. Additive, so no protocol version bump.
- `server/owner-asks-feed.ts`, the only place these rules live:
  - `projectOwnerAsksForViewer(asks, viewer, lookup)`: drops asks held for COO and another owner's
    (`askHiddenFrom`), adds `later` and the asking role from the caller's lookup, `answerable` when `askViewOf` gives
    a form, plain one-line title and summary (paths cut to their last part), newest first (`createdAt`, then id).
  - `openOwnerAskForViewer` / `answerOwnerAskForViewer`: reuse `askViewOf` and `answersFromPage` from
    `server/roles-asks.ts` against the list of asks itself, so a regular chat's question works as well as a role's,
    open or closed. Another owner's or a held ask is refused as "no longer waiting" (a window can't tell it from a
    gone one); a changed ask (revision) is refused; the answer goes in as answered in the browser by the window's
    owner (`asAnswerer`), so the decision record and the chat's `[From: <owner>]` wake name him.
  - `sessionsWithQuestionsFor(rows, asks, viewer)`: new row objects marked per owner; the shared history rows are
    never marked in place.
- What Task 2 adds to `ClientSession` (the acceptance cases call these): an `owner_asks` push to every window of an
  owner on each change (appeared, released, answered, gone, kept for later or brought back, restored after a
  restart), `ownerAskOpen(reqId, askId)`, `ownerAskAnswer(reqId, askId, revision, answers)`, and the `sessions` rows
  through `sessionsWithQuestionsFor`. In the web app: `host:questions` in `BUILTIN_UI_ITEMS` (end of the bar, icon
  `bell`) and in `LATE_TOPBAR_ITEM_IDS`, and `buildLeadBar` counting saved chats with a question under All chats.
  `server/agent-service.ts` must not grow: the push and handlers go in a side module.

## Falsifiers in the acceptance cases

| Case                                                             | Red on 8629275e because                |
| ---------------------------------------------------------------- | -------------------------------------- |
| WQ-1 regular + role chat, kept for later, listed after a restart | no `owner_asks` is pushed              |
| WQ-2 each owner's own asks only; COO-held wait until let through | same                                   |
| WQ-3 answer in place: record, wake as Shine, item gone           | `ownerAskOpen` / `ownerAskAnswer` gone |
| WQ-4 cancel, Telegram, in-chat answer leave every window's bell  | no `owner_asks` is pushed              |
| WQ-5 bell slot on the bar, the last to fold on a small phone     | no `host:questions` item               |
| WQ-6 "?" on a saved chat for its owner only; leads view count    | no `hasQuestion`; count ignores rows   |

The harness (`tests/fixtures/owner-bell-windows.ts`) was checked against a throwaway stand-in wiring of the feed
module: WQ-1..WQ-4 and the server half of WQ-6 went green; only the web-side cases stayed red, as they should.

## Result

Pending Task 2. Red log: `~/ops-checks/waiting-questions-bell-1089/red.log` (7 failed of 7).
