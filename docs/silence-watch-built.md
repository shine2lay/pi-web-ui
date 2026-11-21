# silence watch, built (Ops #1059, step 2 of 2)

Part of [silence-watch.md](silence-watch.md) (the rule, H-SILENCE-1, the seam and the cases).

## What runs

- **Where.** Inside the stall watch's round (every `everyMin`, 10 minutes), after its registry read: no timer
  of its own. `server/silence-wake.ts` `SilenceWatch.round(read, now)`; wired in `startStallWatch`
  (`server/agent-service.ts`). Every round logs `silence: round: <n> waits examined, <m> due`.
- **Inputs, one reader each.** Waits: each role's home-chat queue records through the one queue mirror
  (`replayState`); the mirror now keeps a question's times (`server/task-queue-ask.ts`: `n`, `at`, `from`,
  `routedAt`, `step`, `parked`; never shown on the Queue panel). Turns: `TranscriptScans` keeps each chat's
  newest assistant time (`lastTurnAt`, from the line's first bytes). A block's checkpoint: `leadVerdict` of
  `server/queue-blocks.ts`. A task or queue the owner paused is not a wait.
- **Skips the round (finds nothing).** An incomplete registry read (the whole-list alarm covers it) or a home
  chat that can't be read (its turns would be missing, so a wake could be wrong). Logged as `silence: round
  skipped: <why>`.
- **Delivery.** `RoleMessages.requestStall` with items of kind `task` (rule `silent`), the stall ledger
  `~/.pi-web-ui/stall-watch.jsonl` (stretch `task:<queue>#<id>:silent:<start>`, step 1 lead, step 2 COO) and
  the stall watch's limits: paused role messages hold it (one `held` line), pi-queue `wakeOnDone` off records
  `wakes-off`, a role with no home chat `no-chat`, the per-recipient day cap and the hourly cap count it with
  the stall wakes (`capped`). A send whose ledger line was lost is found in the role messages and not sent again.
- **Wake text.** Lead: "Task <role> #<id> has waited <N> minutes on <what is owed> and this chat has not had a
  turn since. Decide it, or say who should." COO, 60 minutes later: the same facts plus "its lead has not acted
  for <N> minutes". What is owed is the question's number or the block's own `owes` words; never question text.
  The message hint (`server/stall-hints.ts`) says how to act; a reply to it is refused like a stall wake's.
  Never an owner wake.

## Off switch

`~/.pi-web-ui/silence-watch.json` `{"wakes": false}`: the watch still finds and logs (`silence: would wake
<role> about <task> (<step>, <N> min)`, once per wake), wakes nobody, writes no ledger line. Read every round,
no restart. An unreadable file also means log only (with the problem in the log). The stall watch's own `mode`
(`stall-watch.json`) still rules: `dry` or `off` means no silence wake either. Undo of the whole change:
`pi-web-deploy rollback`.

## Proofs

- Gate: `tests/unit/silence-watch.test.ts` (F0, S1-S12, 16 tests), `silence-wake.test.ts` (adapter, off switch,
  delivery limits, planted round), `roles-transcripts-last-turn.test.ts` (F3), `task-queue-ask-times.test.ts`
  (F1, both replays).
- Live replay, sealed, through `SilenceWatch` (`~/ops-checks/queue-hardening/silence-watch/`): rounds at each
  wait's start + 60 give exactly the five lead wakes of `replay_stalls.out`; a planted wait in a throwaway home
  chat gives one lead wake at + 60 and one COO wake at + 120.

## H-SILENCE-1: HIT

Replay parity is exact (5 lead wakes, same tasks, roles and minutes, 0 covered waits woken). Seen beside it,
at the server's real 10-minute cadence over the same days: 4 of the five (product #86 and ops #979 ended within
45 seconds of their + 60 mark, so no 10-minute round sees them open), plus ops #1014 two minutes after its
checkpoint with Architecture still silent (the rule: after the checkpoint the watch counts its own clock) and
one COO wake for backend #218 question 19 (07:40Z; its lead's first turn came at 09:02Z).
