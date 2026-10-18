# Initiatives page: the whole plan from the work registry

Owner 2026-10-18, "now lets plan for initiatives page to show all the planning work"; dialog answers "Your design, 1:1" and "Own section" for projects in no initiative (Ops #223, project initiatives-page). Accountable lead: Ops. This is the data half; the design view (#224) and the wiring task that puts the two together come separately. It lands inert: nothing in the app asks for it until the wiring task.

## H-INITIATIVES-DATA-1: result in "Results" below

**Wrong, and the evidence.** The server can't give the Initiatives page the planning work. The only reader of pi-work-management's log (`server/work-records.ts`, for the Roles panel) keeps an initiative's or project's id, name, lead, status and initiative plus two counts (`UiWorkRecord.items`, `.met`): no outcome, no done-when wording, no proof, who marked it or when, and it skips `task.link` and `task.state` lines entirely, so no task, its status or its block reaches any page. The Initiatives tab's own feed (`initiatives_watch`) shows decision records, not the registry.

**One change.** One read-only feed of the whole registry, `server/work-page.ts`, sent over the socket.

- Source: the work log `events.jsonl` in pi-work-management's work folder (`PI_WORK_DIR`, or `work` in pi's agent folder), the same path the Roles reader uses. Read only: one open and stat per look, a regular file only, at most 32 MiB (`WORK_LOG_MAX`), read again only when its size or time changed (the replay is kept, not the text).
- Replay by the store's own rules (pi-queue `work-store.ts` `applyEvent`, ported line by line): create, change (only the fields that really change; an initiative closes only once none of its projects is active; done needs every item met), met and unmet (items matched like the store's `itemKey`, ignoring case and outer spaces; marks kept in list order and wording, and dropped when an item is reworded or removed), `task.link` (parent must be open when new or changed; status kept across a relink) and `task.state` (block only while blocked). A line the store could never have written (another version, an unknown op, a rule it refuses, a no-op it refuses) is skipped and the page says `problem: "unknown-change"`; it is never guessed at. A half-written last line is left out. A complete line that isn't a JSON object makes the page `unreadable`, as the store refuses such a log too.
- Joined with the queues: each linked task gets, from the Roles overview's own projection of each role's home queue (`workFactsFromOverview`), its own chat's file, the queue's next action, the requester in plain words, the owner's pause, and `needsYou` (text, since) when one of its questions is open in the owner's list. The queue is matched by path (`samePath`), the task by number; when the registry links that number more than once in one queue, the projection's add time must say which, or nothing is joined. What isn't found stays absent.
- Shape (`server/protocol.ts`, protocol 51): `UiWorkPage { at, initiatives, projects, tasks, activity, problem? }`. Records carry id, name, outcome, lead, status, createdAt, createdBy, updatedAt and `doneWhen: [{ item, met?: { proof, by, at } }]`; projects also `initiative` (null = in no initiative). Tasks carry queue, queueName, task, added, title, parent, state, stateAt, block (on, need, lead, owes, due, since) and the joined facts. Activity is the newest 1000 changes, newest first, texts only as recorded. At most 500 initiatives and projects (initiatives first) and 2000 tasks; past that the first ones go and the page says `too-big`.
- Delivery: `work_page_watch` / `work_page_unwatch` from the page, `work_page { page }` or `{ error }` back (`WorkPageWatch` in `server/index.ts`, owned by the Initiatives tab in `server/tabs.ts`). A window gets the page at once, then again only when something but its time changed. While any window watches, it looks every 5 s; there is no queue change signal on the server (the Roles page polls too), so that look covers both the log and the queues. `poke()` (500 ms debounce) is there for one.
- Untouched: `server/work-records.ts` and `server/roles-overview.ts` (what the Roles page gets), pi-queue, the registry and every queue (nothing is written), the UI.

**Expected, and how it's measured.** On a fixed fixture log, `workPageFrom` returns exactly the hand-written page: an initiative whose list was reworded (the moved item keeps its mark in the new wording, the reworded one loses it), a project with one met and one taken-back item, a standalone project (`initiative: null`) later dropped, a blocked task with its block, a working task, every activity line newest first, and `unknown-change` for an unknown op, a refused mark, a link to a missing project and a line of another version, with the half-written last line ignored. Also: a line that isn't JSON says `unreadable`; over the limits says `too-big` with the first ones sent; the file reader says nothing for a missing log, `unreadable` for a folder, `too-big` past its byte limit, and follows appends; the watch sends once, again only on a change, and stops after unwatch. Measured by `tests/unit/work-page.test.ts`, with `tests/unit/work-records.test.ts` and `tests/unit/roles-overview.test.ts` passing unchanged, then the landing gate.

**What would prove it wrong.** Any difference from the expected page (an item out of order, a mark kept on a reworded item, a proof, author or time missing, a standalone project not null, a blocked task without its block, a skipped line not flagged, the torn line counted), a wrong problem for a bad, folder or oversized log, a watch that sends twice or after unwatch, or any change in what the Roles page receives (its tests failing, or its reader's files changed).

## Checks

- `tests/unit/work-page.test.ts`: the fixture replay against the exact expected page; torn last line; not-JSON and non-object lines; a task number linked twice in one queue; the record, task and activity limits; the facts taken from a Roles overview (add time, chat, next action, requester, pause, the oldest open task ask; home asks and roles without a home chat left out); the file reader; the watch.
- `tests/unit/work-records.test.ts` and `tests/unit/roles-overview.test.ts`, unchanged.
- Then the landing gate (`wt land`). No install of its own: the wiring task deploys it.

## Results

**H-INITIATIVES-DATA-1: HIT** (2026-10-18).

- Focused tests (`scripts/sealed.sh npx vitest run`, TZ=UTC), one run: `tests/unit/work-page.test.ts` 8 of 8 passed, the fixture page equal to the hand-written one in full; `tests/unit/work-records.test.ts` 17 of 17 and `tests/unit/roles-overview.test.ts` 42 of 42 passed unchanged. Typecheck clean; oxlint found nothing in the new code.
- Roles unchanged: the commit touches neither `server/work-records.ts` nor `server/roles-overview.ts`.
- Landing gate: `wt land` request 22-a15dac succeeded at 15:03 PDT, rebased onto mine 5f3cfb5f and checked by `scripts/check.sh --fast` (protocol sync, PATCHES.md check, typecheck, oxlint 0 errors, prettier, 424 test files: 6167 passed, 6 skipped). On mine and origin/mine as aad34732.
- Not measured here: the live feed. Nothing asks for it until the wiring task, which installs it and looks at it on the real registry.
- Plan differences: the server has no queue change signal to subscribe to (the Roles page polls too), so the 5 s look covers the log and the queues both; `poke()` (500 ms debounce) is ready for one. A task number linked twice in one queue gets its queue facts only when the projection's add time says which one is meant.

## Undo

Revert this commit (nothing asks for the feed yet, so nothing else changes), and deploy if it was installed.
