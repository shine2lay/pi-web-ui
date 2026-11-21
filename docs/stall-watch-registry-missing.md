# stall-watch: a missing or shrinking registry is an incomplete read (Q-STALL-1)

Ops #1064. Closes QA's final check of the queue hardening set: qa #218 (rm-b55ed8eb), defect D1 and its
sibling O1. Part of the reader's rules in [stall-watch-whole-list.md](stall-watch-whole-list.md); the owner's
approval is the same (record dr-d99bc6d69ea1; Q-STALL-1: never report from a partial list).

## H-STALL-WHOLE-2 (written before the change)

- **What's wrong, with evidence.** `server/work-registry-reader.ts` turned a missing registry file (ENOENT)
  into a complete, empty read: `complete: true`, `tasksRead: 0`. So if the file is moved, deleted or the work
  folder setting changes, the stall watch logs "round complete: 0 linked tasks read, 0 findings", sends no
  owner alarm, writes a healthy heartbeat, and the dead-end answer says "quiet". QA reproduced it (qa #218 D1).
  The live heartbeat (`~/.pi-web-ui/stall-watch-heartbeat.json`) says 3,225 tasks, so a missing file there
  can only mean the watch went blind. Second finding (O1): a file truncated while it is read ends the read
  early and still counts as complete.
- **The change.** Two rules in the one reader, nothing in the watches:
  - D1: a missing file is complete and empty only when nothing says the registry ever had tasks (this
    reader had no complete read with tasks in this process, and the heartbeat file is absent or says 0).
    Otherwise it is incomplete with the new reason `missing`, naming where the file was expected and the
    last known count. A heartbeat file that can't be read can't prove a new machine: incomplete too.
  - O1: a read is complete only if it read at least the file's size at open, and the size after the read is
    at least what was read. Appends during a read stay complete.
- **Expected result.** Cases a-h in `tests/unit/work-registry-missing.test.ts` red before, green after: a
  registry that had tasks and is now missing gives one owner alarm, no findings, dead-end "unknown", no new
  heartbeat, in the same process and after a restart; a machine that never had a registry stays quiet; a
  shrinking file is incomplete. Live: the next round still reads all ~3,2xx tasks with 0 alarms.
- **What would prove it wrong.** A missing registry with a heartbeat over 0 that gives a complete read or
  no alarm; a new machine (no file, no heartbeat) that alarms; an append during a read reported incomplete;
  or the live round after install not complete.

## H-STALL-WHOLE-3: a list emptied in place (Ops #1065, written before the change)

- **What's wrong, with evidence.** QA's re-check of #1064 (qa rm-18025036, case L6, finding O9): if the
  registry file is still there but was emptied to 0 bytes between two rounds, the read is "complete, 0
  tasks": no owner alarm, dead-end "quiet", and the heartbeat is rewritten to 0, so a later missing file
  reads as a new machine. A list that goes from thousands of tasks to none is a deliberate reset or lost
  data; either way the owner should hear it once.
- **The change.** One rule in the reader: a complete read with 0 linked tasks, when the last known count was
  above 0 (this reader's last complete read in this process, else the heartbeat file), sends one owner
  alarm through the same route as the incomplete-read alarm, and waits for it before the round goes on to
  rewrite the heartbeat. The read stays complete.
- **Expected result.** Cases a-f in `tests/unit/work-registry-emptied.test.ts` red before, green after: one
  alarm naming the old count, in the same process and after a restart, then quiet; a new machine, 0 -> 0
  and a drop to a smaller non-zero count stay quiet; tasks coming back and emptied again alarm again. The
  #1064 cases stay green, unchanged. Live: the next round still reads all ~3,2xx tasks with 0 alarms.
- **What would prove it wrong.** A drop to none with no alarm or with two; an alarm on a new machine, on
  0 -> 0 or on a smaller non-zero count; an emptied read that turns incomplete or writes no heartbeat; a
  #1064 case going red; or the live round after install not complete.

## The rule as built (H-STALL-WHOLE-3)

`server/work-registry-drop.ts`, owned by the reader and reached through `registryWatchOf(dataDir, file,
{ alarm })`, which also gives the stall watch its `alarm` and `heartbeat` hooks (one route).

- A complete read with 0 linked tasks, when the last known count was above 0, sends one owner alarm: "The
  work list went from N linked tasks (last complete read at <time>) to none. If that was a deliberate
  reset, nothing is needed. If not, restore <registry file> from the backup. The stuck-work watch keeps
  running. This alarm comes once." The last known count is this reader's last complete read in this
  process, else the heartbeat file (`readRegistryHeartbeat`; one that can't be read shows no drop).
- The read stays complete: findings, the dead-end answer and the heartbeat (rewritten with 0) are as
  before. The alarm is awaited inside the read, so it goes out before the heartbeat says 0; a crash in
  between leaves it owed. A send that surely failed is tried again at the next read (H-STALL-WHOLE-4 below).
- Any drop to exactly 0 counts; a smaller non-zero count doesn't. 0 -> 0, a new machine and tasks coming
  back are quiet. Two reads at once send it once.
- One exception, so #1064's way back holds: right after a "missing" read (the owner had that alarm), a file
  put back, even empty, is the way back, not a second drop (case h).

**Accepted consequence (QA L6).** After a drop to none the heartbeat says 0, so a later missing file reads
as a new machine and stays quiet (case f), in the same process and after a restart. The owner was already
told once, at the drop.

**Way back to healthy.** After a deliberate move or reset, put a file at the configured registry path
(`~/.pi/agent/work/events.jsonl` unless the work-folder setting says otherwise), even an empty one: the
next round reads it complete and the "missing" state ends. Removing or editing the heartbeat file is not
the way and is not needed.

**A failed send (H-STALL-WHOLE-4, Ops #1068).** While the drop alarm is owed, the heartbeat keeps the old
count, so a restart still sends it: [stall-watch-drop-owed.md](stall-watch-drop-owed.md).

## Not changed

QA's notes O3-O7 stay as they are (lead's call); O2 is with Architecture; O8 is older. QA's repro as written
(a never-written file, a brand-new reader, no heartbeat) is the new-machine case and stays quiet by design.
