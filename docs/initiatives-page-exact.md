# Initiatives page: the supplied design live, step by step

Owner, Oct 18 (Ops home chat): "try to start with building out UI 1:1 then add in different features so i can see the progress iwth my own eyes"; then "Side by side" for steps 2-4. Project initiatives-page, accountable lead: Ops.

| Step | Task | What it fills | Module |
| --- | --- | --- | --- |
| 1 | Ops #225 | The design live: page states, header, list cards, the projects-in-no-initiative box, detail frame, lead, counts, project rows, buttons, decisions, lead updates | `web/src/initiatives-page/model.ts` (core) |
| 2 | Ops #226 | Goal, started, done-when items | `web/src/initiatives-page/plan.ts` |
| 3 | Ops #227 | Task rows, waiting on you, the ON YOU bar, status chips and filter counts | `web/src/initiatives-page/tasks.ts` |
| 4 | Ops #228 | Gaps, all activity, hand-offs | `web/src/initiatives-page/gaps.ts` |

Each section module is one exported function from (`UiWorkPage`, selection, open callback) to its part of `InitiativesExactInput`, so steps 2-4 never edit the same file. Until its step lands, a module returns its "Not connected yet" version.

## H-INITIATIVES-PAGE-1: step 1, the design live with what's already known

**Wrong, and the evidence.**
- The Initiatives tab still shows our own layout (`web/src/components/InitiativesView.tsx`), not the design the owner picked on Oct 18 ("Your design, 1:1").
- #224 built that design as an inert view (`InitiativesExactView`, H-INITIATIVES-EXACT-1 hit), and #223 built the work registry feed (`work_page`, H-INITIATIVES-DATA-1). Nothing mounts the view and nothing asks for the feed, so the owner can't see either.

**One change.** Mount `InitiativesExactView` in the Initiatives tab in place of `InitiativesView`, fed by one core model from the `work_page` feed, plus decisions and lead updates from the existing `initiatives_watch` and progress feeds. Everything steps 2-4 will fill says "Not connected yet". The old view stays in source, unmounted, as rollback code.

What shows in step 1:
- Header "<n> initiatives · <date>", chip "Live · updated <time>"; loading, first-load error (Try again watches again), out of date and empty use the drawn states. The feed's `problem` shows as the drawn error panel (`unreadable`) or old-data banner (`too-big`, `unknown-change`).
- One card per registry initiative (active first, then done, then dropped) with "Lead · <role>" and "x of y outcomes done" from its done-when items. The status chip shows the registry status in a neutral grey, because live status comes from tasks (step 3). The All pill shows its count; the others show "—", and picking one says the filter isn't connected yet.
- "Projects in no initiative · N" under the list (the owner's "Own section"), opening like an initiative.
- Detail: lead; Finish "Not set by the lead"; Outcomes "x of y done"; Who's doing what = its projects (name, lead, x of y done, registry status); Latest updates and Lead's next step from the progress feed, else the design's empty wording; the Decisions tab from today's decision log; Spend "Not reported".
- Plan, task and gap sections say "Not connected yet". The ON YOU bar says "Not connected yet: what's waiting on you will show here", never an all-clear.
- Buttons: Message <lead> opens the lead's home chat (the Roles page's open path). Change lead shows only for initiatives the decision log knows, and opens today's lead picker in a dialog that says it changes who writes the progress updates. The other controls stay hidden.

Additions to the design's markup (written by `scripts/extract-initiatives-template.mjs`, continuing #224's 1-3):
4. The "in no initiative" box opens like an initiative: the box and its heading are clickable, and it is outlined like a selected card while open.
5. A section with nothing connected or recorded yet says so in the design's own empty-list style: Who's doing what, Outcomes, Done when, Latest updates, Hand-offs, Gaps and Activity.
6. A "Who's doing what" row can show a plain status chip (the registry status) instead of the role state chip.

**Expected, and how it's measured.**
- `tests/unit/initiatives-page-model.test.ts` on a fixed `UiWorkPage` fixture (`tests/unit/initiatives-page-fixture.ts`): card order and counts, the projects-in-no-initiative box, the "Not connected yet" labels, no all-clear anywhere, the page states and the problem banner, and which buttons show. Run once with the existing Initiatives and Roles exact tests.
- One sealed look at the fixture at 1440 and 390 px: `scripts/sealed.sh node --import tsx scripts/initiatives-exact-shot.mjs --page [dir]` (fails on any console error but the template's blocked handler lines, or when the page scrolls sideways).
- Live, after the install: a look-only check at 1440 and 390 px. The initiative count, the projects-in-no-initiative count and each initiative's "x of y" match the registry (`~/.pi/agent/work/events.jsonl`, read through `server/work-page.ts`). No design sample names, no all-clear, nothing scrolls sideways at 390 px. Screenshots in `~/kept-from-tmp/2026-10-18/initiatives-steps/1/`.

**What would prove it wrong.** A count differs from the registry; design sample data shows; anything says nothing is waiting on the owner; a section steps 2-4 will fill shows anything but "Not connected yet"; a pi-web-deploy check fails.

## Results

Pending.
