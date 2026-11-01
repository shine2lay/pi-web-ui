# Owner card brief (Ops #682, #683)

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

## Continuation-grant cards (Ops #683)

The other card that reaches the owner: a role asks to keep messaging another role past the chain's free limit
(`role_message` approval request) and the request climbs to him. It opens with the same kind of plain brief.
Project `owner-cards-plain-context`, step 2; same owner words (via COO rm-d2c1f9b2).

### What the grant brief says

Five labelled lines, built by `server/grant-card-brief.ts` (`grantRequestBrief`, which reads the binding, and
`grantCardBrief`) from the stored request alone (its binding and the requester's own context), no model, with #682's
plain-words helpers and fit (`plainWords`, `plainSentence`, `fitBrief`), so at most 600 characters with ids, paths
and rule numbers taken out:

| Line | From |
| --- | --- |
| Who asks | the requester, the other roles named in the request (by their identity titles; the requester itself, which the scope also names, is left out; more than three: "and N more"), past which message of the chain, how many more, and who may send under the grant (below) |
| Its goal | first sentence of the context's `goal` |
| Its reason | first sentence of `whyNeeded` |
| Its plan if allowed | first sentence of `nextStepAndOutcome` |
| Your answers | fixed: "Deny": no more messages in this chain; "Allow one send": one more message; "Allow up to N sends": up to N more, for the hour the grant lasts (named as the card's buttons are; the contract's grant lasts 3,600,000 ms) |

Who may send, from the binding's `scope.task` as the host's grant check (`misfit`) reads it, with
`scope.recipients` = `scope.participants`:

- asked from the requester's home chat (`kind: "home"`, which names no role): any named role's home chat may send to
  any other named role, sharing one count. "X asks to continue a chain with A and B past message N: up to Q more
  messages among them, sent by any of them."
- asked from one of its tasks (`kind: "task"`): only that task. "X asks from one of its tasks to continue a chain
  with A and B past message N: up to Q more messages, sent only by that task."
- asked from another of its chats (`kind: "other"`): only that chat, "sent only from that chat".

The goal, reason and plan are the requester's own words, so their labels say "Its" rather than stating them as
facts; only "Who asks" and "Your answers" come from the guard itself.

A part with no plain sentence left (only ids or paths, or under two words) says "Not said in plain words." When
the brief is too long, the goal, reason and plan give first, in the same turn so the longest is cut first and each
keeps a fair share; then the names. Each is cut after a whole word with an ellipsis, down to its floor (24
characters for the three sentences, 12 for a name). `plainWords` reads at most the first 2,000 characters of any
text, since a brief shows at most 600 (below, Security's L1).

### Where the grant brief is built and shown

- `server/role-message-guard-host.ts` `briefOf(question)`: `grantRequestBrief(binding, detail, name)`, roles named by
  `def(role)?.title`; past message `causal.nextHop - 1` (as the card's own line), the binding's `quantity` and
  `scope.task` kind, and the owner question's `detail` as the context. Set as `brief` on the card `present` adds to the AskHub (Telegram) and on each
  `openQuestions()` entry (`UiRoleGuardQuestion.brief`, the app's approval dialog). Both are built from the same
  stored request, so they are the same lines.
- Telegram: `renderBrief` now shows the brief of any card that has one (it took only kind "stuck"); it comes whole
  before the card's line and question, while the requester's context is still cut to 500 characters as before.
- The app: `RoleGuardOwnerQuestions` passes `briefLines(q.brief)` to `RoleMessageGuardApproval`, which draws it with
  `OwnerCardBrief` under the dialog's title. `briefLines` drops a brief that isn't whole and plain.
- Unchanged (display only): the owner question (`questionId`, `generation`, `choices`, `choicesDigest`, `detail`,
  `binding`), the card's id, field id, options, title and line, the request, its digests, admission, grants and
  answer handling. `server/role-message-guard-core.ts`, `-contract.ts` and `-approvals.ts` are untouched.

### Hypothesis H-OWNER-CARD-GRANT (rule 20)

- **Wrong now:** the card had one line, "<role> asks to continue a chain of role messages past message N", then
  the requester's whole context as the detail. Telegram cuts that detail at 500 characters, and the answers
  deny / one_send / requested_quantity aren't explained.
- **Change:** fill the `brief` slot #682 added, from the stored request only: who asks whom, what for, why more
  messages, what happens next, what each answer does; ids and paths taken out; #682's module reused.
- **Expected:** fixture tests show a brief of at most 600 characters, with no ids or paths, covering each point;
  the question id, generation, choices and choicesDigest are byte-identical before and after.
- **Wrong if:** any digest or id changes, or the brief misses a point.

#### Security review and the changes it led to

Security accepted the source of 5b4fe4b5 with no must-fix (rm-112648e9, corrected by rm-51d83b8e) and filed three
Low findings. All three were taken up before landing (Ops lead's decision for L3: an owner card must say exactly
what each answer authorizes):

- **L1, availability:** a request's context can be 16 KB, and #682's path and tidy patterns take time that grows
  with the square of a long run: 0.8 to 2 s per call on Security's worst cases, on every look at a pending card.
  `plainWords` now reads only the first 2,000 characters (this covers #682's queue cards too). Test: those worst
  cases, whole, through `plainWords`, `plainSentence` and the grant brief, take under 3 s together (capped: 0.2
  to 0.3 s at load 38; uncapped: 19.6 s, so the test fails without the cap; a first bar of 500 ms left under
  twice the capped time as headroom on a busy machine); a long text's first sentence still comes through.
- **L2, attribution:** the requester's first sentences sat under labels that read like the guard's own facts ("If
  you allow it"). They are now "Its goal", "Its reason", "Its plan if allowed".
- **L3, who may send:** "X wants to keep messaging A and B" understated a home-chat grant, under which any named
  role's home chat may send. The first line now says who may send, for each kind of binding (above), with a test
  for each.
- Then, measured on the two real owner-tier requests: the longer first line made the old order (next step gives
  first) cut COO's plan to "Send one combined…" while its goal kept 160 characters. Hypothesis: letting the goal,
  reason and plan give in the same turn (longest first) keeps every point readable; wrong if any of the three is
  cut to its floor while another keeps over 90 characters. Result: HIT, the plan came back whole (97 characters)
  and the goal was trimmed to 95, 592 characters in all.

#### Result: HIT

- Brief: `tests/unit/grant-card-brief.test.ts` checks every point in order, "Label: text" within 600 characters and
  `hasIdOrPath` false on each line, for a plain request (380 characters), one full of ids and paths (496; "Land
  Ops #683 from /home/… so grant cards (see server/grant-card-brief.ts) open plainly" becomes "Land Ops from so
  grant cards open plainly."), one with nothing plain ("Not said in plain words." three times) and a very long
  one with five recipients (598, every point still there). Look only, the two real owner-tier requests of Oct 31
  (the guard's stored state, read only, both asked from COO's home chat), with the final wording: COO to Temper
  and Ops, 592 characters; COO to Temper, 562; both with no ids or paths and nothing "not said".
- Unchanged: the same test runs a real guard host to an owner-tier card. The open question's `ownerQuestion` has
  exactly its contract's keys and no brief, its id, generation, choices and a 64-hex `choicesDigest` are the
  question's, the card's id, field id and option values are too, a second `openQuestions()` is equal, and the
  answer still settles it. A/B, old code against new on the same harness run: the open questions and the card,
  less the new `brief`, were identical once each run's random folder, message ids and digests were replaced in
  order of appearance (two runs can't match byte for byte: the digests hash each run's random ids). The brief is
  made from the finished question and never goes into it, its digest or the card's fields.
- Surfaces: `tests/unit/plugin-telegram.test.ts` (a grant card's brief whole and first; the context still cut;
  without a brief the message is as before) and `tests/unit/role-message-guard-view.test.ts` (the dialog draws the
  brief under its title; none without one).
- The new tests failed on the old code (module missing; Telegram showed no brief for a non-stuck card; the dialog
  drew none) and pass after.

### Undo (Ops #683)

Revert the commit and `pi-web-deploy` the previous commit. Nothing is stored: the brief is made each time a card
is shown or the open questions are listed; the guard's state and records are untouched.
