# Owner-question routing

## Current contract

Owner decision `dr-88854f3751a1` (2026-11-27), implemented by Ops #1144:
**every new `ask_user_question` card goes directly to its owner immediately.**
This includes turns started by roles, queued work, schedules or extensions;
restarted turns; missing turn records; and owner inputs over 30 minutes old.
No COO release is needed. Direct delivery does not bypass owner isolation.

Dialogs, tool approvals and queued-task cards keep their existing routing.
Legacy held-question records and their release/return behavior remain supported.
The change needs no hold-store migration.

## Routing decision

`server/owner-question-route.ts` owns the pure `ownerQuestionRoute` decision.
It reads only host-supplied facts, never question wording or model judgment.
With `ownerQuestionsViaCoo` enabled, the first matching rule wins:

| Order | Condition                                                           | Destination / reason                |
| ----- | ------------------------------------------------------------------- | ----------------------------------- |
| 1     | COO's own home chat                                                 | direct / `coo-chat`                 |
| 2     | Queued-task card (`kind=stuck`)                                     | COO / `queued-work`                 |
| 3     | Accepted owner input in this turn, last input under 30 minutes old  | direct / `owner-chatting`           |
| 4     | Question asked again after COO returned it in this turn             | direct / `asked-again-after-return` |
| 5     | Continuation-grant ask                                              | direct / `grant-not-routed`         |
| 6     | Any remaining `kind=question`                                       | direct / `question-direct`          |
| 7     | Dialog/approval in an owner-started turn, last input old or unknown | COO / `owner-away`                  |
| 8     | Remaining dialog/approval                                           | COO / `not-started-by-owner`        |

The 30-minute window is strictly less than 30 minutes. Unknown or invalid input
times are not recent; a future input time counts as recent after a clock rollback.
Only the asking turn's accepted requester inputs count. A timestamp alone does
not establish an owner-started turn. Restarted turns retain their saved inputs;
an overflowed input list cannot establish owner origin. None of these conditions
can hold a new question.

`server/owner-question-router.ts` applies this decision before adding the ask.
The setting defaults on. When off, new asks have no routing metadata and existing
holds are released at the next sweep. An unreadable setting is treated as off.

## Requester and visibility

The requester identifies whose decision is needed. Existing owner attribution
and explicit owner selection remain unchanged; unattributed legacy asks belong
to the default owner, Shine. Routing is not authorization to show another owner's
question or accept an answer from their window.

A new direct question:

- Is immediately in `askHub.list()` and is not held.
- Emits an appeared event and reaches its owner's eligible windows.
- Appears in the topbar Questions feed and opens through its Answer action.
- Keeps its chat-list question mark and can be answered without opening its chat.
- Remains hidden from another owner's bell; their open/answer attempts are refused.

`server/owner-asks-feed.ts` owns bell projection and viewer checks;
`server/owner-asks-push.ts` pushes lists and saved-chat marks to windows.
`server/owner-question-surfaces.ts` owns route presentation and plugin filtering.
Direct routing does not broaden plugin delivery: Wai's asks remain excluded from
the Shine-facing plugin feed.

A held ask is absent from the public ask list, bell, and ordinary appeared feed.
Its own chat can still show it to the correct owner, marked
“With COO first. You can answer here.” Related needs-you indicators are suppressed
until release. Release makes the ask visible again; answering or cancellation
settles it. These rules still apply to held dialogs, approvals, queued-task cards
and explicitly retained legacy question holds.

## Labels

- `owner-chatting`: “You were chatting here”, with elapsed time when known.
- `coo-chat`: “From COO's chat”.
- `question-direct`, grants and re-asks: no extra routing line.
- Released with COO's note or recommendation: “Came through COO”, plus those words.
- Released without added words: the label states that COO added nothing and how
  long delivery took.

Owner attribution remains present even when there is no routing line.

## Holds, restart and safety net

`server/owner-question-holds.ts` stores version-1 hold records in the app data
directory. Records track kind, reason, timestamps, delivery receipt, release state
and bounded COO notes. The file is mode 0600 and replaced atomically. It contains
no question body; queued-card keys hash the stable ask key and signature.

Queued-card holds survive restart with their original time and delivery receipt.
Already released cards remain released when reconciled. Non-stuck hold records
are process-scoped: loading the store marks remaining held ones gone. Restored
question cards are routed under the current direct policy, not held anew because
an older process held them. Legacy reason values remain valid when reading records.

COO may release a held ask with context or retain it until a stated deadline.
Only a held question may be returned to its asking chat; the return is COO's note,
not an owner answer. New questions do not enter that path automatically.

The safety net releases a hold when:

1. Its receiving COO turn ends without COO acting.
2. Thirty minutes pass without COO action.
3. An explicit COO hold expires (at most two hours per hold, renewable).
4. The clock becomes unusable, moves behind the hold's creation, or the store fails.

An explicit COO hold supersedes the first two triggers until its deadline.
The router sweeps at least once a minute. A failed store fails open, does not write
again until restart, and leaves an unreadable file untouched. Full storage also
fails open for new asks. Existing limits remain: 400 records, 14-day finished-record
retention, 600 characters per COO text field and a 4 MiB read limit.

## Regression coverage

- `tests/unit/owner-question-route.test.ts`: direct questions across origin, age
  and restart facts; unchanged dialog, approval and stuck rules.
- `tests/unit/owner-question-client-session.test.ts`: real ClientSession posting,
  immediate unheld state, owner windows, actual bell list/open action and legacy holds.
- `tests/unit/owner-question-wiring.test.ts`: router, surfaces, restart and safety net.
- `tests/unit/waiting-questions-bell.test.ts`: immediate bell delivery and Shine/Wai isolation.
- `tests/unit/owner-question-holds.test.ts`: durable records and failure handling.

Legacy hold-specific integration tests explicitly seed the old held route outside
production. They must not assert that a new role-started question is automatically held.
