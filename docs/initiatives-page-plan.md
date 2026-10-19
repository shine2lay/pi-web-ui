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

Not yet tested.
