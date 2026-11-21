# stall-watch: the live dry run and the result (H-STALL-1)

Part of [stall-watch.md](stall-watch.md) (what the watch is, its rules, how to switch it off, and its parts).

## Live dry run

Installed only through `pi-web-deploy`: the check (5d3ff258, land 120-681236) at Oct 20 09:38 PDT, then
its cost fix (342232a3, land 122-1e8cb3) at 11:06. The latter install's server, page, throwaway reply,
big-chat copy and log checks all passed. Carry-on finished at 11:09:30; the stall timer starts after it.
No settings file was needed: mode dry, emptyHours 2, silentHours 24, gapHours 2, everyMin 10.

Read-only checks used `node bin/pi-web-ui.mjs stall list`, the service's `stall:` log lines, and
`scripts/stall-count.mjs --at <the round's time> --json`, independently replaying the registry rather than
calling the server's stall rules. Results:

| build    | round, PDT Oct 20 | wall time (`tookMs`) | flagged empty | covered initiatives | fine projects | pending / quiet / silent | independent count |
| -------- | ----------------- | -------------------- | ------------- | ------------------- | ------------- | ------------------------ | ----------------- |
| 5d3ff258 | 1, 09:40:51       | 1,007 ms             | 11            | 3                   | 4             | 0 / 0 / 0                | exact match       |
| 5d3ff258 | 2, 09:50:51       | 247 ms               | 11            | 3                   | 4             | 0 / 0 / 0                | exact match       |
| 342232a3 | 1, 11:10:39       | 345 ms               | 11            | 3                   | 4             | 0 / 0 / 0                | exact match       |
| 342232a3 | 2, 11:20:39       | 62 ms                | 11            | 3                   | 4             | 0 / 0 / 0                | exact match       |
| 342232a3 | 3, 11:30:39       | 50 ms                | 11            | 3                   | 4             | 0 / 0 / 0                | exact match       |

The comparisons match each empty item's id, `since` and first lead, plus pending, quiet and covered sets.
There were no quiet items to explain in these rounds. Fixed fixtures cover the owner-pause, needs-you and
active-wait exceptions that the live snapshot did not contain. The independent event-only script cannot
reconstruct past queue-only facts (above); no silent candidates occurred in this live check either.

The dry list, all empty:

- Ops: faster-landing, parallel-queue-work; each ops → owner.
- Design: app-screens-workflow, marketing-visuals-workflow, logo-identity-workflow, design-review-workflow,
  user-research-walks; each design → owner.
- Team in Temper: team-page-truth (frontend → coo → owner), owner-stop-and-notices (temper → coo → owner),
  team-vs-solo and owner-real-task (each architecture → coo → owner).

Each install's first round logged these 11 `would wake` lines. Later rounds logged no changes because no
finding changed. Restarts do not reset `since` or `stretch`; they do reset this dry logger's in-memory
set, so it lists the same findings again. Persisting actual deliveries belongs to #284, not this dry check.

Nothing sent or written by the stall check: against the 09:38:35 baseline, by 11:31 there were no new
Board posts, still 15 queue-reminder lines, and no app/stall-authored registry event (80 new events, all
by roles doing their existing work). One new app-sent role message at 10:55:06 was the existing Initiatives
page's progress-report request to COO; none was about stalls. The runner's only default action is its log
hook; it has no role-message, queue, dialog or registry-write path.

The first cost-fix round includes its initial records read. The later wall times fell to 62 then 50 ms;
round 3 meets H-STALL-COST-2's live prediction of under 60 ms, though its stricter sealed CPU p90 prediction
remains a recorded miss. These wall times include I/O and scheduling, not just main-thread CPU.

## Result

**H-STALL-1: MISS as written (Oct 20).** All four intended overnight cases were found on time, with the
right chains; all must-catch fixtures fired and no must-pass fixture fired, identically on two runs.
But the backtest also flagged three-passing-projects, disproving the prediction that it would never do so.
The registry establishes why: temper #103 closed at Oct 19 08:43; #110 and #112 were linked at 12:04-12:05.
It really had no open task for 3 h 21 min. The hypothesis's premise, not the rule's answer, was wrong.
Lesson: verify historical open-task claims from event replay, not a later diagnosis snapshot. The rules
were not relaxed to hide that counterexample.

Proof of the implemented rules: 0 differences against an independent replay at all 199 backtest steps;
five checked live rounds across the two installs matched the independent empty count; no sends or writes.
The normal-path cost is under the plan's 200 ms main-thread bar at sealed p90 (165-172 ms), and live round 3
is 50 ms wall time. H-STALL-COST-1 and -2 retain their stricter misses and limitations above.

The final unchanged code landed as 122-1e8cb3: 456 unit files passed, 6,580 tests passed and 6 skipped,
plus protocol, PATCHES.md, typecheck, lint and formatting. An earlier land (121-b91ed9) failed only two
unrelated timing tests under load; Ops directed one sealed run of those two files (89/89 passed), then
an unchanged re-land. No timeout or threshold was loosened and no test was skipped for the re-land.
There are 31 stall-watch tests after the cost-reader and overview-choice cases. Tests use the repository's
`tests/unit/stall-watch.test.ts` convention rather than the initially proposed `server/` location; the
backtest uses `scripts/stall-backtest.mts`.

The exported `StallFinding`, `StallSettings`, `stallFindings` and `StallWatch` contract is unchanged for
Ops #284. Only dry logging is live. No delivery or escalation is enabled by this task.

Undo: a settings file with `{"mode":"off"}` stops the runner at its next round (or prevents start after a
restart). Otherwise revert the code and install through `pi-web-deploy`; no registry or queue data needs
undoing.
