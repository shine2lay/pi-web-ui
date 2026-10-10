# The Initiatives page

**Initiatives** is a top-bar view next to Roles (`?view=initiatives`). Per initiative it shows every
design decision found in the roles' records, its later changes, who really decided, and what it means
for the owner: impact, other options and their cost, and until when. It only shows and links; roles
correct it with the `decision_log` tool. Task #85 adds the lead's Progress section above Decisions.
Patch: `initiatives-page` in [PATCHES.md](../PATCHES.md); the records come from `decision-records`.

## What it shows

- **Initiative list**: each initiative with its decisions and changes, how many entries lack an impact
  for the owner, and how many carry a flag about who decided. **Unfiled** holds decisions no tag,
  marker or reader guess could place; nothing is dropped.
- **Decision cards**, newest first: a one-line "what", then two separate chips, the writer (the role
  that wrote the record, or "You" for the owner's own words) and the approval kind ("auto-approved plan
  (you didn't see it)", "plan you approved in a dialog", "your pick in a dialog", "your order",
  "message", "Board news", ...). They are never merged into one "who".
- **"You"** only when one of the owner's own records holds the point word for word: the option he
  picked (label, description or preview) or what he typed, an order's own words, or a plan he approved
  in a dialog ("Architecture proposed, you approved"). A role's wording never makes an entry "you".
- **Flags**, in plain words: "<role>'s choice, inside the option you picked" (a rider), "A role says you
  decided; not in your words", "The quote isn't in the record word for word".
- **Orders** show "Your words" and "<relayer>'s text" as two labelled parts.
- **Impact for you / Other options and their cost / Until when**: each shown, or "not given".
- **Changes** beneath a decision in time order, each with a type chip (reversed, widened, limit raised,
  ...) and its own who chips.
- **Sources**: each opens the record in a dialog, with "Open the chat" where it has one.
- **Reader line**: on or off, records not read yet, tokens today of the daily cap, and tokens per day.

## The reader

`server/decision-reader.ts` reads new records in batches with the cheapest Claude model of the chat
pool, one isolated call per batch with no tools. It is **off until switched on** in
`~/.pi-web-ui/decisions/settings.json`:

```json
{ "enabled": true, "dailyTokenCap": 2000000, "readFrom": "2026-10-03" }
```

Other settings: `model` ("auto" or provider/id), `thinking` (medium), `readEveryMinutes` (5),
`batchRecords` (12), `batchChars` (12000), `callTimeoutSeconds` (420). At the daily cap it stops until
the next day and the page says so. A rate-limit refusal rests that Claude account for an hour.

- `pi-web-ui decisions status`: records per day and the reader's state.
- `pi-web-ui decisions read [--max N]`: read now (only when switched on, within the cap).

## Files (`~/.pi-web-ui/decisions/`)

| File | Holds |
| --- | --- |
| `records.jsonl` | #83's records (messages, Board posts, answers, queue plans) |
| `decisions.json` | decisions, changes, sources, owner fields, who added each |
| `initiatives.json` | `[{ id, name, markers, lead }]` (lead: task #85) |
| `settings.json` | the reader's settings (above) |
| `reader-state.json` | records read, tokens per day, the cap, accounts resting, the last error |
| `previews.json` | option previews of older answers, read from their chat line |

## decision_log (for roles)

`list`, `add` (a decision or change that lived only in files, notes or code, with a link), `fill`
(impact, options, until), `refile`, `not_decision` (and `restore`), `add_initiative`. Entries show who
added them. A role may point to an owner record; the who rules then check it.
