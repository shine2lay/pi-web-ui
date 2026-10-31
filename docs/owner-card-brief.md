# Owner card brief (Ops #682)

Every queue card that reaches the owner ("Task #N needs you") opens with a short plain brief built from the
records, so he can answer it without knowing the project's details. Owner, Oct 31 ~12:10 PDT (via COO
rm-d2c1f9b2): "whenever a card comes to me, I need to know the context in the simplest terms, ... i am just
picking blind". Project `owner-cards-plain-context`, step 1 (pi-web-ui's half; pi-queue's half is Ops #681).

## What the brief says

At most `BRIEF_MAX` (600) characters, a label on each line, no ids, paths or rule numbers. Lines appear only when
the records hold them:

| Label | From |
| --- | --- |
| In short | the card's saved `in_short` (pi-queue #681), or the package's "In short:" line |
| The project | the work registry's project name and the first sentence of its outcome; "Not part of a project." |
| This task | the task's title, plus its plan goal's first sentence once ids and paths are taken out (when a sentence is left) |
| Why you, now | from the card's kind (below) |
| Waiting on it | tasks whose `after`, block or outside `after` names this task, counted, by title and queue; "Nothing else waits on it." |
| Your answers | each choice and what it does: fixed meanings for the queue's own answers, else the first sentence of the package's "Picking it authorizes", else "the task's own answer" |
| Recommended | the package's recommendation without ids; "None given." |

Kinds and their "Why you, now":

- stopped: "Its run was stopped while it was working; nothing more is known about who stopped it."
- failed: "Its run failed with an error."
- stalled: "Its chat stopped twice and couldn't be woken."
- climbed: "It asked its lead a question; no lead answered in time, so it comes to you."
- block: "It waits on another department that hasn't answered."
- owner-only: "Only you can give this: <the kind of consent, in words>."
- passed-on: "Its lead passed it to you."
- anything else: "The task asks you a question."

The kind is the stuck op's saved `card` when pi-queue wrote one (#681's contract: optional `card` and `in_short`
on the "stuck" op and the replayed task); otherwise it is read from the queue's fixed question texts and package
heads (`ownerCardKind`). No model is called (rule 17).

## Where it is built and shown

- `server/owner-card-brief.ts`: `ownerCardBrief` (pure), `ownerCardKind`, `ownerCardWaiters`, `ownerCardBriefOf`
  (a queue task + records), `stuckAskBriefs` (what `reconcileStuckAsks` calls), `briefOfAsk`.
- Records: the queue replays (`ClientSession.taskQueueOfConv` sources, plus the queues the block check has read:
  `QueueBlocks.knownQueues()`), and the work registry through pi-queue's own `readWork`
  (`server/work-records.ts` `workProjectOf`, read again only when the log changes).
- `server/asks.ts`: `Ask.brief` / `StuckAskInput.brief`; `AskHub.refreshBrief` swaps a kept card's brief in place
  without an event. The brief is **not** in `stuckSig`, so a changed waiting count never makes a new card (and
  never resends Telegram). It is made with the card and refreshed on every reconcile for the web; Telegram sends the
  one the card was made with.
- `server/task-queue.ts`: the mirror and the canonical replay keep `card` / `inShort` on a stuck task only.
- Surfaces, each showing the brief first and whole, the question and the package below it as before:
  - Telegram (`plugins/telegram/index.mjs` `renderBrief`): right after the head, in the full message and in the
    short form used when a card is too long. The package is still cut to 500 characters; the brief never is.
  - Roles page decision cards, in "Your decisions" and in the role's own panel (`roles-useful-model.ts`
    `briefLines` puts it on the Needs-you item; `roles-exact/owner-asks.ts` `askValues` and `roles-u0/surface.html` draw
    it between the card's header line and its question).
  - Roles answer dialog (`roles-asks.ts` `askViewOf` adds it outside the revision, so a refresh never refuses an
    open form; `roles-answer-model.ts`; `RoleAnswerDialog`).
  - Queue tab (`queueAnswerBindings` carries it; `TaskQueuePanel` stuck block).
  - The browser's question dialog (`DshQuestionDialog`) shows only `ask_user_question`; queue cards never reach
    it, so it is unchanged.
- `web/src/components/OwnerCardBrief.tsx` renders it in the React surfaces (the answer dialog and the Queue tab;
  a `dl`, bold labels; text only, never HTML). The Roles page's own template draws the same `dl` with its styles. The page takes a
  brief only whole and plain: 1-10 lines, label ≤ 40, text ≤ 2,000, no unsafe characters; else none.

## Hypothesis H-OWNER-CARD-BRIEF (rule 20)

- **Wrong now:** the card (`stuckAsk`) was only a title "Task #N needs you: <title>", the question and an optional
  package. Telegram cuts the package to 500 characters, so a stop card showed one sentence and nothing else, and a
  package showed its head of ids and rule numbers first.
- **Change:** one module that builds the plain brief from records only, shown first and never cut, on every
  surface.
- **Expected:** fixture tests for all seven kinds plus the three real cards of Oct 31 (Temper #244 stopped with a
  task waiting on it, Temper #243 climbed, Ops #666 stopped) show every point that applies, in plain words, with no
  ids or paths, within 600 characters; Telegram shows the whole brief before the question.
- **Wrong if:** any fixture misses a point, holds an id or path, or Telegram cuts the brief.

### Result: HIT

`tests/unit/owner-card-brief.test.ts` (seven kinds, unknown kind, inference without `card`, waiters, the length
squeeze, the three real cards with and without a saved card): every brief has its points, `hasIdOrPath` finds
nothing, all are ≤ 600 characters. Real cards: #244 403 characters (waiting: 1 task, "Bootstrap test: publish
synthetic acknowledgements atomically"), #243 399, #666 323. `tests/unit/plugin-telegram.test.ts`: a 500+
character brief comes whole before the question, in the full message and in the short form, while the package is
still cut. `tests/unit/roles-exact.test.ts`: on the live Roles page the brief stands between a card's header line
and its question, and a card without one draws none. The new tests failed before the change (module missing;
Telegram showed no brief; no brief on any card) and pass after.

One honest gap the fixtures showed: a climbed card whose task named no recommendation offers "Go with the task's
recommendation"; the brief says so ("it goes with what it recommends; it named nothing here") rather than implying
there is one.

## Undo

Revert the commit and `pi-web-deploy` the previous commit. Nothing is stored: the brief lives only on the live ask
and in what is sent to the browser; the queue's saved ops are untouched (pi-web-ui only reads `card` / `in_short`).
