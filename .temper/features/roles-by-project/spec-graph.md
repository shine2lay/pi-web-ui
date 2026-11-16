# Roles by project: task maps

Part of [spec.md](spec.md). One pure module, imported by the server producer and the page (no `node:` imports,
no DOM); the page never builds links any other way.

<!-- doc-check: paths-planned (created by Frontend #293's seam) -->
`server/shared/roles-by-project/graph.ts` exports:

```ts
export interface TaskMap {
  layers: string[][];            // refs per layer, left to right, each layer ordered (§Order)
  edges: { from: string; to: string; kind: "done" | "blocked" | "root" | "plain" }[];
  chains: string[][];            // connected parts with 2+ tasks, ordered (§Order)
  loose: string[];               // tasks with no link inside the group ("On their own")
  roots: { ref: string; waiting: number }[]; // root blockers and how many open tasks wait on each
  cycles: string[][];            // each set of tasks that wait on each other, refs sorted
}
export function taskMapOf(rows: readonly UiBoardTask[]): TaskMap;          // one group's rows
export function miniMapOf(map: TaskMap, rows: readonly UiBoardTask[]): MiniMap;
export function layerWindow(layerCount: number, firstOpenLayer: number | null):
  { start: number; end: number; earlier: number; later: number };
export function heldOnOf(rows: readonly UiBoardTask[]): { role: string; count: number } | null;
export interface MiniMap {
  columns: { refs: string[]; more: number }[]; // the windowed layers of the drawn chain
  earlier: number; later: number;              // layers cut before / after the window
  squares: { refs: string[]; more: number };   // loose open tasks, or done ones when nothing is open
}
```

## Links

- A link `p -> t` exists when `t.dependsOnRefs` holds `p.ref` and both rows are in the same group's input.
  `dependsOnRefs` is the existing canonical union of `after`, `block.on` and outside refs
  (`collectDependsOnRefs`, `server/shared/task-blocker-resolver.ts`); no other link source.
- A ref not in the group's rows (another group, another queue not read, dropped, or done more than 4 steps back)
  is not a node and gets no guessed state; the task's `howToUnblock` says what it waits on.
- Duplicate refs in `dependsOnRefs` make one link; a self-reference makes none.

## Layers and cycles

- Tasks that wait on each other (a strongly connected set, e.g. A -> B -> A) are one unit: same layer, links
  inside it are `plain`, the set is listed in `cycles`. No task is dropped and the page shows "Waits in a loop".
- Layer = 0 for a unit with no linked predecessor, else 1 + the highest predecessor layer.

## Root blockers and edge kinds

- Root blocker: an open task with no open linked predecessor and at least one open task after it (directly or
  through others). `waiting` = the number of distinct open tasks after it. Shown as "N tasks wait on this one".
- Edge kind, first that applies: `root` (from a root blocker), `done` (from a done task), `blocked` (into a
  blocked task), else `plain`.

## Mini map (closed tile)

- Chain drawn = the chain with the most tasks (ties: §Order). Window over its layers with `layerWindow`:
  `start` = first layer holding an open task, or `max(0, count - 3)` when none is open;
  `end = min(count, start + 5)`; `start = max(0, min(start, end - 3))`; `earlier = start`, `later = count - end`.
  So at most 5 layers, at least 3 when the chain has 3, and "+N earlier layers" / "+N later" from the numbers.
- Each layer shows up to 5 tasks, then "+N".
- Loose open tasks follow as squares, up to 40, then "+N". No chain and nothing open: the done tasks as green
  squares, same cap.

## Opened map

- `taskMapOf` over every row of the group, never windowed. Up to 6 loose tasks, then "Show all N".
- Done tasks are green with their `doneSummary`; open tasks show `howToUnblock`; needs-you tasks say "Needs your
  answer: it's at the top".

## Held on

`heldOnOf`: count blocked tasks by the role of their first `dependsOnRefs` entry naming another role; the top role
when its count is 2 or more -> "Mostly held on <Role> (n)"; ties by role id; else `null`.

## Order

State rank needs-you, blocked, waiting, working, queued, done; then `queueIndex` (null last); then `ref`. Chains:
lowest member rank, then more open tasks, then first ref. Same input gives the same output.

## Done predecessors (server, G2)

`donePredecessors(tasks: readonly Pick<UiBoardTask, "ref" | "state" | "dependsOnRefs">[], maxSteps: 4): Set<string>`
lives in `groups.ts` next to `groupKeyOf` (Backend builds it; the page never calls it). Breadth-first from every open task over `dependsOnRefs` across all rows read (not only one group), at most 4
steps; collects done rows met on the way. A ref met twice is visited once (cycles end). Result rows are sent in
their own group.
