# queue-fold: the queue's reports show as one line in a chat until opened

Ops #267. The owner, 2026-10-19 19:0x: "i also want queue reports in chat collapsed by default"; asked
which ones (dialog): "queue reports, by plugin". PATCHES.md entry `queue-fold`. Display only: the
transcript and what the model reads don't change.

## H-QUEUE-FOLD-1

- **Wrong (evidence).** Queue reports take most of the screen in busy chats. Ops' home chat on 2026-10-19
  got 16 "[Queue] …" report cards (median 1,230 characters, longest 4,068) and 57 queue notes (median 478,
  longest 1,279). Counted from the transcript's records (roles, custom types and lengths), no text read.
- **Change.** One change: every queue report shows as one folded line by default ("Queue" and the report's
  first line, cut to fit), drawn with the chat's existing folded-row control. One click (or Enter/Space)
  opens it; it stays open, with the usual Collapse button to fold it again.
- **Why it should work.** The folded row is the same cheap one-line row old messages already use, so a report
  costs one line whatever its length; nothing else in the chat changes.
- **Expected, and how it's measured.**
  - Sealed browser test (`tests/queue-fold-test.mjs`), a chat holding a task's plan, 10 report cards and 10
    queue notes: each report is one row at most 2 text lines high; the plan is fully open; a search for a
    word deep inside a folded report finds it and opens that report; a click opens a report and Collapse
    folds it again; the owner's own message (which mentions "[Queue]" mid-text) stays open.
  - Live, look only, after install: in Ops' home chat and one task chat, the queue reports in view are folded
    (count of folded queue rows = count of queue reports in view; counts and UI words only).
- **Disproved if.** Any queue report still shows open by default, or the plan or any other message folds.

## What folds, what stays open

Recognised by a small pure helper, `web/src/queue-report-fold.ts` (unit test
`tests/unit/queue-report-fold.test.ts`, which holds pi-queue's real templates):

- **Notes** the queue plugin posts: custom messages whose customType starts with `queue-`
  (`queue-report`, `queue-wait`, and pi-web-ui's own `queue-paused`).
- **Report cards**: user messages whose text starts with `[Queue] ` (done, done batch, on hold, blocked,
  poked, lead and Ops cards, reminders, decisions, answers, passed to the owner, needs the user, dropped,
  wake-ups, "back to task").
- **Stays open: a task's own plan.** The two start messages pi-queue writes (`queue.ts` `kickoffText` and
  `taskKickoffText`), recognised by their fixed second paragraph: "The user planned this task with you and
  approved the plan." or "You're working on this task in a chat of its own, started by the queue in … The
  user planned it there and approved the plan."
- **Never folds:** the owner's own messages (a message that mentions "[Queue]" later in its text is not a
  report), assistant replies, anything else.

Where: `web/src/components/MessageList.tsx` decides which rows are folded (the same `expanded` set as old
messages, so opened reports stay open while the chat is shown); `web/src/components/CollapsedMessage.tsx`
draws the row ("Queue" and the first line). Search: a folded report's whole text is in the search's folded
index (`searchCollapsedIds`), so Ctrl+F counts its words and opens it when stepping to one. Reports in the
digests above the loaded window show open while the search bar is open (they aren't in that index).

## Result

**Sealed browser test** (`node tests/run-sealed.mjs queue-fold-test`, run 2026-10-20T03-48-31-111Z):
27 of 27 checks passed. A fixture chat with a task's plan, the owner's message that mentions "[Queue]"
mid-text, 2 replies, 10 report cards and 10 notes: all 20 reports show as folded rows reading "Queue" and
their first line, the tallest 36 px against a 22.4 px text line (2 lines = 44.8 px), on a phone too, with
nothing scrolling sideways; the plan, the owner's message and the replies stay open; Ctrl+F finds a word deep
inside a folded card and a folded note and opens each; one click opens a report whole, Collapse folds it
again, Enter opens a focused row; the transcript is unchanged and the model was never called.
Unit test `tests/unit/queue-report-fold.test.ts`: 33 of 33.

**Install:** `pi-web-deploy` put in 7610a8e4 (mine, with 3c309d3d queue-fold inside) at 2026-10-19 21:04;
`pi-web-deploy result 3c309d3d` = 0. Checks: server, page, reply and big chat passed; the log check flagged 2
crash-guard notices, both the check page's own window ("its chat … was closed (its blank chat was closed); no
open chat to move it to yet"), new wording from chat-slots (#266, in the same install), not from this patch,
which changes no server file. #266 fixes that wording in its follow-up `chat-slots-log`.

**Live look** (2026-10-19 21:16, look only, one background client `carry-on:ops-live-look-queue-fold`, each
chat opened by address; counts and UI words only, no chat text, no screenshots; script
`~/kept-from-tmp/2026-10-19/queue-fold-live/look.mjs`, run2). It classifies the messages the page received
with the helper's rules and counts how each is drawn:

- Ops' home chat: 17 queue reports received; 12 drawn as folded "Queue" rows (the tallest 36 px, text line
  19.2 px, so under 2 lines), the other 5 sit inside quiet-turn rows that were closed already (a turn the
  queue began shows as one closed row; quiet-turns, unchanged). Open queue reports: 0. In view: 12 folded
  queue rows, 0 open reports. Other messages folded by this patch: 0. Page errors: 0.
- Task #267's own chat: 1 queue report, a folded row; the task's plan open in full (5,809 characters drawn
  of its 5,988, the rest being Markdown marks; 2,054 px high). Wrong folds: 0. Page errors: 0.

**H-QUEUE-FOLD-1: HIT.** Every queue report showed folded by default, in the sealed test and live; the plan,
the owner's messages and all other messages stayed open; search finds and opens a folded report.
