# Roles: linked work per department

Owner 2026-10-18, "Put it to use first" (Ops #222, project work-hierarchy-in-use, item 2). Accountable lead: Ops.

## H-ROLES-LINKS-1: HIT (results below)

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

**Installed** at 14:05 on Oct 18 as 13c60525 (land request 17-f90f9f passed the landing gate; `pi-web-deploy --landed 17-f90f9f`). Its own checks all passed: server, page, reply, big-chat copy and log. At 14:16 another task's install (d39954df, acp-fold) went on top; its checks passed too, and the look below ran on it.

**Look-only check** at 14:21 on live data (`~/kept-from-tmp/2026-10-18/roles-links-live/look.mjs`, run in its own systemd unit so a restart couldn't cut it off). It used its own carry-on clients, whose sockets sent only hello and roles_watch; no page errors. It opened every role's panel, read its Linked work row, and compared it with pi-queue's own replay of that role's home-chat queue (`replayTranscript` and `parentOfTask`, read only; open = not done, dropped or removed). A first run at 14:16 on 13c60525 gave the same numbers on desktop dark before that restart cut it off.

| role | panel row | pi-queue's count of open tasks |
| --- | --- | --- |
| Ops | 9 in projects | 9, all in projects (199, 209, 211, 212, 221 to 225); 216 removed not counted |
| Design | 34 not recorded | 34 with no parent (31 ready, 1 waiting, 2 working; 11 of them past the 20 the panel lists); 12 done and 30 removed not counted |
| Product | 6 not recorded | 6 with no parent |
| Temper | 5 not recorded | 5 with no parent; 1 dropped not counted |
| Backend, Frontend, Marketing | 1 not recorded each | 1 each, no parent |
| Architecture, Data, QA, RollCall, Security, Systems | No open tasks | 0 |
| COO, Docs | Not recorded | none: their home chats have never held a queue, so the overview sends none (their Task lanes row reads the same) |

- For all 13 roles with a queue, the row equals the server's counts, and those equal pi-queue's count: no task counted twice or missed, and the four parts add up to the open tasks.
- The row sits right after Task lanes, once per panel, on desktop dark (1400 × 1000), desktop light, and phone (390 × 844); Ops' row read "9 in projects" in each.
- Contrast on the panel's rgb(22, 24, 27): label 7.98, value 15.17, at 14 px. axe found no serious or critical issue on the row. The Roles surface keeps its own palette in the light theme: the light shot is byte-identical to the dark one.

Screenshots of just the row (no task text), in `~/kept-from-tmp/2026-10-18/roles-links-live/out2/`: `ops-dark-row.png`, `design-dark-row.png`, `ops-light-row.png`.

**What it shows.** Of the 57 open tasks in all queues, 9 (Ops') are in a project; the other 48, in six departments, have no parent recorded. None is under an initiative only, and none is standalone. Before this, that gap didn't show anywhere.

**A limit, not changed here.** A role whose home chat has never held a queue (COO, Docs) reads "Not recorded", not "No open tasks", because the overview sends no queue for it. Showing "No open tasks" there would need the overview to send an empty queue for such a role, which would also change its Task lanes row.

## Undo

`pi-web-deploy rollback`, or revert this commit and deploy.
