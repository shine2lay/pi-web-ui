# Owner-question routing: straight to the owner, or through COO first

Ops #684 (project owner-cards-plain-context, lead Ops) laid the groundwork: the routing rule, the durable hold store
with its safety-net clock, and AskHub's held state. Ops #685 wires every owner ask through it behind a switch,
`ownerQuestionsViaCoo`, which is **off** until #687 turns it on: while it is off nothing changes for any chat or
surface. #686 adds COO's card and tool to let a held ask through or hand it back.

## Why

Today every owner ask (ask_user_question, extension dialogs such as plan approvals, tool approvals and queued-task
cards) goes to him on every surface at once, whoever started the turn: `AskHub.add` emits "appeared" and `askUser`
pops the dialog up in every window. So questions raised halfway through work reach him with no context (Temper #243
and #244, RollCall #36, Ops #666).

The owner, via COO, 2026-10-31 (rm-fbbc87f6, rm-79d1a979):

- "if the leads failed and missed, it should come to you first so you can gather the necessary context to ask me
  question, you should be free most of the time since you dont have a task queue that you manage"
- "if i am chatting with a lead and there is a question, i don't want it to go thru you, because if i am chatting a
  question is asked, i have context, i don't have context only when a project is working and half way i get asked a
  very specific question without knowing everything else"
- "i think there must be a deterministic way to figure this out"; "the deterministic question was pointed a way to
  make sure ask_user_question is properly routed"

How long he counts as chatting, he chose on 2026-10-31 (dr-cb84e6f50755, via COO rm-1cf56478): **"Through COO after
30 minutes"**. Continuation-grant asks stay direct: he chose doubled role-message limits instead of routing them.

## The rule (`server/owner-question-route.ts`)

`ownerQuestionRoute(input)` is pure: no model, no text, no clock of its own. Its input is only the host's own
record and times:

| Field                   | What it is                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                  | The ask's kind: question, dialog, approval or stuck (a queued task's card).                                                        |
| `turn`                  | The asking chat's current turn record (`conv.turnRecord`, a `RequesterTurn`) as admission filled it.                               |
| `ownerLastWroteAt`      | The host's own time of his latest accepted input in the asking chat (kept across a carry-on); absent = not known. #685 records it. |
| `now`                   | The host's time now.                                                                                                               |
| `homeRole`              | The identity whose home chat asks (`identities.ts` `homeChatOf`), if any.                                                          |
| `grant`                 | Host-set: one of the role-message guard's continuation-grant asks.                                                                 |
| `askedAgainAfterReturn` | Host-set: COO handed this question back earlier in the same turn and the chat asks again.                                          |

**His input.** An input counts as the owner's only when admission recorded it as an owner requester
(`owner-contacts.ts` `ownerInputIds`): a prompt from a real browser page that passed the WebSocket origin/auth
admission (`index.ts` `browserRoleInput`; never a pseudo-client), or a message the Telegram plugin sends through
`host.roles.send`. `requesterForAdmission` keeps a supplied requester only for the host's own role deliveries, so an
extension can't claim to be him. A turn carried on after a restart keeps its saved inputs. A turn that took more than
`REQUESTER_INPUTS_MAX` (32) inputs keeps no list, so it counts as not his; the safety net still lets its questions
through.

**The window.** `OWNER_CHATTING_WINDOW_MS = 30 * 60_000`. He counts as chatting while his last accepted input in the
asking chat is less than 30 minutes old. Unknown (absent, or not a real time) is not recent. A last input ahead of
`now` (the clock was set back) counts as recent, so he gets the question as before routing.

**First rule that applies** (`OWNER_QUESTION_ROUTE_REASONS` is this closed list, in this order):

| #   | When                                                                                                                                                                  | Route  | Reason                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | -------------------------- |
| 1   | COO's own home chat asks (identity `coo`)                                                                                                                             | direct | `coo-chat`                 |
| 2   | A queued task's card (kind `stuck`), whichever chat shows it                                                                                                          | coo    | `queued-work`              |
| 3   | The turn holds his accepted input (he started it or typed into it while it ran) and he last wrote there under 30 minutes ago                                          | direct | `owner-chatting`           |
| 4   | A question asked again in the same turn after COO handed it back                                                                                                      | direct | `asked-again-after-return` |
| 5   | A continuation-grant ask                                                                                                                                              | direct | `grant-not-routed`         |
| 6   | The turn holds his accepted input, but his last input there is 30 minutes old or more, or its time isn't known                                                        | coo    | `owner-away`               |
| 7   | Anything else: a role message, a Board post, a queue prompt or reminder, a schedule wake-up, a subagent, a plugin or extension message, or no record started the turn | coo    | `not-started-by-owner`     |

So grants and re-asks stay direct even in a turn he started long ago, and a time alone never makes a turn his: a
fresh `ownerLastWroteAt` with no owner input in the turn is rule 7. A turn he wrote in earlier doesn't count either:
only the asking turn's record is read. `OWNER_QUESTION_DIRECT_REASONS` and `OWNER_QUESTION_COO_REASONS` split the
list by route.

## The plain words (fixed here, shown by #686)

On the owner's surfaces:

| Case                                                         | Line                                                                                                                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| direct `owner-chatting`                                      | "You were chatting here", plus how long ago he last wrote there: "You were chatting here (you wrote 3 minutes ago)", "(you wrote just now)" under a minute |
| direct `coo-chat`                                            | "From COO's chat"                                                                                                                                          |
| direct `grant-not-routed`, `asked-again-after-return`        | no line (shown as before)                                                                                                                                  |
| let through by COO with a note or a recommendation           | "Came through COO", with the note and recommendation                                                                                                       |
| let through with nothing added (COO bare, or the safety net) | "Came through COO; COO added nothing (it reached you after 31 minutes)"                                                                                    |

On COO's card, why COO got it first (`cooReasonWords`):

| Reason                 | Words                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `queued-work`          | "a queued task's card"                                                                                                                        |
| `owner-away`           | "the owner started this but hasn't written there for N minutes" ("... but it isn't known when he last wrote there" when the time isn't known) |
| `not-started-by-owner` | "raised by work the owner didn't start"                                                                                                       |

Minutes are whole minutes, rounded down ("less than a minute", "1 minute", "N minutes").

## The hold store (`server/owner-question-holds.ts`)

`OwnerQuestionHolds` keeps one record per ask held for COO, in `<dataDir>/owner-question-holds.json`
(`OWNER_QUESTION_HOLDS_FILE`): written whole (`server/write-whole.ts`: a temporary file in the same folder, then a
rename), mode 0600, `{ "v": 1, "holds": [...] }`. It holds no words of any question.

**A record:** `key`, `kind`, `reason` (the COO reason), `createdAt`, `state` (held / released / returned / gone),
`deliveredToCoo` (`at`, optional `sendId`, and `turnEndedAt` once that COO turn ended), `releasedBy` (coo /
safety-net / owner-answered), `finishedAt`, `note`, `recommendation`, `holdUntil`, optional `holdWhy`.

**Keys:** a queued task's card: `holdKeyOfStuck(stuckKey, stuckSig)`, `stuck:` plus a SHA-256 of its ask key and
signature (no path or question text). A question, dialog or approval: `holdKeyOfAsk(id)`, `ask:<id>` (hashed when
the id is over 200 characters).

**Calls:**

| Call                                       | What it does                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `admit(key, kind, reason)`                 | `hold` (with `deliver`: not yet sent to COO) or `show` (with why: released, returned, a due reason, full, bad-key, store-failed, clock-unusable). A held record kept from before a restart is held again, never delivered to COO twice; one whose time ran out meanwhile is released by the safety net and shown; a released or returned one is shown at once with what COO said; an ended one asked again is held afresh. |
| `delivered(key, sendId?)`                  | It went to COO. False when already delivered: never twice. The optional host send id binds its receiving turn across restart.                                                                                                                                                                                                                                                                                              |
| `cooTurnEnded(key)`                        | The COO turn that got it ended.                                                                                                                                                                                                                                                                                                                                                                                            |
| `cooHold(key, until, why?)`                | COO keeps holding it, at most 2 hours from now (`COO_HOLD_MAX_MS`); renewable while it is held and not yet due. Its reason survives a restart.                                                                                                                                                                                                                                                                             |
| `release(key, by, note?, recommendation?)` | Let through by COO, the safety net, or his own answer on the asking chat's page.                                                                                                                                                                                                                                                                                                                                           |
| `returned(key, note)`                      | COO handed a question back (questions only, a note required).                                                                                                                                                                                                                                                                                                                                                              |
| `gone(key)`                                | The ask ended (answered, cancelled, the chat closed).                                                                                                                                                                                                                                                                                                                                                                      |
| `due(now?)`                                | The held ones the safety net lets through now.                                                                                                                                                                                                                                                                                                                                                                             |

Questions, dialogs and approvals live only in the process that asked them: on start, their held records are marked
gone. Only a stuck card outlives a restart, because the queue shows it again.

**Bounds:** at most `HOLDS_MAX` (400) records; finished ones are pruned after `HOLD_FINISHED_KEEP_MS` (14 days), or
oldest finished first when full; when all 400 are still held a new ask isn't held (shown as before). COO's note and
recommendation at most `HOLD_TEXT_MAX` (600) characters each. The file is read only if it is a plain file (never a
link) of at most `HOLDS_READ_MAX` (4 MiB), and only a version-1 file whose every record it knows.

### The safety-net clock

`holdDue(hold, now, storeOk)` is pure, and `dueReleases` lists every due one without changing anything. A held ask
goes through when:

1. the COO turn that got it ends without COO acting (`coo-turn-ended`);
2. 30 minutes (`HOLD_SAFETY_NET_MS`) have passed since it was held and COO hasn't acted (`no-coo-action`);
3. COO's hold has run out (`hold-ended`); a hold further ahead than 2 hours (a bad record, a clock set back) counts as
   run out;
4. the store can't be read or written (`store-failed`): it fails open. Nothing more is held and every held one goes
   to him as today. A file it couldn't read is left as it was, and the store never writes again until the app
   restarts.

Also through: a clock set back before the hold (`clock-moved-back`), or one that isn't a real time
(`clock-unusable`; `admit` holds nothing then). A COO hold replaces rules 1 and 2 until it runs out.

## AskHub's held state (`server/asks.ts`)

| Call or event                                                                  | Behaviour                                                                                                                                                                         |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add(ask, onAnswer)` with no route                                             | Exactly as today: the caller's own object, "appeared", listed.                                                                                                                    |
| `add(ask, onAnswer, { to: "direct", reason, label? })`                         | As today, on a copy carrying `route` (its reason and line).                                                                                                                       |
| `add(ask, onAnswer, { to: "coo", reason, heldAt? })`                           | Kept, but no "appeared" and not in `list()`: emits "held". `heldAt` keeps the time it was first held across a restart.                                                            |
| `add(..., { to: "coo", ..., releasedBy, releasedAt, note?, recommendation? })` | Already let through (after a restart): "appeared" at once with its line, never held again.                                                                                        |
| `release(id, by, note?, recommendation?)`                                      | `by` coo or safety-net. Sets the route's line, note and recommendation, then emits "released" and "appeared"; it is listed again in its first place. `NOT_HELD` if it isn't held. |
| `returnToAsker(id, note)`                                                      | Questions only, held only, a note required. Emits "returned" with the note; it no longer waits.                                                                                   |
| `heldList()`                                                                   | What is held, oldest first. `list()` leaves those out.                                                                                                                            |
| `answer()` / `settle()`                                                        | Unchanged, also on a held ask: the asking chat's own page can still answer it.                                                                                                    |

`AskHub`'s constructor takes an optional clock (`Date.now` by default) for the times it holds and lets through.

## The wiring (#685)

**The switch.** `ownerQuestionsViaCoo` in pi-web-ui's settings (Settings, "Questions for you go through COO first";
`server/client-state.ts`, `server/settings-service.ts`), **off** by default. Off is exactly as before #685: no ask is
routed, nothing is held or written, and every card looks as it did. Turning it off again is the undo, with no revert:
new asks go as before, and the next sweep (within 30 seconds) lets everything held through.

**His last input's time** (`server/owner-input-time.ts`). Admission collects each accepted input into the chat's turn
record (`noteTurnCause` in agent-service, `collectRoleInput`); when it recorded the input as his (an owner requester:
a real browser page through `browserRoleInput`, or a Telegram message through `host.roles.send`), `noteOwnerInput`
stamps the host's time on the chat and the turn (`ownerLastWroteAt`). Nothing is read from words.
`server/running-chats.ts` saves the time beside the turn's requester (`RunningChat.ownerLastWroteAt`, a field of its
own, so an older build reading the file loses nothing), and `carriedTurnOf` gives it back to a turn carried on after a
restart.

**Where an ask is routed.** At the moment it is made, `OwnerQuestionRouter.routeAskIn`
(`server/owner-question-router.ts`) applies the rule to the asking chat's turn record, `ownerLastWroteAt`, the role
whose home chat asks, and now:

| Ask                                                                    | Call site                                                                                                                                                                         |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ask_user_question                                                      | `askUser`                                                                                                                                                                         |
| Extension dialogs (`ChatDialogs`, including pi-queue's plan approvals) | the dialog watcher                                                                                                                                                                |
| Tool approvals                                                         | `askApproval`                                                                                                                                                                     |
| A queued task's card                                                   | the stuck-card reconcile (`wantedStuckAsks`, then `askHub.add`): route `queued-work`, keyed by the card's key and signature, so it stays held from its first time across restarts |

The role-message guard's continuation-grant asks are not routed. agent-service.ts only calls; the logic is in
`server/owner-question-router.ts` and `server/owner-question-surfaces.ts`.

**A held ask** stays off his screens until it is let through:

- no pop-up in other windows (`shownToWindow`); no "?" or needs-you highlight in the chat list or the lead bar; not
  under Needs you or in the Roles page's counts;
- nothing to Telegram or any other plugin: `server/plugins.ts` passes a plugin only the ask events
  `ownerSeesAskEvent` allows;
- no sound, desktop notification or spoken announcement (`cueIdOf` in `web/src/owner-question-route.ts`);
- the needs-you marks about it wait with it: pi-queue's "Task #N needs you" line and notice and the task chat's
  "Needs decision" label while the card isn't made yet or is held, and the asking chat's own needs-you line written
  for it (the newest unanswered one up to 5 seconds after the ask, `writtenForAsk`, as the Roles page pairs them);
- roles_overview, which COO reads, lists it under "waits on the owner" as "with COO first until HH:MM".

The asking chat's own page and the Queue tab still show it, quietly, marked "With COO first. You can answer here.";
an answer there settles it as usual, and its record becomes gone.

**Let through** by COO (#686) or by the safety net, it reaches him everywhere as today, with the route's line first,
before #682's brief, then COO's note and recommendation when given: in the pop-ups, the Queue tab card, the Roles
page's decision cards (`web/src/roles-exact/owner-asks.ts`, `web/src/roles-u0/surface.html`) and answer dialog, and
Telegram (`renderRoute` before the brief). A direct ask carries its line too ("You were chatting here (you wrote 1
minute ago)", "From COO's chat").

**The safety net.** The router's interval (`SAFETY_NET_SWEEP_MS`, 30 seconds) calls the store's `due(now)` and lets
through what is due. A queued task's card made again after a restart follows the store: still held from its first
time, or shown at once with COO's words once released.

**Handed back.** `returnToAsker` ends the ask_user_question call with: "Not the owner's answer. COO handed this back
as your own call: <note>. If only the owner can give it, ask again: it goes straight to him." A second ask from the
same chat in the same turn goes straight to him (`asked-again-after-return`).

**Known edges** (switch on only, for #686 and #687). pi-queue writes its line and notice about 100 ms before the card
is made, and a chat mostly writes its own needs-you line just before it asks: a mark can show for that moment, without
a sound. A task whose card is held doesn't count as waiting on the owner, so the stall watch may call it quiet if COO
keeps it long.

## COO's desk: the card, the tool and the safety net (#686)

COO sees a held question before the owner does, can add context, and never answers in his place. Three modules,
no model:

| Module                          | Job                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `server/owner-question-card.ts` | The card's text (pure). Each question's tag, `oq-` and 8 hex characters, comes from its hold key. |
| `server/owner-question-coo.ts`  | `CooOwnerQuestionDesk`: delivers cards, tracks what COO did, runs the turn-end safety net.        |
| `server/owner-question-tool.ts` | The `owner_question` tool: checks what COO wrote, words the results, calls the desk.              |

### Delivery

- When AskHub emits "held", the desk waits `CARD_BATCH_MS` (2 seconds) and puts one card into COO's home chat by
  the same delivery role messages use: after COO's current turn, as an extension input (never as the owner's
  words), resuming the chat if it isn't loaded. It is not a role message, so role-message caps don't apply.
- Every held question waiting when the card is written goes in that one card. One held while a card is on its way
  gets the next card; none goes twice, and one already delivered before a restart gets no second card.
- The card is written after opening the chat and waiting for prompt admission and prework. A question answered
  or gone by then is left out; newly held asks join that card. A card with nothing left is never sent.
- SDK input hooks can await too. The existing prompt-start guard checks freshness just before the SDK prepares
  its loadout, before it starts a turn. A stale card is refused without consuming pending next-turn notes. A native
  start still in preflight keeps the card outside the SDK's follow-up queue; it is composed afresh later.
- A lazy card has one outstanding admission, not the ordinary role-delivery timeout: a slow start cannot both
  time out and arrive later, followed by a duplicate retry. Ordinary role messages keep their existing timeout.
- A card that can't go for now (COO's chat busy starting, say) is tried again after `CARD_RETRY_MS` (1 minute). One
  that can never reach COO (no COO role, no home chat) lets its questions through to the owner at once, by the
  safety net: routing fails open.
- Switch off: nothing is delivered, and the tool says routing is off.

### The card

First line `[Owner question] from Design's home chat [oq-1a2b3c4d]`, or for several
`[Owner question] 2 questions, from Design's home chat; Ops's task #12 “New fonts” [oq-…, oq-…]`. Then, for each
question: who asks (role, chat, task), its kind and why it came to COO (the route's reason in plain words), #682's
brief, the question and its choices, "It goes to the owner at HH:MM unless you act", the actions (return only for
an `ask_user_question` question), and the package last. Conditional choices keep their branch conditions. The
existing role-message card shell displays it with a separate **Package** fold per question; those folds open for
search results without changing the reader's own folds. The card ends with the guidance and the turn-end rule.

### The tool (`owner_question`)

Registered only in COO's home chat, and refused anywhere else (checked again at every call). Its guidance is in its
description and prompt guidelines, not in COO's role prompt (the owner's): gather the context and never answer for
him; always release what only he can give (consent, spending, publishing, his pauses, his own stops); prefer release
with a plain note and a recommendation; return only when the question is clearly the asking role's own call.

| Action                               | Does                                                                                            | Refused when                                                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `list`                               | What is held now: tag, who, kind, question, when it goes.                                       | Another chat; routing off.                                                                                         |
| `release(id, note, recommendation?)` | `AskHub.release` with by `coo`: the card reaches him with COO's note first.                     | No note; a note or recommendation over 600 characters or holding an id, a path or code (#682's `plainTextFaults`). |
| `hold(id, until, why)`               | Keeps it until `until` ("45m", "1h30m", "10:30" in his time), recorded in the store; renewable. | More than 2 hours ahead; a time passed; no reason.                                                                 |
| `return(id, note)`                   | `AskHub.returnToAsker`: back to the chat that asked, as its own call.                           | Not an `ask_user_question` question (a queued task's card, a pop-up, a tool approval); no note.                    |

An ask already answered, let through, handed back or gone is reported as such, and nothing is sent. No action
answers an ask: the tool has no way to.

It is not a row in Settings' tool switches: its switch is `ownerQuestionsViaCoo` (`tests/unit/tool-registration.test.ts`
classifies it as COO-home-only). pi-identity's tool limits still apply to it: if COO's identity gives an allow list,
`owner_question` has to be on it, and that file is the owner's. #687 checks this before switching on.

### The safety net on COO's side

When the COO turn that got a card settles, every question in it that is still held with no action from COO in
that turn (no release, return or hold) goes to the owner at once, by the safety net. A question COO held stays held
until its hold runs out (#685's 30-second sweep lets it through then). The hold reason and delivery receipt are
stored beside the hold key. A restarted stuck card can have a new AskHub id; its hold key still binds it to the
receiving turn. Running-chat carry-on keeps only checked host-generated card receipt ids, separately from
requester and owner-input time; it does not restore an old turn cause or give owner/Telegram authority. A turn
settling before delivery returns, or before a closed task's card reappears, still releases the right hold.
The other safety-net points (30 minutes, a hold running out, the store failing) are #684's clock, run by #685.

## Hypotheses and results

**H-OWNER-ROUTE-RULE (rule 20).** Wrong now: every owner ask goes to him on every surface at once, whoever started
the turn (evidence above). The change: one pure rule that decides only from the host's own trusted record of the turn
and its own times, never from words, with no model. Expected: a known-case table of at least 18 cases (14 at first;
the owner's 30-minute window added 4 more) passes, run twice with the same result. Wrong if any case can't be
decided from the record without reading words, or comes out wrong.
**Result: HIT.** The table has 41 cases, covering all 7 reasons (owner-chatting 10, coo-chat 3, grant-not-routed 2,
asked-again-after-return 2, queued-work 2, owner-away 5, not-started-by-owner 17); all 41 pass, on two separate runs
with identical results, and a second pass inside the test gives the same answers. Words added beside the record
change no answer. The window's edge: 29 minutes and 30 minutes less 1 ms direct, 30 minutes and unknown COO.

**H-OWNER-HOLD-STORE.** A durable store whose pure clock releases a held ask at each of the four points above, fails
open when it can't be read or written, shows a released card at once after a restart and never delivers a held one
to COO twice. Expected: clock, restart-reload and fail-open tests pass. Wrong if any path leaves a question held
past these points.
**Result: HIT.** 36 store tests pass: the pure clock at each point, including a clock set back or not a real time
(8); records, delivery once, COO holds, bounds and pruning (8); keys (2); restart reload (7); the store's own clock
(2); and the file (9): a file that isn't JSON, another version, a record it doesn't know, the same key twice, a file
too big, a link or a folder in its place, and a failing write all fail open, and a missing file is an empty store.

**H-OWNER-ROUTE-WIRE (#685).** Wrong now: every owner ask reaches every surface at once (evidence above). The change:
the switch; the time of his last accepted input recorded at admission and kept across a carry-on; the rule applied
where each ask is made; a held ask kept off every owner surface but its own chat's page and the Queue tab; a released
one shown everywhere with its line first; the safety-net interval; the return text. Expected: integration tests with
fake chats show each case: his question with his last input 1 minute old shows at once with its line; the same turn
at 31 minutes is held as owner-away; a carried-on turn keeps his time; a role-started turn's question is held, absent
from Telegram's input, Needs you and the counts but present in the asking chat; a release shows COO's note; the
safety net lets it through after 30 minutes on a fake clock; a restart reload follows the store; the return text,
and a re-ask goes direct; switch off is byte-identical to today. Wrong if a held ask reaches any owner surface before
release, never reaches him after the safety net, the window misroutes a case, or switch off changes anything.
**Result: HIT.** Every case passes (below), and none of the four wrong-if results showed. Switch off: the same run of
every kind of ask, with the router in the path but off and with no router at all, gives byte-identical output on
every surface (events, the list, Telegram's text and buttons, the Roles overview and roles_overview's text, the
pop-ups' messages), routes nothing and writes no store file. Testing also found two more ways a held ask showed, now
kept back with it: the needs-you marks written about it (pi-queue's line, notice and task label, and the chat's own
line), and the pop-up's sound and desktop notification on its own page; and a review before landing found the Roles
page's decision cards drew #682's brief but not the route's line, now added there too.

**H-OWNER-COO-CARD (#686).** Wrong now: COO can't see an owner question before he does, or add context to it. The
change: on "held", a card in COO's home chat by the role-message delivery, the `owner_question` tool there only, and
the turn-end safety net. Expected: tests show the card's content and batching, each action, each refusal (another
chat, a note holding an id or path, return on a stuck card, a hold over 2 hours), release after COO's turn ends
with no action, and nothing delivered with the switch off. Wrong if COO can answer a question for him, a card lacks
who, what, choices or deadline, or a held question stays held after COO's turn ends with no action.
**Result: HIT.** Every expected case passes and none of the three wrong-if results showed: the tool has no action
that answers an ask; every card names who asks, the kind, the question with its choices and the deadline; and a
question still held with no action when COO's turn settles goes to the owner at once, also after a restart before
any ask has reopened the store (a final review found that path; the router now opens the shared store when routing
is on, and the two restart cases fail without that change). With the switch off nothing is delivered, no store is
opened or written and the tool says routing is off. Focused run: 19 files, 324 tests passed. How it got there:
review before wiring found four gaps to correct under this hypothesis: active card receipts
must survive a restart or a stuck card's changed ask id (persist the send id beside its hold key); dependent
choices must remain visible (render their branch conditions); plain notes must reject every owner-question tag;
and clock times must round-trip in the owner's zone at daylight-saving changes. The expected result is immediate
turn-end release on the shared router/store even after reload, complete conditional choices, rejected tags and
the next real local clock occurrence. Each has a fixed-input regression; any contrary result is a MISS.
The delivery check must compose after both session opening and prompt admission, not merely before an artificial
send delay: gone asks are omitted and newly held asks join the same card. Packages must really fold in the page,
not just use Markdown quotes. Further review found that the SDK drains next-turn notes before its preflight
callback; rejecting there would lose notes. The freshness check therefore runs at the existing prompt-start
guard's loadout boundary and restores only the drained notes on refusal. A real-SDK fixed-response regression
checks no stale turn, no lost note and one valid next-turn delivery. No provider request is read.

## Checks

- `tests/unit/owner-question-route.test.ts` (52 tests): the case table, its order and sides, the window constant, no
  words read, the labels and COO's words.
- `tests/unit/owner-question-holds.test.ts` (36 tests): the clock, durability, restart reload, fail-open. Temporary
  folders only.
- `tests/unit/asks-held.test.ts` (16 tests): no route behaves exactly as today (the same objects, events and list),
  a direct route, holding, release, return, and answering while held.
- Before the change the three files fail: the route and store files can't load (no modules), and 15 of the 16
  AskHub tests fail (the one that passes checks `answer()` with no route, which is unchanged). After it, all 104
  pass, with the same results on two runs.
- No route, old against new (a one-off script, not kept): one scenario of all four kinds through the AskHub before
  this change and after it (add, the same id again, list, get, a bad, a missing and two good answers, a late answer,
  settling twice, listeners on and off) gives byte-identical events and results (2,935 bytes each), and every event
  carries the caller's own object in both.
- #685, `tests/unit/owner-question-wiring.test.ts` (13 tests): the cases of H-OWNER-ROUTE-WIRE through the real
  router, store, AskHub, Telegram plugin and Roles reader with fake chats, and switch off against no router at all.
- #685, `tests/unit/owner-question-client-session.test.ts` (11 tests): the same cases through the real ClientSession
  with two fake windows (pop-ups, snapshots, the chat list's "?", the Queue tab card, the needs-you marks), and
  switch off giving exactly today's messages.
- #685, `tests/unit/owner-question-route-view.test.ts` (3 tests): the page shows only plain route lines, and a held
  card doesn't sound. `tests/unit/chat-dialogs.test.ts`: a chat can keep a notice from the window.
  `tests/unit/roles-exact.test.ts`: the Roles page's decision card opens with the route's line, then COO's words,
  then the brief and the question; a card with no route, or one that isn't plain, is drawn as before.
- Before #685's code (its base, 5e36933a), the three new files can't load, and the chat-dialogs notice test fails.
- Roles page with no route, old against new (a one-off render, not kept): the same asks, with and without a brief,
  in Your decisions and the role's panel give the same page, node for node and character for character, apart from
  the renderer's own `data-u0-key` position labels, which shift by one after the added block and are read by nothing
  else.

- #686: `tests/unit/owner-question-card.test.ts` (the card: who, kind, reason, brief, question and choices, the
  deadline, actions, the package folded, several in one card), `tests/unit/owner-question-coo.test.ts` (delivery and
  batching, a gone ask never carded, retry and fail-open, the switch off, the turn-end safety net, where a question
  stands), `tests/unit/owner-question-tool.test.ts` (each action and refusal, routing off, another chat, the hold
  times), `tests/unit/owner-card-brief.test.ts` (`plainTextFaults`). The desk and tool tests share
  `tests/unit/owner-question-desk-fixture.ts`: a real AskHub and hold store, no chat, no model.
- #686 integration: `tests/unit/owner-question-coo-restart.test.ts` uses the real router, store and AskHub for
  restart receipts, changed ask ids, deferred composition and fail-open. `tests/unit/owner-question-delivery.test.ts`
  drives native host seams with synthetic chats for admission, extension-only attribution, tool registration and
  turn-settle release. `tests/unit/owner-question-sdk-freshness.test.ts` uses an isolated SDK session and fixed
  responses (no model) to check the last freshness boundary and preservation of pending next-turn notes.
- #686 carry-on: `tests/unit/carry-on-requester.test.ts` checks persisted card receipts, malformed input rejection,
  copy isolation and no owner/Telegram authority. `tests/unit/owner-question-body.test.ts` checks the package fold
  in the rendered component and its search behavior; `tests/unit/role-message-text.test.ts` checks the card header.
  `tests/unit/tool-registration.test.ts` classifies `owner_question` as a COO-home-only tool, not a catalog row.

## Undo

With the switch on (#687): turn `ownerQuestionsViaCoo` off in Settings. New asks go as before, and the next sweep lets
every held ask through; after that nothing is held or written while it stays off. Keep the code and existing hold
records: once records exist, undo is this forward-disable, not a revert to readers that do not know their new fields.
Before activation and with no hold records, #686's commit alone can also be reverted and deployed; #684/#685 stay
installed with their switch off. No role prompt, identity file, pi-queue code or Telegram answer path changed.
