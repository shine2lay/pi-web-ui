# initiatives-page-tasks: tasks, waiting on you and status on the Initiatives page

Ops #227, project initiatives-page, step 3 of 4 (step 1: `docs/initiatives-page-exact.md`). Lead: Ops. The
owner's plan: design first, then the features one step at a time, steps 2-4 side by side (his dialog answer
"Side by side").

## H-INITIATIVES-PAGE-3

**What is wrong, and the evidence.** The live Initiatives page (step 1, af0ab88b and 9b6c4e73) shows no task
anywhere. Every project row says "Tasks: not connected yet", the ON YOU bar says "Not connected yet: what's
waiting on you will show here.", the Needs you, Needs attention and Paused by you pills read "—", and every
chip shows the registry's status in grey ("Active"). Meanwhile the registry the page already receives
(`work_page`, #223) links 113 tasks at 19:20 on Oct 18. 23 of them are open: 10 working, 9 waiting, 2 ready,
1 asking and 1 blocked. 60 are linked straight to the one initiative and 23 to its five projects. So the
owner can't see on this page who is doing what, or what is waiting on him.

**The one change.** `web/src/initiatives-page/tasks.ts` turns the feed's task facts (status, block, own chat,
next action, the owner's pause, the Needs-you question) into the page by fixed rules:

- Under each project row go its open tasks (any status but done, dropped or removed), each showing "#N title",
  the department (its queue), a status chip, the next action or what it waits on, and "updated <time>". Open
  tasks linked straight to an initiative go in a row "Directly under this initiative". Clicking "#N title"
  opens the task's own chat. When that isn't known (not started, or not in a role's home queue), it opens the
  queue's chat.
- Waiting on you: each open linked task with a Needs-you question, oldest first: "from <department> ·
  waiting <age>", the question, and "#N title". Clicking the question opens that task's chat. The ON YOU bar
  counts the same items, and says nothing is waiting only when the registry was read whole and none are.
- The status, by fixed rules in this order (a task belongs to an initiative straight, or through one of its
  projects; `statusOf()`):
  1. Done or Dropped: the registry's status.
  2. Needs you: an open linked task has a Needs-you question.
  3. Needs attention: an open linked task is stuck or blocked.
  4. Paused by you: every open linked task is paused by the owner.
  5. Moving: an open linked task is ready, working, asking or waiting.
  6. Otherwise a neutral grey chip: "No tasks yet", or "No open tasks" when every linked task is closed.

  Projects, and the projects-in-no-initiative box, get their chip by the same rules from their own tasks. The
  filter pills count the cards by these chips, and filter the list.

The core had no place for five of these things, so each got the smallest hook it needs:

- A "Needs you" chip (`InitiativesExactStatus` "you", amber like ON YOU) in the view.
- Status colours for a row's plain chip (`statusTone` takes a status).
- A click on a row's "#N title" and on a waiting item's question. These are template additions 9 and 10
  (`scripts/extract-initiatives-template.mjs`; step 2 has 7 and 8): with an `open`, those texts are buttons,
  styled as text with an underline like step 2's project names. Without one, the design's markup is unchanged.
- Rows after the project rows (`InitiativesPagePart.rows`, one line in `model.ts`).
- A section's fields on an item of the "in no initiative" box (`InitiativesPagePart.loose`), so the item
  shows ON YOU when one of its project's tasks asks.

Plan, gap and core fields are untouched.

**Expected result, and how it's measured.** On the live page, at one moment, compared with the registry log
(`~/.pi/agent/work/events.jsonl`, replayed by a script) and the roles' queues:

- each project's task rows are exactly its open linked tasks (numbers and departments);
- the "Directly under this initiative" row holds exactly the open tasks linked straight to it;
- the Waiting on you items are exactly the open linked tasks with a Needs-you question;
- each chip is what the rules above give, worked out by hand from the same data;
- the filter counts match those chips;
- one task row opens that task's chat (look only, then back).

Screenshots at 1440 and 390 px in `/home/shinelay/kept-from-tmp/2026-10-18/initiatives-steps/3/`.

**What would prove it wrong.** A missing or extra task row, a wrong chip or count, a missing or extra Waiting
on you item, an all-clear while something waits or before the page has loaded, or a click that opens the
wrong chat or none.

### Choices inside the rules

- A linked task with no recorded status counts as open, and its row chip says Unknown. When nothing else
  decides (rules 2-5), its initiative's chip says Unknown too, not Moving or No tasks yet. All 113 live links
  have a status, so this is a safety net only.
- Row chips use the design's state chip: ready → Queued, working → Working now, asking and waiting →
  Waiting, stuck and blocked → Blocked, paused by the owner → Paused by you. A blocked task shows "Waits on"
  its recorded blocker (tasks, need, the lead that owes it and when).
- The rows come in this order: Needs-you first, then stuck or blocked, working or asking, waiting, ready,
  paused, and newest change first within each group.
- A done or dropped initiative that still has an open task waiting on the owner keeps its Done or Dropped
  chip (rule 1). Its question still shows under Waiting on you and on its card. So the Needs you pill, which
  counts cards with something waiting, would count it too. That keeps a question from ever hiding; no
  initiative is in that state today.
- When the registry couldn't be sent whole (`too-big`, `unknown-change`), the ON YOU bar says "At least N"
  or that it isn't fully known, and the pills read "—".
- Ages and times use the browser's clock (the page rebuilds every minute).
- No write actions: clicks only open chats. No chat contents are read; the question text is the queue's own
  Needs-you line, as the Roles page shows it.

### Checks

- `tests/unit/initiatives-page-tasks.test.ts` on a fixed fixture (`tests/unit/initiatives-page-tasks-fixture.ts`):
  - one case per chip, and the rule order;
  - the paused-only case;
  - a blocked task's "Waits on";
  - the queue-chat fallback;
  - Waiting on you items, the ON YOU bar and its clicks;
  - filter counts and filtering through the real template;
  - no all-clear before load, on errors or on a partial registry.

  These run with the core model tests (`tests/unit/initiatives-page-model.test.ts`) and the design's
  (`tests/unit/initiatives-exact.test.ts`).
- One sealed look at 1440 px: `scripts/sealed.sh node --import tsx scripts/initiatives-exact-shot.mjs --page --tasks <dir>`.
- The landing gate, every pi-web-deploy check, then the look-only live check above.

### Result

**Landed and installed.** Land request 53-3d70cc landed a482b2eb on Oct 18 at about 20:51 (not batched;
the landing gate passed). `pi-web-deploy` swapped it in at 20:53 with every check passing (server, page, reply,
big chat, log); `pi-web-deploy result a482b2eb` returned 0. Logs: `land.log`, `deploy.log` and their `.exit`
files in `/home/shinelay/kept-from-tmp/2026-10-18/initiatives-steps/3/`.

**First live check: MISS, on one chip.** Look only, by `live/look.mjs` in that folder. It replays the
registry log and reads the roles' queues just before, compares every row, chip, count and Waiting on you item
with what the rules give, and holds every message that could open or change anything in its own headless
browser. Run 1 at 21:10 (`live/run1/`) and run 2 at 21:22 (`live/run2/`):

- Passed both times: Temper #99 sits in "Directly under this initiative". Each initiative card's chip
  follows the rule order: Team in Temper Moving, Design department in Temper No tasks yet. The box heading
  counts 6 projects. Nothing waits on the owner (the Roles overview said 0 at 21:10), and the ON YOU bar says
  so only once the page is live. Nothing scrolls sideways at 390 px. The page's own feed has the registry's
  records and links. In run 1, every project's open tasks matched the queues exactly (numbers, departments,
  chips, recorded waits, "updated" times).
- Corrected after run 3: run 2's "rows match" was a false pass. From the 21:18 install on, the box listed
  every open Ops task twice (#199, #211, #212, #227, #234, #241, #242). The look matched rows by task key,
  so a twin with the same chip slipped through. See H-INITIATIVES-PAGE-3c.
- Not the page: in run 1 the task click sent nothing and the filter counts read wrong. Both were faults in
  the look itself. The look holds the page's own state requests, so the app's silence watchdog replaces its
  connection once, about 6.6 s after load (the app drops a send while it reconnects), and run 1 clicked in
  that gap. The pill reader also read each label twice; the screenshot shows All 2, Needs you 0, Needs
  attention 0, Paused by you 0, the expected counts. With the look fixed, run 2 passed both: clicking Temper
  #99 asked for exactly that task's own chat (held, never sent), and the page left for the chat view.
- The page's miss: the box of projects in no initiative kept step 1's "No initiative" chip. By the rules
  above it should have said Moving (run 1), then Needs attention (run 2). `tasksPart` worked out the box's
  status (`statusOf(page, NO_INITIATIVE)` is tested) but gave the box only its Waiting on you items. That is
  the "wrong chip" this hypothesis named as proof against it, so H-INITIATIVES-PAGE-3 is a miss on that one
  point, and H-INITIATIVES-PAGE-3b follows.

Shots: `live/run2/desktop-1440.png`, `desktop-1440-who-box.png`, `desktop-1440-team-in-temper.png`,
`desktop-1440-who-team-in-temper.png`, `phone-390.png`, `phone-390-full.png`.

## H-INITIATIVES-PAGE-3b

**What is wrong, and the evidence.** Live runs 1 and 2 above: the box's own chip says "No initiative" while
its projects' open tasks give Moving, then Needs attention, by the rules. In `web/src/initiatives-page/tasks.ts`
the box's part sets only `onYou`. The rules' status for it is worked out but never handed over.

**The one change.** `tasksPart` gives the box's detail the status the rules give, and the paused text an
initiative gets when the owner paused every open task. With no open task in the box, it keeps step 1's
"No initiative" label.

**Expected result, and how it's measured.** In the unit test, the fixture's box says Needs you (rule 2),
and a box whose tasks are all closed keeps "No initiative". The filter counts stay the same, since the box is
not an initiative card. Live, run 3 after the install: the box's chip is what the rules give on that
moment's registry, and every other check passes as in run 2, 16 of 16.

**What would prove it wrong.** The box still saying "No initiative" while a rule applies, a rules chip on a
box with nothing open, the filter counts or cards changing, or any other check that passed in run 2 failing.

### Result

**HIT on the chip; the live check still misses, on twins (H-INITIATIVES-PAGE-3c).** Commit 0c94f7a4 landed
as 026080c6 (land request 59-caaa34, not batched; the gate passed) and went live at 21:36 with every deploy
check passing; `pi-web-deploy result 026080c6` returned 0. Unit test: the fixture's box says Needs you, a
box with every task closed keeps "No initiative", and the filter counts stay 8, 1, 1, 1 (21 of 21 with the
core model tests). Live run 3 at 21:41 (`live/run3/`, look only; the look now also asks for "No initiative"
when nothing in the box is open): the box's chip is the rules' on the desktop and the phone, and 14 of 16
checks pass. The 2 that fail are the box's rows, desktop and phone: Ops #241 shows twice, once Blocked where
its queue says Waiting, and a done Ops #242 shows as Working.

## H-INITIATIVES-PAGE-3c

**What is wrong, and the evidence.** Since the 21:18 install the box lists every open Ops task twice
(runs 2 and 3: #199, #211, #212, #227, #234, #241, #242). Run 3 caught it only because two twins differ
from their queue: #241 Blocked against Waiting, and #242 Working although it is done. The registry
(pi-work-management's `events.jsonl`) holds a second link for each. Its queue is
`~/.pi/agent/sessions/--home-shinelay-.cache-pi-web-check-copy-cwd--/pi-web-check-copy.jsonl`, the copy of
the Ops lead chat that pi-web-deploy's big-chat check opens. The queue inside that copy wrote its tasks into
the registry under the copy's path, in bulk, during the checks at 10:15:15 (13 links), 10:52:28 (4 state
changes) and 21:19:16 (10 links, 20 state changes). The copy is deleted after each check, so the twins never
change again. Of the registry's 9 queue files, that one alone is gone (21 links). The feed hands the page
every link, and the page lists every open one.

**The one change.** The `work_page` feed leaves out links whose queue file no longer exists.
`WorkPageFile.get` looks up each queue file once per read: only whether it exists, never what's in it, and
a file it can't look up stays in. `workPageOf` then drops those links: a deleted chat's or a throwaway
copy's tasks are no one's open work. Callers of the pure builder that pass nothing see no change. The
registry itself isn't touched. Stopping the copy from writing into it is a separate fix, in pi-queue or
pi-web-deploy.

**Expected result, and how it's measured.** Unit test: one task number linked from a queue file that
exists and from one that doesn't gives one task through `WorkPageFile`, and two through the pure builder.
Live run 4 after the install, with the look now also failing any task shown twice in a row: each open task
appears once and matches its queue, and all 16 checks pass. Projects' "N of M done" can't move, because they
count done-when items, not tasks.

**What would prove it wrong.** A twin or an extra task still on the page, a task whose queue file exists
going missing, or any other check failing.
