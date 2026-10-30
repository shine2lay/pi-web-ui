# gate-time: the gate's tests decide pass/fail from something a busy machine doesn't change

Ops #639, 2026-10-29. On 2026-10-29 four Ops lands in a row (#631, #633, #635, #637) failed the gate and retried,
because tests decided pass/fail from wall-clock time while other lands shared the machine (load 80 to 115 on 20
cores). A gate that fails on a busy machine says nothing about whether the change is good.

## Hypothesis H-GATE-TIME-1

Every gate test that decides pass/fail from wall-clock time can decide from something load-independent instead (CPU
time of its own thread or process, a counted amount of work, or the event it waits for) without losing what it
protects; afterwards the full gate gives the same result quiet and at load 80+, and the changed tests still fail on
the defects they were written for.

Wrong if: a test only passes at load because it no longer checks its property (it must still fail on a broken copy
of the code it protects), or the gate still fails at load on a test that measures wall-clock.

## The rules the tests now follow

`tests/unit/load-independent.ts` holds them:

- `HANG_GUARD_MS` (5 minutes): the one wall-clock limit a test may have, a hang guard far past any test's run at
  load 100. `vitest.config.ts` makes it vitest's `testTimeout`, `hookTimeout` and `expect.poll` default;
  `tests/unit/setup-hang-guards.ts` makes it the default of `vi.waitFor`/`vi.waitUntil`. No test sets a smaller one.
  The tests' own waiting loops (plugin-host, mcp-bridge, mcp-hot-reload, task-chat-start, prompt-start-race,
  terminal-notices, terminal-view, decision-recovery) wait for their event with it as their only limit.
- `SOAK_HANG_GUARD_MS` (1 hour): the hang guard of a soak, a test that runs thousands of real store transactions
  and takes minutes on a quiet machine.
- `threadCpuMs()` / `processCpuMs()`: what a piece of work cost, not how long it waited for a core. A test's speed
  budget (durable-migrator, repair-linear, marker-service-incremental, usage-accounting-collector W0,
  usage-accounting-store W1) is checked on these. The usage store's worker fixture sets `performance.now` to its
  thread's CPU time, the H-W0-CLOCK-1 decision (Ops #538), because the store's index reads `performance.now()`
  directly.
- `loadSensitive(what)`: for a test, or the part of one, whose whole point is wall-clock latency (session-index's
  event-loop pause, conn-events' real-timer stall bounds, the usage collector's parent filesystem callback
  latency, plugin-proxy-close's 300 ms idle timeout against 100 ms keepalives). Above a 1-minute load equal to the machine's cores it prints why and skips those assertions; the rest
  of the test always runs.
- An order of events instead of a duration: eval-tool's timeout (the call comes back before the code's sleep is
  over, proved by a file the code writes only after it), task-chat-start's quick refusal (refused before the
  prompt finished).

## Found on the way

The usage store's index (`server/usage-accounting-store.ts`, `step()`) checks its 100 ms work slice on
`performance.now()`, so on a busy machine the live store refuses commits with `store-capacity`, the same wall-clock
fault Ops #538 fixed in the collector. The usage pass (`server/usage-accounting-pass.ts`, `openPassState()`) does the
same with its 2,000 ms work budget (`PASS_LIMITS.workMs`), whose default clock is `performance.now()`: on a busy
machine passes end partial and W5 reports stale. The pass fixture gives the pass `clock: threadCpuMs`, and the host
test's real pass worker gets a prelude setting `performance.now` to its thread CPU time. Both are product code,
outside a test-only change; reported to the Ops lead.

Fixed by Ops #643 (H-USAGE-CPU-CLOCK-1): both budgets now count the Worker thread's CPU time
(`server/thread-cpu-clock.ts` `threadCpuMs()`, the product twin of `tests/unit/load-independent.ts`'s, kept apart so a
test's yardstick is never the code under test). The index's 25 ms slice and 100 ms unit guard read it directly; the
pass's default `clock` is it. No wall-clock limit ends a healthy slice or pass; the host's 5-minute
no-finished-pass alarm stays the hang guard. The test-side clocks above are unchanged and now only repeat what the
product does. `tests/unit/usage-accounting-cpu-clock.test.ts` runs the same work quiet and on a simulated busy
machine (a twentieth of a core, in turns) and fails on the old code (the index refuses with `store-capacity`; the
pass reads nothing in most passes).

Inventory, before and after runs and the broken-copy proofs: `/home/shinelay/kept-from-tmp/2026-10-29/gate-time/`.
