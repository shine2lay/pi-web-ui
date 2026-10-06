# The Roles page

**Roles** is a top-bar view next to Chat, Terminal and Git. It shows every role from
Settings -> Identities on one page: what each one is doing, what is waiting on the owner, its newest
TL;DR line, its queue, its goals and its 6 am report. It only shows and links. Answers, queue
controls and edits stay in the chats and in Settings, and nothing on the page starts or stops work.

Design: `~/design-lab/roles-page/SPEC.md` for what the page says; the layout is the owner's
2026-10-05 call ("show less, tap for more"): tiles instead of SPEC's board, which read as a flat
table. Patch: `roles-overview` in [PATCHES.md](../PATCHES.md).

## What it shows

- **Waiting on you**: every distinct open ask from the owner, oldest first, each with its role, where
  it is (home chat or task #N), how long it has waited and a link to that chat. The strip is open on
  a desktop and folded on a phone (both remembered on the device).
- **Two groups**: "Start their own work" and "Work on request", alphabetical in each.
- **One tile per role**, in a grid (two columns on a phone), coloured by its status (an amber tile
  for "needs you", a blue edge for busy, a grey edge for paused, a dashed one for nothing yet; the
  word and its icon always say it too). A tile shows the name, the status, the newest line (two
  lines on a desktop, three on a phone) and one footer line: a few words on the queue ("#20 Working ·
  2 queued"; a hold is just "On hold" or "Blocked", since what it waits on can be a paragraph; a
  task the owner paused says "Paused by you", a whole paused queue "Queue paused by you") or,
  with nothing queued, when the line is from. A role with nothing going on for a day steps back. All
  14 tiles fit on a 1440x900 screen with real lines (80-130 characters) and long hold reasons; what a
  tile cuts is in the panel.
- **Tap a tile for the rest**: a side panel (full screen on a phone) with the role's home chat and
  "About & rules", every TL;DR line, the queue (counts, active tasks with their words, what is
  queued), the goals and the 6 am report's Goal in plain words. Escape, the close button or a click
  beside the panel closes it, back on the tile. Every link in it closes it first. No separate detail
  page.
- **The whole report** opens from "Show full report" (or a tap anywhere on the report part) in a big
  window over 85% of the screen, all of a phone's: the report's Markdown drawn like a chat's (bold,
  lists, code, links), each heading's part in its own box, side by side when there is room. Escape,
  its close button or a click beside it closes it, back where it opened. "Report in chat" opens the
  chat the answer is in.
- **6 am reports** (the switch at the top, on the phone and the desktop): only the roles the 6 am job
  asks, each with its Goal in a few lines (a tap anywhere on the card opens the whole report) or the
  reason there is none.

Status, strongest first:

| Status      | When                                                                                   |
| ----------- | -------------------------------------------------------------------------------------- |
| Needs you   | the role has an open owner ask                                                         |
| Busy        | its home chat or a task chat is working, or a queued task is being worked              |
| Paused      | its home chat's queue was stopped (by the owner or after a stop) with tasks still in it, or the owner paused its queue or one of its open tasks (a paused task is never "needs you") |
| Idle        | it has a home chat and has done something                                              |
| Nothing yet | no home chat that can be read, or no TL;DR line or task in it yet                      |

## Where the data comes from

Everything is read; nothing is written, opened or started.

- **Roles**: the identity registry (each `identity.json`, plus the Focus line of `about.md`, cut at 120
  characters like the roster). Never the about text, prompt, rules or notes.
- **Home chats and task chats**: their saved transcripts, read from where the last look stopped, in
  1 MB pieces. Only TL;DR entries, queue entries and a marker for each owner reply are kept. No message
  text, thinking, tool calls or results, prompts or model requests leave the reader. Task chats are
  read only for tasks still in progress, at most 8 per role.
- **Working or not**: the app's own runtime state. No chat is loaded or kept loaded for the page.
- **Owner asks**:
  - unanswered needs-you TL;DR lines;
  - stuck tasks, with the time the task got stuck (the queue's own record);
  - question, dialog and approval cards open in a role's loaded chats.
  A task's question that was also copied into the home chat appears once. A task asking its main chat
  is not an owner ask. Different asks are never merged. An ask with no known start time sorts last
  rather than getting a made-up age.
- **Requests**: the whole role-message store (not only the newest 100 rows Settings lists).
- **6 am reports**: role-reports' run record (`$XDG_STATE_HOME` or `~/.local/state`,
  `role-reports/runs.json`), the store's report requests, and the reply in the home chat, read with
  the same boundaries as role-reports' receipt. The reasons for no report: not active the day before,
  not in the job, the request couldn't be sent, not answered yet, answered without a report, or the
  first report is still to come (the scheduler's `role-reports run` job). Days are Pacific. Since
  2026-10-06 the roles are asked for a short plain-English report under `## Goal`, `## Yesterday`,
  `## Learnings`, `## Next`; older reports, under `## Goal or hypothesis`, `## Done yesterday`,
  `## Learned`, `## Next`, still show under their own headings.
- **Work mode and goals**: the owner's `workMode` and `goals` in `identity.json`; without them, the
  every-chat rules' defaults (`server/role-rules.ts`): product, design and qa start their own work, all
  other roles (and any new one) work on request, and Architecture keeps its two approved goals. An
  ended goal leaves the page. When the owner's setting disagrees with the rules, the role's panel
  says so; nothing acts on either.

Every chat file must be an absolute path that is its own resolved path (no `..`, no symlink), end in
`.jsonl` and lie inside the sessions folders (`PI_CODING_AGENT_SESSION_DIR`, `<agent dir>/sessions`).
Anything else is not read: a note at the top names those roles, and the role's panel says what
couldn't be read ("home chat", "task #N chat", "report"); the rest of the page still shows.

## How it stays current

The browser asks with `roles_watch { full }` (`full` while the page is open; otherwise only the
number for the top bar's badge) and stops with `roles_unwatch`. With no window watching, nothing is
read. While a page watches, the server looks again every 3 seconds (every 10 for the badge only) and
right after a role message or an identity file changes. It sends the page only what changed, and a
"checked at" time every 30 seconds otherwise. A failed look keeps the last data on the page and says
so. A lost connection shows "Not live" with the last update time, and a new connection asks again.

Limits per role: 20 TL;DR lines, 20 queued tasks, report text up to 12,000 characters.

## Links

- `?view=roles` opens the page, `?view=roles#r-<role>` at that role's tile.
- The page's links open the chat that already exists for that transcript (never a new one), with
  `focus=tldr:<id>`, `task:<n>`, `question:<id>` or `report:<day>`: the right panel opens at TL;DR or
  Queue and the item is marked, or the chat scrolls to the report.
- The gear next to a name opens Settings -> Identities at that role.

## The owner's settings

Settings -> Identities -> a role -> **How it works**: the work mode (the rules' default, starts its own
work, or works on request) and the goals the owner approved (name up to 80 characters, scope up to
160, the approval time, an optional end; at most 12). Saving goes through the same hash-checked
`identity.json` save as the file editor: only these two fields change, the other fields and their
order stay, and a file that changed after it was opened is refused. pi-identity reads the same
fields (`config.ts`, kept byte-identical as `server/identity-config.ts`); about-drafts and agents
can't set them.

These settings are for showing. They don't start, stop or schedule anything, and they don't change a
role's prompt or the every-chat rules.

## On the device

Whether the strip is folded is kept in the browser, separately for the phone and the desktop
layout (`pi-web-ui:roles:strip:<layout>`). Nothing else on the page is remembered.

`PI_WEB_TABS` can turn the page off (`roles`).

## For chats: roles_overview

The same data as text, for a chat (telegram-coo; the COO uses it for its morning brief): the
read-only tool `roles_overview` (`server/roles-overview-tool.ts`), in every chat. Without arguments it
gives every role in short: the counts, then per role its title, home chat, status, last activity,
newest 3 TL;DR lines, open asks, queue (running, active tasks and counts) and the latest 6 am report
in a line. `{ role: "<id>" }` gives one role in full (every TL;DR line the page has, the tasks waiting
to start, the whole report). Times are Pacific. Output is capped (24,000 characters; 300 per part,
200 per line in short). On a busy day the details shrink together so every role still fits in
one call. An unknown role is a plain error naming the roles. It reads nothing the page doesn't.

## Role messages in a chat (folded)

In a chat, a message from another role (question, request, reply, an FYI added without a turn, the
app's 6 am report request) is one folded row: an envelope, "From <role>", its kind and its first
words (role-message-fold). A click, Enter or Space opens it; the open card's head folds it again.
What is open is kept while the page is open, nowhere else. The Ctrl+F search opens them all while it
searches. `message_role` calls are folded too, even with the tool-details switch on: "To <role> ·
<kind> · first words" and the id it was sent (or held) under. Display only: the model and the
transcript get the full text. On Telegram, turns that role messages start never reach the owner,
except COO's answers to his own questions (telegram-coo).

## Tests

- `tests/unit/roles-overview.test.ts`: the server reader and push (temporary folders, synthetic
  transcripts).
- `tests/unit/roles-view.test.ts`: the view model, the owner's form and the page's markup.
- `tests/unit/topbar-fit.test.ts`, `tests/unit/ui-slots.test.ts`: the tab and its place in the top bar.
- `tests/roles-page-test.mjs`: the page in a sealed server and headless Chrome (14 and 20 synthetic
  roles, both themes, phone and desktop).
- `tests/unit/roles-overview-tool.test.ts`: the `roles_overview` text (short, one role, an unknown
  role, the report states, the cap).
- `tests/unit/role-message-text.test.ts`, `tests/role-message-fold-test.mjs`: folded role messages and
  message_role cards in a chat (both themes, phone and desktop, Ctrl+F, axe).
