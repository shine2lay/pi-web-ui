# Owner-question routing: straight to the owner, or through COO first

Ops #684 (project owner-cards-plain-context, lead Ops). Groundwork only: the routing rule, the durable hold store
with its safety-net clock, and AskHub's held state, with tests. **Nothing calls them yet**, so nothing changes for
any chat or surface. #685 records the facts the rule needs and passes a route, #686 adds COO's card and the plain
lines on the owner's surfaces, #687 switches it on.

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

| Field | What it is |
| --- | --- |
| `kind` | The ask's kind: question, dialog, approval or stuck (a queued task's card). |
| `turn` | The asking chat's current turn record (`conv.turnRecord`, a `RequesterTurn`) as admission filled it. |
| `ownerLastWroteAt` | The host's own time of his latest accepted input in the asking chat (kept across a carry-on); absent = not known. #685 records it. |
| `now` | The host's time now. |
| `homeRole` | The identity whose home chat asks (`identities.ts` `homeChatOf`), if any. |
| `grant` | Host-set: one of the role-message guard's continuation-grant asks. |
| `askedAgainAfterReturn` | Host-set: COO handed this question back earlier in the same turn and the chat asks again. |

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

| # | When | Route | Reason |
| --- | --- | --- | --- |
| 1 | COO's own home chat asks (identity `coo`) | direct | `coo-chat` |
| 2 | A queued task's card (kind `stuck`), whichever chat shows it | coo | `queued-work` |
| 3 | The turn holds his accepted input (he started it or typed into it while it ran) and he last wrote there under 30 minutes ago | direct | `owner-chatting` |
| 4 | A question asked again in the same turn after COO handed it back | direct | `asked-again-after-return` |
| 5 | A continuation-grant ask | direct | `grant-not-routed` |
| 6 | The turn holds his accepted input, but his last input there is 30 minutes old or more, or its time isn't known | coo | `owner-away` |
| 7 | Anything else: a role message, a Board post, a queue prompt or reminder, a schedule wake-up, a subagent, a plugin or extension message, or no record started the turn | coo | `not-started-by-owner` |

So grants and re-asks stay direct even in a turn he started long ago, and a time alone never makes a turn his: a
fresh `ownerLastWroteAt` with no owner input in the turn is rule 7. A turn he wrote in earlier doesn't count either:
only the asking turn's record is read. `OWNER_QUESTION_DIRECT_REASONS` and `OWNER_QUESTION_COO_REASONS` split the
list by route.

## The plain words (fixed here, shown by #686)

On the owner's surfaces:

| Case | Line |
| --- | --- |
| direct `owner-chatting` | "You were chatting here", plus how long ago he last wrote there: "You were chatting here (you wrote 3 minutes ago)", "(you wrote just now)" under a minute |
| direct `coo-chat` | "From COO's chat" |
| direct `grant-not-routed`, `asked-again-after-return` | no line (shown as before) |
| let through by COO with a note or a recommendation | "Came through COO", with the note and recommendation |
| let through with nothing added (COO bare, or the safety net) | "Came through COO; COO added nothing (it reached you after 31 minutes)" |

On COO's card, why COO got it first (`cooReasonWords`):

| Reason | Words |
| --- | --- |
| `queued-work` | "a queued task's card" |
| `owner-away` | "the owner started this but hasn't written there for N minutes" ("... but it isn't known when he last wrote there" when the time isn't known) |
| `not-started-by-owner` | "raised by work the owner didn't start" |

Minutes are whole minutes, rounded down ("less than a minute", "1 minute", "N minutes").

## The hold store (`server/owner-question-holds.ts`)

`OwnerQuestionHolds` keeps one record per ask held for COO, in `<dataDir>/owner-question-holds.json`
(`OWNER_QUESTION_HOLDS_FILE`): written whole (`server/write-whole.ts`: a temporary file in the same folder, then a
rename), mode 0600, `{ "v": 1, "holds": [...] }`. It holds no words of any question.

**A record:** `key`, `kind`, `reason` (the COO reason), `createdAt`, `state` (held / released / returned / gone),
`deliveredToCoo` (`at`, and `turnEndedAt` once that COO turn ended), `releasedBy` (coo / safety-net /
owner-answered), `finishedAt`, `note`, `recommendation`, `holdUntil`.

**Keys:** a queued task's card: `holdKeyOfStuck(stuckKey, stuckSig)`, `stuck:` plus a SHA-256 of its ask key and
signature (no path or question text). A question, dialog or approval: `holdKeyOfAsk(id)`, `ask:<id>` (hashed when
the id is over 200 characters).

**Calls:**

| Call | What it does |
| --- | --- |
| `admit(key, kind, reason)` | `hold` (with `deliver`: not yet sent to COO) or `show` (with why: released, returned, a due reason, full, bad-key, store-failed, clock-unusable). A held record kept from before a restart is held again, never delivered to COO twice; one whose time ran out meanwhile is released by the safety net and shown; a released or returned one is shown at once with what COO said; an ended one asked again is held afresh. |
| `delivered(key)` | It went to COO. False when already delivered: never twice. |
| `cooTurnEnded(key)` | The COO turn that got it ended. |
| `cooHold(key, until)` | COO keeps holding it, at most 2 hours from now (`COO_HOLD_MAX_MS`); renewable while it is held and not yet due. |
| `release(key, by, note?, recommendation?)` | Let through by COO, the safety net, or his own answer on the asking chat's page. |
| `returned(key, note)` | COO handed a question back (questions only, a note required). |
| `gone(key)` | The ask ended (answered, cancelled, the chat closed). |
| `due(now?)` | The held ones the safety net lets through now. |

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

| Call or event | Behaviour |
| --- | --- |
| `add(ask, onAnswer)` with no route | Exactly as today: the caller's own object, "appeared", listed. |
| `add(ask, onAnswer, { to: "direct", reason, label? })` | As today, on a copy carrying `route` (its reason and line). |
| `add(ask, onAnswer, { to: "coo", reason, heldAt? })` | Kept, but no "appeared" and not in `list()`: emits "held". `heldAt` keeps the time it was first held across a restart. |
| `add(..., { to: "coo", ..., releasedBy, releasedAt, note?, recommendation? })` | Already let through (after a restart): "appeared" at once with its line, never held again. |
| `release(id, by, note?, recommendation?)` | `by` coo or safety-net. Sets the route's line, note and recommendation, then emits "released" and "appeared"; it is listed again in its first place. `NOT_HELD` if it isn't held. |
| `returnToAsker(id, note)` | Questions only, held only, a note required. Emits "returned" with the note; it no longer waits. |
| `heldList()` | What is held, oldest first. `list()` leaves those out. |
| `answer()` / `settle()` | Unchanged, also on a held ask: the asking chat's own page can still answer it. |

`AskHub`'s constructor takes an optional clock (`Date.now` by default) for the times it holds and lets through.

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

## Undo

Revert the commit. Nothing calls the new code, so no deploy is needed either way.
