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

**Result: HIT** (2026-10-19, Ops #274).

- Sealed: `tests/initiatives-projects-done-test.mjs`, 29 of 29 checks at 1400 and 390 px. The card reads "2 of 6 projects done · 1 dropped" under its outcomes count; "Finished projects · 3" ("latest Sat Oct 17") is closed, 44 px high and above the first active row; one click opens 3 rows, newest first; no finished project shows among the active rows; a row's name opens its project. Focused vitest `tests/unit/initiatives-projects-done.test.ts` 7 of 7. Landed c715f6de (request 93-15f801, gate passed); `pi-web-deploy` of c715f6de at 21:00 passed every check (server, page, reply, bigchat, log).
- Live, look only (build 7610a8e4, which holds c715f6de; pseudo client `carry-on:ops-live-look-projects-done`; script and screenshots in `~/kept-from-tmp/2026-10-19/initiatives-projects-done-live/run1`), compared with the registry read at the same time, at 1400 and 390 px:
  - the Team in Temper card reads "0 of 15 outcomes done" and under it "2 of 7 projects done", matching the registry (7 projects, 2 done, 0 dropped);
  - "Finished projects · 2" ("latest Mon Oct 19") is right under the Who's doing what heading, closed, 44 px high, above the 5 active projects' rows;
  - opened, it lists "Quality bar for the team's apps" (Lead · QA, 4 of 4 done, done Mon Oct 19) and "Project 2: independent check" (Lead · Architecture, 4 of 4 done, done Mon Oct 19); neither shows among the active rows;
  - "Projects in no initiative" (desktop): "Finished projects · 3" with Message approvals back on, Roles page and Work hierarchy in use, the 3 active ones in the rows below;
  - no sideways scroll, no page errors; only hello and the page's watches were sent.
- Note: the fold's open or closed state is one setting for the page, like the Done fold's: opened on one initiative, it stays open on the next one picked.
- Limit, as planned: a finished project's tasks no longer show under Who's doing what (on 2026-10-19 no finished project had an open task).
