# stall-watch: an owed drop alarm survives a restart (H-STALL-WHOLE-4)

Ops #1068. Closes QA's note N1 on Ops #1065 (qa rm-827d3912, case L10). Builds on the drop-to-none alarm
(H-STALL-WHOLE-3) in [stall-watch-registry-missing.md](stall-watch-registry-missing.md); the owner's
approval is the same (record dr-d99bc6d69ea1; Q-STALL-1).

## Hypothesis (written before the change)

- **What's wrong, with evidence.** QA's check of #1065 (case L10): when the drop alarm's send fails, the
  same process tries again at the next read, but that round still rewrites the heartbeat to 0. A restart
  before a send succeeds starts from "0 tasks known" and never tries again (0 sends after the restart). An
  alarm about possibly lost data is dropped by one failed send plus a restart.
- **The change.** One rule: while the drop alarm is owed (its last send surely failed), the round does not
  rewrite the heartbeat; the last good heartbeat (count above 0) stays on disk. Once a send succeeds (or may
  have gone out), the heartbeat is written as before.
- **Expected result.** Four new cases in `tests/unit/work-registry-emptied.test.ts` (N1a-N1d): a-c red
  before, green after; d (first send works) green both sides. A failed send keeps the old count on disk
  round after round; a restart then sends the alarm exactly once and the heartbeat goes to 0. Cases a-i and
  the #1064 cases stay green, unchanged. Live: the next round reads all ~3,2xx tasks with 0 alarms.
- **What would prove it wrong.** A heartbeat of 0 on disk while the alarm is owed; no alarm, or two, after
  the restart; a heartbeat not written after a successful send; an existing case going red; or the live
  round after install not complete or not writing its heartbeat.

## The rule as built

`server/work-registry-drop.ts` knows whether the alarm is owed (`owed()`); the heartbeat writer that
`registryWatchOf` in `server/work-registry-reader.ts` gives the stall watch asks it before writing.

- While the drop alarm is owed (its last send surely failed: an error, or no owner alarm route yet), the
  round doesn't rewrite the heartbeat. The log says "stall: heartbeat kept at N linked tasks: the
  drop-to-none owner alarm is still owed", and the last good heartbeat (count N above 0) stays on disk.
- A restart while it is owed: the new reader sees N in the heartbeat and an empty file, and sends the alarm
  (the H-STALL-WHOLE-3 restart rule). It is never dropped by a failed send plus a restart.
- Once a send succeeds, or may have gone out (not sent again, as before), the heartbeat is written as
  before (0 tasks) and nothing repeats. Tasks coming back, or the way back after "missing", end the owed
  state too, and the heartbeat is written with the new count.
- "Not sent" means what it means for the incomplete-read alarm: any answer that is not ok and not "may
  have gone out" is tried again. With the stall watch off (`stall-watch.json` mode off) no round runs, so no
  heartbeat is written either way, as for the incomplete-read alarm.

**Accepted consequence.** While sends keep failing, the heartbeat's time goes stale, so the scheduled-jobs
silence row for the stall watch raises its own alarm once the heartbeat is older than its allowed age. That
is a second, independent signal, and it is wanted.
