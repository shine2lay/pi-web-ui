# Roles by project: data contract (G1, G2, groups)

Part of [spec.md](spec.md). Types go in the new board protocol file (spec-build.md §Modules), `doneWhen` in
`server/protocol.ts`; every new field is optional so an older server reads as "not sent" (§Absent).

## G1: done-when items on the work registry

```ts
export interface UiWorkDoneWhenMark { item: string; met: boolean }
// UiWorkRecord gains:
doneWhen?: UiWorkDoneWhenMark[]; // registry order; item text verbatim; met by itemKey (trim, lower case)
```

- Producer: `workRecordsFrom` / `workRecordsFromState` in `server/work-records.ts`, from the `doneWhen` list and
  `met` set they already hold; `items === doneWhen.length` and `met === doneWhen.filter(m => m.met).length` always.
- `[]` = a record with no items (ring hidden). Absent = older server: the page hides the "Done when" fold and keeps
  the ring from `items`/`met`. No proof text, no `by`/`at` (the Initiatives page keeps those).

## G2: groups and board rows

```ts
export type UiBoardState = "needs-you" | "blocked" | "waiting" | "working" | "queued" | "done";
export type UiBoardGroupKind = "project" | "tag" | "none" | "role";
export interface UiBoardGroup {
  key: string;            // "project:<projectId>" | "tag:<tag>" | "none" | "role:<roleId>"
  kind: UiBoardGroupKind;
  label: string;          // project name from work.projects, the tag, or "No project or tag"
  projectId?: string;     // kind "project" only; joins work.projects[].id (ring, lead, initiative, doneWhen)
  projectStatus?: "active" | "done" | "dropped"; // kind project only, from the registry
  open: number;           // every non-done, non-dropped task in the group, never capped
  counts: Record<Exclude<UiBoardState, "done">, number>; // sums to open
  done14d: number;        // tasks with finishedAt in [at - 14 d, at], over ALL done rows read
  doneShown: number;      // done rows of this group in doneTasks (<= done14d + predecessors)
  roles: string[];        // role ids with a task in the group, by open count desc, then id
  lastFinishedAt: number | null; // newest finishedAt in the group, for "Done lately" order
}
export interface UiBoardTask extends Pick<UiRoleTask,
  "id" | "role" | "title" | "status" | "lifecycleStatus" | "project" | "initiative" | "tags" |
  "dependsOnRefs" | "howToUnblock" | "finishedAt" | "doneSummary" | "stuck"> {
  ref: string;            // "<role> #<id>", the same canonical form as dependsOnRefs
  groupKey: string;       // UiBoardGroup.key
  state: UiBoardState;
  queueIndex: number | null; // position in its role's queue (active first), null for done
}
export interface UiTaskBoard {
  asOf: number;           // = UiRolesOverview.at; the 14-day window ends here
  groups: UiBoardGroup[]; // §Which groups; order §Order
  roleGroups: UiBoardGroup[]; // kind "role": one per roster role, same counts by task.role (Department view)
  tasks: UiBoardTask[];   // every open task + the done rows of §Done rows; no duplicates by ref
  problem?: string;       // a queue that could not be read: groups are partial, the page says so
}
// UiRolesOverview gains:
taskBoard?: UiTaskBoard;
```

Named `UiTaskBoard` / `taskBoard` because `UiRolesOverview.board?: UiBoard` is already the roles' message board.

## Group key (one implementation: `groupKeyOf`)

1. `t.project` when it is an id in `work.projects` -> `project:<id>`.
2. Else the first tag (tags are already canonical: `normTags` folds aliases at read) that is a project id ->
   `project:<id>`.
3. Else the first tag -> `tag:<tag>`.
4. Else `none` ("No project or tag"; its body clusters by role).

A task is in exactly one group, so the group counts sum to the role counts (unlike `tagGroups`).

## Which groups

- Every `work.projects` record, whatever its status, even with 0 tasks (the page puts an active project with
  nothing open in "Nothing open right now", a done or dropped one in "Done lately").
- Every `tag:` and `none` group with an open task or a sent done row.

## Board state (one implementation: `boardStateOf`)

`stuck` -> needs-you; `blocked` -> blocked; `asking`, `waiting`, or any open task with `paused` -> waiting;
`working` -> working; `ready` -> queued; `done` -> done; `dropped` -> not on the board, not counted.

## Done rows

- Per group: the 6 newest done tasks with `finishedAt` within 14 days of `asOf` (ties: higher id first).
- Plus every done task reachable backwards from an open task through `dependsOnRefs` in at most 4 steps
  (step 1 = a direct predecessor), regardless of age; step 5 is never sent.
- `done14d` is counted over all done rows the producer read, so it may exceed the rows sent (e.g. 40 vs 6).
- Window: `[asOf - 14 * 86_400_000, asOf]` in ms, UTC; no local day boundaries. `finishedAt` absent -> not in
  the window and not counted.

## Order

- `groups`: tier needs-you > held (blocked/waiting) > active (working/queued) > done-only; then `open` desc; then
  `label` (locale compare, `en`); `none` last within its tier.
- `tasks`: by group order, then open before done, then `queueIndex`, then `finishedAt` desc, then `ref`.
- `roles` of a group and every list are deterministic: same input, byte-identical output.

## Absent, empty, partial

- `taskBoard` absent: the server could not build it this look. First load -> loading state; later -> keep the
  last good board and show the error banner (spec-page.md). Never an empty board.
- No group with `open > 0` -> empty state ("All clear"); project groups with 0 tasks still come, for the minis.
- `problem` set: some role queue failed to read; groups are shown with a one-line note, counts are of what was
  read (never guessed).
- Unread `dependsOnRefs` (a task not in `tasks`) are external: see [spec-graph.md](spec-graph.md).

## Payload bound (largest real case)

Busy snapshot (2026-11-05, 876 tasks read, 61 open): about 61 + 75 done rows sent. Tonight (895 read, 13 open):
about 13 + 178. Both inside the design's 200-260 tasks; no cap beyond the two approved rules (6 newest, 4 steps).
B12 checks the exact rows against a recount; Backend records `JSON.stringify(taskBoard).length` for both in its
land note (a measurement, not a gate).
