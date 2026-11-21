# stall-watch: the contract, the dry run and the wait field

Part of [stall-watch.md](stall-watch.md) (what the watch is, its rules, how to switch it off, and its parts).

## The contract (Ops #284 builds on it)

```ts
export interface StallFinding {
	kind: "project" | "initiative";
	id: string;
	name: string;
	rule: "empty" | "silent";
	since: number;
	stretch: string; // `${kind}:${id}:${rule}:${since}`, the dedupe key
	chain: string[];
	initiative?: string;
	lastDone?: { queue: string; task: number; title: string; summary?: string; at: number };
	open: { queue: string; task: number; title: string; status: string; waitsOn?: string }[];
}
export function stallFindings(page: UiWorkPage, extra: StallExtra, now: number, s: StallSettings): StallFinding[];
export interface StallSettings { mode: "off" | "dry" | "on"; emptyHours: number; silentHours: number; gapHours: number; everyMin: number }
export function stallSettings(): StallSettings;
export class StallWatch; // a round every everyMin minutes; hands the findings to act(findings, now)
```

- `queue` in `open` and `lastDone`: how people call the task's queue (a role id or the queue chat's title), else
  its chat file.
- `lastDone`: the newest done task under it (an initiative: straight under it or under one of its projects),
  with its queue_done summary when the Roles overview has it.
- `open`: its open tasks, oldest link first; `waitsOn` says what a blocked task waits on.
- `since` only moves when something happens (a task closes, a status changes, a wait ends, something is
  recorded), so the same stall keeps the same `stretch` from round to round and across restarts.
- `StallExtra` holds what the page lacks: per item, its last status or lead change, the newest registry event
  about it or its tasks, when an open task (or, for an initiative, an active project) last left it, and when a
  wait was last resumed (`server/work-registry-times.ts`, built in the same pass as the registry read; the
  backtest uses its `stallTimesFrom(text)`); and each initiative's newest lead update.

## The dry run

- Each round reads the whole registry through its one reader (`server/work-registry-reader.ts`, no task-count
  ceiling; the server's `readWorkRegistry()` joins it with the Roles overview's queue facts), which gives the
  page and the extra times from one pass, and the progress feed's lead updates. It does not depend on any open
  window. A complete round logs `stall: round complete: <n> linked tasks read, <m> findings` and writes
  `~/.pi-web-ui/stall-watch-heartbeat.json` (`at`, `tasksRead`), which agent-tools' scheduled-jobs dead man's
  switch watches (row `stall-watch`, 30 min).
- Otherwise it logs changes only:
  - `stall: would wake <role> about <kind> <id> (<rule> since <local time>, step 1 of N)` for a new stretch,
    then step 2, 3 … as each comes due, `gapHours` apart;
  - `stall: <id> cleared (<why>)` when a stretch ends.
- It keeps the current findings for the control socket's `stall_list` (`pi-web-ui stall list` prints it): the
  findings and every active item's state (flagged, quiet with why, empty but not for long enough, covered by its
  projects, or fine); `incomplete` says why the last round couldn't read the whole registry.
- In dry mode it sends nothing (apart from the alarm above) and writes nothing beyond its log lines and the
  heartbeat. Its memory of what it logged is in the
  server's memory only: after a restart the current stretches are logged again once.
- A registry it can't read whole (a line that isn't JSON, a read error, a round that fails) means it isn't
  watching: it logs `stall: registry not read whole (...)` each such round, shows no findings, and pages the
  owner once per condition through the lane watchdog's Telegram route; a complete round re-arms the alarm. The
  dead-end answer on such a read is "unknown". Details: [stall-watch-whole-list.md](stall-watch-whole-list.md).

## The wait field in the work page

pi-queue's `project.wait` / `initiative.wait` (`{id, until, why}`) and `project.resume` / `initiative.resume`
(`{id}`) events (Ops #282) are read by `server/work-page.ts`'s replay with the store's rules: a wait is kept on
the record as `wait: {until, why, at, by}`, replaced by a new wait, cleared by a resume or by a status change to
done or dropped; both need the item active. They add no activity line and don't change `updatedAt`, so the
Roles and Initiatives pages look exactly as before (they don't show waits yet). Without this, the first real
wait would mark the page "unknown change".
