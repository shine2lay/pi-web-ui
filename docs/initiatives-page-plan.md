# Initiatives page step 2: goals, done-when items and projects

Owner, Oct 18 (Ops home chat): design first, then features, so he sees the progress; "Side by side" for steps 2-4. Ops #226, project initiatives-page, accountable lead: Ops. The steps and their modules: `docs/initiatives-page-exact.md`.

## H-INITIATIVES-PAGE-2: step 2, the plan section from the registry

**Wrong, and the evidence.**

- Step 1's live look (#225, Oct 18 17:47) found Goal, Started, Outcomes and Done when saying "Not connected yet" for every initiative and for the "in no initiative" box. `web/src/initiatives-page/plan.ts` still returns its stub.
- The registry holds what those sections should show. At 19:21 (`~/.pi/agent/work/events.jsonl`, read through `server/work-page.ts`): Team in Temper has a goal, started Fri Oct 16 and has 11 done-when items, 0 met; the 5 projects in no initiative each have a goal and 26 items between them, 16 met, each met item with its proof, who marked it and when.
- A project can't be opened at all. Only initiatives and the box open; a project row and a box item have no click, so a project's own goal and items have nowhere to show.

**One change.** Connect the plan section to the registry, for initiatives and for projects:

- `plan.ts` fills, in the design's own sections:
  - Goal = the record's outcome; Started = the day it was created.
  - Outcomes and Done when: each done-when item in the registry's order, header "<met> of <items> done". A met item reads "Done · <day marked>", with "Proof: <proof>" as its step and "Marked by <role>" (or "you") as its owner. An open item lists as its steps the initiative's open projects (name, "x of y done"), or "No project yet", and never a done step, so only met items count as done.
  - The box: goal and done-when items belong to each project; it says to open one.
- The smallest core hook for projects: a project opens in the detail panel like an initiative, with its own frame (`projectFrameId`, built in `model.ts` and filled by the parts like an initiative's). Its row in "Who's doing what" is the project's own; the sections an initiative keeps (the lead's updates, decisions, hand-offs, gaps, activity) say so and name the initiative.

Additions to the design's markup (`scripts/extract-initiatives-template.mjs`, continuing 4-6):

7. A "Who's doing what" row's name can be a button that opens the project's own detail.
8. An item's name in the "in no initiative" box can be the same button (it opens the project, not the box).

The view takes optional fields for them (`opens` on a row and a box item, `details` on the input); absent keeps step 1's behaviour.

**Expected, and how it's measured.**

- `tests/unit/initiatives-page-plan.test.ts` on a fixed `UiWorkPage` (`tests/unit/initiatives-page-fixture.ts`, with goals added in the test): met and open items in order with their marks, a reworded item losing its mark (through `server/work-page.ts`'s replay), a project in no initiative opened in the detail panel, "No project yet"; run once with the core model and design tests.
- One sealed look at the fixture at 1440 px.
- Live, after the install, look only at 1440 and 390 px: Team in Temper's goal, start day and its 11 items with the registry's met count at that moment; one project opened with its goal, start day and items, each met one with its day, proof and marker, as the registry holds them.

**What would prove it wrong.** An item missing, extra or out of order; a wrong mark; proof shown for an unmet item; a count that differs from the registry; a project that doesn't open; a pi-web-deploy check failing; the page scrolling sideways at 390 px.

## Results

**HIT** (Oct 18, 20:01). Every item, mark, proof, goal and start day on the live page matched the registry at that moment.

- Focused tests, run once sealed (TZ=UTC): the 7 Initiatives test files, 113 tests. The new file failed 2 at first because of two mistakes in the tests themselves: the registry's replay leaves out a last line with no newline, and an item button's text has no spaces between its number, title and state. Both tests fixed; the file passes 7 of 7. Typecheck, formatting and the extraction check pass. Sealed look at the fixture at 1440 and 390 px: pass, nothing scrolls sideways (`~/kept-from-tmp/2026-10-18/initiatives-steps/2/fixture/`).
- Land: request 48-47138d, rebased onto step 4 (fd4bc4e3); one test-file conflict, resolved keeping both steps' code; the gate passed. Commit 90995a22.
- Install: `pi-web-deploy --landed 48-47138d`, 19:49; all 5 checks passed (server, page, reply, big chat, log), result 0. Rollback: fd4bc4e3.
- Live look, look only (`~/kept-from-tmp/2026-10-18/initiatives-steps/2/live/look.mjs`, run `out1`): 49 of 49 checks; the registry didn't change during it.
  - 1440 px, every record. Team in Temper: its goal, Started Fri Oct 16, "Outcomes · 0 of 11 done", its 11 items in the registry's order, each "Not started: No project yet" with Architecture (lead) as owner, no proof. The 5 projects in no initiative, each opened from the box: their goals, Started Sun Oct 18, 26 items. The 16 met ones read "Done · Sun Oct 18" and, opened, show their proof, day and "Marked by Ops"; the 10 open ones show no proof, "In progress: <project> · x of y done" and Ops (lead).
  - 390 px: Team in Temper and Faster landing, every item opened: the same, and nothing scrolls sideways.
  - The page sent only hello and its read-only watches; its own feed held 1 initiative and 5 projects.
- Screenshots: `~/kept-from-tmp/2026-10-18/initiatives-steps/2/` desktop-1440, desktop-1440-initiative-items, desktop-1440-project, desktop-1440-project-items, desktop-1440-project-done-when, phone-390, phone-390-full (cut at 12,000 px high), phone-390-project-full (.png).
- Seen, not misses (for the lead): every item's "Roles on it" reads "No role recorded" (the design's own field, which the registry doesn't fill); next to a long proof, the day wraps onto three lines; the page's first load took 19.3 s on desktop and 8.5 s on the phone (known from step 1: it waits for the Roles overview).
