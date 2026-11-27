# §4g host recovery admission

## Hypothesis and result

Before implementation: an interrupted native edit batch can leave half a tool pair in canonical history. Public writable SessionManager, AgentSession.refreshContext and awaited public request/next-turn hooks appeared sufficient to recover before provider admission. Falsifiers: any transport call while held, stale finalized projection, duplicate native operations, or extra native messages contaminating a frozen batch.

**First candidate: MISS.** Throwing from prepareRequest/prepareNextTurnWithContext enters Agent.handleRunFailure, which emits an assistant error through message_end; AgentSession persists it. The isolated actual-SDK test reproduced zero transport calls but an extra native error. Those wrappers were removed, not retained as fallback code.

**Revised candidate: HIT for the tested scope.** Recover outside the Agent run at session.prompt, agent.prompt and agent.continue. Recover after the original public finishTurn has awaited addon turn_end and committed its native boundary drafts. On a held boundary, call public session.abort without awaiting its idle promise, then return action:end. This suppresses post-run compaction/settle and overrides continuation without injecting an error. Successful recovery invokes public refreshContext before release. No private SDK APIs or second projection/parser.

## Shared capability

`server/raw-run-recovery-host.ts` exports `installRawRunRecoveryHost(session)` and `RAW_RUN_RECOVERY_HOST = Symbol.for('pi-web.raw-run-recovery.v1')`.

The global symbol holds a WeakMap keyed by the public readonly session-manager identity. Its value has `register(factory)`. The factory receives only `sessionId`, `leafId`, `projection`, `branch`, required canonical `entry(id)` and guarded `append`, and returns `recover(): Promise<{held:boolean}>`. Append is legal only while the host is awaiting recovery. Drafts are restricted to null context edits, openviking.raw-run.operation custom records, and openviking.archive custom messages. The coordinator remains responsible for immutable plan, ownership, receipt and operation validation.

Registration failure poisons admission until valid registration. Without a registered factory, ANY canonical native custom entry named openviking.raw-run.operation requires the coordinator and holds admission with E_RAW_RUN_RECOVERY_UNAVAILABLE. The host does not interpret completion, operation phase, or journal contents. Unmarked sessions preserve existing behavior. A journal-only plan without native operations is not declared completed: absent-addon admission has no partial native pair to repair; normal registration later reconciles it.

Addon turn_end freezes the plan using the fresh canonical projection, without mutable SDK access. The host finishTurn wrapper applies/reconciles it after the original SDK boundary finishes. Existing prefix-v2 and native boundary drafts are not rewritten. Concurrent drafts that invalidate the frozen predecessor cause a safe hold, not re-planning.

## Placement and SDK entry-path evidence

The common user/subagent runtime factory installs the capability immediately after createAgentSessionFromServices and before extension binding/session_start. The additive agent-service change is two lines. Independent in-memory model utilities are not user-session restoration paths.

SDK 1.5.2 agent-session.js calls agent.prompt at line 1513 and agent.continue at 1518/1525 for post-run and before-settle continuations. Public abort at 2073 sets the run-abort flag synchronously before waiting for idle. The host never awaits that idle promise inside finishTurn. Current SDK Agent.handleRunFailure (agent.js 368 onward) explains why the rejected in-loop-hook candidate was unsafe.

## Proof

- Web full typecheck and focused Vitest host tests: admission ordering, guarded writes, held-boundary end, native marker with missing coordinator, and no-addon/idempotent behavior.
- OV external helper: tests/helpers/raw-run-host-startup.ts, invoked by the unchanged actual-AgentSession acceptance assertion. Default host root is this worktree; PI_WEB_4G_HOST_ROOT can select the integrated checkout.
- Actual SDK and extension runner use isolated temporary durable sessions, inline external test extensions and fake authentication/transport. Transport is a counter; no request payload is inspected or emitted.
- Crash after hiding a tool call but before hiding its result; reopen; unavailable receipt holds at zero calls; repair admits exactly one call. Protected hashes and exactly-once operations/references remain intact.
- Real turn_end freezes a second plan; half-pair crash overrides an explicit continuation decision. No second transport and no synthetic error. A refused outer continue adds zero native entries. Receipt restoration repairs the same pair before the next request.
- Missing factory on marked reopen: zero provider calls and zero new native entries. Unmarked no-addon session still admits normally.
- At each transport admission the finalized Agent state equals the same canonical SDK projection (boolean equality assertion; no payload printing).
- Foreign null edit and conflicting ownership record hold. Valid legacy-v2 journal is refused byte-identically by the v3 coordinator; this is not a claim that v3 performs legacy recovery.
- Full OV acceptance: 5 passed, zero failed/skipped. Largest-real-case convergence and parent addon/writer integration remain separate proofs; this helper does not claim them.

No deployment, landing, live-session edits, runtime fixtures or model-payload logging.
