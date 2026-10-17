# The Roles page

**Roles** is a top-bar view next to Chat, Terminal and Git. It shows every role from
Settings -> Identities on one page: what each one is doing, what is waiting on the owner, its newest
TL;DR line, its queue, its goals and its 6 am report. It only shows and links. Answers, queue
controls and edits stay in the chats and in Settings, and nothing on the page starts or stops work.

Design: `~/design-lab/roles-page/SPEC.md` for what the page says; the layout is the owner's
2026-10-05 call ("show less, tap for more"): tiles instead of SPEC's board, which read as a flat
table. Patch: `roles-overview` in [PATCHES.md](../PATCHES.md).

## The role panel (owner, 2026-10-16)

The owner asked what the full Roles page needs (dialog, about 23:00) and picked the role panel as its first
piece, built in his chat with Ops, with Security checking the new data shown before install.

Hypothesis (rule 20):

- **What is wrong.** The live page (Ops #190, #200) shows what waits on the owner and each role's task rows, but
  not a role's own picture: its recent updates, its 6 am report, its goals, which project and initiative its
  tasks serve, and who a blocked task waits on. Evidence: the feed already carries the TL;DR lines, the report
  and the goals, and the work registry (pi-work-management) holds each task's project and initiative with their
  leads, but the page's closed projection shows none of them; the old rich panel (`RolesView.tsx`) is unmounted.
- **The change.** A panel per role, opened from its card: status, focus, work mode, goals, its home chat and
  "About & rules" (Settings), its TL;DR lines, its latest 6 am report, and its open tasks grouped by initiative
  and project, a blocked task with the lead it waits on, what that lead owes, when it is due and how many
  reminders went. The server adds two read-only things to the feed: each task's parent from its own queue
  entry, and the work registry's initiatives and projects (name, lead, status, done-when items met). All of it
  goes through the same closed projection as the cards: whole-text rejection of unsafe text, clipping, chat
  paths only in memory.
- **Expected result, and how it is measured.** Every role's panel shows the same lines, report and goals as
  `roles_overview` for that role; every open task appears exactly once, under the project and initiative its
  queue entry names ("Not in a project" when it names none); a blocked task's lead, what it owes, due time and
  reminders match its queue. Measured by the unit and sealed page tests on fixtures, and after install by a
  look-only comparison of every role's panel against `roles_overview` and `work_project`/`work_initiative`
  show on real data.
- **What would prove it wrong.** A task under a different parent than its queue entry, shown twice or missing;
  a panel line, report or goal differing from `roles_overview`; any unsafe text shown in part; a chat path in
  the page's DOM, attributes or URL; or a registry problem breaking the rest of the page.

Result (live look 2026-10-17 10:20, all 15 panels against `roles_overview` and the work registry): hit, with
one part not seen live (no lead block existed then) and three display faults, fixed in the round below.

### Follow-up round (owner, 2026-10-17)

The owner picked "fix both here after install" for Security's two findings (dialog, about 00:35), and the three
display faults the live look found go in the same round: one Security check, one restart.

Hypothesis (rule 20):

- **What is wrong, and the evidence.**
  1. A new connection reopens the project's newest chat through the SDK's `continueRecent`, whose
     `findMostRecentSession` stats each `.jsonl` following links. A link in the sessions folder to a file
     elsewhere can win, and the shell then writes into that file. The sealed page test's outside canary
     (`outside/private.jsonl`, linked as `sessions/linked.jsonl`) changed in 1 of 4 runs. Security traced
     this cause in source (rm-885a66f3); the test now logs the kinds of entries written, not yet seen again.
  2. The Roles reader's small JSON files (`JsonFile`) are read with `stat` + `readFile`. A FIFO in a file's
     place would stall the Roles feed, and neither reader passes `O_NOCTTY` (Security's nit on 25db5d49).
  3. On the live panel: a task waiting on other tasks reads "waits on · waits on …"; at 390 px the status
     word breaks mid-word beside a long title ("Workin/g"); goal dates show raw ("2026-10-04T22:20").
- **The change.** (1) pi-web-ui picks the newest chat itself: only regular files directly in the sessions
  folder (`lstat`, so never a link or anything else), newest by modification time, header readable as before;
  then opens it as `continueRecent` would. The repair fallback (#235) targets the same file. (2) `JsonFile`
  reads like the registry reader: open non-blocking, `fstat` the handle, regular files only, 8 MiB cap
  checked while reading; both readers add `O_NOCTTY`. (3) The panel's task line handles "waits on other
  tasks" as the card row does; the status sits under the title; goal dates read "Oct 4".
- **Expected result, and how it is measured.** The outside canary never changes: the sealed page test run
  4 times in a row with no canary failure (it failed 1 in 4 before), and a unit test where a link to an
  outside file is the newest entry and a regular file is picked. A FIFO in a Roles JSON file's place returns
  the empty value at once (unit test that hangs without the fix). The three display faults are gone in unit
  tests and in a look-only live check after install.
- **What would prove it wrong.** The canary changes again in any run; a new connection no longer reopens the
  newest regular chat (a unit test, and the live reconnect after install); the FIFO test still stalls; or
  any of the three faults is still visible live.

## Each department's own-work spend

Owner, 2026-10-10: "each count its own have write it somewhere and roles page shows it".
This is a display of the department's own tally, **not a central meter or an automatic stop**.
No spending is counted by the app and it never writes a tally or changes any queue.

Each role's tile and details show one line read from
`~/.pi/agent/memory/identities/<id>/spend.json`; `roles_overview` carries the same line, both
for all roles and for a single role. The role writes its own file under the separate Ops107
validated-write exception. The contract is v1 in `~/.pi/agent/spend-format.md`: `v`, `budgetUsd`,
`budgetFrom`, `weekStart`, `weekEnd`, `spentUsd`, `updatedAt`, `stopped`, optional `byInitiative`.
Budgets are positive finite USD amounts, spending non-negative finite USD, the dates real calendar
dates, and `updatedAt` an ISO timestamp with a numeric offset. Normal weeks are Monday–Sunday;
the first approved week is Oct 10–18, 2026. Unknown fields or a bad field make the figure unreadable.

- Current and under budget: "Own work this week: $412 of $2,000 · updated 3 h ago".
- At/over budget or `stopped`: "Budget used up: own work stopped until Mon", in the existing
  AA amber foreground. This reports the tally; it does not stop anything itself.
- Strictly more than 24 hours since the update: still show the amounts, with the age in muted text.
- End date before today (or a future week): "No figure for this week yet". Bounds are inclusive
  **America/Los_Angeles** calendar dates and work across daylight saving, not the server's UTC day.
- No file/no own-work budget: "No own-work budget", muted.
- Bad JSON, validation failure, excessive size (over 64 KiB), links or non-regular files:
  "Spend figure unreadable", muted. A bad figure never breaks another role or the page.

`byInitiative` appears in the details and tool only when non-empty. Each refresh re-reads the tally;
no separate watcher, model call, billing request, enforcement hook or hold is added. Older page
snapshots without `spend` remain readable. Undo: revert the spend-display commit and redeploy;
the files then stay untouched and are simply ignored.

Checks: `tests/unit/roles-spend.test.ts`, the Roles reader/tool/view tests and
`tests/roles-page-test.mjs` cover the seven cases plus stopped, Pacific/DST bounds, stale threshold,
invalid data and refusing links. The browser checks cards and panels, non-empty initiatives,
refresh, unchanged fixture hashes, contrast and axe in dark/White at desktop/phone widths.
Compact card spacing and two-line TL;DR previews keep the existing first-screen density bars;
the details panel retains the full text. `ROLES_LAYOUT_ONLY=1` isolates those layout checks
on the same fixtures without repeating the full Roles stage.

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
- **Board** (the third switch, with the number of open posts): the roles' board, news and the owner's
  orders for several roles in one post each. Who read each post, who got an order directly, who has
  done it (with their notes); the owner posts and closes from here. A role's panel lists its open
  orders not yet done. See [board.md](board.md).

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
With posts on the board it adds a "Board:" line (the open orders and who hasn't done each) and, per
role, the open orders it hasn't marked done.

## Role messages in a chat (folded)

In a chat, a message from another role (question, request, reply, an FYI added without a turn, the
app's 6 am report request) is one folded row: an envelope, "From <role>", its kind and its first
words (role-message-fold). A click, Enter or Space opens it; the open card's head folds it again.
What is open is kept while the page is open, nowhere else. The Ctrl+F search opens them all while it
searches. `message_role` calls are folded too, even with the tool-details switch on: "To <role> ·
<kind> · first words" and the id it was sent (or held) under. Display only: the model and the
transcript get the full text. On Telegram, turns that role messages start never reach the owner,
except COO's answers to his own questions (telegram-coo). The board's turn-start notes ("From the
board · 2 new posts") and orders sent directly ("From owner · Board order · Title: first words")
fold the same way (role-board).

## Turns another agent started (quiet turns)

A turn begun only by another role's message (question, request, reply, FYI) or a Board order is
not for the owner (quiet-turns): the whole turn folds into that message's row, which adds what the
turn sent ("→ replied to coo", "→ acked bp-…", "→ queued #12", "→ nothing sent", "· failed").
Opening the row shows the turn as before. Two role messages in one run share the first one's row.
Never folded: turns the owner began or joined, a reply answering a question asked for him
(forOwner), the 6 am report request, plugin messages such as the morning brief, and inside a folded
turn its ask_user_question dialogs and Needs-you items (queue_stuck, a needs-you TL;DR line, a question
passed on with queue_reply). A quiet turn plays no "done" sound, sends no browser notice and lights no
unread mark. Three switches in Settings → Display (server settings, so phone and laptop agree; all
off by default) fold more kinds the same way: a finished queue task waking its main chat ("[Queue] Task
#N … is done in its chat"), stall-check pokes (a role message starting "[Stall check] ") and scheduled
wake-ups. Trusted browser-owner questions retain `forOwner` through delegated and nested callbacks,
so their answers remain full here. Internal `ownerChannel` provenance is separate: browser answers
stay in chat; Telegram answers require the accepted Telegram input receipt. Unknown or mixed
provenance cannot cross-post. Neither marker is a model-settable `message_role` argument; no old
callbacks are rewritten or retransmitted. The hint line under each delivered role message and Board order tells the role to write
nothing for the owner and to answer the sender with message_role only if it needs an answer.

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
- `tests/unit/quiet-turns.test.ts`, `tests/quiet-turns-test.mjs`: which turns are quiet, the row's
  words, the hint lines, the switches, no sound or unread mark (both themes, phone and desktop, axe).
- `tests/unit/role-board.test.ts`, `tests/board-test.mjs`: the board (see [board.md](board.md)).
- `tests/unit/owner-answer-routing.test.ts`: fixed source, store, nested callback, visibility and
  Telegram-decision stages, followed by a metadata-only full-chain test with fake transport.
