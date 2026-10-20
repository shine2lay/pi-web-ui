# Initiatives: finished projects at a glance

Ops #274 (owner, 2026-10-19, relayed by COO rm-0a0353b3: "you mentioned that a project done but i cant see that in initiatives page"; in the dialog that followed he picked "Yes, show them clearly"). Accountable lead: Ops. The owner chose the form himself, so there is no Design review; Design gets an FYI after install.

## H-PROJECTS-DONE-1

**Wrong, and the evidence.** A finished project can't be seen on the Initiatives page without scrolling (code at `mine` 0ce9bd8b; registry read 2026-10-19 20:20):

- Team in Temper has 7 projects, 2 of them closed (project-2-check, team-quality-bar).
- The left card and "Done when" count only the initiative's own done-when items ("0 of 15 outcomes done"); nothing counts projects.
- `planPart` (`web/src/initiatives-page/plan.ts`) lists only active projects as steps.
- Closed projects show only as the last rows of "Who's doing what" (`byStatus` in `web/src/initiatives-page/model.ts`), with a grey Done chip, below every active project and its open tasks.

**One change, and why it should fix it.** The card counts projects, and the finished ones get their own fold at the top of "Who's doing what", so a finished project is visible on the card and one line under the section's heading, never below the active work.

- Card: a second line under the outcomes count, in the same style: "N of M projects done". M is every project except dropped ones; " · K dropped" only when K > 0. No line when the initiative has no projects.
- A fold "Finished projects · N", closed by default, at the top of "Who's doing what", right under its heading: the same markup and look as the "Done · N" fold under Done when (one 44 px line, chevron, green tick), with "latest <date>" on the right.
- Each row: the name (opens the project, as a row's name does today), its lead, "done <date>" or "dropped <date>" (its last recorded change), and its done-when count ("3 of 3 done"). Newest first.
- "Who's doing what" then lists only active projects and their tasks. When every project is finished it says "No active projects." instead of an empty box.
- The "Projects in no initiative" box's detail gets the same split. Its items in the left column stay as they are (each already says Done or Dropped).
- Unchanged: done-when counting, the registry, the server, every other part of the layout.

**Expected result, and how it is measured.**

- Sealed (an initiative with 2 done, 1 dropped and 4 active projects): the card reads "2 of 6 projects done · 1 dropped"; the fold header sits above the first active row; the fold is closed until clicked, then lists 3 rows; no finished project among the active rows. At 1400 and 390 px.
- Live: the Team in Temper card shows "2 of 7 projects done", and the fold lists project-2-check ("Project 2: independent check") and team-quality-bar ("Quality bar for the team's apps").

**What would prove it wrong.** A finished project is still only findable below the active rows, or the counts differ from the registry.

**Result:** pending.
