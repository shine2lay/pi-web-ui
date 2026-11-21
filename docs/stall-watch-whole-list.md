# stall-watch: read the whole work registry, or raise the alarm (Q-STALL-1)

Ops #1055 (step 1 of 2), owner Shine 2026-11-21: queue hardening proposal approved (Show&Tell d_x5rdobqnby
v1, record dr-d99bc6d69ea1), set A + B+ at 60 minutes + D; this is A. Contract: Architecture rm-71a63c5b
(Q-STALL-1 in `~/architecture-dept/conventions/queue-resilience.md`). How the watch works is in
[stall-watch.md](stall-watch.md); this note covers only the registry reader and the alarm.

## H-STALL-WHOLE-1 (written before the change)

- **What's wrong, with evidence.** The stall watch has skipped every round since 2026-11-03. The registry
  holds 3,201 linked tasks (3,217 on 2026-11-21); the work page reads at most `WORK_PAGE_TASKS_MAX` = 2,000
  and then says "too-big". The 2,000th link was written 2026-11-03T18:48:15Z. The watch then logs
  "stall: round skipped (the registry is bigger than is read); last findings kept" once per restart: 69
  journal lines in 7 days, no alarm. The dead-end answer reads the same capped page, so a project whose tasks
  were linked after the 2,000th looks like it has no task at all.
- **The change.** One reader of the registry for the watches, `server/work-registry-reader.ts`, with no
  task-count ceiling. It returns a complete read or a typed incomplete one with its reason. A watch that gets
  an incomplete read sends one alarm through the owner alarm route the lane watchdog uses, in that same round,
  and shows no earlier findings as current. The dead-end answer on an incomplete read is "unknown".
  `WORK_PAGE_TASKS_MAX` stays only as a limit on what a page sends for display.
- **Expected result.** Zero skipped rounds. A round over the live registry (3,200+ links) completes. An
  unreadable line or a read error planted in a copy alarms within one round, once per condition, and again
  only after it recovered and broke again. A complete round records a heartbeat (time, tasks read).
- **What would prove it wrong.** Any round skipped without an alarm, or a dead-end answer of "moving" or
  "quiet" on a read that wasn't complete.

## The seam

`server/work-registry-reader.ts` (types and signatures; step 1's bodies are stubs that keep today's
behaviour, and nothing live calls them yet):

- `WorkRegistryReader.read(now)`: `RegistryComplete` (the replay, the extra times, `tasksRead`, bytes, time
  taken) or `RegistryIncomplete` (`reason`: unreadable-line or read-error, with a detail).
- `watchInputsOf(read, facts, leadUpdates, at)`: a round's inputs, with the read itself kept on them.
- `RegistryWatchHooks`: `alarm` (the lane watchdog's owner Telegram sender) and `heartbeat`.
- `registryIncompleteAlarm(watch, read)`: the alarm's text.

The stall watch, the dead-end answer and the later silence watch get registry tasks only through it.

## Acceptance cases

`tests/acceptance/stall-watch-whole-list.test.ts`, outside the land gate until step 2 builds it
(`npm run test:stall-watch-whole-list`):

- AC1: 3,500 links; a round completes and finds the stuck task that is link 3,400.
- AC2: an unreadable line, then a read error: one alarm each in the same round, none repeated while it
  lasts, no "round skipped; last findings kept", no earlier findings shown as current.
- AC3: dead-end on an incomplete read answers "unknown"; on a complete 3,500-link read it sees link 3,400.
- AC4: a complete round records a heartbeat; an incomplete one doesn't.
- AC5: the display page still sends at most 2,000 tasks, with the same fields.
- AC6: one reader: the stall watch and dead-end take registry tasks only through the new module.
- AC7: the reader's count equals an independent count; the real case runs on a copy with
  `scripts/registry-read.mts`.
