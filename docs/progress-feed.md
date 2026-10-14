# The progress feed (Initiatives page, Progress)

One running progress feed per initiative, written by its **lead** from the roles' own records and linked to
them, so the owner reads one feed instead of one TL;DR per role (owner via COO rm-ba07e068, Oct 9: "Similar
to tldr but more unified, I want the updates to be more from a the initiative level"; he picked "Lead +
sources"). Task #85; patch `progress-feed` in [PATCHES.md](../PATCHES.md). The page itself:
[initiatives-page.md](initiatives-page.md).

## Which initiatives

Only those listed in `~/.pi-web-ui/decisions/settings.json` (owner, Oct 10: "only enable it for teams in
temper"):

```json
{ "feedInitiatives": ["team-in-temper"], "pokeEveryHours": 3, "dailyAt": "17:00", "feedReaderCheck": true }
```

Other initiatives show **Progress: off**: none of their TL;DR lines are kept, their lead is never asked and
their updates never read. None listed = off everywhere.

## The lead

- One per initiative: `lead` and `leadSet {by, at, source}` in `initiatives.json`.
- Only the owner sets it: the role picker on the page (empty by default; `source: "page"`), or his own
  answer to a question. No tool sets it.
- Team in Temper starts with Architecture, his own pick in Ops's dialog (2026-10-09 15:46 PDT, record
  `dr-2941468511bb`); the page shows "Set by you, Oct 9". Applied once; a lead he sets or clears later stays.
- No lead: no asks; Progress lists the roles' own TL;DR lines and done tasks, in time order, under "No lead
  yet".

## What the page shows

- The initiative list: the lead, how long since the last update, a Needs-you count and a "new since you
  looked" dot.
- Progress, above Decisions: the lead's updates, newest first. Each gives What changed, What's next, Needs
  you, and Impact for you / Other options and their cost / Until when ("not given" when missing); the
  writer and approval labels of every decision it links; and its sources, one click away (TL;DR lines, queue
  plans and done summaries, role messages, Board posts, the owner's answers, decisions).
- A flagged sentence shows on its update, in plain words ("Not in its sources"), with the kind, the claim and
  whether a script or the reader found it. Only a new update from the lead clears it.
- "Not in any update yet: N decisions, M changes", decisions missing impact, options or until, and "Asked
  <lead> at hh:mm, no update yet" while an ask is open; an **Ask for an update** button otherwise.

## initiative_update (for roles)

A server tool in every chat; it refuses chats without a role.

- `new` (initiative, page): what was filed under it since the lead's last update, one line each with its id
  (TL;DR lines, queue plans and done summaries, messages, Board posts, owner answers, decisions and changes,
  with their filled fields in their own words), the decisions missing impact, options or until, and every
  decision or change no update links yet.
- `post`: initiative; changed, next, needs_you (may be empty); impact, options, until (optional, text only);
  sources = record or decision ids, at least one. About 1,500 characters per field. Only the initiative's
  lead may post; anyone else is refused with "the lead is X". The reply lists what is still unlinked and any
  flags.
- `read`: the latest updates, or one in full with its sources.

Updates are kept as records (`source: "update"`) in `records.jsonl`; the decision reader skips them and TL;DR
lines.

## TL;DR lines

The records scanner keeps `tldr` entries of chats as records (`source: "tldr"`) when their initiative has a
feed. Their initiative is, in order: the line's own `initiative` field (pi-tldr), else the initiative of the
queued task whose chat they are in (pi-queue), else the reader's filing.

## Asks to the lead ("pokes")

Delivered to the lead's home chat like a role request (after any running turn, starts a turn, retries), from
"the Initiatives page", outside the role message caps, each a fresh chain. The text: the owner's request
(so it is requested work under rule 14), what's new (counts and a few lines, unlinked decisions first), the
decisions missing the three fields, any flags on its last update, then how to post ("say only what the linked
records hold; fill impact/options/until with decision_log where known, else say not known").

Triggers: a queued task filed under it is done; a new decision or change is filed under it; daily at
`dailyAt` if anything is new; a flag on its last update; the owner's button. Throttle: at most one automatic
ask per initiative per `pokeEveryHours`, none when nothing is new, none while one is unanswered (an ask closes
once an update came after it and the lead's turn is over, or after 24 h). The lead may answer from a queued
task (Board order bp-94c7e08b): its updates close the ask only once that task's chat is out of its turn too,
so a catch-up's next round doesn't reach the home chat while the task is still posting. The button skips the
throttle but not an ask still on its way.

**Catch-up**: `pi-web-ui decisions catch-up --initiative team-in-temper --from 2026-10-03` asks the lead to
cover everything since that day, round after round, until no decision or change is unlinked; it stops (and
says so) when a round doesn't lower the count. `pi-web-ui decisions feed` shows each feed's state.

## The second-hand check

Every update is checked against the metadata and text of its linked records (`server/feed-check.ts`), with
code first (AGENTS.md rule 17):

- **Owner credit** (code): a sentence that says or implies the owner decided is flagged unless a linked
  owner record (his answer, his order's own words, a plan he approved) holds it (#84's who rules).
- **Numbers, money, tokens, percentages, durations, dates and times** (code): each must be in a linked
  record's text or time. A sum of money or a token count is held only by the same kind.
- **Paraphrased impact, cost, option or date** (the reader, the pool's cheapest Claude model, no tools): it
  lists the claims a script can't see, each with a quote from a linked record; code checks every quote, and a
  label counts only when no quote holds it. `feedReaderCheck: false` keeps only code's checks.

Stand-alone: `node --import tsx scripts/feed-check.mts --update <file.json> --dir <decisions dir>` prints each
sentence with its flags and why (`--id <update>` for a kept one, `--reader` to ask the model, `--claims
<saved check>` to replay a saved reader answer). Stage tests (rule 16) and their planted sets:
`~/company-lab/shared/decisions-page-replay-2026-10-10/REPLAY-FEED.md`.

## Files

| File               | Holds                                                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `initiatives.json` | `lead`, `leadSet` per initiative                                                                                                  |
| `settings.json`    | `feedInitiatives`, `pokeEveryHours`, `dailyAt`, `feedReaderCheck`                                                                 |
| `feed-state.json`  | per initiative: the open ask, past asks, triggers, the daily mark, the catch-up, the owner's last look; the check of every update |
| `records.jsonl`    | TL;DR lines (`tldr`) and updates (`update`) beside #83's records                                                                  |
