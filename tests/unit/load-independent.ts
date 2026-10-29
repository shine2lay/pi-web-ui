// Ops #639 (H-GATE-TIME-1, docs/gate-time.md): the gate's tests decide pass/fail from something a busy machine
// doesn't change. A wall-clock budget fails whenever other work shares the CPU, so it tells nobody whether the
// change is good. These helpers are the load-independent clocks the tests use instead, and the one way a test
// whose whole point is wall-clock latency may still run: marked load-sensitive, skipped with a printed reason
// when the machine is busier than it has cores.
import { availableParallelism, loadavg } from "node:os";

/** The one wall-clock limit a test may have: a hang guard, far past any test's run at load 100, never a verdict on
 *  speed (vitest.config.ts testTimeout/hookTimeout/expect.poll, vi.waitFor/vi.waitUntil, the tests' own waits). */
export const HANG_GUARD_MS = 300_000;

/** The hang guard of a soak (thousands of real store transactions in one test): it takes minutes on a quiet
 *  machine, so only an hour says it hangs rather than shares the CPU. */
export const SOAK_HANG_GUARD_MS = 3_600_000;

/** CPU time (user + system, ms) of this whole process, all its threads: what a piece of work cost, not how long
 *  it waited for a core. Use it around async work, whose parts may run on libuv's or V8's threads. */
export function processCpuMs(): number {
	const { user, system } = process.cpuUsage();
	return (user + system) / 1000;
}

/** CPU time (user + system, ms) of the calling thread only: for synchronous work, and for code running in a
 *  worker thread (it doesn't count the other threads). */
export function threadCpuMs(): number {
	const { user, system } = process.threadCpuUsage();
	return (user + system) / 1000;
}

/** Above this 1-minute load the machine has more runnable work than cores, and a wall-clock latency measured
 *  here says more about the other work than about the code under test. */
export const LOAD_SENSITIVE_MAX_LOAD = availableParallelism();

/** For a test (or the part of one) whose whole point is wall-clock latency. Returns null when it may run;
 *  otherwise the reason it can't, already printed (vitest's silent mode drops console output, so it goes to
 *  stdout directly). Pass it to the test context's skip(), or skip just the latency assertions with it. */
export function loadSensitive(what: string): string | null {
	const load = loadavg()[0]!;
	if (load <= LOAD_SENSITIVE_MAX_LOAD) return null;
	const reason = `load-sensitive, skipped: ${what} measures wall-clock latency, and the 1-minute load is ${load.toFixed(1)}, above ${LOAD_SENSITIVE_MAX_LOAD} (this machine's cores)`;
	process.stdout.write(`${reason}\n`);
	return reason;
}
