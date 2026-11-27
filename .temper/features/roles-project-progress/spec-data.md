# Project progress: producer-to-consumer truth map

Part of [spec.md](spec.md). Owner: Architecture; existing producers remain Ops-owned.

## Wire and identity

Exact existing declarations: `server/protocol.ts` (`UiWorkRecord`, `UiWorkRecords`) and
`server/roles-board-protocol.ts` (`UiWorkDoneWhenMark`, `UiRolesOverview`, `UiTaskBoard`,
`UiBoardGroup`, `UiBoardTask`). No schema additions in this feature.

| Datum/type | Producer/export | Card binding and refusal |
| --- | --- | --- |
| `work?: UiWorkRecords` | `RolesOverviewReader` → `WorkRecordsFile.get()` | Absent means registry not sent, not zero criteria |
| `work.projects: UiWorkRecord[]` | `workRecordsFromState` / existing `workRecordsFrom` | Join `group.projectId` to exact `project.id`; not by name/tag guesses |
| `id,name,lead: string`; `initiative?: string` or `null` | Same record | Existing title/chip/lead unchanged; null initiative means standalone |
| `status: active / done / dropped` | Registry status → `group.projectStatus?` | Group status controls project lifecycle/placement; absent is unknown, not done |
| `items:number`, `met:number` | Same criterion list/marks | Labeled count only when names not sent and valid `0 <= met <= items` integers |
| `doneWhen?: {item:string;met:boolean}[]` | `recordsOut` in `server/work-records.ts` | Full sentences, exact order and each boolean; no first-N fill |
| `work.problem?: unreadable / too-big / unknown-change` | Existing read/adaptation path | Expose registry unavailable/partial; do not claim authoritative empty/zero |
| `taskBoard?: UiTaskBoard`; `asOf:number` | `taskBoardOf` in `server/roles-by-project.ts` | Latest coherent overview binding, existing as-of text |
| `groups: UiBoardGroup[]`; `key:string`, `kind`, `projectId?` | `buildTaskBoard`, `groupKeyOf` | Only `kind=project` in Project grouping uses new body |
| `open:number`, `counts:Record<OpenState,number>` | `tally` over all read tasks | Group counts, not milestone completion; search-specific counts remain existing model's |
| `done14d:number`, `doneShown:number` | `tally`, retention selection | Activity = `done14d`; `doneShown` is sent rows, not a count substitute |
| `lastFinishedAt:number` or `null` | `tally` | Existing sorting only; null means no known finish, not epoch or a delivery date |
| `tasks:UiBoardTask[]`; `ref,groupKey,title:string` | Existing gathered queue rows → `boardTaskOf` | Filter exact groupKey, stable ref keys; full title accessible |
| `state:UiBoardState` | `boardStateOf` | Existing pill/word, never derive state from criteria/counts |
| `queueIndex:number` or `null` | `taskBoardRowsOf` | Role-local position only; null/absent does not establish next |
| `role?:string`, `id:number` | Queue row | Use existing `refLabel`; task role is not necessarily blocker owner |
| `howToUnblock?:string` | Queue's authored text | Render plain escaped text, not owner chip/markdown/parsed command |
| `dependsOnRefs?:string[]` | Queue dependencies | Existing map boundary only; does not map tasks to criteria |
| `problem?:string` on taskBoard | `taskBoardOf`: unread role home queues | Partial counts/rows; preserve warning, no “nothing queued” certainty |

`OpenState` is `"needs-you"|"blocked"|"waiting"|"working"|"queued"`.
Actual `boardStateOf` precedence: dropped → omitted; done → done; then paused → waiting;
stuck → needs-you; blocked → blocked; asking/waiting → waiting; working → working;
ready → queued. Reuse it; a paused done task remains done. `lifecycleStatus` does not replace state.

## Counts and rows stay separate

Current producer counts completed tasks over every done row with `finishedAt` inside
`[asOf - 14 * 86_400_000, asOf]`; missing finish time is not counted. It sends the six newest
recent done rows per group plus done predecessors within four steps, so `doneShown` can be
less than `done14d` or include older predecessors. UI reads the aggregate; no new recount/window.

With complete named criteria, `goalsOf` projects marks/counts from that list. The producer
invariant is `items === doneWhen.length` and `met === number of true marks`. If received
fields contradict that invariant, fail visibly as inconsistent data; do not clamp/fill/sort marks
to make the image plausible. This guard precedes `goalsOf`. With names absent, valid counts
may say “1 of 6 met” + “Milestone names weren't sent by this server.” No segmented marks,
checklist rows, guessed criterion text or placeholder identities. `[]` with counts 0/0 is empty;
`[]` with positive counts is inconsistent, not an old-server count-only signal.

## Now, held, queued and lifecycle

Use existing `tile.shown` for search-aware task previews; do not silently show unrelated rows.
Now = non-done, non-queued rows sorted stably by existing `rankOf`: needs-you, blocked,
waiting, working. Show up to three; a positive remainder is reachable on opening. Work is
parallel, never placed underneath a guessed criterion. Under search, an empty preview says
“No matching current work” rather than declaring the project idle. Milestones/activity remain
project-wide, as existing goals/activity were; do not recompute them from matching tasks.

Held rows (blocked/waiting) show recorded `howToUnblock`, or “How it unblocks: not recorded.”
Needs-you refers to the existing answer area, never invents a new answer or unblock action.
Task role and referenced dependency do not prove the responsible unblock owner; missing
structured owner stays not recorded. Full source wording remains accessible in task details.

Queued rows are previews, not a plan: up to two plus remainder. Preserve source-board stable
order for preview (existing producer order is deterministic); no cross-role rank labels, winner,
“next task” or sequence numbers. Within a single role existing queue order remains unchanged.
Label “Queued work · no project-wide order recorded”. None on a complete unfiltered board →
“Next: not recorded · nothing queued.” None under search → “No matching queued work”.
Incomplete board → no assertion of total emptiness. Never treat first unmet criterion as next.

Explicit `projectStatus` controls done/dropped versus active independently of criterion marks,
Now, held or queued activity. Existing quiet/done placement in `projectTiles` is Frozen: opening
one of those projects reveals the new body; its closed mini stays unchanged. An active project
with every criterion marked met is still active; a dropped project with 6/7 met stays dropped.
No global project status is derived from the highest-priority task pill.
