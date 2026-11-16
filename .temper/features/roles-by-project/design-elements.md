# Roles by project: tiles, task maps and data (`roles-by-project`)

Part of [design.md](design.md). Field names are from `server/protocol.ts` (`UiRolesOverview`);
Architecture's spec.md is the contract and may change how a gap is closed.

## Tile, closed

- Name + chip: initiative name, "Project", or "Tag".
- "Led by" with a department dot (project), or up to 3 role dots (tag).
- "Mostly held on X (n)" when tasks are held.
- Goals ring met/total (projects only; `#` for a tag).
- Big numbers: open, needs you, held, done · 14 days (zeros omitted except open).
- Mini task map, then the counts line (needs you, blocked, waiting, working, queued).
- Gold border when it holds a needs-you task.
- Size: large (two columns at 1440 px) with 6+ open tasks; one column on phones.
- Order: needs you > held > active, then by open count. Projects with nothing open drop to the
  "Nothing open right now" minis (same mini map).

## Mini task map rule

- Layers come from `after` and `block.on` links (left to right; a phone keeps it compact).
- Window: at most 5 layers, starting at the earliest layer that still has an unfinished task.
- Nothing open: the last 3 layers. No links and nothing open: finished tasks as green squares.
- Cut layers show "+N earlier layers" / "+N later".
- Colours: the state colours; done = green.

## Task map, opened

- Full map, never windowed: boxes placed by `after` + `block.on`; phones stack them with
  bracket arrows.
- Arrows: green from done tasks, dashed coral into blocked tasks, thick blue from the root
  blocker (the task holding the chain), labelled "N tasks wait on this one".
- Box: state pill, role, #id, title (3-line clamp, full title on hover). Held: how to unblock it
  ("Unblocks when Architecture #491 finishes"). Done: its summary. Needs-you tasks say "Needs your
  answer: it's at the top".
- Unlinked tasks under "On their own"; 6 per stage then "Show all N".
- "Done when · M of N met" fold below the map.

## Element -> data

| Element | Source | Status |
|---|---|---|
| Task id, title, role, status, pill | `roles[].queue.active/queued[]` (`UiRoleTask`) | exists |
| Group key: project, else tag | `UiRoleTask.project`, `.tags` (canonical, aliases folded, ops #964) | exists |
| Initiative chip | `UiWorkRecord.initiative` -> `work.initiatives[].name` | exists |
| Project name, lead, status | `work.projects[]` | exists |
| Goals ring | `UiWorkRecord.items`, `.met` | exists |
| Done-when texts + met marks | `UiWorkPageRecord.doneWhen[]` (Initiatives payload) | **gap G1** |
| Map links | `UiRoleTask.after`, `.dependsOnRefs` | exists |
| How to unblock | `UiRoleTask.howToUnblock` / `blocked` / `wait` / `owing` | exists |
| Root blocker | `tagGroups[].rootBlockerRef` (or computed from links) | exists |
| Needs-you question + choices | `asks[]`, `UiRoleTask.stuck.question/.choices` | exists |
| Answer | `roles_ask_open` / `roles_ask_answer` | exists |
| Done tasks as green boxes + summary | done tasks per group (`doneSummary`, `finishedAt`, `after`) | **gap G2** |
| done · 14 days | per-group count | **gap G2** |
| Done predecessors for the window | up to 4 steps back from open tasks | **gap G2** |
| Tag tile roles and counts | `tagGroups[]` (`UiTaskGroupRollup`) | exists |
| Now lanes | `queue.active` + `queue.queued` (capped at `ROLES_QUEUED_MAX`; "+N more" from `counts.queued`) | exists |
| As of, error keeps last view | roles watch `at` + watch failure | exists (frontend state) |
| Remembered grouping and fold | localStorage `roles.groupBy`, `roles.needsOpen` | frontend only |

## Gaps (Architecture decides)

- **G1** Done-when items per project: add to `UiWorkRecord`, or fetch when a tile opens.
- **G2** Done tasks per group: last 6 done within 14 days (id, role, title, trimmed summary,
  finishedAt, after); every done task an open task starts after, up to 4 steps back; the 14-day
  done count. Measured on the fixtures: 200-260 tasks total. Closed tiles need the count and
  window, so a lazy fetch only covers the opened map.
- **G3** (minor) no priority on `UiRoleTask`; Now uses queue order (the run order). No change needed.
- Server-owned truth (DESIGN.md principle 3): counts the tiles show should come from server
  fields (`tagGroups` rollups, G2 counts) where they exist.
