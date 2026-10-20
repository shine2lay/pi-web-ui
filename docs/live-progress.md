# Live progress on Roles and Initiatives: the shared data contract

Ops #269 (owner, 2026-10-19 about 19:52, relayed by COO in rm-63784858: "i want live progress in both role and initiatives"; minutes earlier he picked "Make 'needs you' live"). Accountable lead: Ops.

This file is the groundwork: the evidence, the fields the server adds, the owner rule, and the three hypotheses the next tasks test. It changes no behaviour.

The next tasks run side by side once this lands (rule 26):

- Ops #270, server: fills the fields (`server/roles-overview.ts`, `server/work-page.ts`) and applies the owner rule. Tests H-LIVE-NEEDS-1.
- Ops #271, Initiatives page: uses them. Tests H-INIT-LIVE-1.
- Ops #272, Roles page: uses them. Tests H-ROLES-LIVE-1.
- Later, from #272's live look: Ops #277, Roles page: which task is the Current task. Tests H-ROLES-CURRENT-1.

#271 and #272 can build and test against fixtures that carry the fields before #270 lands. A page must work as today when the fields are absent. Known overlaps: #270 may meet #245 (pages-fresh) in `server/roles-overview.ts` and `server/work-page.ts`; #271 may meet #274 (initiatives-projects-done) in `web/src/initiatives-page/model.ts`.

## Where "live" comes from

Only from records already kept (rule 17; decided in the plan). No model call, and no text a lead has to write:

- the queue's state, and where each task's question is (pi-queue's records, mirrored by `server/task-queue.ts`);
- the work registry (pi-queue's work log: initiatives, projects, linked tasks);
- task chats' TL;DR lines (pi-tldr, read through `server/tldr-lines.ts`);
- queue_done summaries (the queue's done record, `summary`).

The lead's posts (initiative_update) stay, as one record among these instead of the only one.

## Evidence

Ops' reading of the code on Oct 19 about 20:05, checked again from 20:25 to 20:35 (pi-web-ui at bb432079, pi-queue as installed). Line numbers are as of then.

1. **"Needs you" is built from task status.** `server/roles-overview.ts` (about 957-999) builds a role's `asks` from its home chat's unanswered needs-you TL;DR lines and from every task whose status is `stuck` and that isn't paused (kind "task", since its `stuckAt`). The Roles page's "Needs your decision" counts these, and the Initiatives page's "Needs you" takes them from `role.asks` (`server/work-page.ts`, `workFactsFromOverview`, about 575-603). The concern: since Oct 17 15:20 (rule 21) a task's question goes first to its lead's home chat, so a question a lead still holds could be counted as the owner's.
   Checked against the records, it doesn't happen today:
   - A question a lead holds is status `asking`, never `stuck`. With routing on, pi-queue records a lane task's queue_stuck as op "ask" (pi-queue `index.ts` about 1796; `server/task-queue.ts` case "ask": status `asking`, `askOps`, `askLead`). An `asking` task is never an ask; `server/roles-task-next.ts` already shows it as waiting for that lead's answer.
   - Every pi-queue path that records op "stuck" today hands the question to a person, the owner: a lead or Ops passed it on (`ask.passed`, `to: "ops"`, `via`, `brief`), a routed question ran out (`ask.why`: turn, timeout, undelivered, limit, unreachable), a block no lead answered, the owner's own stop of a run, a needs_owner package, a task in its main chat's own queue (the user there is its lead), an unreachable incident. (pi-queue `index.ts` at about 981, 1349, 1620, 1804, 1950, 2886, 3164, 4381, 4389, 4627, 5338, 5479, 5494, 5814.)
   - A script over `~/.pi/agent/sessions` found only 2 "stuck" ops since routing went live, both for Ops #234 on Oct 19 at 04:17, both with `ask.passed: true`: it had reached the owner. The live overview at 20:10: 15 roles, 0 things waiting on the owner.
   - The app's mirror drops where a stuck question went: `server/task-queue.ts` case "stuck" (about 681-702) keeps the question, choices, detail and `stuckAt`, but not `op.ask` (passed, why, to, lead, step, chain).

   So the plan's evidence for H-LIVE-NEEDS-1 isn't borne out by today's records; #270 measures before it changes anything (see the hypothesis).
2. **Initiatives' Latest updates lag.** `web/src/initiatives-page/model.ts` (about 205) shows the lead's newest 3 posts whenever the lead has posted at all, so the section changes only when the lead posts again: COO's 17:49 post was still up at 19:44. Tasks have no progress line, and done tasks have no summary.
3. **"Needs attention" reads as aimed at the owner.** `web/src/initiatives-page/tasks.ts` (`WORD.attention`) marks any open task that is stuck or blocked; the owner read it as his to do.
4. **Roles' Latest progress has no time.** For a working task with a TL;DR line, the server sends the line with its time (`UiRoleTask.latest`, a `UiRoleTldrLine` with `ts`), but the page keeps only the text (`web/src/roles-useful-model.ts`, `record()`), so `web/src/roles-exact-view.ts` (about 812-813) shows the time as "Not recorded".
5. **Roles' Activity misses done work.** Corrected on checking: the panel's Activity (`web/src/roles-panel-model.ts` about 594, `row.tldr`) already merges the open started tasks' own lines with the home chat's (`server/roles-overview.ts` about 937-955). What it misses is done tasks: their chats aren't read once they are done, and their queue_done summaries are shown nowhere.

## The contract

New optional fields in `server/protocol.ts`; each has one comment line pointing here. An older server leaves them out, and a page then shows what it shows today. Absent always means "not known", never "none". They are additive and optional, so `PROTOCOL_VERSION` doesn't change.

Two named shapes:

- `UiTaskProgress { text: string; at: number }`: one TL;DR line of a task's own chat, with its time in ms.
- `UiRoleDoneTask { id: number; title: string; summary: string; at: number }`: one done task of a role's queue.

On a task, both in the Roles overview's task row (`UiRoleTask`) and in the Initiatives page's task (`UiWorkPageTask`):

- `progress?: UiTaskProgress`: the newest TL;DR line of the task's own chat, with its time. Open tasks only (started, with a chat the server reads); on the Roles row it is the same line as `latest`. Same limits as today's latest line: the server clips it (`server/tldr-lines.ts`, `TEXT_MAX`: 400 characters, then "…"), and the pages show it only through the same unsafe-text filter as `latest` (`web/src/roles-useful-model.ts`, `plain()`: a line with control, format, surrogate, private-use or unassigned characters, or a line or paragraph separator, isn't shown). No line yet: absent.
- `withLead?: string`: the role id of the home chat that has the task's question now, while the question hasn't reached the owner. In the records' terms (decided below): a task with status `asking` gets `askOps ? (askLead ?? "ops") : the role whose queue holds it`; a `stuck` task only when its record shows a lead still holds the question (no pi-queue path records that today). Absent when that chat isn't a role's home chat. A task with `withLead` is never an owner ask.

On a done task in `UiWorkPageTask`:

- `doneSummary?: string`: its queue_done summary, clipped to 300 characters (the first 299, then "…"). Absent when none was recorded. The queue keeps up to 2000 (`server/task-queue.ts`, `NOTE_MAX`).

On a role in the Roles overview (`UiRoleOverview`):

- `doneRecent?: UiRoleDoneTask[]`: its queue's newest 10 done tasks, newest first. `at` is when it was marked done (`doneAt`); done tasks without one are left out. `summary` is its queue_done summary clipped like `doneSummary`, or "" when none was recorded. The pages apply the same unsafe-text filter.

### Decided by Ops (accountable lead, within the approved plan, Oct 19 about 20:35)

- `withLead` covers `asking` tasks too. In today's records a question a lead holds is `asking`, not `stuck`, so a `withLead` for stuck tasks alone would never be set. Rows can then say "Question with <lead>" (#271, #272).
- Named shapes, `UiTaskProgress` and `UiRoleDoneTask`, instead of inline object types, so the three next tasks share one name for each.
- `doneRecent` summaries are clipped like `doneSummary` (300 characters), which keeps a role's overview small (10 × 300 characters at most).

## The owner rule

A stuck task waits on the owner only when its question has reached him: `passed`, or `why` set, or its route's chain ended at the owner, or an escalate record names it. Otherwise it carries `withLead`. Open dialogs and unanswered needs-you TL;DR lines stay owner asks, as now.

In the records' terms, for #270: every path that records op "stuck" today means the question reached the owner, the routed ones (`passed`, `why`) and the direct ones alike: a block no lead answered (pi-queue `index.ts` about 2886), the owner's own stop of a run (about 5814), a needs_owner package (about 4381), a task in its main chat's own queue (about 981, 1349, 4389), an unreachable incident (about 3164). #270 keeps all of them as owner asks, or real owner asks would vanish. Only a stuck record that names a lead still holding the question gets `withLead` instead. Since the app's mirror drops `op.ask` (Evidence 1), #270 keeps from it whatever it needs to tell these apart.

## Hypotheses

Each next task tests its own (rule 16) and records HIT or MISS here, under its hypothesis.

### H-LIVE-NEEDS-1 (server, Ops #270)

**Wrong, and the evidence.** "Needs you" counts questions a lead still holds (Evidence 1). The records check above doesn't show it today: since routing went live, no question a lead held was counted as the owner's.

**One change, and why it should fix it.** Owner asks only for questions that reached the owner (the owner rule), so the count follows what really waits on him; a question a lead holds carries `withLead` instead.

**Expected result, and how it is measured.** The live "Needs your decision" count equals the count of questions that reached the owner, counted by a script over the queue records (the queues' "queue" and "queue-ops" entries: open stuck tasks, their asks' `passed` and `why`, escalate records), not over the page. #270 runs the script against the live count first. If they already match, the premise is a MISS and is recorded as one; #270 then changes no owner-ask logic, only fills `withLead` and the progress fields, and keeps the script as the check.

**What would prove it wrong.** Any owner ask is a question still with a lead, or a question that reached the owner is missing.

**Start counts (#270, Oct 19 21:14 PDT, before any change; counts only).** The installed overview (7610a8e4) read over the app's socket: 15 roles, 7 things waiting on the owner, all 7 open dialogs (kind "question", Design), 0 stuck-task asks, 0 needs-you lines. The queue records of the 15 home queues, replayed by the app's own `taskQueueFromEntries`: 0 stuck tasks (0 reached the owner, 0 with a lead, 0 paused), 0 asking tasks, 15 escalate records in the leads' chats, 0 of them still pending (each one's task had taken it). So the live count of stuck-task asks (0) already equals the records' count of questions that reached the owner (0): the premise holds nowhere today.

**What #270 changed, given that (Ops, accountable lead, within the plan).** No owner ask counted today changes. The contract's own rule still needs one line of code: "a task with `withLead` is never an owner ask". So the server keeps each task's newest "stuck" record's `ask` route from its scan (the mirror drops it), and a stuck task gets `withLead`, stops being an owner ask and shows that lead's answer as its next step only when that record names the lead still holding it (`ask.lead`, or the chain's step), isn't `passed`, has no `why`, its chain hasn't ended, and the lead is a role with a home chat. No pi-queue path writes such a record today (Evidence 1), so on today's records this never fires; a route that names nobody (`to: "ops"` alone included) stays the owner's. An escalate record needs no reading of its own: its delivery writes the stuck record with `passed: true`, and until then the task is `asking`, with its lead. pi-queue needed no change: its records already carry the route. The counting script (Ops' kept-from-tmp `count-owner-asks.mts`, counts and task numbers only) replays the home queues with the app's own `taskQueueFromEntries` and sorts each stuck task by the rule: reached the owner (direct, passed, why, chain ended, names nobody), with a lead, or paused.

**Result (#270): MISS, recorded as this section says: the premise didn't hold.** At the start, "needs you" counted no question a lead held (start counts above: 0 = 0), so the owner rule had no miscount to fix. After the install of 282512a6 (Oct 19 21:50 PDT, every deploy check passed) the measure still holds, counts only:

- The live overview, read over the app's socket at 21:52:22 PDT: 2 things waiting on the owner. 1 is a stuck task (temper #116, no `withLead`), 1 is a needs-you line, and there are 0 open dialogs.
- The script over the 15 home queues' records at 21:52:44: 1 stuck question that reached the owner (temper #116, passed on to him), 0 with a lead, 0 paused, 0 asking; 16 escalate records, 0 still pending.
- Same count, same task: no owner ask is a question still with a lead, and none that reached the owner is missing. The needs-you line stays an owner ask by the rule; the script doesn't count it because it isn't a queue record.
- The new fields are live: `progress` on 7 open tasks in 5 roles, `doneRecent` on all 15 roles (none over 10), `withLead` on none (the records hold no question with a lead), `allChatsRead` true on all 15 (#268). Whether each `progress` line is its chat's newest is H-ROLES-LIVE-1's live check (#272).

**What we learned, and the next hypothesis.** Nothing was miscounted, because pi-queue keeps a question a lead holds as `asking`, with its lead, and writes `stuck` only once the question reaches the owner. The `withLead` guard follows the contract's rule, but no record makes it fire today. If "needs you" still looks wrong to the owner, the next hypothesis starts from what he saw (which ask, and when), not from the count rule. The script (`count-owner-asks.mts`, kept by Ops) stays as the check.

### H-INIT-LIVE-1 (Initiatives page, Ops #271)

**Wrong, and the evidence.** Latest updates lag behind the records (Evidence 2), and "Needs attention" reads as aimed at the owner (Evidence 3).

**One change, and why it should fix it.** Latest updates come from the records (task progress lines, done summaries and registry changes, with the lead's posts as labelled lines among them), and the "Blocked" label names what the task waits on (for example "Temper #113 · …" or "Question with <lead>"). The section then moves when the work moves, and nothing reads as the owner's unless it is.

**Expected result, and how it is measured.** For 3 initiatives live, the newest Latest-updates line is no older than the newest record for that initiative (the newest of its tasks' progress lines, done summaries, registry changes and the lead's posts, found by a script over those records); "Needs attention" appears nowhere on the page.

**What would prove it wrong.** Either fails.

**Result (#271): HIT, both parts held.** 6293f27f was installed on Oct 19 at 22:03 PDT with every deploy check passing (`pi-web-deploy result 6293f27f` = 0). The live look at 22:08:43 PDT read the installed page as its own look-only client (`carry-on:ops-live-look-initiatives-live`: only its hello and the page's watches were sent, every other send was held), at 1400 × 1000 and 390 × 844, times and page words only:

- For the 3 initiatives with the newest records, the first Latest-updates line is the newest record, to the minute the page shows, on both sizes. A script found each newest record in the data the page itself received: the work page's registry changes in the initiative's scope, its open tasks' progress lines and its done tasks' summaries, and the lead's posts from the progress feed.
  - Design department in Temper: newest record 22:08, a state change of #98 by Design; first line 22:08, Design.
  - Team in Temper: newest record 22:07, a state change of #116 by Temper; first line 22:07, Temper, then QA's "#18 done: …" at 21:55. The lead's newest post is 2 hours old ("Lead’s report · 2h ago"); before this change, Latest updates showed only the lead's posts here.
  - Team in Temper groundwork (Oct 3-19): newest record 08:18, an initiative change by Architecture; first line 08:18, Architecture.
- "Needs attention" appears nowhere on either size, and neither do "Last report" or the old stuck note ("Waiting on you, but its question isn’t listed"). No page errors.
- Not on the live data, so shown by the sealed test only (`tests/initiatives-live-test.mjs`): an open task's progress line ("#N <line>"; none of these initiatives' open tasks had one at the time) and "Question with <lead>" (no record holds a question with a lead; see H-LIVE-NEEDS-1). There, a task-done record with no lead post showed as "#5 done: <summary>" within one refresh (4.75 s and 4.88 s of 6 s, in two runs), a blocked task read "Waits on Temper #113 · …", a stuck task with `withLead` read "Question with Ops" with nothing on the owner, and "Needs attention" appeared nowhere at 1400 and 390 px.

### H-ROLES-LIVE-1 (Roles page, Ops #272)

**Wrong, and the evidence.** Latest progress has no time (Evidence 4), and Activity misses the task chats' work: on checking, open tasks' lines are already there, and done tasks and their summaries are missing (Evidence 5).

**One change, and why it should fix it.** Progress lines with their times (`progress`), and Activity merges the task lines and the done summaries (`doneRecent`).

**Expected result, and how it is measured.** Every working role's Latest progress shows a time, equal to its current task's newest line or newer, checked live against each working task's own chat's newest TL;DR line.

**What would prove it wrong.** Any working role shows "Not recorded", or an older line.

**Result (#272): HIT.** Every working role's Latest progress showed a time, equal to its current task's newest line or newer: 18 of 18 checks live, 0 "Not recorded", 0 older lines.

- Sealed (`tests/roles-live-test.mjs`, the real server and Chrome on a fixture overview): a working task's Latest progress shows its own chat's line with that line's time (it said "Not recorded"); a new line written in the task chat showed after 2,796 ms (2 overviews; the bar is one refresh, 4,000 ms); Activity lists the task line, the done summary and the home line, newest first, each with its time; no page errors. Focused unit tests: `tests/unit/roles-live.test.ts` (14). The land gate passed (land 101-b15f03, commit bc8f514).
- Installed: bc8f514 went live inside 282512a6 (Oct 19 21:50 PDT, every deploy check passed) and stays live in 6293f27f (22:03).
- Before (live 05129317, Oct 19 21:45 PDT, one pass): 6 working roles; Product #51 showed "Not recorded" although its chat's newest line was from Oct 13, 08:15.
- After (live 6293f27f, Oct 19 22:06 to 22:08 PDT, 3 passes a minute apart, one fixed look id, times and UI words only): 6 working roles in each pass, 18 of 18 hits, 0 errors, 0 page errors.
  - Product #51 shows 08:15, its chat's newest line (Oct 13; equal, and `progress` is that line). Its owner pause (Oct 10, 19:35) is older, so the line is right.
  - Design #41 shows "Queue recorded: paused by you · 00:17" (Oct 9), newer than its newest line (Oct 7, 07:49).
  - The other current tasks had no line yet and show their queue milestone's time ("task started" or "waiting for a check").
  - Activity: every role lists its 10 newest done tasks (10 sent, 10 shown), and every Activity row has a time.
  - "Question with <lead>": 0 sent and 0 shown live, because the records hold no question a lead still has (H-LIVE-NEEDS-1); those words are proven by the unit and sealed tests only. "Needs your decision" lists the owner asks #270 measured (1 = 1).
- Limits of this proof: live, only one current task had its own line (Product #51), and no new line was written during the look, so "within one refresh" is proven sealed only.

**What we learned, and the next hypothesis.** The panel's Current task is the first busy task, else the first open one in queue order (`lead` in `web/src/roles-exact-view.ts`). So between turns a paused task can stand in front of the working ones: in passes 1 and 2 Design showed #41, paused by the owner since Oct 9, while #45 and #63 were in progress; in pass 3 it showed #98, which was busy. The time was right for #41, but #41 isn't what Design was doing. Next hypothesis (H-ROLES-CURRENT-1, built in Ops #277; its result is below): pick the busy task, then a started task that isn't paused, then the rest. Measured live: every working role's Current task is a started, unpaused task whenever it has one. Proven wrong if a paused task still shows while one of its tasks is in progress.

### H-ROLES-CURRENT-1 (Roles page, Ops #277)

**Wrong, and the evidence.** A role's Current task (its card's line and its panel's Current task) was the first busy task, else the first open one in queue order (`lead` in `web/src/roles-exact-view.ts`). Between turns no task is busy, so a paused task stood in front of the working ones: in #272's live look, passes 1 and 2, Design showed #41, paused by the owner since Oct 9, while #45 and #63 were in progress (H-ROLES-LIVE-1, "What we learned").

**One change, and why it should fix it.** `currentTask` picks, in order: the busy task; a started task (`working`) that isn't paused; any task that isn't paused; else the first (all paused: it is still shown, with its paused wording). Queue order decides among equals. A paused task then comes first only when every open task is paused. Only that choice changes: Latest progress, the next step and the other panel fields follow whichever task is picked.

**Expected result, and how it is measured.** Every working role's Current task is a started, unpaused task whenever it has one. Measured live, look only: for each role with a task in progress (started and not paused), the panel's Current task number, checked against the roles feed the page itself received.

**What would prove it wrong.** A paused task still shows while one of the role's tasks is in progress.

**Result (#277): HIT, with one limit.** No role with a task in progress showed a paused task as its Current task: 15 of 15 checks live.

- Unit (`tests/unit/roles-current-task.test.ts`, through the view; the card and the panel agree): a paused task first, then working ones: the first working one; busy wins; all paused: the first; none started: the first that isn't paused. On the old line 2 of 4 fail (both show the paused task); all 4 pass now. The land gate passed (land 113-775950, commit bdc956a).
- Installed: bdc956a5 on Oct 19 at 22:37 PDT, every deploy check passed (`pi-web-deploy result bdc956a5` = 0).
- Before (live 6293f27f, 22:33 to 22:35 PDT, 3 passes a minute apart): where no task was in progress, a paused task stood in front of one that isn't paused in all 3 passes. Design showed #41 (its #41, #45 and #63 are all paused now; #98 is on hold), and Frontend showed #1 (paused; #43 is on hold). The roles with a task in progress passed the check too, 13 of 13, because each of them had a busy task.
- After (live bdc956a5, 22:38 to 22:40 PDT, 3 passes a minute apart, one fixed look id `carry-on:ops-live-look-roles-current`, task numbers and states only):
  - 5 roles had a task in progress in each pass (Architecture, Ops, QA, Systems, Temper): 15 of 15 show a started task that isn't paused.
  - Design shows #98 and Frontend #43, the first tasks that aren't paused. Backend #1, Marketing #3 and Product #51, whose open tasks are all paused, still show their paused task.
  - Every read (30 of 30) is the pick worked out from the feed the page received (before: 22 of 28), and the line under the role's name names the same task. No page errors; only the look's hello and the page's watches were sent.
- The limit: live, every task in progress was busy when read, and none of those roles had a paused task. So the case #272 saw (a started task between turns, behind a paused one) is proven by the unit test only, and that check alone couldn't tell the old pick from the new one live. The live look proves the busy step, the step for roles with nothing started (the first task that isn't paused) and the all-paused step.

## Limits

- Progress exists only for a started open task whose chat the server reads (Roles reads at most `ROLES_TASK_CHATS_MAX`, 40, started task chats per role) and that has written a TL;DR line. Done tasks' chats aren't read; their queue_done summary stands in.
- Nothing here writes to a queue, a chat or a record, or changes routing, permissions or who is asked.
- No model call anywhere: every field is copied or clipped from a record.

## Undo

Revert this commit. It adds only this file, optional types in `server/protocol.ts` and a PATCHES.md entry; nothing live changes.

#270 (`live-progress-server`): `pi-web-deploy rollback`, or revert its commit and deploy. Pages that read the fields then show what they show without them.
