# Project progress: state, cache and action rules

Part of [spec.md](spec.md). Owner: Architecture. Scope is card-local truth, not refresh redesign.

## Presence and failure precedence

Evaluate transport/availability before empty/count rendering. Unknown is never known zero.

| Condition | Required behaviour |
| --- | --- |
| First full watch, no board, no failure | Existing loading skeleton and “Loading projects and queues”; no 0/0 |
| No board after a good board | Existing error banner/retry with last-good board; not empty success |
| `roles` error, even with `status=ready` | Keep existing error visible with last-known view; data not current |
| `work` absent | Registry not supplied/older server; milestones unknown, not an empty plan |
| `work.problem=unreadable` | “Milestones couldn't be read just now (not zero: unknown).” No current fraction/marks |
| `work.problem=too-big` or `unknown-change` | Explicit incomplete registry warning; sent record may be shown as partial/last-known, never authoritative success/empty |
| Joined project missing | Milestones unavailable/unknown; do not attach another project or turn it into 0/0 |
| `doneWhen` absent, valid counts present | Count-only fraction + missing-names notice; no per-item marks/names |
| `doneWhen=[]`, `items=0`, `met=0`, healthy work | “No milestones recorded for this project.” No ratio or strip |
| Named criteria all false with valid matching counts | Known “0 of N met”, real unmet marks; not missing data |
| `work.projects=[]` with healthy complete work | No recorded project, not a synthetic 0/0 project; existing tag/none grouping remains |
| Board `problem` | Show existing partial warning. Observed rows/counts may show, but empty observations cannot prove nothing running/queued or all clear |
| No current work, healthy unfiltered board | “Nothing running right now.” Queued work remains separate; never mark project done |
| Search filtered everything | Existing no-results/filter semantics; not “nothing queued/running” for the project |
| Stale/disconnected last-good snapshot | Retain last-known view/as-of and existing reconnect/error status; no new progress or fresh-success claim |
| Malformed null/invalid type in required fields | Unavailable/inconsistent card section with visible reason, not zero or repair; no app crash |

Absent `projectStatus` is unknown; `group.projectStatus` wins a disagreement with separately
bound project record, and show data mismatch rather than synthesizing a lifecycle. `null` is
valid only where already declared (e.g. `initiative`, `lastFinishedAt`, done `queueIndex`).
`doneWhen:null`, non-boolean marks, negative/fractional/non-finite counts, counts out of range,
wrong array/string types or mismatched list/counts are malformed, not authorized emptiness.
A partial record cannot prove zero or completion even if its observed counters happen to be 0.

## Existing caching and reload bindings

Roles page reader: `RolesOverviewReader` → `WorkRecordsFile.get` (not watch `WorkRegistryReader`).
`WorkRecordsFile` opens/stats each look, caches by mtime+size; ENOENT currently returns empty,
other open/read/non-regular errors return `unreadable`; file/record limits return `too-big`;
unknown events yield `unknown-change`. Canonical `piQueueReaders().readWork` is preferred for
`events.jsonl`; its refusal falls back through the existing adapter. These are existing read
limitations, not a claim of content-hash freshness or a reason to add a parallel reader.
The frame cannot distinguish a deleted registry from never-created when the adapter emits
healthy empty; present only “No recorded projects”, never “all project work is finished”.

Existing `RolesWatch` (`server/roles-watch.ts`) replays its cache on watch, then checks again;
default full interval 3,000 ms, count interval 10,000 ms, plus pokes/heartbeat. Retain it unchanged.
`web/src/roles-state.ts` owns `overview`, `checkedAt`, `overviewReceivedAt`, `appliedAt`,
`waitingSince`, `failedAt`, `error`; initial cache replay alone does not prove a newer look.
Count-only WS heartbeat carries no milestone/item data: it cannot rebuild names/marks, clear
registry `problem`, or supply a missing board. A newer checkedAt confirms a look under the
existing rules; the card does not create its own timers, polling, age threshold or storage.

`RolesByProjectView` currently stores lastGood board and binds it against the latest overview's
work via `contextOf`. Do not claim an atomic old pair if a board is missing in a later overview.
For the new card body, mismatched board/work generations must be marked last-known/unknown,
not silently combined as fresh. Keep any paired value only inside the existing page/card state,
not a new authority/store; do not change Frozen transport/recovery semantics to solve it.

“Try again” is existing `reloadRoles()` once per activation. Keep last-good content until a
healthy response; an error becoming partial is not complete recovery. No new action, endpoint,
registry write, answer, reorder, guessed retry, or new persisted preference.

## Disclosure, links and focus

Preserve header disclosure identity, `aria-expanded`, chevron, open set and stable group/task
keys. Lists and links live OUTSIDE the header button; no nested buttons or raw HTML. Opening
reveals all criteria (not hover-only), extra tasks and existing full map/details. Closing returns
to preview. Met/unmet has icon and text; decorative strip `aria-hidden`. Preserve reduced motion.

Reuse existing `OpenedMap`/task details and `RoleAnswerDialog` routes/actions. A needs-you preview
may direct to the existing answer area; no synthetic dialog context. Do not parse free text into
URLs, commands, role ownership or task actions. Existing task links remain canonical (same base
URL/navigation policy), not hand-built `file:`/unsafe links or guessed ref→chat resolution.
Keep full criterion sentence/title/reason available with keyboard or open details, not tooltip alone.

A live update preserves search text/caret, scroll, focus by stable ref, tile expansion, answer
choice and pointer press in flight; a vanished group closes per current behaviour. Do not steal
focus when progress updates or auto-open blocked work. Error retry remains keyboard reachable.
