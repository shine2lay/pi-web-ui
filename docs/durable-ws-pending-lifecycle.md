# Pending WebSocket command lifecycle contract

Accountable lead: Ops. Module/tests/contract: #580. Host/socket/protocol/client
integration, recovery delivery and release qualification: #570. Browser durable
retention/reconciliation: #579. This additive module is not wired or deployed.

## Hypothesis H-PENDING-LIFECYCLE-1

Evidence on base `f70eb359f9a9d14d9ee0e9baed5d896de2fd8acc` (includes #577
`429ec0ff6560fc60c1cb2ffc86df52e23429dcb6`):

- `server/index.ts:2598-2607` has separate no-client and no-session/not-attached
  admissions, inside a generic error-reporting wrapper.
- `server/index.ts:4278-4280` sets `attachDone` and drains into an untracked local
  loop. A drained command/suffix is no longer held by the queue.
- `server/index.ts:4283-4326` treats quiesce and ordinary initialization failure
  separately; ordinary failure clears pending work. The plugin success/fallback
  paths both call the same replay function.
- `server/index.ts:4333-4338` closes/clears the socket queue. A notice cannot prove
  a closed socket received recovery. Existing closed checks are not an ownership
  ledger for a local drain or a generation replacement.
- #577's `RecoverablePendingCommandQueue` safely refuses/abandons its own buffer,
  but deliberately does not capture immutable content, correlate, dispatch, or
  account for a drained suffix.

Change: add one finite, generation-bound lifecycle around the existing safe queue.
Capture immutable command content and supplied correlation at admission. Drain only
into lifecycle ownership; record dispatch-start before invoking external code.
Transfer never-started suffixes as unprocessed and all started work as uncertain,
exactly once, including reentrant close and late completion. Never replay.

Expected: fixed input arrays account for each admitted entry exactly once across
helper-held undispatched work, an active dispatch, and caller-owned dispositions.
Full text/attachments/correlation and FIFO survive close/failure/capacity; stale or
duplicate callbacks do not dispatch or hand off again. Total helper-owned entries
never exceed the existing capacity (default/ceiling 256); no dispatch history is
retained. Buffering/handler return never become persistence or deletion evidence.

Wrong if: any accepted entry disappears, changes, crosses generations, receives a
second destructive handoff/dispatch, or an untouched suffix becomes uncertain;
started work becomes definitely unprocessed; close allows stale completion to
reopen admission; capacity evicts an accepted entry; any result authorizes client
copy deletion or automatic replay. Module-only success is not host recovery proof.

Result: **HIT at the module boundary** on 2026-10-26. All 58 new regressions,
94 focused regressions including #577/legacy compatibility, build/typecheck and
the unchanged sealed full gate pass. The same five thin-consumer preservation
assertions genuinely fail against legacy behavior. No assertion, timeout, gate or
existing file was weakened. This does not qualify the still-unwired host.

## Exact API

Import from `server/ws-pending-lifecycle.ts`. All generation arguments are exact
caller-supplied strings; one instance represents one socket/attach generation.

```ts
new PendingCommandLifecycle(generation: string, cap = 256)

admit(command: ClientMessage, correlation: PendingCommandCorrelation): PendingLifecycleBuffered
attachSucceeded(generation: string): { kind: "attached"; pendingCount: number } | PendingLifecycleIgnored

dispatchNext(
  generation: string,
  handler: (entry: PendingLifecycleEntry) => void | Promise<void>,
): Promise<PendingLifecycleHandoff | PendingLifecycleIgnored>

attachFailed(generation: string): PendingLifecycleHandoff | PendingLifecycleIgnored
socketClosed(generation: string): PendingLifecycleHandoff | PendingLifecycleIgnored
supersede(generation: string): PendingLifecycleHandoff | PendingLifecycleIgnored
```

`generation` and `cap` are read-only getters. `state` is a frozen, payload-free
accounting snapshot: `{ phase, terminalReason, buffered, undispatched, dispatching,
held }`. `phase` is `attaching | attached | terminal`; `held` counts undispatched
plus the single not-yet-transferred active dispatch. It is not an execution or
persistence status query. There is no reset, clear, public drain or retry method.

### Entry, acceptance and refusal

`PendingCommandCorrelation` requires exactly the supplied values:

```ts
{
  sessionId: string | null;
  requestId: string | null;
  connectionGeneration: string;
}
```

`null` means unknown. Empty strings are preserved, not normalized. IDs/session are
never extracted from command text, `id`, `forSession`, the currently open chat or
an attachment. Identical command IDs/text are not deduplicated by this helper.
Generation is a fence, not persistence proof or a newly fabricated request ID.

`PendingLifecycleEntry` is `{ command: ClientMessage, correlation }`. Admission
clones the entire parsed-JSON command and recursively freezes it; correlation and
entry are frozen too. Full Unicode, line endings, nested attachments and optional
fields remain intact, independently of later mutations of the supplied objects.
The helper accepts protocol data, not arbitrary mutable JavaScript objects. This
is a parsed-command content snapshot, **not a claim to retain raw WS frame bytes**;
#579 separately retains the exact outbound string/full discriminated client work.

Normal `admit` returns `{ kind: "buffered", entry, persistence: "unknown",
releaseClientCopy: false }`. The entry reference is for correlation only: the
lifecycle still owns buffering. The input remains caller-owned until that return.

- `PendingLifecycleRejectedError.disposition` returns the exact frozen refused
  entry as `unprocessed`, never evicting accepted entries. Reasons are `capacity`,
  `stale-generation`, `attach-complete`, or the already-recorded terminal reason.
  The payload is private-backed, not in ordinary error serialization/inspection.
- `PendingLifecycleCaptureError` means cloning/freezing failed **before admission**.
  Its private-backed `command` getter returns the original input, and `correlation`
  returns the captured supplied correlation. It exposes `status: "unprocessed"`,
  `retryable: true`, `persistence: "unknown"`, `releaseClientCopy: false`. The
  original remains caller-owned; no immutable capture was promised. Do not send
  this error to generic logging or forget its original.
- Missing/invalid correlation fails before admission with `TypeError`. Supply
  strings/null explicitly and retain the original; do not invent missing proof.

Only pre-attach admission is allowed. Once attach succeeds, existing accepted work
forms one sealed finite batch. Later live commands belong to the host's normal
live path; a late missing-session admission is explicitly `attach-complete`, not
silently added to a second queue. `RecoverablePendingCommandQueue` enforces its
unchanged 1..256 capacity, reject-new behavior, shared 60s payload-free warning and
broken-logger protection. There is no new content-size limit, quota, or retained
rejected/dispatched history. Caller-owned recovery also needs a real ownership
path; retaining it in an unbounded new array is not the integration contract.

### Attach, dispatch and one-time handoff

`attachSucceeded` seals admission and drains the core queue **into lifecycle
ownership**, without calling external code or returning the batch. Only its first
`kind: "attached"` result can start the host's driver. Duplicate attach/plugin
success/fallback completions are ignored and cannot replace a partial batch.

`dispatchNext` moves the next FIFO entry to active/dispatch-started **before**
invoking the callback, then awaits its void/Promise return. During that interval a
second call is `ignored/dispatch-in-progress`, not a second dispatch. The callback
must perform the actual dispatch, not return a thunk. No automatic replay occurs.

Every `PendingLifecycleHandoff` is:

```ts
{
  kind: "handoff";
  dispositions: readonly PendingLifecycleDisposition[];
  persistence: "unknown";
  releaseClientCopy: false;
}
```

Each frozen disposition also carries `persistence: "unknown"` and
`releaseClientCopy: false`, plus the full exact frozen `entry`:

| Status | retryable | Meaning / reason |
| --- | --- | --- |
| `unprocessed` | `true` | Helper never began this entry's handler. Admission refusal or terminal untouched suffix. |
| `uncertain` | `false` | Handler entry began. `handler-returned`, `dispatch-threw`, or the terminal event that won the handoff. |

`retryable` describes nonprocessing certainty, **not automatic replay permission**.
Even a callback that throws before its first observable side effect has crossed the
boundary and is conservatively uncertain. Normal return, promise resolution,
exception text, send completion, ready/attach success or a callback's own invented
`persisted` field is not authoritative persistence evidence. The callback result
is deliberately ignored. No result allows releasing a client copy.

`attachFailed`, `socketClosed` and `supersede` are synchronous terminal transitions:

1. Fence admission and all subsequent attach/dispatch calls.
2. Transfer the active entry, if any, as uncertain.
3. Transfer every untouched core/batch entry in FIFO order as unprocessed.
4. Remove helper-held references only as part of that returned ownership transfer.

Terminal reasons are `attach-failed`, `socket-closed`, `generation-replaced` and
`dispatch-threw`. A callback exception terminally transfers active uncertainty plus
the complete untouched suffix. If close/failure/replacement already transferred
that active entry, late return/rejection yields `ignored/already-transferred`, not
a second handoff. Duplicate terminal events yield `ignored/terminal`, with no
payload. Empty first terminal handoffs are still valid transitions.

Previously returned uncertainty is **already caller-owned** and is not returned
again at close. The helper is not a history store. A handler that never settles
may retain its one invocation's call stack; close still hands off active/suffix
immediately without waiting or automatically invoking any further handler.

`PendingLifecycleIgnored` is `{ kind: "ignored", reason }`, with reasons
`stale-generation | terminal | attach-complete | attach-pending |
dispatch-in-progress | empty | already-transferred`. It contains no command,
acknowledgement or recovery transfer. A wrong generation cannot mutate current
state or dispatch its commands. On replacement the host **must supersede the old
instance before publishing the new one**; no helper can infer a global current
socket. Capture instance/token in asynchronous callbacks, never read a new current
token to authorize an old completion. Ignore and separately detach a stale attach
session using the actual host's attach ownership rules.

## Mandatory #570 integration checklist (not done by #580)

Base source line numbers move as #570 edits shared files; these are source patterns,
not a claim that the current host is wired.

1. Replace the per-socket `PendingCommandQueue` construction with one lifecycle
   bound to that connection's actual supplied generation. No second recovery
   queue, invented session/request ID or unbounded dispatched list.
2. In **both** `!clientId` and `!session || !attachDone` branches, call `admit` with
   the original parsed command and exact correlation. Catch lifecycle rejection
   and capture errors before the generic crash wrapper. Consume the full original
   disposition; a generic `error` frame is not recoverable delivery proof.
3. At successful attach/plugin initialization and the existing plugin fallback,
   use `attachSucceeded(capturedGeneration)`. Set `attachDone`/start the driver only
   for `attached`, never a duplicate/terminal/stale result. Never dispatch a raw
   `pending.drain()` batch or start a second fallback replay.
4. Drive FIFO through `await dispatchNext(capturedGeneration, actualDispatch)`;
   consume every handoff, including uncertainty on normal handler return. Use the
   actual guarded dispatch rather than pretend that successful invocation saved
   transcript state. Do not put handed-off entries into an automatic retry loop.
5. At ordinary attach failure, quiesce failure/close and the socket close handler,
   terminally consume `attachFailed`/`socketClosed` results **even when the socket
   cannot send**. Include both active uncertainty and the unstarted suffix. The
   winning terminal result owns the transfer; duplicate paths cannot transfer it
   destructively again. A sent outcome or returned error is not a receipt.
6. On generation replacement, supersede the old instance before installing the
   new one. Capture/fence all attach/ensureLoaded success/fallback callbacks;
   detach a stale returned session without disturbing the new generation's
   session. The helper fences commands, not SDK session attachment ownership.
7. Retain original client content through disconnect/reload using #579. Connect
   exact owner/session/ID/full-work proof and the actual persistence verifier;
   missing/negative/text-only/uncertain evidence never releases content. Server
   helper states cannot alone authorize deletion, synthesize persisted acks or
   prove the closed socket received recovery. Process loss remains a separate
   client/durable-storage concern.
8. Prove actual host/socket/client integration and release independently. These
   module tests and typed results do not qualify live end-to-end preservation.

## Verification record

All fixtures are synthetic, deterministic protocol commands; no model calls,
real-chat reads, live socket experiment, storage write, release or deployment.

- The dedicated suite covers empty/FIFO, both admission patterns, default and
  boundary capacities, warning/throwing logger, immutable full content and exact
  correlation, heterogeneous non-idempotent commands, attach/failure/close,
  duplicate events, old/new generations, every drain-to-next-dispatch boundary,
  reentrant terminal events, await/late settle, throw-before/after possible
  acceptance, exact untouched suffix, and no fabricated persistence/replay.
- The same five `thin consumer preservation contract` assertions run normally
  against the lifecycle adapter. With
  `WS_PENDING_LIFECYCLE_LEGACY_CONTROL=1` they run against the real legacy queue
  behind a complete test-driver API: push eviction, clear on close/failure and a
  consumer-local `drain()` loop. Expected red is **behavioral** lost ownership or
  stale suffix dispatch, not missing methods, imports or an invented receipt.
- Exact command/correlation equality, unique entry identity and
  `helperHeld + handedOff = admitted` are asserted across fixed input arrays.

Finished-implementation runs, before landing:

| Check | Result |
| --- | --- |
| Sealed focused lifecycle + #577 + existing queue suites | PASS: 3 files, 94 tests (58 + 31 + 5), no skips. |
| Sealed legacy thin-consumer controls | Expected exit 1: all five contract assertions fail behaviorally; 53 unrelated tests filtered out. No missing/import/API failure. |
| Sealed `npm run build` | PASS: web, server and vendor/runtime outputs. |
| Sealed `npm run typecheck` | PASS: server, web, tests, desktop, extension. |
| Unchanged `VITEST_MAX_WORKERS=4 TZ=UTC scripts/check.sh` | PASS: 512 files, 8,530 tests; 16 existing skips. Includes protocol/PATCHES, typecheck, lint, whole-tree formatting, build and both real-PTY suites (upstream suite 74 checks). |
| Final staged scope / whitespace | Only the three new module/test/contract files; no shared wiring, existing test, queue core, config/package/lock or gate changes. |

The full gate uses the unchanged sealed temporary HOME/environment and unreachable
stand-in model. It reports no live-data fence hit; no model call or deployment is
part of these checks. Unit tests took 276.61s; normal nonfatal lint/bundle warnings
were not suppressed. Sealed focused/control commands:

```sh
scripts/sealed.sh env VITEST_MAX_WORKERS=4 npm test -- tests/unit/ws-pending-lifecycle.test.ts tests/unit/ws-pending-command-preservation.test.ts tests/unit/ws-pending-queue.test.ts
scripts/sealed.sh env WS_PENDING_LIFECYCLE_LEGACY_CONTROL=1 npm test -- tests/unit/ws-pending-lifecycle.test.ts -t 'thin consumer preservation contract'
```

Landing uses normal detached `wt land`; its checked immutable pin and receipt are
handed to #570 separately, so this file does not predict its own commit. No deploy
or activation is authorized. Before integration, rollback is a normal revert of
these three unused files. Once callers are integrated, #570 must coordinate the
matching caller/adapter/client rollback; removing the helper alone is not safe.
