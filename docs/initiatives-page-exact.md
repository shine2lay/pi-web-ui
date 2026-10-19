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

### H-INITIATIVES-PAGE-1: hit (Oct 18)

- Focused tests, run once (sealed, `TZ=UTC`): 13 files, 332 of 332 passed (`initiatives-page-model` 11, `initiatives-exact` 14, the old Initiatives tests and the Roles exact tests unchanged).
- Sealed look at the fixture: 1440 and 390 px, fonts loaded, only the template's own blocked handler lines in the console, nothing scrolls sideways (390 of 390). Shots: `~/kept-from-tmp/2026-10-18/initiatives-steps/1/fixture/`.
- Landed as `af0ab88b` through `wt land` (gate: 433 files, 6195 tests passed, 6 skipped). Installed with `pi-web-deploy --landed 35-238909` at 17:30; `pi-web-deploy result af0ab88b` returned 0 with every check passed (server, page, reply, big chat, log).
- Live look, look only (own blank client; every socket message but hello, ping, frame acks and the read-only watches held and counted, never sent), 17:47, against the registry read through `server/work-page.ts` at the same time: 42 of 43 checks passed, the one miss below.
  - Header "1 initiative · Sun Oct 18", chip "Live · updated 17:47"; the page's own feed held 1 initiative and 5 projects, no problem, the same as the registry.
  - One card, Team in Temper, "Lead · Architecture", "0 of 11 outcomes done" (registry: 0 of 11 met). Pills: All 1, the others "—".
  - "Projects in no initiative · 5" with all 5 (Faster landing 4 of 7, Parallel queue work 2 of 5, Initiatives page 0 of 4, Roles page 6 of 6, Work hierarchy in use 4 of 4, the registry's figures); opened, it shows "Outcomes · 16 of 26 done", "No one leads this" and no buttons.
  - Goal, Started, Outcomes, Done when, Hand-offs, Gaps and Activity say "Not connected yet"; the ON YOU bar says "Not connected yet: what's waiting on you will show here."; no all-clear anywhere; no design sample names.
  - Finish "Not set by the lead", Spend "Not reported", Latest updates and Lead's next step from the progress feed, Decisions 3990 (the decision log's own count for it).
  - Buttons: Message Architecture and Change lead; Message Architecture asked for Architecture's home chat (held) and left the tab for the chat; the Change lead dialog says "This changes who writes this initiative's progress updates."
  - 390 px: nothing scrolls sideways (page, frame and its body all 390 wide, nothing past the edge), on the first screen and the full page.
  - By eye, the 1440 shot has the design's layout (`company-lab/shared/initiatives-reference-audit-2026-10-11/desktop-initial.png`): header, ON YOU bar, pills, cards and box on the left, detail frame, tabs, Who's doing what, Done when, Hand-offs, the lead box and Gaps on the right.
- Shots: `~/kept-from-tmp/2026-10-18/initiatives-steps/1/desktop-1440.png`, `desktop-box-1440.png`, `desktop-change-lead.png`, `phone-390.png`, `phone-390-full.png` (since replaced by the 18:30 look's, below; the 17:47 ones stay in `live/out3/`).
- Seen, not this hypothesis's measure: the first load waited 6.7 s at 1440 and 14.6 s at 390 px for the feed (36 s and over 40 s in two earlier looks that evening under load). `readWorkPage` in `server/agent-service.ts` waits for the Roles overview's queue facts before it answers, so "Loading" lasts as long as that read. A follow-up for the feed (#223's code): answer with the registry first, the facts after.

### Found in the live look: Escape doesn't close the Change lead dialog, and would cancel a hidden question

With the Change lead dialog open, Escape left it open (`dialog[open]` still there 400 ms later), and at that moment the page tried to send one `question_answer` (held by the look, never sent): the cancel of the question waiting in the Ops lead chat, whose notice showed top right. The cause is in the app's Escape order (`web/src/shortcut-stack.ts`): one capture listener on the document hands Escape to the newest handler on its stack and stops it there (`preventDefault`). The question dialog in the chat pane (`DshQuestionDialog`, mounted while the chat pane is hidden behind the Initiatives tab) is on that stack and cancels its question; the page's dialogs aren't on it, so the native dialog never gets its Escape.

## H-INITIATIVES-ESCAPE-1: Escape closes the page's own dialogs first

Called H-INITIATIVES-PAGE-2 in the commits that landed it (774e5a71, 44b29280); renamed so that steps 2, 3 and 4 keep the ids their plans give them (H-INITIATIVES-PAGE-2, -3 and -4).

**Wrong, and the evidence.** The live look above: Escape with the Change lead dialog open kept it open and tried to cancel the Ops lead chat's waiting question. The source dialog the page opens from a decision is built the same way, so it has the same problem.

**One change.** While one of its dialogs is open, the Initiatives page puts its own Escape handler on the app's stack (`useEscapeKey`), which closes that dialog. It is the newest handler while the dialog is open, so Escape goes to it and stops there.

**Expected, and how it's measured.**
- `tests/unit/initiatives-page-escape.test.ts`: the real question dialog is open first (its sends captured), then the page opens Change lead (or a decision's source); Escape closes the page's dialog and sends no `question_answer`; with no page dialog open, Escape still reaches the question dialog. Without the change, the test fails on the first two (the dialog stays, the cancel is sent).
- Live, after the install, the same look: Escape closes the Change lead dialog and the page tries no `question_answer`.

**What would prove it wrong.** The dialog stays open on Escape, or any `question_answer` is tried while a page dialog is open.

Not this change: the question dialog keeps its Escape while the chat pane is hidden, so Escape on another tab, with focus outside a page's own frame or dialog, still cancels a waiting question the owner can't see. That is the question dialog's behaviour across the app, a follow-up of its own.

### H-INITIATIVES-ESCAPE-1: hit (Oct 18)

- `tests/unit/initiatives-page-escape.test.ts` failed without the change (2 failed: the dialog stayed open and the cancel was sent) and passed with it (3 of 3).
- Landed as `9b6c4e73`, with the doc `774e5a71`, through `wt land` request `38-c6a823` (gate: 434 files, 6198 tests passed, 6 skipped). The first try (`36-43bc8b`) failed on one test this change doesn't touch: `tests/unit/role-message-guard-core.test.ts` went past vitest's 5 s limit (5134 ms) while its file took 64 s instead of the usual 33 to 38 s, with load average 28.6 and another landing beside it; the second try ran unchanged.
- Installed with `pi-web-deploy --landed 38-c6a823` at 18:22; `pi-web-deploy result 9b6c4e73` returned 0 with every check passed (server, page, reply, big chat, log).
- The same live look, look only, 18:30: 44 of 44 checks passed. Escape closed the Change lead dialog, and the page tried no `question_answer`. Everything step 1 measured held against the registry read at 18:28: "1 initiative · Sun Oct 18", Team in Temper "Lead · Architecture" and "0 of 11 outcomes done", "Projects in no initiative · 5" with the registry's figures, every section steps 2-4 fill says "Not connected yet", no all-clear, no design sample names, nothing scrolls sideways at 390 px, and nothing written.
- Shots: `~/kept-from-tmp/2026-10-18/initiatives-steps/1/desktop-1440.png`, `desktop-box-1440.png`, `desktop-change-lead.png`, `phone-390.png`, `phone-390-full.png`; the look's own files in `live/out4/`.
- Seen again, not this measure: the feed's first load took 66 s at 1440 and 12.4 s at 390 px; the same follow-up as in step 1's result.
