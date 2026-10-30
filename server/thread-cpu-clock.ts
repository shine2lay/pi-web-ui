// Ops #643 (H-USAGE-CPU-CLOCK-1): the work clock for budgets that mean "how much work this code did".
// Wall-clock time keeps running while a busy machine gives the thread no core, so a budget read from it ends a slice
// having done only part of its work. This clock counts only the time the calling thread actually ran. It is the
// product side of the clock seam the gate's tests use (tests/unit/load-independent.ts threadCpuMs, Ops #639;
// docs/gate-time.md); the tests keep their own copy, so their yardstick is never the code under test.

/** CPU time (user + system, ms) of the calling thread only. Monotonic for a thread; it doesn't count other threads,
 *  time spent waiting for a core, or time blocked (a sleep, an awaited read on libuv's pool). A wall-clock limit kept
 *  beside it is a hang guard only, never what ends a healthy slice. */
export function threadCpuMs(): number {
	const { user, system } = process.threadCpuUsage();
	return (user + system) / 1000;
}
