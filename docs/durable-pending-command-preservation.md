# Pre-initialization command preservation contract

Accountable: Ops. Module work: #577; socket/protocol/client integration: #570.

## Hypothesis H-PENDING-COMMAND-PRESERVATION-1

Evidence: the original `server/ws-pending-queue.ts` shifts away the oldest command
when its 256-entry buffer is full; `clear()` silently discards the rest. The
original `server/index.ts` calls `clear()` after initialization failure and socket
close, and ignores `push()`'s return value. Neither transport `ready` nor buffer
admission proves execution.

Change: add `RecoverablePendingCommandQueue` alongside the compatible legacy
`PendingCommandQueue`. Reject NEW overflow with a thrown, typed retryable error;
transfer the complete queued set on abandonment instead of clearing it. Keep the
256 default/ceiling and process-wide 60-second warning throttle. Do not change
engine, storage, host call sites, or protocol here.

Expected result: accepted objects retain their full content and FIFO order;
refused objects remain caller-owned; every buffered command moves exactly once
into a drain or abandonment result. No method executes or automatically retries a
command. Measure with synthetic exact-content/reference comparisons, boundary
cases, cleanup races, old-code red controls, and the unchanged sealed landing gate.

Falsifiers: accepted content/order disappears without an observable recoverable
transfer; a failure can be silently ignored as a return value; the existing bound
is bypassed; or an unwired module result is described as end-to-end preservation.

Result: **HIT at the module boundary** (31 new preservation regressions and 5
unchanged legacy tests pass). Full landing-gate result is recorded in the task's
normal landing receipt. This document is NOT an integrated/deployed preservation
claim.

## API and ownership

Import the additive API from `server/ws-pending-queue.ts`:

- `new RecoverablePendingCommandQueue(cap = MAX_PENDING_WS_MESSAGES)`: one queue
  per socket/attach attempt. `cap` must be an integer from 1 to 256; smaller values
  support tests, not a new production limit. Invalid capacities throw before use.
- `push(command): void`: normal return means only buffered, NOT processed or
  acknowledged. At capacity it throws `PendingCommandRejectedError` with
  `reason === "capacity"`, `retryable === true`, `status === "unprocessed"`, and
  `command` equal to the exact refused object. No accepted object is displaced.
  The queue retains no extra reference to refused objects; callers own recovery.
- `drain(): ClientMessage[]`: transfers the buffered objects in FIFO order and
  empties the buffer. This is an ownership handoff for dispatch, NOT evidence of
  processing. A repeat drain returns an empty array. The receiver owns every
  drained command, including any suffix not dispatched when a socket closes or
  initialization subsequently fails. No automatic replay occurs.
- `abandon(reason): PendingCommandAbandonment`: reasons are `"attach-failed"` and
  `"socket-closed"`. Returns `{ status: "unprocessed", reason, commands }`, where
  `commands` holds all remaining buffered objects in FIFO order. It permanently
  closes admission to that queue. Repeated/stale cleanup returns an empty set and
  retains the first abandonment reason. A late `push()` throws the same typed
  error with that terminal reason and the exact new command. Create a NEW queue
  for a new socket/attach attempt; never reset/reopen the abandoned one.
- `size` counts only buffered commands; `rejected` counts refused pushes. The safe
  queue has no `clear()` or silent discard method.

Methods are synchronous. In a drain/abandon race, the first call transfers the
current buffer; the second cannot transfer those commands again. A drain result
remains caller-owned even if later cleanup is empty. Queues do not detect command
mutation, deduplicate commands/IDs, dispatch, persist, acknowledge, or contact a
socket. Callers must not mutate accepted objects before handoff. Object identity
and attachment references are preserved; no attachment file is read here.

Admission failure is an exception rather than a boolean/result that an old-style
`push(command);` call could ignore. Catch `PendingCommandRejectedError` explicitly
BEFORE a generic handler-error catch. Its message/stack and queue warnings contain
no payload; its `command` getter is for recovery, not logging. Never log the error's
command, abandonment/drain objects, IDs, text, attachment paths, or raw frames.

## Required #570 hooks (not implemented by #577)

1. Replace the legacy queue construction/import in `server/index.ts`. Cover BOTH
   pending-admission branches: no `clientId`, and no session or `!attachDone`.
   Catch the typed refusal and map the exact command to a correlated retryable
   **not processed** outcome. Preserve client-owned unacknowledged work before
   sending. Do not return an ignored false/result or turn generic notice delivery
   into successful recovery. Each refusal must have an actual handling path.
2. On attach rejection/failure (including quiesce/close branches), call
   `abandon("attach-failed")` before returning. On socket close call
   `abandon("socket-closed")`. Handle every command in the returned set as
   unprocessed. Consume the returned set exactly once; repeated cleanup is empty.
   Do not retain unbounded extra rejected/abandoned buffers on the server.
3. Before dispatching a drain, ensure the socket/attach generation is still the
   active one. Keep ownership of the drained batch until handed to the real
   handler. If close/failure interrupts dispatch, explicitly recover the
   undispatched suffix; the empty queue cannot do that for the host. A thrown or
   asynchronous handler error after handoff is NOT proof the operation did not
   happen: reconcile with the actual operation's status/receipt mechanism.
4. On an OPEN socket, use #570's correlated protocol/client hooks to expose
   refusal/abandonment without claiming success. For prompts with IDs use the
   existing negative-ack/status semantics only when they truthfully describe the
   operation. Other operations need their own correlation/recovery design; this
   module invents no wire message, server ledger, or receipt.
5. **A closed socket cannot receive a notice.** Keep exact client-owned
   unacknowledged sends (including text, attachments and original correlation)
   through close/reload. On reconnect, reconcile them against authoritative
   operation-specific status before offering or performing a safe retry. Socket
   send success, `ready`, admission, drain, a snapshot count, or a missing notice
   is not execution/ack evidence. Unknown status is uncertainty, NOT success.
6. Never automatically replay a non-idempotent operation on uncertainty. Prompts
   may use only the existing verified ID/status deduplication contract; other
   mutations need authoritative reconciliation or explicit user recovery. The
   queue supplies exact content, not an exactly-once execution guarantee.
7. A stale attach completion must not drain/replay abandoned work; never set
   `attachDone` or dispatch after its socket/generation closed. Reconnecting uses
   a fresh queue; old cleanup must not affect it. Failed initialization cannot
   leave a half-ready socket silently accumulating new commands.

## Compatibility and release qualification

`PendingCommandQueue`, `warnPendingDrop`, `resetPendingDropWarn`, and the existing
constant names remain source/behavior compatible. The original host is deliberately
NOT switched here: its overflow still evicts oldest commands, and `clear()` still
silently drops them. Landing #577 alone does NOT fix those host paths. The additive
API makes that seam available without a thrown error escaping an unwired caller.
`PENDING_DROP_WARN_INTERVAL_MS` and `resetPendingDropWarn()` also govern the safe
queue's overflow warnings: both modes share the original process-wide throttle.

Before a preservation/release claim, #570 must prove actual socket capacity
refusal, attach failure, close before attach, late attach completion, interrupted
drain, and close/reconnect recovery with exact full content and order, including
attachment references and non-idempotent commands. Include dropped/undeliverable
notices, negative/unknown status, repeated cleanup, and no duplicate execution.
Keep existing rollback/no-data-loss gates. Module-only tests are not that proof.

## Verification record

Checked 2026-10-26, synthetic commands only: no real chats, model calls, attachment
reads, protocol changes, migration, or deployment.

- Unchanged baseline `5be6d044cf2698ae71293929441347da9f8ed593`: temporary independent
  controls exercised the existing `PendingCommandQueue` directly, alongside its
  existing tests. All 5 existing tests passed; all 4 preservation controls FAILED
  normally (no `it.fails`, skipped assertions, or ignored unrelated failures):
  overflow returned `[second, new]` instead of the exact `[first, second]` accepted
  batch; an unchecked overflow push did not throw; initialization-failure and
  socket-close `clear()` each returned `undefined` instead of the exact
  `{status: "unprocessed", reason, commands}` disposition. Fixtures included exact
  Unicode/combining text, CRLF/trailing spaces, IDs and attachment path references.
  The temporary control worktree is removed after the red run.
- Focused sealed check: 36/36 passed (31 new tests in
  `tests/unit/ws-pending-command-preservation.test.ts`, plus all 5 existing tests
  in `tests/unit/ws-pending-queue.test.ts`). New tests compare full values to
  independent snapshots AND original object identities; test cap-1/cap/cap+1 at
  capacities 1, 2 and 256; repeated overflow; mixed/non-idempotent commands and
  duplicate IDs; failed attach/close; both drain/abandon orders; terminal/repeated
  cleanup; stale-vs-fresh queues; invalid capacities/cleanup; ignored return-value
  misuse; failing logger; shared 60-second throttle and non-content diagnostics.
- `scripts/sealed.sh npm run build` and `scripts/sealed.sh npm run typecheck`
  passed. The normal detached `wt land` still requires the unchanged
  `scripts/check.sh --fast` full gate before landing; no bypass or timeout change.

Focused command (UTC, `VITEST_MAX_WORKERS=4`):

```sh
scripts/sealed.sh npm test -- tests/unit/ws-pending-queue.test.ts tests/unit/ws-pending-command-preservation.test.ts
```

These results establish module preservation/ownership behavior only. #570 still
owes all socket, correlated-outcome, client retention/status/reconnect and rollback
proof above before any end-to-end or deployed no-loss claim.
