# Roles: linked work per department

Owner 2026-10-18, "Put it to use first" (Ops #222, project work-hierarchy-in-use, item 2). Accountable lead: Ops.

## H-ROLES-LINKS-1: result in "Results" below

**Wrong, and the evidence.** Nothing shows how many of a department's open tasks have no project or initiative. The registry audit on 2026-10-18 at 13:05 found 0 projects ever recorded, and tasks without a parent aren't indexed anywhere. The Roles page shows a task's parent only in that task's own row, so a department with ten unlinked tasks looks the same as one with none.

**One change.** Count each role queue's open tasks by parent and show the counts in the role panel.

- Server (`server/roles-overview.ts`): in the loop that builds `counts`, every open task (every one not done, removed or dropped, also the waiting ones past `ROLES_QUEUED_MAX`) goes into one of four counts by the parent its queue entry names, the same parent its row shows (`UiRoleTask.parent`): `project`, `initiative`, `standalone`, `unrecorded`. The queue entry is the authority for a task's parent (pi-queue `docs/work-model.md`).
- Protocol (`server/protocol.ts`): optional `UiRoleQueue.links`; no protocol bump. An older server sends none.
- Page: the model (`web/src/roles-useful-model.ts`) accepts the counts only from a readable queue and only as whole numbers of 0 or more. The panel's Now section (`web/src/roles-u0/surface.html`) gets a "Linked work" row right after "Task lanes", from `exactLinks` (`web/src/roles-exact-view.ts`):
  - "5 in projects · 1 under an initiative · 2 standalone · 3 not recorded", zero parts left out ("1 in a project", "2 under initiatives");
  - "No open tasks" when all four are 0;
  - "Not recorded" from an older server, a queue that couldn't be read, a role with no queue (like its Task lanes row), or a malformed count.
- The cards stay as designed.

**Expected, and how it's measured.** Ops shows all its open tasks in projects; roles with older tasks show their not-recorded counts. Measured by one look-only live check: the counts shown for Ops and for one other role, compared with their queues.

**What would prove it wrong.** A count that disagrees with the queue, or a task counted twice or missed (for example a waiting task past `ROLES_QUEUED_MAX` = 20).

## Checks

- `tests/unit/roles-overview.test.ts`: one queue with a task in a project, one under an initiative, one standalone, one with none, one given a project later, a done, a dropped and a removed task, and 20 more waiting tasks than the overview lists: the counts are 22 / 1 / 1 / 1, they add up to the open counts, and the list is still capped at 20. A queue with only done tasks sends all zeros; a role with no queue sends none.
- `tests/unit/roles-exact.test.ts`: the panel row's text and place (right after Task lanes), zero parts left out, singular wording, "No open tasks", and "Not recorded" for no counts, an unread queue, and malformed counts (negative, fraction, text, a missing part).
- Then the landing gate and pi-web-deploy's checks.

## Results

Pending: the live look after install.

## Undo

`pi-web-deploy rollback`, or revert this commit and deploy.
