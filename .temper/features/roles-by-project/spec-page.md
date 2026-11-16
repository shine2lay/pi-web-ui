# Roles by project: page states, controls and answering

Part of [spec.md](spec.md). Behaviour follows [design.md](design.md); this part fixes what the page reads and
what it must keep across a live update.

## Data the page reads

- `useRoles("full")` (`web/src/roles-state.ts`): `overview.taskBoard`, `overview.work`, `overview.asks`,
  `overview.at`, plus the state's `status`, `error`, `checkedAt`. No new message type, no polling of its own.
- Needs-you cards: `projectExactRoles(...).needs` (`web/src/roles-exact-model.ts`), oldest first as sent. A card's
  task ref and group link come from the ask with `kind: "task"`: its `role` and the number in `task:<n>` give the
  ref `"<role> #<n>"`, looked up in `taskBoard.tasks`; no match -> the card shows no group link (never a guess).

## Screen states (exactly one at a time)

| State | When | Shows |
|---|---|---|
| loading | no `taskBoard` received yet and the watch has not failed | skeleton tiles, "Loading projects and queues" |
| live | last payload had `taskBoard` | the view; "As of" = `taskBoard.asOf` formatted |
| empty | live and no open task (`groups` all `open: 0`) | "All clear" panel, then minis; fleet bar hidden |
| error | `status === "error"`, or a payload without `taskBoard` after a good one | coral banner "Couldn't read the queues just now" + "Try again" above the last good view, kept as it was; no last good view -> banner alone |
| no results | search on and nothing matches | "Clear search" + suggestion buttons |

- "Try again" calls `reloadRoles()` once per press; no timer, no fake delay. The banner leaves when a payload
  with `taskBoard` arrives.
- `taskBoard.problem` set: a one-line note above the view; counts stay the server's.

## Controls (exactly two)

- **Group by** radiogroup: Project (default), Now, Department ("Dept." under 400 px), Status. Arrow keys move
  and select. Stored in `localStorage["roles.groupBy"]` as `project | now | department | status`; any other
  value or a storage error -> Project.
- **Search** "Find a task, project or role": case-insensitive substring, one leading `#` ignored, over title,
  id, role id and name, `"<Role> #<id>"`, group label, tags, initiative name. A group whose label matches shows
  all its tasks. Search is not stored. Counts shown while searching are `boardStateOf` over matched rows.
- "Needs you" open/closed is stored in `localStorage["roles.needsOpen"]` (`"0"` closed, else open). Tile
  open/closed and folds are not stored.

## Views

- **Project**: tiles for groups with open tasks (tier, then open count, as the server ordered `groups`);
  active projects with nothing open -> "Nothing open right now · N" minis; done/dropped projects and tag groups
  with only done rows -> "Done lately · N" fold. Tile large when `open >= 6`.
- **Now**: one lane per role with an open task (needs-you first, then most working); Running / Held / "Up next,
  in order" numbered by `queueIndex`; Up next shows 20 then "+N more".
- **Department**: the same tiles, one per role (all its open rows); roles with nothing open -> "Quiet roles" fold.
- **Status**: Needs you / Blocked or waiting / Working / Queued / Done lately, each clustered by group.
- Fleet bar: one mark per open task in `tasks` order; hidden when nothing is open or search is on.
- Needs you: shown in Project and Department; first row only (cards that fit one row, measured from layout:
  3 at 1440 px, 1 at 390 px), then "Show N more".

## Answering (the existing flow, unchanged)

Answer opens `RoleAnswerDialog` (`web/src/components/RoleAnswerDialog.tsx`) with the card's `NeedsYouItem`; the
dialog sends `roles_ask_open` then `roles_ask_answer` through `web/src/roles-answer-state.ts`. Send stays disabled
until a choice is picked; nothing is sent before. The page never marks a task answered itself: the card and
the pill change only when the next roles payload drops the ask. A refused answer shows the dialog's own error and
is never retried automatically.

## Live updates must not disturb the owner

A roles payload arriving mid-interaction patches the view in place. Kept across it: scroll position, keyboard
focus (same element by task ref or control), the search text and caret, every tile's `aria-expanded`, the open
answer dialog with its picked choice, and a pointer press in progress (mousedown -> mouseup still clicks, WebKit
included). A tile whose group disappeared closes; nothing else resets.

## Accessibility and looks

Tiles are buttons with `aria-expanded`; Group by is `role="radiogroup"`; the dialog is a native dialog (Escape,
focus held). Every state pairs colour with word and icon. Targets >= 24 px; Answer 44 px tall on phones. One 160 ms
opening animation, none with reduced motion. 320, 390, 1440 px, light and dark, 0 horizontal overflow, 0 overlap.
