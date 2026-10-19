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

Not run yet.
