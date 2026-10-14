# Role mail before restart carry-on (Ops #176)

H-MAIL-2 fixes startup ordering only. Busy mail still uses #156's `role-mail-boundary.ts` FIFO at a completed-run boundary; nothing is inserted into a running run and FYIs are not running-turn context notes.

## Why

After the Oct 13 20:08 restart, reopening Ops took about three minutes. Carry-on began before the mail poll could admit its waiting message. That message then waited out a 19.8-minute carry-on run, reaching Ops 22.6 minutes after restart. The same order recurred at 21:13.

## Startup handoff

1. The persisted mail store loads as before. The server defers general delivery until `startRoleMessages()`, preventing an early send/kick from racing the startup handoff. This is not a store pause or an Owner hold; accepted sends are still recorded.
2. Carry-on retains its original plan, paused-task check, target reopen, prompt, deadline and gate. Once each target is open, `RoleMessages.beforeResume()` selects only that target's waiting records, oldest first.
3. Each selected record passes the original `step()` route, transcript proof, pause, retry, in-flight, cap and give-up checks. Startup delivery uses public `AgentSession.followUp()` and the same no-turn note adapter. The client keeps the normal accepted role/Owner provenance in the pending turn record.
4. The existing boundary FIFO is attached to the imminent native prompt as one batch, ahead of its unchanged carry-on input. Native SDK message events persist both user mail and custom FYIs. This is only done if the runtime is still idle; a running runtime retains ordinary boundary buffering.
5. The temporary prompt arm restores itself after its first use, on admission failure, or when carry-on's existing start wait ends. General mail and guard startup remain in their original order afterward. A transcript header, not admission success, still proves delivery. Restart retries use the original persisted store and transcript scan, not a new acknowledgement store.

No SDK edit, model probe, guard policy, approval ladder, cap, Owner hold, task pause, give-up deadline, Telegram path or history migration is part of this patch. Other carry-on callers do not arm this handoff.

## Fixed stages

`tests/unit/role-mail-restart.test.ts` uses synthetic transcripts, a three-minute fake reopen, a fake clock and local public SDK hooks. Its stream function throws if invoked; no provider request is made or inspected.

- 1–3 waiting question/request/FYI records: old code lands them only after the fake twenty-minute carry-on ends; new code lands the ordered batch once with native resume input, inside five minutes.
- No waiting mail; unrelated target; Owner-held store across restart; paused task and its no-turn delivery; unchanged 24-hour give-up; second restart after transcript commit but before acknowledgement; later mail withheld throughout a running run and tool continuation.
- Old proof: run the interrupted-chat cases on the unchanged base normally (failure), then with `ROLE_MAIL_RESTART_OLD=1` (three passes proving the old late order). That flag is an old-code assertion mode, never a production option or a passing new-code gate.
- Run new stages twice. Existing busy/boundary/message/report/reply/guard suites and the full sealed gate must also pass.

## Live proof and undo

Live observation is passive metadata only: waiting ids, server-up/admission/delivery times, carry-on start/end, states and duplicate header counts. No synthetic message or Telegram send. A zero-sample restart is not a live HIT. A slow delivery, late arrival, duplicate, loss or running-run insertion is a MISS and requires a fresh written hypothesis, not silent scope growth.

Task #176 must not install before #150's heap window ends (about 2026-10-14 04:11 PDT), unless #150 completes earlier. Use the normal installer and its result receipt; reconcile any red check honestly.

Undo: revert the one labelled patch in a fresh worktree, land and use `pi-web-deploy`. No transcript or mail-store rollback, migration or replay.
