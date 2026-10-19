# Initiatives page step 4: gaps, all activity and hand-offs

Owner, Oct 18 (Ops home chat): design first, then the features, so he sees the progress; "Side by side" for steps 2-4. Project initiatives-page, accountable lead: Ops. Task Ops #228; the step table is in `docs/initiatives-page-exact.md`.

Step 4 fills the last three sections of the live Initiatives page from its own module, `web/src/initiatives-page/gaps.ts`, and never edits the files steps 2 and 3 work in (`plan.ts`, `tasks.ts`).

## Do role messages keep message_role's initiative field?

Yes. `RoleMessageRecord.initiative` (`server/role-messages.ts`, added by decision-records): message_role's `initiative` argument is checked (`checkInitiative`) and stored on the record; a reply without one takes its original's. So hand-offs come from the role-message store, not "Not recorded". What was missing is the way to the page: no feed the page watches carries role messages with their initiative (the Roles overview counts open requests per role, without the initiative). That is the one core hook this step adds (below). No new producer: nothing new writes role messages or their initiative.

## H-INITIATIVES-PAGE-4: step 4, gaps, all activity and hand-offs from what's recorded

**Wrong, and the evidence.**
- On the live page (step 1, af0ab88b, installed Oct 18 17:30) Gaps, Hand-offs and Activity say "Not connected yet" for every initiative and for the projects-in-no-initiative box (`gaps.ts` is step 1's stub). The owner can't see what is stuck or uncovered, what happened, or what passed between roles.
- The facts are already recorded: the `work_page` feed (#223) carries every linked task with its recorded status and block, each record's done-when items with their met marks, and the newest 1000 registry changes; the progress feed carries the lead's updates; role-message records carry the initiative they are part of.

**One change.** Fill `gaps.ts` from those records, by script, no model:
- Gaps the lead hasn't covered, a fixed list, in this order:
  1. a task of the initiative (linked to it or to one of its projects) whose queue last recorded it blocked or stuck, with what it waits on as recorded: blocked, its block (the tasks it waits on, its need, which lead owes what and when); stuck, whose answer it waits on (its next action);
  2. an active project of the initiative with unmet done-when items and no open task (none linked in a state other than done, dropped or removed);
  3. an active initiative with no active project: each of its unmet done-when items.
  The count is in the section header. The box gets kinds 1 and 2 for its projects.
- All activity: the registry's changes to the initiative, its projects and their tasks, plus the lead's progress updates, newest first, with the count in the tab. Items and proof only as recorded.
- Hand-offs between roles: the open questions and requests between two roles that carry the initiative's id (open by the Roles page's rule: no reply, not failed), oldest first: from → to (with the task number when sent from or to a queue task's chat), the kind and first line, and where it stands (delivered, no reply yet; not delivered yet; held while role messages are paused). An older server that sends none: "Not recorded". The box: "Not recorded", because role messages carry an initiative, and its projects are in none.
- The hook: `work_page`'s page gains an optional `handoffs` list, made by the role-message store's `openHandoffs()` and attached in `readWorkPage()`. It is additive, so no protocol bump: an old page ignores it, and this page says "Not recorded" on a server that doesn't send it. `model.ts` changes one call: `gapsPart` also gets the progress feed and the clock.
- Facts nobody records say "Not recorded"; nothing in these sections says "Not connected yet".

**Expected, and how it's measured.**
- `tests/unit/initiatives-page-gaps.test.ts` on a fixed fixture (`tests/unit/initiatives-page-gaps-fixture.ts`, made-up names): each gap kind and its wording, and none where the rules say none; activity order, texts and count, in the model and in the drawn tab; hand-offs with their states, and both Not recorded cases; no "Not connected yet" in the three sections; `openHandoffs()` on a fixed `role-messages.json`. Run once with the core model tests.
- One sealed look at the fixture at 1440 px.
- Live, after the install, look only, at 1440 and 390 px: for every initiative and the box, the page's gaps equal what an independent script finds in the live registry and queues at that moment (the same `work_page` answer the page gets); the activity count equals that script's count of matching registry changes plus the lead's updates shown; the hand-offs equal the open initiative-carrying questions and requests in the role-message store (compared by count and ids, texts never printed into a chat); nothing in the three sections says "Not connected yet"; nothing scrolls sideways at 390 px. Screenshots in `~/kept-from-tmp/2026-10-18/initiatives-steps/4/`.

**What would prove it wrong.** A gap the script doesn't find, or one it finds that the page misses; an activity count that differs from the events; a missing or extra hand-off; "Not connected yet" left in these sections; a pi-web-deploy check fails.

## Results
