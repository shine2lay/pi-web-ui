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

## Not changed

QA's notes O3-O7 stay as they are (lead's call); O2 is with Architecture; O8 is older. QA's repro as written
(a never-written file, a brand-new reader, no heartbeat) is the new-machine case and stays quiet by design.
