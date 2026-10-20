# Live progress on Roles and Initiatives: the shared data contract

Ops #269 (owner, 2026-10-19 about 19:52, relayed by COO in rm-63784858: "i want live progress in both role and initiatives"; minutes earlier he picked "Make 'needs you' live"). Accountable lead: Ops.

This file is the groundwork: the evidence, the fields the server adds, the owner rule, and the three hypotheses the next tasks test. It changes no behaviour.

The next tasks run side by side once this lands (rule 26):

- Ops #270, server: fills the fields (`server/roles-overview.ts`, `server/work-page.ts`) and applies the owner rule. Tests H-LIVE-NEEDS-1.
- Ops #271, Initiatives page: uses them. Tests H-INIT-LIVE-1.
- Ops #272, Roles page: uses them. Tests H-ROLES-LIVE-1.

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

**Result.** Pending (#270).

### H-INIT-LIVE-1 (Initiatives page, Ops #271)

**Wrong, and the evidence.** Latest updates lag behind the records (Evidence 2), and "Needs attention" reads as aimed at the owner (Evidence 3).

**One change, and why it should fix it.** Latest updates come from the records (task progress lines, done summaries and registry changes, with the lead's posts as labelled lines among them), and the "Blocked" label names what the task waits on (for example "Temper #113 · …" or "Question with <lead>"). The section then moves when the work moves, and nothing reads as the owner's unless it is.

**Expected result, and how it is measured.** For 3 initiatives live, the newest Latest-updates line is no older than the newest record for that initiative (the newest of its tasks' progress lines, done summaries, registry changes and the lead's posts, found by a script over those records); "Needs attention" appears nowhere on the page.

**What would prove it wrong.** Either fails.

**Result.** Pending (#271).

### H-ROLES-LIVE-1 (Roles page, Ops #272)

**Wrong, and the evidence.** Latest progress has no time (Evidence 4), and Activity misses the task chats' work: on checking, open tasks' lines are already there, and done tasks and their summaries are missing (Evidence 5).

**One change, and why it should fix it.** Progress lines with their times (`progress`), and Activity merges the task lines and the done summaries (`doneRecent`).

**Expected result, and how it is measured.** Every working role's Latest progress shows a time, equal to its current task's newest line or newer, checked live against each working task's own chat's newest TL;DR line.

**What would prove it wrong.** Any working role shows "Not recorded", or an older line.

**Result.** Pending (#272).

## Limits

- Progress exists only for a started open task whose chat the server reads (Roles reads at most `ROLES_TASK_CHATS_MAX`, 40, started task chats per role) and that has written a TL;DR line. Done tasks' chats aren't read; their queue_done summary stands in.
- Nothing here writes to a queue, a chat or a record, or changes routing, permissions or who is asked.
- No model call anywhere: every field is copied or clipped from a record.

## Undo

Revert this commit. It adds only this file, optional types in `server/protocol.ts` and a PATCHES.md entry; nothing live changes.
